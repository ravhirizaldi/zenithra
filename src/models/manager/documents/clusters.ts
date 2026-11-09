import { text as pageText } from '../../../config/manager/documents/resources.js';
import type pg from 'pg';
import { documentAdministratorId, documentDetail } from './details.js';
import { labelChecked, LabelValidationError } from '../labels/index.js';
import { element } from '../../client-definition-xml.js';
import { reportTableValue } from '../../client-report-tables.js';

function splitClusterItems(value: string) {
  const items: string[] = [];
  let text = '';
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== ',') text += value[index];
    else if (index === value.length - 1) break;
    else if (value[index + 1] === ',') {
      text += ',';
      index++;
    } else {
      items.push(text);
      text = '';
    }
  }
  if (text) items.push(text);
  return items;
}

export function documentClusterInput(row: {
  cluster_type: string;
  input_parameter: string | null;
  input_value: string | null;
  display_value: string | null;
  cluster_role: string;
}) {
  const hidden = row.cluster_role === '2',
    parameter = hidden ? '' : (row.input_parameter ?? ''),
    value = hidden ? '' : (row.input_value ?? '');
  const parameters = parameter.split(';').map((part) => part.split('='));
  const first = (name: string) => parameters.find((part) => part[0] === name && part[1])?.[1] ?? '';
  const toggle = row.cluster_type === 'MultipleChoiceNumber',
    multiple = row.cluster_type === 'MultiSelect';
  const items = first('Items'),
    display = parameter.includes('Display=ItemsAndLabels')
      ? 'both'
      : parameter.includes('Display=Items')
        ? 'items'
        : parameter.includes('Display=Labels')
          ? 'labels'
          : 'items';
  const labels = toggle || display !== 'items' ? first('Labels') : '';
  const options = parameter
    ? [
        ...(multiple ? [] : [{ value: '', text: '' }]),
        ...splitClusterItems(items).map((item) => ({ value: item, text: item })),
      ]
    : [];
  splitClusterItems(labels).forEach((label, index) => {
    const option = options[index + (multiple ? 0 : 1)];
    if (!option) return;
    if (toggle) {
      option.value = label;
      option.text += ' - ' + label;
    } else option.text = display === 'both' ? option.text + ' - ' + label : label;
  });
  const useTime = parameters.some((part) => part[0] === 'UseTime' && part[1] === '1');
  const keyboard = parameters.filter((part) => part[0] === 'UseKeyboard' && part[1]).at(-1)?.[1] ?? '';
  const isKeyboardInput =
    !toggle &&
    Boolean(value) &&
    splitClusterItems(value).some((item) => !options.some((option) => option.value === item));
  const date =
    useTime && ['Date', 'CalendarDate'].includes(row.cluster_type)
      ? reportTableValue(element('cluster', [element('type', 'Date'), element('value', value)]), 'D', 'en-US', true)
      : null;
  return {
    useTime,
    input_value_date: date?.slice(0, 10).replaceAll('-', '/') ?? '',
    input_value_time: date?.slice(11) ?? '',
    input_check_value: /^(?:true|1)$/i.test(value),
    options,
    multi_input_value: value.split(','),
    selected: toggle ? (hidden ? '' : (row.display_value ?? '')) : value,
    selectItems: toggle ? labels : items,
    selectLabels: toggle ? items : labels,
    isKeyboardEnable: !toggle && /^(?:true|1|2)$/i.test(keyboard),
    isKeyboardInput,
    keyboardValue: isKeyboardInput ? value : '',
  };
}

// EditSheet posts unchanged cluster controls too; only actual changes need the unported rendering/save pipeline.
export function documentCheckUnchangedClusters(input: Record<string, unknown>, rows: Record<string, unknown>[]) {
  const pending = () =>
    new LabelValidationError(
      'pending',
      pageText['Cluster editing and rendered-preview persistence have not been migrated. No changes were saved.'],
    );
  for (const [key, submitted] of Object.entries(input)) {
    if (!key.startsWith('rep_clusters[')) continue;
    const match = /^rep_clusters\[(\d+)\]\.(\w+)$/.exec(key),
      row = match && rows[Number(match[1])];
    if (!match || !row) throw pending();
    const name = match[2];
    const values: Record<string, unknown> = {
      cluster_role: row.cluster_role,
      rep_sheet_id: row.rep_sheet_id,
      cluster_id: row.cluster_id,
    };
    if (row.cluster_role !== '2')
      Object.assign(values, {
        input_value: row.cluster_type === 'MultipleChoiceNumber' ? row.selected : row.input_value,
        input_value_date: row.input_value_date,
        input_value_time: row.input_value_time,
        KeyboardValue: row.keyboardValue,
        IsKeyboardInput: row.isKeyboardInput,
        input_check_value: row.input_check_value,
        Verified: Number(row.verified) === 1,
        ChangeReason: row.change_reason,
        comment_value: row.comment_value,
        SelectListExItems: row.selectItems,
        SelectListLabels: row.selectLabels,
        multi_input_value: row.multi_input_value,
      });
    if (!Object.hasOwn(values, name)) throw pending();
    const expected = values[name];
    if (typeof expected === 'boolean') {
      const parts = Array.isArray(submitted) ? submitted : [submitted];
      if (
        !parts.length ||
        parts.length > 2 ||
        parts.some((value) => typeof value !== 'string' || !/^(true|false)$/i.test(value)) ||
        labelChecked(submitted) !== expected
      )
        throw pending();
    } else if (name === 'multi_input_value' && Array.isArray(expected)) {
      const parts = Array.isArray(submitted) ? submitted : [submitted];
      if (
        parts.some((value) => typeof value !== 'string') ||
        JSON.stringify([...parts].sort()) !== JSON.stringify([...expected].sort())
      )
        throw pending();
    } else if (typeof submitted !== 'string' || submitted !== String(expected ?? '')) throw pending();
  }
}

type Database = Pick<pg.Pool, 'query'>;
export const documentHistoryColumns = `h.history_id,h.rep_sheet_id,h.cluster_name,h.cluster_type,h.input_value,h.display_value,
  h.verified,h.comment_value,h.change_reason,h.applicant_name,h.applicant_comment,h.approver_name,h.approver_comment,
  to_char(h.applicant_date,'YYYY/MM/DD') AS applicant_date,to_char(h.approver_date,'YYYY/MM/DD') AS approver_date,
  COALESCE(length(h.image_file),0)>0 AS has_image,COALESCE(length(h.approval_sign),0)>0 AS has_signature,
  COALESCE(length(h.recording_file),0)>0 AS has_recording,h.recording_file_extension,h.edit_user,h.edit_user_name,
  to_char(h.edit_time,'YYYY/MM/DD HH24:MI:SS') AS edit_time,h.gps_lat,h.gps_lon,h.gps_alt,h.cluster_id,h.sys_update_user,
  COALESCE(u.user_name,h.sys_update_user,'') AS updated_by,to_char(h.sys_update_time,'YYYY/MM/DD HH24:MI:SS') AS updated`;
export const documentClusterPermissionQuery = `SELECT
  NOT EXISTS(SELECT 1 FROM rep_cluster_role r WHERE r.rep_sheet_id=c.rep_sheet_id AND r.cluster_id=c.cluster_id) AS none,
  NOT EXISTS(SELECT 1 FROM rep_cluster_role r WHERE r.rep_sheet_id=c.rep_sheet_id AND r.cluster_id=c.cluster_id)
  OR EXISTS(SELECT 1 FROM rep_cluster_role r JOIN mst_group_affiation a USING(group_id) WHERE r.rep_sheet_id=c.rep_sheet_id AND r.cluster_id=c.cluster_id AND a.user_id=$1) AS edit,
  NOT EXISTS(SELECT 1 FROM rep_cluster_refer r WHERE r.rep_sheet_id=c.rep_sheet_id AND r.cluster_id=c.cluster_id)
  OR EXISTS(SELECT 1 FROM rep_cluster_refer r JOIN mst_group_affiation a USING(group_id) WHERE r.rep_sheet_id=c.rep_sheet_id AND r.cluster_id=c.cluster_id AND a.user_id=$1) AS refer`;

export async function documentClusters(db: Database, id: number, user: string, sheetId: number | null = null) {
  if (!(await documentDetail(db, id, user)))
    throw new LabelValidationError('access', pageText['Role authority is insufficient.']);
  const administrator = await documentAdministratorId();
  return (
    await db.query(
      `SELECT c.rep_sheet_id,c.cluster_id,c.cluster_name,c.cluster_type,c.input_parameter,
    c.input_value,c.display_value,c.verified,c.comment_value,c.change_reason,c.pin_value,
    c.applicant,c.applicant_name,c.applicant_comment,to_char(c.applicant_date,'YYYY/MM/DD') AS applicant_date,
    c.approver,c.approver_name,c.approver_comment,to_char(c.approver_date,'YYYY/MM/DD') AS approver_date,
    COALESCE(length(c.approval_sign),0)>0 AS has_signature,COALESCE(length(c.image_file),0)>0 AS has_image,
    COALESCE(length(c.recording_file),0)>0 AS has_recording,c.recording_file_extension,
    c.edit_user,c.edit_user_name,to_char(c.edit_time,'YYYY/MM/DD HH24:MI:SS') AS edit_time,c.gps_lat,c.gps_lon,c.gps_alt,
    c.sys_update_user,COALESCE(u.user_name,c.sys_update_user,'') AS updated_by,
    EXISTS(SELECT 1 FROM mst_terminal term WHERE c.sys_update_term=term.term_id::text AND term.term_type='iPad') AS client_updated,
    to_char(c.sys_update_time,'YYYY/MM/DD HH24:MI:SS') AS updated,s.rep_sheet_no,
    CASE WHEN $2=$4 THEN '1'
      WHEN NOT roles.refer AND (roles.none OR NOT roles.edit) THEN '2'
      WHEN roles.edit THEN '1' ELSE '0' END AS cluster_role,
    (SELECT count(*) FROM history_rep_cluster h WHERE h.rep_sheet_id=c.rep_sheet_id AND h.cluster_id=c.cluster_id)::integer AS history_count
    FROM rep_cluster c JOIN rep_sheet s USING(rep_sheet_id) LEFT JOIN mst_user u ON u.user_id=c.sys_update_user
    CROSS JOIN LATERAL(${documentClusterPermissionQuery.replaceAll('$1', '$2')}) roles
    WHERE s.rep_top_id=$1 AND ($3::int IS NULL OR s.rep_sheet_id=$3) ORDER BY s.rep_sheet_no,c.cluster_id`,
      [id, user, sheetId, administrator],
    )
  ).rows;
}

export async function documentClusterHistory(
  db: Database,
  id: number,
  user: string,
  sheetId: number,
  clusterId: number,
) {
  const cluster = (await documentClusters(db, id, user, sheetId)).find((row) => Number(row.cluster_id) === clusterId);
  if (!cluster || cluster.cluster_role === '2')
    throw new LabelValidationError('access', pageText['Role authority is insufficient.']);
  return (
    await db.query(
      `SELECT ${documentHistoryColumns}
    FROM history_rep_cluster h LEFT JOIN mst_user u ON u.user_id=h.sys_update_user
    WHERE h.rep_sheet_id=$1 AND h.cluster_id=$2 ORDER BY h.history_regist_time DESC`,
      [sheetId, clusterId],
    )
  ).rows;
}

export async function documentApplicantLocked(db: Database, id: number, user: string) {
  return (
    (
      await db.query<{ locked: boolean }>(
        `SELECT
    t.edit_refer_status<>4 AND t.use_applicant_lock=1
    AND (SELECT com_value FROM mst_common WHERE com_key='IPAD_SETTING' AND com_name='USE_APPLICANT_LOCK' ORDER BY com_index LIMIT 1)='1'
    AND EXISTS(SELECT 1 FROM rep_cluster c JOIN rep_sheet s USING(rep_sheet_id)
      WHERE s.rep_top_id=t.rep_top_id AND c.cluster_type='Approve' AND c.input_value IN ('2','4')
      AND EXISTS(SELECT 1 FROM rep_cluster_role r WHERE r.rep_sheet_id=c.rep_sheet_id AND r.cluster_id=c.cluster_id)
      AND NOT EXISTS(SELECT 1 FROM rep_cluster_role r JOIN mst_group_affiation a USING(group_id)
        WHERE r.rep_sheet_id=c.rep_sheet_id AND r.cluster_id=c.cluster_id AND a.user_id=$2))
    AND ((SELECT com_value FROM mst_common WHERE com_key='IPAD_SETTING' AND com_name='APPLICANT_LOCK_TYPE' ORDER BY com_index LIMIT 1) IS DISTINCT FROM '1'
      OR NOT EXISTS(SELECT 1 FROM rep_cluster c JOIN rep_sheet s USING(rep_sheet_id)
        WHERE s.rep_top_id=t.rep_top_id AND c.cluster_type='Approve' AND
        (c.input_value='3' AND c.applicant=$2 OR c.input_value='2' AND
          (NOT EXISTS(SELECT 1 FROM rep_cluster_role r WHERE r.rep_sheet_id=c.rep_sheet_id AND r.cluster_id=c.cluster_id)
          OR EXISTS(SELECT 1 FROM rep_cluster_role r JOIN mst_group_affiation a USING(group_id)
            WHERE r.rep_sheet_id=c.rep_sheet_id AND r.cluster_id=c.cluster_id AND a.user_id=$2))))) AS locked
    FROM rep_top t WHERE rep_top_id=$1`,
        [id, user],
      )
    ).rows[0]?.locked === true
  );
}
