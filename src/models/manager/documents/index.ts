import { text as pageText } from '../../../config/manager/documents/resources.js';
import type pg from 'pg';
import { hostname } from 'node:os';
import { labelChecked, labelInteger, labelRows, labelString, LabelValidationError } from '../labels/index.js';
import { legacyDecrypt, legacyEncrypt } from '../../../shared/legacy-auth.js';
import { documentSchemeAuth } from '../../../services/manager/documents.js';

type Database = Pick<pg.Pool, 'query'>;
type CommonRow = { com_key: string; com_name: string; com_value: string; com_index: number };
export const documentSortColumns = [
  'REP_TOP_ID',
  'REP_TOP_NAME',
  'REP_TOP_ORG',
  'REV_NO',
  'EDIT_REFER_STATUS',
  'SYS_REGIST_TIME',
  'SYS_REGIST_USER',
  'SYS_UPDATE_TIME',
  'SYS_UPDATE_USER',
] as const;
export const documentSearchFields = [
  'ReportId',
  'ReportName',
  'Remarks',
  'InputValue',
  'RegistUser',
  'UpdateUser',
  'SystemKey',
  'RegistDateFrom',
  'RegistTimeFrom',
  'RegistDateTo',
  'RegistTimeTo',
  'UpdateDateFrom',
  'UpdateTimeFrom',
  'UpdateDateTo',
  'UpdateTimeTo',
] as const;
export type DocumentState = {
  Act: string;
  LabelID: string;
  PublicStatus: string;
  EditReferStatus: string;
  ApprovalStatus: string;
  ReportTypeSheet: boolean;
  ReportTypeSet: boolean;
  IsLabelUnderSearch: boolean;
  PageIndex: number;
  PageSize: number;
  SortColumn: string;
  SortDirection: 'ASC' | 'DESC';
  LabelPageIndexBackup: number;
  SearchNameLabelViewBackup: string;
  SearchInfo: Record<(typeof documentSearchFields)[number], string>;
};
export async function documentSettings(db: Database) {
  const rows = (
    await db.query<CommonRow>(`SELECT com_key,com_name,com_value,com_index FROM mst_common
    WHERE com_key IN ('CONMAS_FUNCTION','REPORT_APPROVE_SETTING','SEARCH_SETTING','DEFAULT_PUBLIC_STATUS_REPORT',
    'DEFAULT_PAGE_SIZE','PAGE_SIZE','NEW_DISPLAY_TIME','ROLE_SETTING','CUSTOM_GRID','CUSTOM_MENU','CUSTOM_URL_SCHEME','PASSWORD_ENCRYPTION') ORDER BY com_index`)
  ).rows;
  const value = (key: string, name?: string) =>
    rows.find((r) => r.com_key === key && (name === undefined || r.com_name === name))?.com_value ?? '';
  const positive = (text: string, fallback: number) =>
    /^\d+$/.test(text) && Number(text) > 0 && Number(text) <= 2147483647 ? Number(text) : fallback;
  return {
    initLoad: value('CONMAS_FUNCTION', 'INPUTREPORT_LABEL_INIT_LOAD') !== '0',
    allDisplay: value('CONMAS_FUNCTION', 'INPUTREPORT_LABEL_ALL_DISPLAY') !== '0',
    inputValue: value('SEARCH_SETTING', 'CLUSTER_VALUE_FILTER') === '1',
    approvalMode: value('SEARCH_SETTING', 'APPROVE_MODE') === '1',
    noCount: value('SEARCH_SETTING', 'REPORT_LIST_IS_COUNT') === '0',
    virtualCount:
      value('SEARCH_SETTING', 'REPORT_LIST_IS_COUNT') === '0'
        ? labelInteger(value('SEARCH_SETTING', 'VIRTUAL_COUNT_MAX'))
        : 0,
    bulkApproval: value('REPORT_APPROVE_SETTING', 'ENABLE_BULK_APPROVAL') === '1',
    managerRoleType: value('ROLE_SETTING', 'MANAGER_INPUT_REPORT_MANGERROLE_TYPE'),
    publicStatus: value('DEFAULT_PUBLIC_STATUS_REPORT') || '2',
    pageSize: positive(value('DEFAULT_PAGE_SIZE'), 20),
    pageSizes: rows.filter((r) => r.com_key === 'PAGE_SIZE').map((r) => positive(r.com_value, 20)),
    newDisplayTime: positive(value('NEW_DISPLAY_TIME', 'DisplayTime'), 10),
    newInterval: positive(value('NEW_DISPLAY_TIME', 'Interval'), 1),
    reportHeading: value('CUSTOM_GRID', 'REP_REPORT'),
    menu: Object.fromEntries(rows.filter((r) => r.com_key === 'CUSTOM_MENU').map((r) => [r.com_name, r.com_value])),
    schemeEnable: value('CUSTOM_URL_SCHEME', 'ENABLE'),
    schemeAuth: value('CUSTOM_URL_SCHEME', 'AUTH_PARAMETER_ENABLE') === '1',
    passwordEncrypted: value('PASSWORD_ENCRYPTION', 'PASSWORD_ENCRYPTION') === '1',
  };
}
export type DocumentSettings = Awaited<ReturnType<typeof documentSettings>>;
export async function documentAppLaunch(db: Database, settings: DocumentSettings, user: string, userAgent: string) {
  const windows = userAgent.includes('Windows');
  const ios = !windows && /iPad|iPhone|iPod|Macintosh/.test(userAgent);
  if (!((windows && ['2', '3'].includes(settings.schemeEnable)) || (ios && ['1', '3'].includes(settings.schemeEnable))))
    return null;
  let auth = '';
  if (settings.schemeAuth) {
    const row = (await db.query<{ password: string }>('SELECT password FROM mst_user WHERE user_id=$1', [user]))
      .rows[0];
    if (!user || !row || typeof row.password !== 'string')
      throw new Error(pageText['The Documents app-launch account is unavailable.']);
    let password = row.password;
    if (settings.passwordEncrypted) {
      const key = process.env.CONMAS_LEGACY_KEY;
      if (!key) throw new Error(pageText['Password encryption key is not configured.']);
      password = legacyDecrypt(password, legacyEncrypt(`#*${user}*#`, key));
    }
    auth = '&auth=' + (await documentSchemeAuth(user, password));
  }
  return {
    template: 'ireporter.openreport:repid={rep_top_id}' + auth,
    icon: windows ? 'win_ir.ico' : 'ios_ir.png',
  };
}
export async function documentLabels(db: Database, user: string, search: string, hidden: boolean) {
  const rows = await labelRows(db, 'Rep', user, search);
  if (!hidden) return rows;
  const used = (
    await db.query(
      `SELECT DISTINCT unnest(string_to_array(m.label_id_path,'/')) AS id FROM mst_label_rep m
    WHERE EXISTS (SELECT 1 FROM rep_label l JOIN rep_role rl USING(rep_top_id) JOIN rep_top t USING(rep_top_id) JOIN rep_current c USING(rep_top_id)
      WHERE l.mst_label_id=m.mst_label_id AND t.deleted=0 AND rl.role_rep_read>0 AND rl.group_id IN (SELECT group_id FROM mst_group_affiation WHERE user_id=$1))`,
      [user],
    )
  ).rows;
  const ids = new Set(used.map((row) => Number(row.id)));
  return rows.filter((row) => ids.has(row.mst_label_id));
}
export async function documentLinkLabels(
  db: pg.Pool,
  reportInput: unknown,
  labelInput: unknown,
  status: string,
  user: string,
) {
  const ids = (input: unknown) => {
    const result = [
      ...new Set(
        labelString(input)
          .split(',')
          .map((value) => labelInteger(value)),
      ),
    ];
    if (result.some((id) => id <= 0)) throw new LabelValidationError('', pageText['Select valid reports and labels.']);
    return result;
  };
  const reports = ids(reportInput),
    labels = ids(labelInput);
  if (!['add', 'delete'].includes(status)) throw new LabelValidationError('', pageText['Invalid label operation.']);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const accessible = (
      await client.query(
        `SELECT a.rep_top_id FROM rep_top a
      WHERE a.rep_top_id=ANY($1::int[]) AND a.deleted=0
      AND EXISTS (SELECT 1 FROM rep_role r WHERE r.rep_top_id=a.rep_top_id AND r.role_rep_read>0
        AND r.group_id IN (SELECT group_id FROM mst_group_affiation WHERE user_id=$2))
      AND EXISTS (SELECT 1 FROM rep_role r WHERE r.rep_top_id=a.rep_top_id AND r.role_rep_update=1
        AND r.group_id IN (SELECT group_id FROM mst_group_affiation WHERE user_id=$2))
      AND NOT EXISTS (SELECT 1 FROM rep_lock l WHERE l.rep_top_id=a.rep_top_id AND l.user_id IS NOT NULL AND l.user_id<>'0')
      FOR UPDATE OF a`,
        [reports, user],
      )
    ).rows;
    if (accessible.length !== reports.length)
      throw new LabelValidationError('', pageText['A selected report is unavailable, locked or not editable.']);
    const selected = (
      await client.query(
        `SELECT mst_label_id,binder_rep_id FROM mst_label_rep
      WHERE mst_label_id=ANY($1::int[]) FOR SHARE`,
        [labels],
      )
    ).rows;
    if (selected.length !== labels.length || selected.some((label) => label.binder_rep_id != null))
      throw new LabelValidationError('', pageText['A selected label is unavailable or belongs to a binder.']);
    if (status === 'add')
      await client.query(
        `INSERT INTO rep_label
      (rep_top_id,mst_label_id,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time)
      SELECT r,l,$3,$4,CURRENT_TIMESTAMP,$3,$4,CURRENT_TIMESTAMP
      FROM unnest($1::int[]) r CROSS JOIN unnest($2::int[]) l
      WHERE NOT EXISTS (SELECT 1 FROM rep_label x WHERE x.rep_top_id=r AND x.mst_label_id=l)
      ON CONFLICT (rep_top_id,mst_label_id) DO NOTHING`,
        [reports, labels, hostname(), user],
      );
    else
      await client.query('DELETE FROM rep_label WHERE rep_top_id=ANY($1::int[]) AND mst_label_id=ANY($2::int[])', [
        reports,
        labels,
      ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export async function documentPermissions(db: Database, user: string, settings: DocumentSettings) {
  const row =
    (
      await db.query(
        `SELECT MAX(role_rep_read_manager) AS read, MAX(role_rep_update_manager) AS update,
    MAX(role_rep_delete_manager) AS delete, MAX(role_rep_super_manager) AS super,
    MAX(role_schedule_create) AS schedule FROM mst_group WHERE group_id IN
    (SELECT group_id FROM mst_group_affiation WHERE user_id=$1)`,
        [user],
      )
    ).rows[0] ?? {};
  const elevated = String(row.super) === '1' && settings.managerRoleType !== '1';
  const read = elevated || String(row.read) === '1',
    update = elevated || String(row.update) === '1',
    remove = elevated || String(row.delete) === '1';
  return { read, update, delete: remove, refer: read || update || remove, schedule: String(row.schedule) === '1' };
}
export function documentState(
  input: Record<string, unknown>,
  settings: DocumentSettings,
  previous?: DocumentState,
): DocumentState {
  const act = labelString(input.Act ?? input.act);
  const source = act === 'BACK_INDEX' && previous ? { ...previous, Act: act } : input;
  const choice = (name: string, allowed: string[], fallback: string) => {
    const value = labelString(source[name]) || fallback;
    if (!allowed.includes(value)) throw new LabelValidationError(name, pageText['Invalid filter value.']);
    return value;
  };
  const column = labelString(source.SortColumn) || 'SYS_UPDATE_TIME';
  if (!(documentSortColumns as readonly string[]).includes(column))
    throw new LabelValidationError('SortColumn', pageText['Invalid sort column.']);
  const label = labelString(source.LabelID);
  if (label && !['All', 'NoLabel', 'Trash'].includes(label)) labelInteger(label);
  const search = source.SearchInfo as DocumentState['SearchInfo'] | undefined;
  const integer = (value: unknown, fallback: number) =>
    labelInteger(typeof value === 'number' ? String(value) : value, fallback);
  const size = integer(source.PageSize, settings.pageSize) || settings.pageSize;
  const index = integer(source.PageIndex, 0);
  const labelIndex = integer(source.LabelPageIndexBackup, 1);
  if (size <= 0 || index < 0 || labelIndex < 1)
    throw new LabelValidationError('PageIndex', pageText['Invalid page value.']);
  return {
    Act: act,
    LabelID: label,
    PublicStatus: choice('PublicStatus', ['-1', '1', '2'], settings.publicStatus),
    EditReferStatus: choice('EditReferStatus', ['-1', '0', '1', '2', '3', '4'], '-1'),
    ApprovalStatus: choice('ApprovalStatus', ['-1', '0', '1', '2', '3'], '-1'),
    ReportTypeSheet:
      source.ReportTypeSheet === undefined
        ? true
        : source.ReportTypeSheet === true || labelChecked(source.ReportTypeSheet),
    ReportTypeSet:
      source.ReportTypeSet === undefined ? true : source.ReportTypeSet === true || labelChecked(source.ReportTypeSet),
    IsLabelUnderSearch: source.IsLabelUnderSearch === true || labelChecked(source.IsLabelUnderSearch),
    PageIndex: index,
    PageSize: size,
    SortColumn: column,
    SortDirection: choice('SortDirection', ['ASC', 'DESC'], 'DESC') as 'ASC' | 'DESC',
    LabelPageIndexBackup: labelIndex,
    SearchNameLabelViewBackup: labelString(source.SearchNameLabelViewBackup),
    SearchInfo: Object.fromEntries(
      documentSearchFields.map((key) => [key, labelString(source['SearchInfo.' + key] ?? search?.[key])]),
    ) as DocumentState['SearchInfo'],
  };
}
const halfWidth = (value: string) =>
  value
    .replace(/[！＃＄％＆（）＊＋，－．／０-９：；＜＝＞？＠Ａ-Ｚ［］＾＿｀ａ-ｚ｛｜｝～]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 65248),
    )
    .replace(/\u3000/g, ' ');
export function documentDate(date: string, time: string): string | null {
  if (!date.trim()) return null;
  const match = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(date.trim());
  if (!match) throw new LabelValidationError('SearchInfo', pageText['Invalid date. Use yyyy/MM/dd.']);
  const year = Number(match[1]),
    month = Number(match[2]),
    day = Number(match[3]);
  const check = new Date(0);
  check.setUTCFullYear(year, month - 1, day);
  check.setUTCHours(0, 0, 0, 0);
  if (year < 1 || check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day)
    throw new LabelValidationError('SearchInfo', pageText['Invalid date.']);
  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(time.trim());
  const valid = clock && Number(clock[1]) < 24 && Number(clock[2]) < 60 && Number(clock[3] ?? 0) < 60;
  return `${match[1]}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')} ${valid ? `${clock[1].padStart(2, '0')}:${clock[2]}:${clock[3] ?? '00'}` : '00:00:00'}`;
}
export function documentQuery(state: DocumentState, settings: DocumentSettings, user: string) {
  const values: unknown[] = [user];
  const bind = (value: unknown) => {
    values.push(value);
    return '$' + values.length;
  };
  const groups = 'SELECT group_id FROM mst_group_affiation WHERE user_id=$1';
  const selected = state.ApprovalStatus !== '-1';
  const where = [
    `EXISTS (SELECT 1 FROM rep_role rl WHERE rl.rep_top_id=a.rep_top_id AND rl.role_rep_read>0
    ${state.ApprovalStatus === '1' ? 'AND rl.role_rep_update>0' : ''} AND rl.group_id IN (${groups}))`,
  ];
  const label = state.LabelID || (settings.initLoad ? (settings.allDisplay ? 'All' : 'NoLabel') : '-1');
  if (label === 'Trash') where.push('a.deleted=1');
  else {
    where.push('a.deleted=0', 'EXISTS (SELECT 1 FROM rep_current c WHERE c.rep_top_id=a.rep_top_id)');
    if (label === 'NoLabel') where.push('NOT EXISTS (SELECT 1 FROM rep_label l WHERE l.rep_top_id=a.rep_top_id)');
    else if (label !== 'All') {
      const parameter = bind(labelInteger(label));
      where.push(
        `EXISTS (SELECT 1 FROM rep_label l WHERE l.rep_top_id=a.rep_top_id AND l.mst_label_id ${
          state.IsLabelUnderSearch
            ? `IN (WITH RECURSIVE tree AS (SELECT mst_label_id FROM mst_label_rep WHERE mst_label_id=${parameter} UNION SELECT m.mst_label_id FROM mst_label_rep m JOIN tree ON m.upper_label_id=tree.mst_label_id) SELECT mst_label_id FROM tree)`
            : '=' + parameter
        })`,
      );
    }
  }
  if (selected) {
    const cluster = settings.approvalMode ? 'rep_cluster_approval' : 'rep_cluster';
    const role = settings.approvalMode ? 'rep_cluster_role_approval' : 'rep_cluster_role';
    const condition = {
      '0': 'a.edit_refer_status IN (2,3)',
      '1': `a.edit_refer_status=2 AND e.input_value='2' AND e.applicant IS NOT NULL AND EXISTS
        (SELECT 1 FROM ${role} cr WHERE cr.rep_sheet_id=e.rep_sheet_id AND cr.cluster_id=e.cluster_id AND cr.group_id IN (${groups}))`,
      '2': "a.edit_refer_status=3 AND e.input_value='3' AND e.applicant=$1",
      '3': 'a.edit_refer_status=2 AND e.applicant=$1',
    }[state.ApprovalStatus];
    where.push(`EXISTS (SELECT 1 FROM ${cluster} e JOIN rep_sheet sh USING(rep_sheet_id)
      WHERE sh.rep_top_id=a.rep_top_id AND e.cluster_type='Approve' AND ${condition})`);
  }
  for (const [value, column] of [
    [state.PublicStatus, 'public_status'],
    [state.EditReferStatus, 'edit_refer_status'],
  ])
    if (value !== '-1') where.push(`a.${column}=${bind(Number(value))}`);
  const types = [...(state.ReportTypeSheet ? [1] : []), ...(state.ReportTypeSet ? [2] : [])];
  where.push(types.length ? `a.report_type=ANY(${bind(types)}::int[])` : 'a.report_type NOT IN (1,2)');
  const search = state.SearchInfo;
  if (search.ReportId.trim()) {
    if (
      !/^[+-]?\d+$/.test(search.ReportId.trim()) ||
      !Number.isSafeInteger(Number(search.ReportId)) ||
      Math.abs(Number(search.ReportId)) > 2147483647
    )
      where.push('1=2');
    else where.push(`a.rep_top_id=${bind(Number(search.ReportId))}`);
  }
  for (const [field, columns] of [
    ['ReportName', ['rep_top_name']],
    ['Remarks', Array.from({ length: 10 }, (_, i) => 'top_remarks' + (i + 1))],
    ['SystemKey', Array.from({ length: 5 }, (_, i) => 'system_key' + (i + 1))],
  ] as const) {
    if (!search[field].trim()) continue;
    for (const word of halfWidth(search[field])
      .replace(/(\s)\1{1,}/g, ' ')
      .trim()
      .split(' ')) {
      const parameter = bind('%' + word + '%');
      where.push(
        '(' +
          columns
            .map(
              (column) =>
                `${field === 'SystemKey' ? `a.${column}` : `convert_full2half(a.${column})`} ILIKE ${parameter}`,
            )
            .join(' OR ') +
          ')',
      );
    }
  }
  if (settings.inputValue && search.InputValue.trim())
    for (const word of halfWidth(search.InputValue)
      .replace(/(\s)\1{1,}/g, ' ')
      .trim()
      .split(' '))
      where.push(`EXISTS (SELECT 1 FROM rep_cluster e JOIN rep_sheet sh USING(rep_sheet_id) WHERE sh.rep_top_id=a.rep_top_id
      AND convert_full2half(e.input_value) ILIKE ${bind('%' + word + '%')} AND e.cluster_type NOT IN ('FixedText','FreeText','Image','DrawingImage','Create','Inspect','Approve'))`);
  for (const [field, column] of [
    ['RegistUser', 'sys_regist_user'],
    ['UpdateUser', 'sys_update_user'],
  ] as const)
    if (search[field].trim()) {
      const parameter = bind('%' + halfWidth(search[field]) + '%');
      where.push(`(convert_full2half(a.${column}) ILIKE ${parameter} OR convert_full2half(a.${column}_name) ILIKE ${parameter}
        OR EXISTS (SELECT 1 FROM mst_user u WHERE u.user_id=a.${column} AND convert_full2half(u.user_name) ILIKE ${parameter}))`);
    }
  for (const [field, column] of [
    ['Regist', 'sys_regist_time'],
    ['Update', 'sys_update_time'],
  ] as const)
    for (const edge of ['From', 'To'] as const) {
      const date = documentDate(search[`${field}Date${edge}`], search[`${field}Time${edge}`]);
      if (date) where.push(`a.${column}${edge === 'From' ? '>=' : '<='}${bind(date)}::timestamp`);
    }
  return { from: 'FROM rep_top a WHERE ' + where.join(' AND '), values, label };
}
export async function documentList(db: Database, state: DocumentState, settings: DocumentSettings, user: string) {
  const query = documentQuery(state, settings, user);
  const total = settings.noCount
    ? settings.virtualCount
    : Number((await db.query(`SELECT COUNT(*) AS total ${query.from}`, query.values)).rows[0].total);
  const values = [...query.values, state.PageSize, state.PageIndex * state.PageSize];
  const rows = (
    await db.query(
      `SELECT a.rep_top_id,CASE WHEN COALESCE(TRIM(a.rep_top_name),'')='' THEN '...' ELSE a.rep_top_name END AS rep_top_name,
    COALESCE(a.rep_top_org,a.rep_top_id) AS rep_top_org,COALESCE(a.rev_no,1) AS rev_no,a.top_remarks1,a.edit_refer_status::integer AS edit_refer_status,
    to_char(a.sys_regist_time,'YYYY/MM/DD HH24:MI') AS registered,
    COALESCE(NULLIF(a.sys_regist_user_name,''),NULLIF((SELECT user_name FROM mst_user WHERE user_id=a.sys_regist_user),''),a.sys_regist_user) AS created_by,
    to_char(a.sys_update_time,'YYYY/MM/DD HH24:MI') AS updated,to_char(a.sys_update_time,'YYYY/MM/DD HH24:MI:SS') AS update_time,
    COALESCE(NULLIF(a.sys_update_user_name,''),NULLIF((SELECT user_name FROM mst_user WHERE user_id=a.sys_regist_user),''),a.sys_update_user) AS updated_by,
    EXISTS (SELECT 1 FROM rep_lock l WHERE l.rep_top_id=a.rep_top_id AND l.user_id IS NOT NULL AND l.user_id<>'0') AS locked,
    COALESCE((SELECT MAX(role_rep_update) FROM rep_role rl WHERE rl.rep_top_id=a.rep_top_id AND rl.group_id IN (SELECT group_id FROM mst_group_affiation WHERE user_id=$1)),0) AS role_update,
    COALESCE((SELECT MAX(role_rep_delete) FROM rep_role rl WHERE rl.rep_top_id=a.rep_top_id AND rl.group_id IN (SELECT group_id FROM mst_group_affiation WHERE user_id=$1)),0) AS role_delete,
    EXISTS (SELECT 1 FROM rep_cluster cl JOIN rep_cluster_role cr USING(rep_sheet_id,cluster_id) JOIN rep_sheet sh USING(rep_sheet_id)
      WHERE sh.rep_top_id=a.rep_top_id AND cl.cluster_type='Approve' AND cl.input_value='2' AND cr.group_id IN (SELECT group_id FROM mst_group_affiation WHERE user_id=$1)) AS approve,
    REPLACE(a.auto_numbering_value,'{SAVE_COUNT}',COALESCE(a.auto_numbering_display_save_count,'')) AS auto_numbering_value,a.auto_numbering_message,
    COALESCE((SELECT json_agg(m.label_name ORDER BY m.diplay_number) FROM rep_label l JOIN mst_label_rep m USING(mst_label_id) WHERE l.rep_top_id=a.rep_top_id),'[]'::json) AS labels
    ${query.from} ORDER BY a.${state.SortColumn.toLowerCase()} ${state.SortDirection}
    LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    )
  ).rows;
  return { rows, total, pages: Math.ceil(total / state.PageSize), state: { ...state, LabelID: query.label } };
}
