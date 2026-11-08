import { licenseStatus } from '../../../shared/license-counts.js';
import type { Express, Request, Response } from 'express';
import type pg from 'pg';
import { hostname } from 'node:os';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { hasSystemPermission } from '../../../middleware/manager/system/permissions.js';

type FormValues = Record<string, unknown>;
type Settings = {
  Url: string;
  EndpointCreateDefReplication: string;
  Tenant: string;
  MbId: string;
  RealtimeLinkageEnabled: string;
  IsNew: boolean;
  act: string;
};
type Filters = {
  SendTimeFrom: string;
  SendTimeFromHour: string;
  SendTimeTo: string;
  SendTimeToHour: string;
  StatusSuccess: boolean;
  StatusFailure: boolean;
  StatusRetrying: boolean;
  IreporterUser: string;
  RepTopId: string;
  RepTopName: string;
};
type PageSettings = {
  pageSizeOptions: { value: number; text: string }[];
  defaultPageSize: number;
  limitOfDownloadCount: number;
};
type LogRow = {
  log_id: string;
  status: number;
  rep_top_id: number;
  rep_top_name: string;
  view_name: string;
  error_message: string;
  sys_update_time_display: string;
  sys_update_user: string;
  sys_update_user_name: string;
};
type PageState = { pageIndex: number; pageSize: number; sortColumn: string; sortDirection: 'ASC' | 'DESC' };
type MbCloudGateState = 'available' | 'denied' | 'unavailable';

const root = '/ConMasManager/System';
const SETTING_KEY = 'mbcloud';
const SERVER_ERROR = 'Server error has been occurred.';
const ROLE_ERROR = 'Role authority is insufficient.';
const FEATURE_GATE_ERROR = 'License information is unavailable.';
function mbCloudGateState(): MbCloudGateState {
  try {
    return licenseStatus().freeDrawOnly ? 'denied' : 'available';
  } catch {
    return 'unavailable';
  }
}

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: false });
const builder = new XMLBuilder({ ignoreAttributes: false, format: true });
const sortableColumns: Record<string, string> = {
  sys_update_time: 'log.sys_update_time',
  status: 'log.status',
  sys_update_user: 'log.sys_update_user',
  rep_top_id: 'log.rep_top_id',
  rep_top_name: 'log.rep_top_name',
  view_name: 'log.view_name',
  error_message: 'log.error_message',
};

function value(source: FormValues, key: string): string {
  const raw = source[key];
  if (Array.isArray(raw)) {
    const last = raw[raw.length - 1];
    return typeof last === 'string' ? last : '';
  }
  return typeof raw === 'string' ? raw : '';
}

function checked(source: FormValues, key: string, fallback: boolean): boolean {
  const raw = source[key];
  if (raw === undefined) return fallback;
  const candidate = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  return candidate === 'true' || candidate === 'on' || candidate === '1';
}

function emptySettings(): Settings {
  return {
    Url: '',
    EndpointCreateDefReplication: '',
    Tenant: '',
    MbId: '',
    RealtimeLinkageEnabled: '0',
    IsNew: true,
    act: '',
  };
}

function cloudNode(xml: string): Record<string, unknown> {
  const document = parser.parse(xml) as Record<string, unknown>;
  const node = document.conmas;
  if (!node || typeof node !== 'object' || Array.isArray(node))
    throw new Error('Invalid MotionBoard Cloud settings XML.');
  return node as Record<string, unknown>;
}

function xmlText(node: Record<string, unknown>, key: string): string {
  const raw = node[key];
  if (raw === undefined || raw === null || typeof raw === 'object') return '';
  return String(raw);
}

export function parseMbCloudSettingXml(xml: string | null): Settings {
  if (!xml) return emptySettings();
  const node = cloudNode(xml);
  return {
    Url: xmlText(node, 'url'),
    EndpointCreateDefReplication: xmlText(node, 'endpointCreateDefReplication'),
    Tenant: xmlText(node, 'tenant'),
    MbId: xmlText(node, 'id'),
    RealtimeLinkageEnabled: xmlText(node, 'realtimeLinkageEnabled') === '0' ? '0' : '1',
    IsNew: false,
    act: '',
  };
}

export function validateMbCloudSettings(settings: Settings, password: string): string {
  if (!settings.Url.trim()) return 'Please enter URI.';
  if (!settings.EndpointCreateDefReplication.trim()) return 'Please enter URI.';
  if (!settings.Tenant.trim()) return 'Please enter tenant.';
  if (!settings.MbId.trim()) return 'Please enter ID.';
  if (settings.IsNew && !password) return 'Please enter Password.';
  if (!['0', '1'].includes(settings.RealtimeLinkageEnabled)) return 'Select Yes or No for Realtime data connection.';
  return '';
}

export function serializeMbCloudSettingXml(xml: string | null, settings: Settings, password: string): string {
  const node = xml ? cloudNode(xml) : {};
  node.url = settings.Url;
  node.endpointCreateDefReplication = settings.EndpointCreateDefReplication;
  node.tenant = settings.Tenant;
  node.id = settings.MbId;
  if (password) node.password = password;
  node.realtimeLinkageEnabled = settings.RealtimeLinkageEnabled;
  return builder.build({ conmas: node });
}

export function readMbCloudFilters(source: FormValues, isGet: boolean): Filters {
  const prefix = 'WhereData.';
  return {
    SendTimeFrom: value(source, `${prefix}SendTimeFrom`),
    SendTimeFromHour: value(source, `${prefix}SendTimeFromHour`),
    SendTimeTo: value(source, `${prefix}SendTimeTo`),
    SendTimeToHour: value(source, `${prefix}SendTimeToHour`),
    StatusSuccess: checked(source, `${prefix}StatusSuccess`, isGet),
    StatusFailure: checked(source, `${prefix}StatusFailure`, isGet),
    StatusRetrying: checked(source, `${prefix}StatusRetrying`, isGet),
    IreporterUser: value(source, `${prefix}IreporterUser`),
    RepTopId: value(source, `${prefix}RepTopId`),
    RepTopName: value(source, `${prefix}RepTopName`),
  };
}

function parseDate(input: string): string | null {
  const raw = input.trim();
  let match = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  let year: number;
  let month: number;
  let day: number;
  if (match) {
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  } else {
    match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!match) return null;
    month = Number(match[1]);
    day = Number(match[2]);
    year = Number(match[3]);
  }
  if (year < 1000 || year > 9999 || month < 1 || month > 12) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseTime(input: string): string | null {
  if (!input.trim()) return '00:00:00';
  const match = input.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? 0);
  const suffix = match[4]?.toUpperCase();
  if (suffix) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (suffix === 'PM' ? 12 : 0);
  }
  if (hour > 23 || minute > 59 || second > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
}

function dateTimeFilter(dateInput: string, timeInput: string): string | null {
  if (!dateInput.trim()) return null;
  const date = parseDate(dateInput);
  const time = parseTime(timeInput);
  return date && time ? `${date} ${time}` : null;
}

function replaceFullWidth(value: string): string {
  return value
    .replace(/[！＃＄％＆（）＊＋，－．／０-９：；＜＝＞？＠Ａ-Ｚ［］＾＿｀ａ-ｚ｛｜｝～]/g, (character) =>
      String.fromCharCode(character.charCodeAt(0) - 65248),
    )
    .replace(/\u3000/g, ' ');
}

export function buildMbCloudWhere(filters: Filters): { sql: string; parameters: unknown[]; error: string } {
  const clauses: string[] = [];
  const parameters: unknown[] = [];
  const add = (clause: (index: number) => string, parameter: unknown) => {
    parameters.push(parameter);
    clauses.push(clause(parameters.length));
  };
  const from = dateTimeFilter(filters.SendTimeFrom, filters.SendTimeFromHour);
  const to = dateTimeFilter(filters.SendTimeTo, filters.SendTimeToHour);
  if (filters.SendTimeFrom.trim() && !from)
    return { sql: '', parameters: [], error: 'Enter a valid send date and time.' };
  if (filters.SendTimeTo.trim() && !to) return { sql: '', parameters: [], error: 'Enter a valid send date and time.' };
  if (from) add((index) => `log.sys_update_time >= $${index}::timestamp`, from);
  if (to) add((index) => `log.sys_update_time <= $${index}::timestamp`, to);
  const statuses = [
    filters.StatusSuccess ? 0 : null,
    filters.StatusFailure ? 1 : null,
    filters.StatusRetrying ? 2 : null,
  ].filter((status): status is number => status !== null);
  if (statuses.length > 0 && statuses.length < 3) add((index) => `log.status = ANY($${index}::numeric[])`, statuses);
  const user = replaceFullWidth(filters.IreporterUser);
  if (user)
    add(
      (index) => `(convert_full2half(log.sys_update_user) ILIKE $${index} OR EXISTS (
    SELECT 1 FROM mst_user uu WHERE log.sys_update_user = uu.user_id
      AND convert_full2half(uu.user_name) ILIKE $${index}
  ))`,
      `%${user}%`,
    );
  const repTopId = filters.RepTopId.trim();
  if (repTopId) {
    if (
      !/^[+-]?\d+$/.test(repTopId) ||
      !Number.isSafeInteger(Number(repTopId)) ||
      Number(repTopId) < -2147483648 ||
      Number(repTopId) > 2147483647
    ) {
      return { sql: '', parameters: [], error: 'Document ID must be an integer.' };
    }
    add((index) => `log.rep_top_id = $${index}`, Number(repTopId));
  }
  const repTopName = replaceFullWidth(filters.RepTopName);
  if (repTopName) add((index) => `convert_full2half(log.rep_top_name) ILIKE $${index}`, `%${repTopName}%`);
  return { sql: clauses.length ? clauses.join(' AND ') : '1=1', parameters, error: '' };
}

function readPageState(source: FormValues, settings: PageSettings): PageState {
  const requestedSize = Number(value(source, 'PageData.PageSize'));
  const pageSize = settings.pageSizeOptions.some((option) => option.value === requestedSize)
    ? requestedSize
    : settings.defaultPageSize;
  const requestedIndex = Number(value(source, 'PageData.PageIndex'));
  const pageIndex = Number.isSafeInteger(requestedIndex) && requestedIndex >= 0 ? Math.min(requestedIndex, 10000) : 0;
  const requestedColumn = value(source, 'PageData.SortColumn').toLowerCase();
  const sortColumn = Object.hasOwn(sortableColumns, requestedColumn) ? requestedColumn : 'sys_update_time';
  const requestedDirection = value(source, 'PageData.SortDirection').toUpperCase();
  const sortDirection = requestedDirection === 'ASC' ? 'ASC' : 'DESC';
  return { pageIndex, pageSize, sortColumn, sortDirection };
}

async function loadPageSettings(db: pg.Pool): Promise<PageSettings> {
  const [defaultResult, sizesResult, limitResult] = await Promise.all([
    db.query<{ com_value: string }>(
      "SELECT com_value FROM mst_common WHERE com_key='DEFAULT_PAGE_SIZE' ORDER BY com_index LIMIT 1",
    ),
    db.query<{ com_value: string; com_name: string }>(
      "SELECT com_value,com_name FROM mst_common WHERE com_key='PAGE_SIZE' ORDER BY com_index",
    ),
    db.query<{ com_value: string }>(
      "SELECT com_value FROM mst_common WHERE com_key='CSV_DOWNLOAD_SETTING' AND com_name='LIMIT_OF_DOWNLOAD_COUNT' ORDER BY com_index LIMIT 1",
    ),
  ]);
  const options = sizesResult.rows
    .map((row) => ({ value: Number(row.com_value), text: row.com_name }))
    .filter((option) => Number.isSafeInteger(option.value) && option.value > 0 && option.value <= 10000);
  const uniqueOptions = options.filter(
    (option, index) => options.findIndex((other) => other.value === option.value) === index,
  );
  const defaultValue = Number(defaultResult.rows[0]?.com_value);
  const defaultPageSize =
    Number.isSafeInteger(defaultValue) && defaultValue > 0 && defaultValue <= 10000
      ? defaultValue
      : (uniqueOptions[0]?.value ?? 20);
  if (!uniqueOptions.length) uniqueOptions.push({ value: defaultPageSize, text: String(defaultPageSize) });
  if (!uniqueOptions.some((option) => option.value === defaultPageSize))
    uniqueOptions.push({ value: defaultPageSize, text: String(defaultPageSize) });
  const configuredLimit = Number(limitResult.rows[0]?.com_value);
  return {
    pageSizeOptions: uniqueOptions,
    defaultPageSize,
    limitOfDownloadCount: Number.isSafeInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : 0,
  };
}

function selectedLogIds(source: FormValues): string[] {
  const ids: string[] = [];
  for (let index = 0; index < 10000; index++) {
    const id = value(source, `SendLogList[${index}].LogId`);
    if (!id) break;
    const selected = checked(source, `SendLogList[${index}].IsSelect`, false);
    if (selected && id.length <= 128 && !Array.from(id).some((character) => character.charCodeAt(0) < 32)) ids.push(id);
  }
  return [...new Set(ids)];
}

export function mbCloudLogCsv(rows: LogRow[], limit: number): string {
  const lines = [
    [
      'Send date and time',
      'Status',
      'i-Reporter users',
      'Document ID',
      'Form name',
      'View physical name',
      'Error message',
    ]
      .map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`)
      .join(','),
  ];
  const output = limit > 0 ? rows.slice(0, limit) : rows;
  for (const row of output) {
    const status = row.status === 0 ? 'Succeeded to send' : row.status === 1 ? 'Failed to send' : 'Retrying to send';
    lines.push(
      [
        row.sys_update_time_display,
        status,
        `${row.sys_update_user}:${row.sys_update_user_name}`,
        row.rep_top_id,
        row.rep_top_name,
        row.view_name,
        row.error_message,
      ]
        .map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`)
        .join(','),
    );
  }
  if (limit > 0 && rows.length > limit) lines.push('"Truncated to ' + limit.toLocaleString('en-US') + ' records."');
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function show(
  res: Response,
  render: (res: Response, data: Record<string, unknown>) => unknown,
  page: Record<string, unknown>,
  section: 'MbCloudSetting' | 'MbCloudSendLog',
  title: string,
) {
  return render(res, {
    active: 'System',
    section,
    login: false,
    title,
    userName: res.locals.userName,
    mbCloudPage: page,
  });
}

function showSettings(
  res: Response,
  render: (res: Response, data: Record<string, unknown>) => unknown,
  model: Settings,
  error: string,
  permissions: { canEdit: boolean; canDelete: boolean },
) {
  return show(
    res,
    render,
    { kind: 'setting', model, error, ...permissions },
    'MbCloudSetting',
    'MotionBoard Cloud linkage setting',
  );
}

function showLogs(
  res: Response,
  render: (res: Response, data: Record<string, unknown>) => unknown,
  page: Record<string, unknown>,
) {
  return show(res, render, { kind: 'sendLog', ...page }, 'MbCloudSendLog', 'MotionBoard Cloud linkage log');
}

function showRoleError(
  res: Response,
  render: (res: Response, data: Record<string, unknown>) => unknown,
  section: 'MbCloudSetting' | 'MbCloudSendLog',
  title: string,
) {
  return show(res.status(403), render, { kind: 'forbidden', error: ROLE_ERROR }, section, title);
}
function showLicenseGateUnavailable(
  res: Response,
  render: (res: Response, data: Record<string, unknown>) => unknown,
  section: 'MbCloudSetting' | 'MbCloudSendLog',
  title: string,
) {
  return show(res.status(503), render, { kind: 'forbidden', error: FEATURE_GATE_ERROR }, section, title);
}

async function getSetting(db: pg.Pool): Promise<{ xml: string | null; model: Settings }> {
  const result = await db.query<{ xml_data: string }>('SELECT xml_data FROM mst_external_linkage WHERE key=$1', [
    SETTING_KEY,
  ]);
  const xml = result.rows[0]?.xml_data ?? null;
  return { xml, model: parseMbCloudSettingXml(xml) };
}

function readSettings(source: FormValues, isNew: boolean): Settings {
  return {
    Url: value(source, 'Url'),
    EndpointCreateDefReplication: value(source, 'EndpointCreateDefReplication'),
    Tenant: value(source, 'Tenant'),
    MbId: value(source, 'MbId'),
    RealtimeLinkageEnabled: value(source, 'RealtimeLinkageEnabled'),
    IsNew: isNew,
    act: value(source, 'act'),
  };
}

async function capabilities(db: pg.Pool, userId: string) {
  const [canEdit, canDelete] = await Promise.all([
    hasSystemPermission(db, userId, 'system', 'edit'),
    hasSystemPermission(db, userId, 'system', 'delete'),
  ]);
  return { canEdit, canDelete };
}

async function renderLogList(
  res: Response,
  db: pg.Pool,
  render: (res: Response, data: Record<string, unknown>) => unknown,
  userId: string,
  source: FormValues,
  isGet: boolean,
  action: string,
  error = '',
) {
  const settings = await loadPageSettings(db);
  const filters = readMbCloudFilters(source, isGet);
  const state =
    action === 'SearchType'
      ? {
          pageIndex: 0,
          pageSize: settings.defaultPageSize,
          sortColumn: 'sys_update_time',
          sortDirection: 'DESC' as const,
        }
      : readPageState(source, settings);
  const [canDelete, canResend] = await Promise.all([
    hasSystemPermission(db, userId, 'system', 'delete'),
    hasSystemPermission(db, userId, 'system', 'edit'),
  ]);
  const where = buildMbCloudWhere(filters);
  if (where.error) {
    return showLogs(res.status(400), render, {
      filters,
      rows: [],
      total: 0,
      ...state,
      totalPages: 0,
      ...settings,
      canDelete,
      canResend,
      error: where.error,
    });
  }
  const count = await db.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM conmas_mbcloud_send_log log WHERE ${where.sql}`,
    where.parameters,
  );
  const total = Number(count.rows[0]?.total ?? 0);
  const totalPages = Math.ceil(total / state.pageSize);
  const pageIndex = totalPages ? Math.min(state.pageIndex, totalPages - 1) : 0;
  const order = `${sortableColumns[state.sortColumn]} ${state.sortDirection}, log.log_id`;
  const parameters = [...where.parameters, state.pageSize, pageIndex * state.pageSize];
  const result = await db.query<LogRow>(
    `SELECT log.log_id, log.status, log.rep_top_id, log.rep_top_name,
      log.view_name, coalesce(log.error_message,'') AS error_message,
      to_char(log.sys_update_time,'YYYY/MM/DD HH24:MI:SS') AS sys_update_time_display,
      log.sys_update_user, coalesce(u.user_name,'') AS sys_update_user_name
    FROM conmas_mbcloud_send_log log
    LEFT OUTER JOIN mst_user u ON log.sys_update_user = u.user_id
    WHERE ${where.sql}
    ORDER BY ${order}
    LIMIT $${parameters.length - 1} OFFSET $${parameters.length}`,
    parameters,
  );
  return showLogs(res, render, {
    filters,
    rows: result.rows.map((row) => ({ ...row, status: Number(row.status) })),
    total,
    pageIndex,
    pageSize: state.pageSize,
    sortColumn: state.sortColumn,
    sortDirection: state.sortDirection,
    totalPages,
    ...settings,
    canDelete,
    canResend,
    error,
  });
}

function logErrorPage(
  res: Response,
  render: (res: Response, data: Record<string, unknown>) => unknown,
  source: FormValues,
  isGet: boolean,
  error: unknown,
) {
  console.error(error);
  return showLogs(res.status(500), render, {
    filters: readMbCloudFilters(source, isGet),
    rows: [],
    total: 0,
    pageIndex: 0,
    pageSize: 20,
    sortColumn: 'sys_update_time',
    sortDirection: 'DESC',
    totalPages: 0,
    pageSizeOptions: [{ value: 20, text: '20' }],
    limitOfDownloadCount: 0,
    canDelete: false,
    canResend: false,
    error: SERVER_ERROR,
  });
}

export function registerMbCloud(
  app: Express,
  db: pg.Pool,
  render: (res: Response, data: Record<string, unknown>) => unknown,
) {
  app.get(`${root}/MbCloudSetting`, async (req: Request, res: Response) => {
    const title = 'MotionBoard Cloud linkage setting';
    try {
      const userId = req.session?.userId ?? '';
      if (!(await hasSystemPermission(db, userId, 'system', 'read')))
        return showRoleError(res, render, 'MbCloudSetting', title);
      if (value(req.query, 'act') === 'edit' && !(await hasSystemPermission(db, userId, 'system', 'edit')))
        return showRoleError(res, render, 'MbCloudSetting', title);
      const gate = mbCloudGateState();
      if (gate === 'unavailable') return showLicenseGateUnavailable(res, render, 'MbCloudSetting', title);
      if (gate === 'denied') return showRoleError(res, render, 'MbCloudSetting', title);
      const { model } = await getSetting(db);
      const permissions = await capabilities(db, userId);
      model.act = value(req.query, 'act') === 'edit' && permissions.canEdit ? 'edit' : '';
      return showSettings(res, render, model, '', permissions);
    } catch (error) {
      console.error(error);
      return showSettings(res.status(500), render, emptySettings(), SERVER_ERROR, { canEdit: false, canDelete: false });
    }
  });

  app.post(`${root}/MbCloudSetting`, async (req: Request, res: Response) => {
    const title = 'MotionBoard Cloud linkage setting';
    const userId = req.session?.userId ?? '';
    let model = emptySettings();
    let permissions = { canEdit: false, canDelete: false };
    try {
      if (!(await hasSystemPermission(db, userId, 'system', 'read')))
        return showRoleError(res, render, 'MbCloudSetting', title);
      const action = value(req.body, 'act');
      if (action === 'delete' && !(await hasSystemPermission(db, userId, 'system', 'delete')))
        return showRoleError(res, render, 'MbCloudSetting', title);
      if (action !== 'delete' && !(await hasSystemPermission(db, userId, 'system', 'edit')))
        return showRoleError(res, render, 'MbCloudSetting', title);
      const gate = mbCloudGateState();
      if (gate === 'unavailable') return showLicenseGateUnavailable(res, render, 'MbCloudSetting', title);
      if (gate === 'denied') return showRoleError(res, render, 'MbCloudSetting', title);
      const current = await getSetting(db);
      model = readSettings(req.body, current.model.IsNew);
      permissions = await capabilities(db, userId);
      if (action === 'delete') {
        if (!(await hasSystemPermission(db, userId, 'system', 'delete')))
          return showRoleError(res, render, 'MbCloudSetting', title);
        await db.query('DELETE FROM mst_external_linkage WHERE key=$1', [SETTING_KEY]);
        return res.redirect(`${root}/MbCloudSetting`);
      }
      if (!(await hasSystemPermission(db, userId, 'system', 'edit')))
        return showRoleError(res, render, 'MbCloudSetting', title);
      const password = value(req.body, current.model.IsNew ? 'Password' : 'PasswordEdit');
      const error = validateMbCloudSettings(model, password);
      if (error) return showSettings(res.status(400), render, model, error, permissions);
      const xml = serializeMbCloudSettingXml(current.xml, model, password);
      const term = hostname();
      await db.query(
        `INSERT INTO mst_external_linkage
          (key,xml_data,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time)
        VALUES ($1,$2,$3,$4,now(),$3,$4,now())
        ON CONFLICT (key) DO UPDATE SET xml_data=EXCLUDED.xml_data,
          sys_update_term=EXCLUDED.sys_update_term,sys_update_user=EXCLUDED.sys_update_user,sys_update_time=now()`,
        [SETTING_KEY, xml, term, userId],
      );
      return res.redirect(`${root}/MbCloudSetting`);
    } catch (error) {
      console.error(error);
      return showSettings(res.status(500), render, model, SERVER_ERROR, permissions);
    }
  });

  app.get(`${root}/MbCloudSendLog`, async (req: Request, res: Response) => {
    try {
      const userId = req.session?.userId ?? '';
      if (!(await hasSystemPermission(db, userId, 'system', 'read')))
        return showRoleError(res, render, 'MbCloudSendLog', 'MotionBoard Cloud linkage log');
      const gate = mbCloudGateState();
      if (gate === 'unavailable')
        return showLicenseGateUnavailable(res, render, 'MbCloudSendLog', 'MotionBoard Cloud linkage log');
      if (gate === 'denied') return showRoleError(res, render, 'MbCloudSendLog', 'MotionBoard Cloud linkage log');
      return await renderLogList(res, db, render, userId, {}, true, '');
    } catch (error) {
      return logErrorPage(res, render, {}, true, error);
    }
  });

  app.post(`${root}/MbCloudSendLog`, async (req: Request, res: Response) => {
    const source = req.body as FormValues;
    const action = value(source, 'ActionCommonType');
    try {
      const userId = req.session?.userId ?? '';
      if (!(await hasSystemPermission(db, userId, 'system', 'read')))
        return showRoleError(res, render, 'MbCloudSendLog', 'MotionBoard Cloud linkage log');
      if (action === 'DeleteType' && !(await hasSystemPermission(db, userId, 'system', 'delete')))
        return showRoleError(res, render, 'MbCloudSendLog', 'MotionBoard Cloud linkage log');
      if (value(source, 'ResendLogId') && !(await hasSystemPermission(db, userId, 'system', 'edit')))
        return showRoleError(res, render, 'MbCloudSendLog', 'MotionBoard Cloud linkage log');
      const gate = mbCloudGateState();
      if (gate === 'unavailable')
        return showLicenseGateUnavailable(res, render, 'MbCloudSendLog', 'MotionBoard Cloud linkage log');
      if (gate === 'denied') return showRoleError(res, render, 'MbCloudSendLog', 'MotionBoard Cloud linkage log');
      if (action === 'CsvType') {
        const settings = await loadPageSettings(db);
        const filters = readMbCloudFilters(source, false);
        const pageState = readPageState(source, settings);
        const where = buildMbCloudWhere(filters);
        if (where.error)
          return await renderLogList(res.status(400), db, render, userId, source, false, '', where.error);
        const order = `${sortableColumns[pageState.sortColumn]} ${pageState.sortDirection}, log.log_id`;
        const parameters = [...where.parameters];
        const limit = settings.limitOfDownloadCount;
        const limitClause = limit > 0 ? ` LIMIT $${parameters.push(limit + 1)}` : '';
        const result = await db.query<LogRow>(
          `SELECT log.log_id, log.status, log.rep_top_id, log.rep_top_name,
            log.view_name, coalesce(log.error_message,'') AS error_message,
            to_char(log.sys_update_time,'YYYY/MM/DD HH24:MI:SS') AS sys_update_time_display,
            log.sys_update_user, coalesce(u.user_name,'') AS sys_update_user_name
          FROM conmas_mbcloud_send_log log
          LEFT OUTER JOIN mst_user u ON log.sys_update_user = u.user_id
          WHERE ${where.sql} ORDER BY ${order}${limitClause}`,
          parameters,
        );
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="mbCloudSendLog.csv"');
        return res.send(
          Buffer.from(
            mbCloudLogCsv(
              result.rows.map((row) => ({ ...row, status: Number(row.status) })),
              limit,
            ),
            'utf8',
          ),
        );
      }
      if (action === 'DeleteType') {
        if (!(await hasSystemPermission(db, userId, 'system', 'delete')))
          return showRoleError(res, render, 'MbCloudSendLog', 'MotionBoard Cloud linkage log');
        const ids = selectedLogIds(source);
        if (!ids.length)
          return await renderLogList(
            res.status(400),
            db,
            render,
            userId,
            source,
            false,
            '',
            'Please check on the target logs to be deleted',
          );
        await db.query('DELETE FROM conmas_mbcloud_send_log WHERE log_id = ANY($1::text[])', [ids]);
      } else if (value(source, 'ResendLogId')) {
        if (!(await hasSystemPermission(db, userId, 'system', 'edit')))
          return showRoleError(res, render, 'MbCloudSendLog', 'MotionBoard Cloud linkage log');
        const logId = value(source, 'ResendLogId');
        if (logId.length > 128 || Array.from(logId).some((character) => character.charCodeAt(0) < 32))
          return res.status(400).send('Invalid MotionBoard Cloud log ID.');
        const existing = await db.query<{ log_id: string }>(
          'SELECT log_id FROM conmas_mbcloud_send_log WHERE log_id=$1',
          [logId],
        );
        if (!existing.rowCount) return res.status(404).send('MotionBoard Cloud send log not found.');
        return await renderLogList(
          res.status(503),
          db,
          render,
          userId,
          source,
          false,
          '',
          'Resend requires the legacy report CSV exporter and MotionBoard Cloud upload runtime, which this Node app does not provide.',
        );
      }
      return await renderLogList(
        res,
        db,
        render,
        userId,
        source,
        false,
        action === 'SearchType' ? 'SearchType' : 'PageType',
      );
    } catch (error) {
      return logErrorPage(res, render, source, false, error);
    }
  });
}
