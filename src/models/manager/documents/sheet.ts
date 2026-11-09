import { text as pageText } from '../../../config/manager/documents/resources.js';
import type pg from 'pg';
import { hostname } from 'node:os';
import { documentAdministratorId, documentDetail } from './details.js';
import {
  documentApplicantLocked,
  documentClusters,
  documentClusterInput,
  documentCheckUnchangedClusters,
} from './clusters.js';
import { documentPatchXml } from './top.js';
import { children, must, optionalField, root, serialize } from '../../client-definition-xml.js';
import { saveReportTables } from '../../client-report-tables.js';
import { checkReportSaveFeatures } from '../../client-report-upload.js';
import { reportNameDate, setReportName } from '../../client-report-name.js';
import { updateReportAutoLabels } from '../../client-report-labels.js';
import { labelString, LabelValidationError } from '../labels/index.js';

type Database = Pick<pg.Pool, 'query'>;
export async function documentSheet(db: Database, id: number, pageIndex: number, user: string, edit = false) {
  const report = await documentDetail(db, id, user);
  if (!report) throw new LabelValidationError('access', pageText['Role authority is insufficient.']);
  const sheets = (
    await db.query(
      `SELECT s.*,t.def_top_id,t.edit_refer_status,t.use_applicant_lock,t.use_input_history,t.use_change_reason,
    t.use_exclusive_mode_manager,t.is_sort_report,t.xml_data,
    (t.use_change_reason=1 OR (SELECT com_value FROM mst_common WHERE com_key='HISTORY_SETTING' AND com_name='ENABLE' ORDER BY com_index LIMIT 1) IN ('1','2')
      AND (SELECT com_value FROM mst_common WHERE com_key='HISTORY_SETTING' AND com_name='CHANGE_REASON_ENABLE' ORDER BY com_index LIMIT 1)='1') AS show_change_reason
    FROM rep_sheet s JOIN rep_top t USING(rep_top_id) WHERE s.rep_top_id=$1 ORDER BY s.rep_sheet_no`,
      [id],
    )
  ).rows;
  if (pageIndex < 0 || pageIndex >= sheets.length)
    throw new LabelValidationError('', pageText['Invalid sheet page index.']);
  const sheet = sheets[pageIndex];
  const administrator = await documentAdministratorId();
  const [clusters, references, layers, draws] = await Promise.all([
    documentClusters(db, id, user, Number(sheet.rep_sheet_id)),
    db.query(
      `SELECT r.*,($2=$3 OR r.document_id IS NULL OR
      CASE WHEN EXISTS(SELECT 1 FROM mst_common_document d WHERE d.document_id=r.document_id)
      THEN NOT EXISTS(SELECT 1 FROM mst_common_document_role role WHERE role.document_id=r.document_id)
        OR EXISTS(SELECT 1 FROM mst_common_document_role role JOIN mst_group_affiation a USING(group_id) WHERE role.document_id=r.document_id AND a.user_id=$2)
      WHEN EXISTS(SELECT 1 FROM mst_report_document d WHERE d.document_id=r.document_id)
      THEN NOT EXISTS(SELECT 1 FROM mst_report_document_role role WHERE role.document_id=r.document_id)
        OR EXISTS(SELECT 1 FROM mst_report_document_role role JOIN mst_group_affiation a USING(group_id) WHERE role.document_id=r.document_id AND a.user_id=$2)
      ELSE true END) AS accessible FROM rep_reference r WHERE r.rep_sheet_id=$1 ORDER BY r.diplay_number`,
      [sheet.rep_sheet_id, user, administrator],
    ),
    db.query('SELECT layer_id,input_value FROM rep_layer WHERE rep_sheet_id=$1 ORDER BY layer_id', [
      sheet.rep_sheet_id,
    ]),
    db.query(
      "SELECT key_id,image_no,'layer' AS type FROM rep_layer_draw WHERE rep_sheet_id=$1 UNION ALL SELECT key_id,image_no,'cluster' AS type FROM rep_cluster_draw WHERE rep_sheet_id=$1 ORDER BY type,key_id,image_no",
      [sheet.rep_sheet_id],
    ),
  ]);
  const rows = references.rows;
  let next = rows.length ? Math.max(...rows.map((row) => Number(row.reference_id))) : 0;
  while (rows.length < 10)
    rows.push({
      reference_id: ++next,
      diplay_number: next,
      reference_name: '',
      reference_type: '',
      reference_value: '',
      accessible: true,
    });
  const reEditDisabled = edit && optionalField(must(root(sheet.xml_data), 'top'), 'reEditDisable') === '1';
  const visible = clusters.filter(
    (row) =>
      !edit ||
      (!['DrawingPinNo', 'PinItemTableNo', 'Scandit', 'EdgeOCR'].includes(row.cluster_type) &&
        !(
          row.cluster_type === 'KeyboardText' &&
          String(row.input_parameter ?? '')
            .split(';')
            .map((part) => part.split('='))
            .find((part) => part[0] === 'AutoNumber')?.[1] === '1'
        ) &&
        !(row.cluster_type === 'Image' && ['PinImage', 'PinImage2'].includes(row.cluster_name) && !row.pin_value)),
  );
  return {
    report: { ...report, applicant_locked: await documentApplicantLocked(db, id, user) },
    sheet,
    pageIndex,
    pages: sheets.length,
    clusters: visible.map((row) => ({
      ...row,
      ...documentClusterInput(row),
      cluster_role:
        row.cluster_role !== '2' &&
        (reEditDisabled ||
          (row.cluster_type === 'InputNumeric' && /KeypadMode=2/i.test(row.input_parameter ?? '')) ||
          (Number(sheet.use_exclusive_mode_manager) === 1 &&
            row.edit_user &&
            row.input_value &&
            row.edit_user !== user &&
            user !== administrator &&
            !['Approve', 'Create', 'Inspect'].includes(row.cluster_type)))
          ? '0'
          : row.cluster_role,
    })),
    references: rows,
    layers: layers.rows,
    draws: draws.rows,
  };
}

export async function documentSaveSheetMetadata(
  db: pg.Pool,
  id: number,
  pageIndex: number,
  input: Record<string, unknown>,
  user: string,
) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT rep_top_id FROM rep_top WHERE rep_top_id=$1 FOR UPDATE', [id]);
    const model = await documentSheet(client, id, pageIndex, user, true);
    if (!model.report.role_update)
      throw new LabelValidationError('access', pageText['Role authority is insufficient.']);
    if ((await client.query('SELECT 1 FROM rep_lock WHERE rep_top_id=$1 AND user_id<>$2', [id, user])).rowCount)
      throw new LabelValidationError('', pageText['The report is locked by another user.']);
    if (
      model.report.workflow_locked ||
      !model.report.current ||
      Number(model.sheet.edit_refer_status) === 4 ||
      model.report.applicant_locked
    )
      throw new LabelValidationError(
        'pending',
        pageText['This report state requires an unmigrated sheet-editing workflow. No changes were saved.'],
      );
    documentCheckUnchangedClusters(input, model.clusters);
    const row = (await client.query('SELECT xml_data FROM rep_top WHERE rep_top_id=$1', [id])).rows[0];
    const xml = root(row.xml_data),
      top = must(xml, 'top');
    const sheet = children(must(top, 'sheets'), 'sheet').find(
      (node) => optionalField(node, 'repSheetId') === String(model.sheet.rep_sheet_id),
    );
    if (!sheet || optionalField(top, 'repTopId') !== String(id))
      throw new Error(pageText['Report XML identity differs.']);
    await checkReportSaveFeatures(client, top);
    if (
      (
        await client.query(
          "SELECT 1 FROM rep_top WHERE rep_top_id=$1 AND (COALESCE(use_input_history,0)<>0 OR COALESCE(use_change_reason,0)<>0 OR COALESCE(journalizing_def_top_id,-1)>0 OR COALESCE(edit_output,1)<>0 OR COALESCE(edit_mail,'')<>'')",
          [id],
        )
      ).rowCount
    )
      throw new LabelValidationError(
        'pending',
        pageText['Sheet history, output or notifications have not been migrated. No changes were saved.'],
      );
    const names = ['rep_sheet_name', ...Array.from({ length: 10 }, (_, index) => 'sheet_remarks' + (index + 1))];
    const supported = new Set([
      'rep_sheets[0].rep_top_id',
      'rep_sheets[0].rep_sheet_id',
      'rep_sheets[0].rep_sheet_no',
      'rep_sheets[0].rownum',
      'rep_sheets[0].def_top_id',
      'rep_sheets.PageIndex',
      ...names.map((name) => 'rep_sheets[0].' + name),
    ]);
    if (Object.keys(input).some((key) => key.startsWith('rep_sheets') && !supported.has(key)))
      throw new LabelValidationError(
        'pending',
        pageText['This sheet setting has not been migrated. No changes were saved.'],
      );
    if (labelString(input['rep_sheets[0].rep_sheet_id']) !== String(model.sheet.rep_sheet_id))
      throw new LabelValidationError('', pageText['The selected sheet has changed.']);
    if (
      optionalField(top, 'lockMode') === '1' ||
      optionalField(top, 'useAutoNumbering') === '1' ||
      (
        await client.query(
          'SELECT 1 FROM binder_rep_src src JOIN rep_top t ON t.rep_top_org=src.rep_top_org WHERE t.rep_top_id=$1 LIMIT 1',
          [id],
        )
      ).rowCount
    )
      throw new LabelValidationError(
        'pending',
        pageText['Numbering, cooperative editing or binder persistence has not been migrated. No changes were saved.'],
      );
    const now = new Date();
    const parameters: unknown[] = [model.sheet.rep_sheet_id, user, hostname(), now];
    const assignments = ['sys_update_user=$2', 'sys_update_term=$3', 'sys_update_time=$4'];
    for (const name of names) {
      const key = 'rep_sheets[0].' + name;
      if (!Object.hasOwn(input, key)) continue;
      const value = labelString(input[key]);
      if (name === 'rep_sheet_name' && !value.trim())
        throw new LabelValidationError(key, pageText['Enter a sheet name.']);
      if (value.length > 4000) throw new LabelValidationError(key, pageText['The value is too long.']);
      parameters.push(value);
      assignments.push(name + '=$' + parameters.length);
      documentPatchXml(
        sheet,
        name === 'rep_sheet_name' ? 'repSheetName' : 'remarksValue' + name.slice('sheet_remarks'.length),
        value,
      );
    }
    documentPatchXml(top, 'editStatus', String(model.sheet.edit_refer_status));
    documentPatchXml(top, 'updateUser', user);
    documentPatchXml(top, 'updateTime', reportNameDate(now, 'yyyy/MM/dd HH:mm:ss'));
    documentPatchXml(top, 'repTopName', model.report.rep_top_name);
    setReportName(top, now, false);
    await client.query(`UPDATE rep_sheet SET ${assignments.join(',')} WHERE rep_sheet_id=$1`, parameters);
    await client.query(
      'UPDATE rep_top SET xml_data=$2,rep_top_name=$3,sys_update_user=$4,sys_update_user_name=(SELECT user_name FROM mst_user WHERE user_id=$4),sys_update_term=$5,sys_update_time=$6 WHERE rep_top_id=$1',
      [id, serialize(xml), optionalField(top, 'repTopName'), user, hostname(), now],
    );
    await saveReportTables(client as pg.PoolClient, top, new Set());
    await updateReportAutoLabels(
      client,
      must(root(row.xml_data), 'top'),
      top,
      {
        userId: user,
        userName:
          (await client.query('SELECT user_name FROM mst_user WHERE user_id=$1', [user])).rows[0]?.user_name ?? '',
        terminalId: hostname(),
      },
      now,
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
