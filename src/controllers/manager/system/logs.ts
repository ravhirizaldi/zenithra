import { licenseStatus } from '../../../shared/license-counts.js';
import type { Express, Request, Response } from 'express';
import type pg from 'pg';
import { hasSystemPermission } from '../../../middleware/manager/system/permissions.js';

type FormValues = Record<string, unknown>;
type LogKind = 'operation' | 'definition' | 'inputReport';
export type SystemLogKind = LogKind;
type SortDirection = 'ASC' | 'DESC';
type Render = (res: Response, data: Record<string, unknown>) => unknown;
type Filters = {
  timeFrom: string;
  timeFromHour: string;
  timeTo: string;
  timeToHour: string;
  operationTypeLogin: boolean;
  operationTypeLogout: boolean;
  appTypeTablet: boolean;
  appTypeApi: boolean;
  appTypeDesigner: boolean;
  appTypeManager: boolean;
  deviceTypeiPad: boolean;
  deviceTypeWindows: boolean;
  deviceTypeiRepoFreeDraw: boolean;
  operationTypeInsert: boolean;
  operationTypeUpdate: boolean;
  operationTypeDelete: boolean;
  userId: string;
  userName: string;
  termId: string;
  physicalId: string;
  termName: string;
  appVersion: string;
  clientName: string;
  clientAddress: string;
  browserName: string;
  formName: string;
};
export type SystemLogFilters = Filters;
type PageState = {
  pageIndex: number;
  pageSize: number;
  sortColumn: string;
  sortDirection: SortDirection;
};
type PageOption = { value: number; text: string };
type LogRecord = Record<string, string | number | null>;

type LogConfig = {
  route: string;
  deleteRoute: string;
  title: string;
  table: string;
  timeColumn: string;
  sorts: Record<string, string>;
  tieBreaker: string;
};

const root = '/ConMasManager/System';
const fallbackPageSizes = [10, 20, 50, 100];
const batchSize = 1000;
const logConfigs: Record<LogKind, LogConfig> = {
  operation: {
    route: 'OperationLog',
    deleteRoute: 'DeleteOperationLog',
    title: 'Login history',
    table: 'conmas_operation_log',
    timeColumn: 'log.log_time',
    tieBreaker: 'log.log_id',
    sorts: {
      log_time: 'log.log_time',
      operation_type: 'log.operation_type',
      operation_content: 'log.operation_content',
      app_type: 'log.app_type',
      device_type: 'log.device_type',
      user_id: 'log.user_id',
      user_name: 'log.user_name',
      term_id: 'log.term_id',
      physical_id: 'log.physical_id',
      term_name: 'log.term_name',
      app_version: 'log.app_version',
      client_host_name: 'log.client_host_name',
      client_ip_address: 'log.client_ip_address',
      browser_name: 'log.browser_name',
    },
  },
  definition: {
    route: 'DefinitionFormOperationLog',
    deleteRoute: 'DeleteDefinitionFormOperationLog',
    title: 'Form operation history',
    table: 'log_def_top',
    timeColumn: 'log.sys_update_time',
    tieBreaker: 'log.def_top_id',
    sorts: {
      log_time: 'log.sys_update_time',
      log_type: 'log.log_type',
      formid: 'log.def_top_id',
      formname: 'log.def_top_name',
      user_id: 'log.sys_update_user',
    },
  },
  inputReport: {
    route: 'InputReportOperationLog',
    deleteRoute: 'DeleteInputReportOperationLog',
    title: 'Input document operation history',
    table: 'log_rep_top',
    timeColumn: 'log.sys_update_time',
    tieBreaker: 'log.rep_top_id',
    sorts: {
      log_time: 'log.sys_update_time',
      log_type: 'log.log_type',
      formid: 'log.rep_top_id',
      formname: 'log.rep_top_name',
      user_id: 'log.sys_update_user',
      autonumberingvalue: 'log.auto_numbering_value',
      autonumberingmessage: 'log.auto_numbering_message',
    },
  },
};

const loginContentLabels: Record<string, string> = {
  LoginAuthError: 'Login authentication error',
  LoginError: 'Login error (Other reasons)',
  LoginLockError: 'Login account lock error',
  LoginSuccess: 'Login succeeded',
  LoginTerminalApplyError: 'Login device unapplied error',
  LoginTerminalApproveError: 'Login device unauthenticated error',
  LoginVersionError: 'Login version error',
  LogoImage: 'Logo image',
  Logout: 'Logout',
  LogoutTimeout: 'Logout timeout',
};

function value(source: FormValues, key: string): string {
  const raw = source[key];
  if (Array.isArray(raw)) {
    const last = raw[raw.length - 1];
    return typeof last === 'string' || typeof last === 'number' ? String(last) : '';
  }
  return typeof raw === 'string' || typeof raw === 'number' ? String(raw) : '';
}

function checked(source: FormValues, key: string, fallback: boolean): boolean {
  if (!(key in source)) return fallback;
  const raw = source[key];
  const candidate = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  return candidate === true || candidate === 'true' || candidate === 'on' || candidate === '1';
}

function readFilters(source: FormValues, kind: LogKind, isGet: boolean): Filters {
  const field = (name: string) => `whereData.SearchChild.${name}`;
  const text = (name: string) => value(source, field(name));
  const flag = (name: string) => checked(source, field(name), isGet);
  return {
    timeFrom: text('TimeFrom'),
    timeFromHour: text('TimeFromHour'),
    timeTo: text('TimeTo'),
    timeToHour: text('TimeToHour'),
    operationTypeLogin: kind === 'operation' ? flag('OperationTypeLogin') : false,
    operationTypeLogout: kind === 'operation' ? flag('OperationTypeLogout') : false,
    appTypeTablet: kind === 'operation' ? flag('AppTypeTablet') : false,
    appTypeApi: kind === 'operation' ? flag('AppTypeApi') : false,
    appTypeDesigner: kind === 'operation' ? flag('AppTypeDesigner') : false,
    appTypeManager: kind === 'operation' ? flag('AppTypeManager') : false,
    deviceTypeiPad: kind === 'operation' ? flag('DeviceTypeiPad') : false,
    deviceTypeWindows: kind === 'operation' ? flag('DeviceTypeWindows') : false,
    deviceTypeiRepoFreeDraw: kind === 'operation' ? flag('DeviceTypeiRepoFreeDraw') : false,
    operationTypeInsert: kind !== 'operation' ? flag('FromOperationTypeInsert') : false,
    operationTypeUpdate: kind !== 'operation' ? flag('FormOperationTypeUpdate') : false,
    operationTypeDelete: kind !== 'operation' ? flag('FormOperationTypeDelete') : false,
    userId: text('UserId'),
    userName: kind === 'operation' ? text('UserName') : '',
    termId: kind === 'operation' ? text('TermId') : '',
    physicalId: kind === 'operation' ? text('PhysicalId') : '',
    termName: kind === 'operation' ? text('TermName') : '',
    appVersion: kind === 'operation' ? text('AppVersion') : '',
    clientName: kind === 'operation' ? text('ClientName') : '',
    clientAddress: kind === 'operation' ? text('ClientAddress') : '',
    browserName: kind === 'operation' ? text('BrowserName') : '',
    formName: kind !== 'operation' ? text('FormName') : '',
  };
}

function parseDate(input: string): string | null {
  const candidate = input.trim();
  let year: number;
  let month: number;
  let day: number;
  let match = candidate.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (match) {
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  } else {
    match = candidate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!match) return null;
    month = Number(match[1]);
    day = Number(match[2]);
    year = Number(match[3]);
  }
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day)
    return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseTime(input: string): string | null {
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
  const date = parseDate(dateInput);
  if (!date) return null;
  return `${date} ${parseTime(timeInput) ?? '00:00:00'}`;
}

export function buildSystemLogWhere(kind: SystemLogKind, filters: SystemLogFilters) {
  const clauses = ['1=1'];
  const parameters: unknown[] = [];
  const add = (build: (index: number) => string, parameter: unknown) => {
    parameters.push(parameter);
    clauses.push(build(parameters.length));
  };
  const addText = (column: string, text: string) => {
    if (text.trim()) add((index) => `log.${column} ILIKE $${index}`, `%${text}%`);
  };
  const addDate = (operator: '>=' | '<=', date: string | null) => {
    if (date)
      add(
        (index) => `log.${kind === 'operation' ? 'log_time' : 'sys_update_time'} ${operator} $${index}::timestamp`,
        date,
      );
  };

  if (kind === 'operation') {
    const operationTypes = [
      filters.operationTypeLogin ? 'Login' : '',
      filters.operationTypeLogout ? 'Logout' : '',
    ].filter(Boolean);
    if (operationTypes.length !== 2) {
      if (operationTypes.length) add((index) => `log.operation_type = ANY($${index}::text[])`, operationTypes);
      else clauses.push(`log.operation_type = ''`);
    }
    const appTypes = [
      filters.appTypeApi ? 'Api' : '',
      filters.appTypeDesigner ? 'Designer' : '',
      filters.appTypeManager ? 'Manager' : '',
    ].filter(Boolean);
    const deviceTypes = [
      filters.deviceTypeiPad ? 'iOS' : '',
      filters.deviceTypeWindows ? 'Windows' : '',
      filters.deviceTypeiRepoFreeDraw ? 'i-Repo FreeDraw' : '',
    ].filter(Boolean);
    if (
      ![
        filters.appTypeTablet,
        filters.appTypeApi,
        filters.appTypeDesigner,
        filters.appTypeManager,
        filters.deviceTypeiPad,
        filters.deviceTypeWindows,
        filters.deviceTypeiRepoFreeDraw,
      ].every(Boolean)
    ) {
      if (appTypes.length && filters.appTypeTablet && deviceTypes.length) {
        const appIndex = parameters.push(appTypes);
        const deviceIndex = parameters.push(deviceTypes);
        clauses.push(
          `(log.app_type = ANY($${appIndex}::text[]) OR (log.app_type = 'Tablet' AND log.device_type = ANY($${deviceIndex}::text[])))`,
        );
      } else if (appTypes.length && (!filters.appTypeTablet || !deviceTypes.length)) {
        add((index) => `log.app_type = ANY($${index}::text[])`, appTypes);
      } else if (!appTypes.length && filters.appTypeTablet && deviceTypes.length) {
        add((index) => `log.app_type = 'Tablet' AND log.device_type = ANY($${index}::text[])`, deviceTypes);
      } else {
        clauses.push(`(log.app_type = '' AND log.device_type = '')`);
      }
    }
    const timeFrom = dateTimeFilter(filters.timeFrom, filters.timeFromHour);
    const timeTo = dateTimeFilter(filters.timeTo, filters.timeToHour);
    addDate('>=', timeFrom);
    addDate('<=', timeTo);
    addText('browser_name', filters.browserName);
    addText('user_id', filters.userId);
    if (timeTo) add((index) => `log.user_name ILIKE $${index}`, `%${filters.userName}%`);
    if (filters.termId.trim()) add((index) => `log.term_id = $${index}`, filters.termId);
    addText('physical_id', filters.physicalId);
    addText('term_name', filters.termName);
    addText('app_version', filters.appVersion);
    addText('client_ip_address', filters.clientAddress);
    addText('client_host_name', filters.clientName);
  } else {
    const nameColumn = kind === 'definition' ? 'def_top_name' : 'rep_top_name';
    addText(nameColumn, filters.formName);
    addText('sys_update_user', filters.userId);
    addDate('>=', dateTimeFilter(filters.timeFrom, filters.timeFromHour));
    addDate('<=', dateTimeFilter(filters.timeTo, filters.timeToHour));
    const operationTypes = [
      filters.operationTypeInsert ? 'I' : '',
      filters.operationTypeUpdate ? 'U' : '',
      filters.operationTypeDelete ? 'D' : '',
    ].filter(Boolean);
    if (operationTypes.length !== 3) {
      if (operationTypes.length) add((index) => `log.log_type = ANY($${index}::text[])`, operationTypes);
      else clauses.push(`log.log_type = ''`);
    }
  }
  return { sql: clauses.join(' AND '), parameters };
}

function readPageState(source: FormValues, kind: LogKind, defaultPageSize: number): PageState {
  const requestedSize = Number(value(source, 'PageData.PageSize'));
  const requestedIndex = Number(value(source, 'PageData.PageIndex'));
  const sortColumn = value(source, 'PageData.SortColumn').toLowerCase();
  const direction = value(source, 'PageData.SortDirection').toUpperCase();
  return {
    pageIndex: Number.isSafeInteger(requestedIndex) && requestedIndex >= 0 ? Math.min(requestedIndex, 10000) : 0,
    pageSize:
      Number.isSafeInteger(requestedSize) && requestedSize > 0 && requestedSize <= 10000
        ? requestedSize
        : defaultPageSize,
    sortColumn: Object.hasOwn(logConfigs[kind].sorts, sortColumn) ? sortColumn : 'log_time',
    sortDirection: direction === 'DESC' ? 'DESC' : 'ASC',
  };
}

function orderClause(kind: LogKind, state: PageState): string {
  const config = logConfigs[kind];
  const primary = `${config.sorts[state.sortColumn] ?? config.timeColumn} ${state.sortDirection}`;
  if (kind !== 'operation' && state.sortColumn === 'formid') return primary;
  return `${primary}, ${config.tieBreaker}`;
}

async function commonValue(db: pg.Pool, key: string, name?: string): Promise<string> {
  const result = name
    ? await db.query<{ com_value: string }>(
        'SELECT com_value FROM mst_common WHERE com_key=$1 AND com_name=$2 ORDER BY com_index LIMIT 1',
        [key, name],
      )
    : await db.query<{ com_value: string }>(
        'SELECT com_value FROM mst_common WHERE com_key=$1 ORDER BY com_index LIMIT 1',
        [key],
      );
  return result.rows[0]?.com_value ?? '';
}

async function loadPageSettings(db: pg.Pool) {
  const [defaultValue, list, downloadValue] = await Promise.all([
    commonValue(db, 'DEFAULT_PAGE_SIZE'),
    db.query<{ com_value: string; com_name: string }>(
      'SELECT com_value,com_name FROM mst_common WHERE com_key=$1 ORDER BY com_index',
      ['PAGE_SIZE'],
    ),
    commonValue(db, 'CSV_DOWNLOAD_SETTING', 'LIMIT_OF_DOWNLOAD_COUNT'),
  ]);
  const pageSizeOptions: PageOption[] = [];
  for (const row of list.rows) {
    const option = { value: Number(row.com_value), text: row.com_name };
    if (
      Number.isSafeInteger(option.value) &&
      option.value > 0 &&
      option.value <= 10000 &&
      !pageSizeOptions.some((item) => item.value === option.value)
    )
      pageSizeOptions.push(option);
  }
  const configuredDefault = Number(defaultValue);
  const defaultPageSize =
    Number.isSafeInteger(configuredDefault) && configuredDefault > 0 && configuredDefault <= 10000
      ? configuredDefault
      : (pageSizeOptions[0]?.value ?? 20);
  if (!pageSizeOptions.length)
    pageSizeOptions.push(...fallbackPageSizes.map((size) => ({ value: size, text: String(size) })));
  const configuredLimit = Number(downloadValue);
  const limitOfDownloadCount =
    Number.isSafeInteger(configuredLimit) && configuredLimit > 0 && configuredLimit <= 2147483647 ? configuredLimit : 0;
  return { pageSizeOptions, defaultPageSize, limitOfDownloadCount };
}

function localizeLoginContent(content: string | null | undefined): string {
  return Object.hasOwn(loginContentLabels, content ?? '') ? loginContentLabels[content ?? ''] : '..';
}

function logSelect(kind: LogKind): string {
  if (kind === 'operation') {
    return `SELECT log.log_id, log.log_time,
      to_char(log.log_time,'FMMM/FMDD/YYYY FMHH12:MI:SS AM') AS log_time_display,
      to_char(log.log_time,'YYYY/MM/DD HH24:MI:SS') AS log_time_csv,
      log.operation_type, log.operation_content, log.app_type,
      log.device_type,
      log.user_id, log.user_name, log.term_id, log.physical_id, log.term_name, log.app_version,
      log.client_host_name, log.client_ip_address, log.browser_name
      FROM conmas_operation_log log`;
  }
  const prefix = kind === 'definition' ? 'def' : 'rep';
  const id = `${prefix}_top_id`;
  const name = `${prefix}_top_name`;
  const autoNumbering = kind === 'inputReport' ? ', log.auto_numbering_value, log.auto_numbering_message' : '';
  return `SELECT log.${id}::text AS form_id, log.${name} AS form_name,
    CASE WHEN log.log_type='D' THEN '' ELSE log.sys_update_user END AS user_id,
    CASE WHEN log.log_type='D' THEN NULL ELSE to_char(log.sys_update_time,'FMMM/FMDD/YYYY FMHH12:MI:SS AM') END AS log_time_display,
    CASE WHEN log.log_type='D' THEN NULL ELSE to_char(log.sys_update_time,'YYYY/MM/DD HH24:MI:SS') END AS log_time_csv,
    CASE log.log_type WHEN 'I' THEN 'Insert' WHEN 'U' THEN 'Update' WHEN 'D' THEN 'Delete' ELSE '' END AS log_type_display${autoNumbering}
    FROM ${logConfigs[kind].table} log`;
}
async function fetchRows(
  db: pg.Pool,
  kind: LogKind,
  where: { sql: string; parameters: unknown[] },
  state: PageState,
  limit?: number,
  paginated = true,
): Promise<LogRecord[]> {
  const parameters = [...where.parameters];
  let suffix = '';
  if (limit !== undefined) suffix = ` LIMIT $${parameters.push(limit)}`;
  else if (paginated)
    suffix = ` LIMIT $${parameters.push(state.pageSize)} OFFSET $${parameters.push(state.pageIndex * state.pageSize)}`;
  const result = await db.query(
    `${logSelect(kind)} WHERE ${where.sql} ORDER BY ${orderClause(kind, state)}${suffix}`,
    parameters,
  );
  return result.rows.map((row) =>
    kind === 'operation'
      ? {
          ...row,
          operation_content_display: `${row.operation_content ?? ''}:${localizeLoginContent(String(row.operation_content ?? ''))}`,
        }
      : row,
  ) as LogRecord[];
}

function csvLine(values: unknown[]): string {
  return values.map((raw) => `"${String(raw ?? '').replaceAll('"', '""')}"`).join(',');
}

function csvRows(kind: LogKind, rows: LogRecord[], limit: number): string {
  const headers =
    kind === 'operation'
      ? [
          'Operation date and time',
          'Operation type',
          'Operation content',
          'Application type',
          'Device type',
          'User ID',
          'User name',
          'Device ID',
          'Device ID',
          'Device name',
          'Device App. version',
          'Client name',
          'Client address',
          'Browserlication name',
        ]
      : kind === 'definition'
        ? ['Operation date and time', 'Operation type', 'Form ID', 'Form name', 'User ID']
        : [
            'Operation date and time',
            'Operation type',
            'Document ID',
            'Form name',
            'User ID',
            'Value of auto. numbering',
            'Auto. numbering message',
          ];
  const lines = [csvLine(headers)];
  const visibleRows = limit > 0 ? rows.slice(0, limit) : rows;
  for (const row of visibleRows) {
    const cells =
      kind === 'operation'
        ? [
            row.log_time_csv,
            row.operation_type,
            `${row.operation_content ?? ''}:${localizeLoginContent(String(row.operation_content ?? ''))}`,
            row.app_type,
            row.device_type,
            row.user_id,
            row.user_name,
            row.term_id,
            row.physical_id,
            row.term_name,
            row.app_version,
            row.client_host_name,
            row.client_ip_address,
            row.browser_name,
          ]
        : kind === 'definition'
          ? [row.log_time_csv, row.log_type_display, row.form_id, row.form_name, row.user_id]
          : [
              row.log_time_csv,
              row.log_type_display,
              row.form_id,
              row.form_name,
              row.user_id,
              row.auto_numbering_value,
              row.auto_numbering_message,
            ];
    lines.push(csvLine(cells));
  }
  if (limit > 0 && rows.length > limit) lines.push(csvLine([`Truncated to ${limit.toLocaleString('en-US')} records.`]));
  return `${lines.join('\r\n')}\r\n`;
}

function deleteCutoff(days: number): string {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  if (days === 0) date.setDate(date.getDate() + 1);
  else if (days > 1) date.setDate(date.getDate() - (days - 1));
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

async function deleteLogRows(db: pg.Pool, kind: LogKind, days: number): Promise<number> {
  const config = logConfigs[kind];
  const client = await db.connect();
  let deleted = 0;
  try {
    while (true) {
      await client.query('BEGIN');
      try {
        let selectedCount: number;
        if (kind === 'operation') {
          const selected = await client.query<{ log_id: string }>(
            'SELECT log_id::text FROM conmas_operation_log WHERE log_time < $1::date ORDER BY log_id OFFSET 0 LIMIT $2',
            [deleteCutoff(days), batchSize],
          );
          selectedCount = selected.rows.length;
          if (!selectedCount) {
            await client.query('COMMIT');
            break;
          }
          const result = await client.query('DELETE FROM conmas_operation_log WHERE log_id <= $1::text', [
            selected.rows[selectedCount - 1].log_id,
          ]);
          deleted += result.rowCount ?? 0;
        } else {
          const selected = await client.query<{ log_date: string }>(
            `SELECT to_char(sys_update_time,'YYYY-MM-DD') AS log_date FROM ${config.table}
             WHERE sys_update_time < $1::date ORDER BY sys_update_time OFFSET 0 LIMIT $2`,
            [deleteCutoff(days), batchSize],
          );
          selectedCount = selected.rows.length;
          if (!selectedCount) {
            await client.query('COMMIT');
            break;
          }
          const result = await client.query(
            `DELETE FROM ${config.table} WHERE sys_update_time < $1::date + INTERVAL '1 day'`,
            [selected.rows[selectedCount - 1].log_date],
          );
          deleted += result.rowCount ?? 0;
        }
        await client.query('COMMIT');
        if (selectedCount < batchSize) break;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return deleted;
  } finally {
    client.release();
  }
}

function parseDeleteDays(source: FormValues): number | null {
  const raw = value(source, 'DeleteDays').trim();
  if (!raw) return 0;
  if (!/^[+-]?\d+$/.test(raw)) return null;
  const days = Number(raw);
  return Number.isSafeInteger(days) && days >= 0 && days <= 999 ? days : null;
}

function show(res: Response, render: Render, kind: LogKind, mode: 'list' | 'delete', values: Record<string, unknown>) {
  const config = logConfigs[kind];
  return render(res, {
    active: 'System',
    section: mode === 'list' ? config.route : config.deleteRoute,
    login: false,
    title: mode === 'delete' ? `${config.title} - Log deletion` : config.title,
    userName: res.locals.userName,
    systemLogsPage: {
      kind,
      mode,
      route: config.route,
      deleteRoute: config.deleteRoute,
      title: config.title,
      canDelete: false,
      ...values,
    },
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deny(res: Response, action: 'read' | 'delete') {
  return res.status(403).type('text/plain').send(`You do not have permission to ${action} operation logs.`);
}
function gateUnavailableFreeDrawOnlyLogs(kind: LogKind, res: Response) {
  if (kind === 'operation') return null;
  try {
    if (!licenseStatus().freeDrawOnly) return null;
    return res.status(403).type('text/plain').send('Role authority is insufficient.');
  } catch {
    return res.status(503).type('text/plain').send('License information is unavailable.');
  }
}

async function permissions(db: pg.Pool, req: Request) {
  const userId = req.session?.userId ?? '';
  const [canRead, canDelete] = await Promise.all([
    hasSystemPermission(db, userId, 'data', 'read'),
    hasSystemPermission(db, userId, 'data', 'delete'),
  ]);
  return { canRead, canDelete };
}

async function listPage(
  db: pg.Pool,
  res: Response,
  render: Render,
  kind: LogKind,
  source: FormValues,
  isGet: boolean,
  action: string,
  canDelete: boolean,
) {
  const settings = await loadPageSettings(db);
  const filters = readFilters(source, kind, isGet);
  const pageState =
    action === 'SearchType'
      ? { pageIndex: 0, pageSize: settings.defaultPageSize, sortColumn: 'log_time', sortDirection: 'ASC' as const }
      : readPageState(source, kind, settings.defaultPageSize);
  const where = buildSystemLogWhere(kind, filters);
  const count = await db.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM ${logConfigs[kind].table} log WHERE ${where.sql}`,
    where.parameters,
  );
  const total = Number(count.rows[0]?.total ?? 0);
  const rows = await fetchRows(db, kind, where, pageState);
  return show(res, render, kind, 'list', {
    filters,
    rows,
    total,
    ...pageState,
    pageSizeOptions: settings.pageSizeOptions,
    totalPages: Math.ceil(total / pageState.pageSize),
    limitOfDownloadCount: settings.limitOfDownloadCount,
    canDelete,
    errorMessage: '',
  });
}

function fallbackListPage(source: FormValues, kind: LogKind, isGet: boolean, action: string, canDelete: boolean) {
  const pageState =
    action === 'SearchType'
      ? { pageIndex: 0, pageSize: 20, sortColumn: 'log_time', sortDirection: 'ASC' as const }
      : readPageState(source, kind, 20);
  return {
    filters: readFilters(source, kind, isGet),
    rows: [],
    total: 0,
    ...pageState,
    pageSizeOptions: fallbackPageSizes.map((size) => ({ value: size, text: String(size) })),
    totalPages: 0,
    limitOfDownloadCount: 0,
    canDelete,
  };
}

function fallbackDeletePage(days = 365) {
  return { deleteDays: days, deleteResult: -1, errorMessage: '' };
}

export function registerSystemLogs(app: Express, db: pg.Pool, render: Render) {
  for (const kind of Object.keys(logConfigs) as LogKind[]) {
    const config = logConfigs[kind];
    app.get(`${root}/${config.route}`, async (req: Request, res: Response) => {
      try {
        const access = await permissions(db, req);
        if (!access.canRead) return deny(res, 'read');
        const blocked = gateUnavailableFreeDrawOnlyLogs(kind, res);
        if (blocked) return blocked;
        return await listPage(db, res, render, kind, {}, true, '', access.canDelete);
      } catch (error) {
        console.error(error);
        const blocked = gateUnavailableFreeDrawOnlyLogs(kind, res);
        if (blocked) return blocked;
        return show(res, render, kind, 'list', {
          ...fallbackListPage({}, kind, true, '', false),
          errorMessage: errorText(error),
        });
      }
    });

    app.post(`${root}/${config.route}`, async (req: Request, res: Response) => {
      const source = req.body as FormValues;
      const action = value(source, 'ActionCommonType');
      try {
        const access = await permissions(db, req);
        if (!access.canRead) return deny(res, 'read');
        const blocked = gateUnavailableFreeDrawOnlyLogs(kind, res);
        if (blocked) return blocked;
        if (action === 'CsvType') {
          const settings = await loadPageSettings(db);
          const filters = readFilters(source, kind, false);
          const pageState = readPageState(source, kind, settings.defaultPageSize);
          const where = buildSystemLogWhere(kind, filters);
          const rows = await fetchRows(
            db,
            kind,
            where,
            pageState,
            settings.limitOfDownloadCount > 0 ? settings.limitOfDownloadCount + 1 : undefined,
            false,
          );
          res.setHeader('Content-Type', 'text/csv');
          res.setHeader(
            'Content-Disposition',
            `attachment; filename="${kind === 'operation' ? 'operationLog.csv' : kind === 'definition' ? 'definitionFormOperationLog.csv' : 'inputReportOperationLog.csv'}"`,
          );
          return res.send(Buffer.from(csvRows(kind, rows, settings.limitOfDownloadCount), 'utf8'));
        }
        return await listPage(
          db,
          res,
          render,
          kind,
          source,
          false,
          action === 'SearchType' ? 'SearchType' : 'PageType',
          access.canDelete,
        );
      } catch (error) {
        console.error(error);
        const blocked = gateUnavailableFreeDrawOnlyLogs(kind, res);
        if (blocked) return blocked;
        return show(res, render, kind, 'list', {
          ...fallbackListPage(source, kind, false, action, false),
          errorMessage: errorText(error),
        });
      }
    });

    app.get(`${root}/${config.deleteRoute}`, async (req: Request, res: Response) => {
      try {
        const access = await permissions(db, req);
        if (!access.canRead) return deny(res, 'read');
        if (!access.canDelete) return deny(res, 'delete');
        const blocked = gateUnavailableFreeDrawOnlyLogs(kind, res);
        if (blocked) return blocked;
        return show(res, render, kind, 'delete', { ...fallbackDeletePage(), canDelete: true });
      } catch (error) {
        console.error(error);
        const blocked = gateUnavailableFreeDrawOnlyLogs(kind, res);
        if (blocked) return blocked;
        return show(res, render, kind, 'delete', { ...fallbackDeletePage(), errorMessage: errorText(error) });
      }
    });

    app.post(`${root}/${config.deleteRoute}`, async (req: Request, res: Response) => {
      const source = req.body as FormValues;
      try {
        const access = await permissions(db, req);
        if (!access.canRead) return deny(res, 'read');
        if (!access.canDelete) return deny(res, 'delete');
        const blocked = gateUnavailableFreeDrawOnlyLogs(kind, res);
        if (blocked) return blocked;
        const days = parseDeleteDays(source);
        if (days === null) {
          return show(res, render, kind, 'delete', {
            deleteDays: value(source, 'DeleteDays'),
            deleteResult: -1,
            errorMessage: 'Log deletion days must be an integer from 0 to 999.',
            canDelete: true,
          });
        }
        const deleteResult = await deleteLogRows(db, kind, days);
        return show(res, render, kind, 'delete', { deleteDays: days, deleteResult, errorMessage: '', canDelete: true });
      } catch (error) {
        console.error(error);
        const blocked = gateUnavailableFreeDrawOnlyLogs(kind, res);
        if (blocked) return blocked;
        return show(res, render, kind, 'delete', {
          deleteDays: value(source, 'DeleteDays') || 365,
          deleteResult: -1,
          errorMessage: errorText(error),
          canDelete: true,
        });
      }
    });
  }
}
