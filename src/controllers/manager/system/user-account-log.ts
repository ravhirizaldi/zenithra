import type { Express, Request, Response } from 'express';
import type pg from 'pg';

type FormValues = Record<string, unknown>;
type SortColumn =
  | 'operation_type'
  | 'operation_content'
  | 'log_time'
  | 'app_type'
  | 'user_id'
  | 'user_name'
  | 'term_id'
  | 'physical_id'
  | 'term_name'
  | 'client_ip_address'
  | 'update_user_id';

type Filters = {
  timeFrom: string;
  timeFromHour: string;
  timeTo: string;
  timeToHour: string;
  operationTypeInsert: boolean;
  operationTypeUpdate: boolean;
  operationTypeDelete: boolean;
  userId: string;
  userName: string;
};

type LogRecord = {
  log_id: string | number | null;
  operation_type: string | null;
  operation_content: string | null;
  app_type: string | null;
  user_id: string | null;
  user_name: string | null;
  term_id: string | null;
  physical_id: string | null;
  term_name: string | null;
  client_ip_address: string | null;
  log_time_display: string | null;
  log_time_csv: string | null;
  update_user_id: string | null;
};

type DisplayRecord = LogRecord & {
  operationTypeLabel: string;
  operationContentLines: string[];
};

const SORT_COLUMNS: Record<string, SortColumn> = {
  operation_type: 'operation_type',
  operation_content: 'operation_content',
  log_time: 'log_time',
  app_type: 'app_type',
  user_id: 'user_id',
  user_name: 'user_name',
  term_id: 'term_id',
  physical_id: 'physical_id',
  term_name: 'term_name',
  client_ip_address: 'client_ip_address',
  update_user_id: 'update_user_id',
};

const CONTENT_LABELS: Record<string, string> = {
  Insert: 'Insert',
  Update: 'Update',
  Delete: 'Delete',
  RegistUser: 'User registration completed.',
  UpdatetUser: '',
  UpdatetUserName: 'The user name has been changed.',
  UpdatetUserPassWd: 'The user password has been changed.',
  UpdatetUserEmail: 'The mail address has been changed.',
  UpdatetUserStartTime: 'Start date of use has been changed.',
  UpdatetUserEndTime: 'End date of use has been changed.',
  UpdatetUserApprovalSign: 'Imprint image has been changed.',
  UpdatetUserAmiVoiceEnable: 'Voice input availability has been changed.',
  UpdatetUserGroup: 'Permission group has been changed.',
  DeleteUser: 'The user deleted.',
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

function readFilters(source: FormValues, isGet: boolean): Filters {
  const prefix = 'whereData.SearchChild.';
  return {
    timeFrom: value(source, `${prefix}TimeFrom`),
    timeFromHour: value(source, `${prefix}TimeFromHour`),
    timeTo: value(source, `${prefix}TimeTo`),
    timeToHour: value(source, `${prefix}TimeToHour`),
    operationTypeInsert: checked(source, `${prefix}OperationTypeInsert`, isGet),
    operationTypeUpdate: checked(source, `${prefix}OperationTypeUpdate`, isGet),
    operationTypeDelete: checked(source, `${prefix}OperationTypeDelete`, isGet),
    userId: value(source, `${prefix}UserId`),
    userName: value(source, `${prefix}UserName`),
  };
}

function parseDate(input: string): string | null {
  const value = input.trim();
  let year: number;
  let month: number;
  let day: number;
  let match = value.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (match) {
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  } else {
    match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!match) return null;
    month = Number(match[1]);
    day = Number(match[2]);
    year = Number(match[3]);
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
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
  // The legacy business method combines the date with the time; a blank time is midnight.
  return `${date} ${parseTime(timeInput) ?? '00:00:00'}`;
}

function readPageState(source: FormValues, defaultPageSize: number) {
  const rawPageSize = Number(value(source, 'PageData.PageSize'));
  const pageSize =
    Number.isSafeInteger(rawPageSize) && rawPageSize > 0 && rawPageSize <= 10000 ? rawPageSize : defaultPageSize;
  const rawPageIndex = Number(value(source, 'PageData.PageIndex'));
  const pageIndex = Number.isSafeInteger(rawPageIndex) && rawPageIndex >= 0 ? Math.min(rawPageIndex, 10000) : 0;
  const requestedColumn = value(source, 'PageData.SortColumn').toLowerCase();
  const sortColumn = SORT_COLUMNS[requestedColumn] ?? 'log_time';
  const requestedDirection = value(source, 'PageData.SortDirection').toUpperCase();
  const sortDirection = requestedDirection === 'DESC' ? 'DESC' : 'ASC';
  return { pageIndex, pageSize, sortColumn, sortDirection };
}

function whereClause(filters: Filters) {
  const clauses = ['1=1'];
  const parameters: unknown[] = [];
  const add = (clause: (index: number) => string, parameter: unknown) => {
    parameters.push(parameter);
    clauses.push(clause(parameters.length));
  };
  const operationTypes = [
    filters.operationTypeInsert ? 'Insert' : '',
    filters.operationTypeUpdate ? 'Update' : '',
    filters.operationTypeDelete ? 'Delete' : '',
  ].filter(Boolean);
  if (operationTypes.length !== 3) {
    if (operationTypes.length) add((index) => `log.operation_type = ANY($${index}::text[])`, operationTypes);
    else clauses.push(`log.operation_type = ''`);
  }
  const timeFrom = dateTimeFilter(filters.timeFrom, filters.timeFromHour);
  if (timeFrom) add((index) => `log.log_time >= $${index}::timestamp`, timeFrom);
  const timeTo = dateTimeFilter(filters.timeTo, filters.timeToHour);
  if (timeTo) add((index) => `log.log_time <= $${index}::timestamp`, timeTo);
  if (filters.userId.trim()) add((index) => `log.user_id ILIKE $${index}`, `%${filters.userId}%`);
  if (filters.userName.trim()) add((index) => `log.user_name ILIKE $${index}`, `%${filters.userName}%`);
  return { sql: clauses.join(' AND '), parameters };
}

function orderClause(sortColumn: SortColumn, sortDirection: string): string {
  const direction = sortDirection === 'DESC' ? 'DESC' : 'ASC';
  const primary = `log.${sortColumn} ${direction}`;
  if (sortColumn === 'update_user_id') return `${primary}, log.update_user_id`;
  return `${primary}, log.log_id`;
}

function localizeContent(content: string | null): string {
  const key = content ?? '';
  return Object.hasOwn(CONTENT_LABELS, key) ? CONTENT_LABELS[key] : '..';
}

function displayRows(rows: LogRecord[]): DisplayRecord[] {
  return rows.map((row) => ({
    ...row,
    operationTypeLabel: localizeContent(row.operation_type),
    operationContentLines: String(row.operation_content ?? '')
      .split(';')
      .map(localizeContent),
  }));
}

function csvValue(raw: unknown): string {
  const value = String(raw ?? '');
  return `"${value.replaceAll('"', '""')}"`;
}

function csvLine(values: unknown[]): string {
  return values.map(csvValue).join(',');
}

const CSV_HEADERS = [
  'Operation date and time',
  'Operation type',
  'Operation content',
  'User ID',
  'User name',
  'Device ID',
  'Device ID',
  'Device name',
  'Client address',
  'Application type',
  'Update User ID',
];

function csvRows(rows: LogRecord[], limit: number): string {
  const lines = [csvLine(CSV_HEADERS)];
  const visibleRows = limit > 0 ? rows.slice(0, limit) : rows;
  for (const row of visibleRows) {
    const content = String(row.operation_content ?? '')
      .split(';')
      .map(localizeContent)
      .join(';');
    lines.push(
      csvLine([
        row.log_time_csv ?? '',
        localizeContent(row.operation_type),
        content,
        row.user_id,
        row.user_name,
        row.term_id,
        row.physical_id,
        row.term_name,
        row.client_ip_address,
        row.app_type,
        row.update_user_id,
      ]),
    );
  }
  if (limit > 0 && rows.length > limit) {
    lines.push(csvLine([`Truncated to ${limit.toLocaleString('en-US')} records.`]));
  }
  return `${lines.join('\r\n')}\r\n`;
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
  const pageSizeOptions = list.rows
    .map((row) => ({ value: Number(row.com_value), text: row.com_name }))
    .filter((option) => Number.isSafeInteger(option.value) && option.value > 0 && option.value <= 10000);
  const uniquePageSizeOptions = pageSizeOptions.filter(
    (option, index) => pageSizeOptions.findIndex((candidate) => candidate.value === option.value) === index,
  );
  const defaultPageSize = Number(defaultValue);
  const safeDefaultPageSize =
    Number.isSafeInteger(defaultPageSize) && defaultPageSize > 0 && defaultPageSize <= 10000
      ? defaultPageSize
      : (uniquePageSizeOptions[0]?.value ?? 20);
  if (!uniquePageSizeOptions.length)
    uniquePageSizeOptions.push({ value: safeDefaultPageSize, text: String(safeDefaultPageSize) });
  const configuredLimit = Number(downloadValue);
  const limitOfDownloadCount =
    Number.isInteger(configuredLimit) && configuredLimit > 0 && configuredLimit <= 2147483647 ? configuredLimit : 0;
  return { pageSizeOptions: uniquePageSizeOptions, defaultPageSize: safeDefaultPageSize, limitOfDownloadCount };
}

function show(
  res: Response,
  render: (res: Response, data: Record<string, unknown>) => unknown,
  userAccountLogPage: Record<string, unknown>,
) {
  return render(res, {
    active: 'System',
    section: 'UserAccountOperationLog',
    login: false,
    title: 'Users - User Account Log',
    userName: res.locals.userName,
    userAccountLogPage,
  });
}

function showErrorPage(
  res: Response,
  render: (res: Response, data: Record<string, unknown>) => unknown,
  source: FormValues,
  isGet: boolean,
  action: string,
  error: unknown,
) {
  const defaultPageSize = 20;
  const pageState =
    action === 'SearchType'
      ? { pageIndex: 0, pageSize: defaultPageSize, sortColumn: 'log_time' as SortColumn, sortDirection: 'ASC' }
      : readPageState(source, defaultPageSize);
  console.error(error);
  return show(res, render, {
    filters: readFilters(source, isGet),
    rows: [],
    total: 0,
    ...pageState,
    pageSizeOptions: [{ value: pageState.pageSize, text: String(pageState.pageSize) }],
    totalPages: 0,
    limitOfDownloadCount: 0,
    errorMessage: error instanceof Error ? error.message : String(error),
  });
}

export function registerUserAccountLog(
  app: Express,
  db: pg.Pool,
  render: (res: Response, data: Record<string, unknown>) => unknown,
) {
  const root = '/ConMasManager/System';

  const list = async (res: Response, source: FormValues, isGet: boolean, action: string) => {
    const settings = await loadPageSettings(db);
    const filters = readFilters(source, isGet);
    const pageState =
      action === 'SearchType'
        ? {
            pageIndex: 0,
            pageSize: settings.defaultPageSize,
            sortColumn: 'log_time' as SortColumn,
            sortDirection: 'ASC',
          }
        : readPageState(source, settings.defaultPageSize);
    const where = whereClause(filters);
    const totalResult = await db.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM conmas_user_account_operation_log log WHERE ${where.sql}`,
      where.parameters,
    );
    const total = Number(totalResult.rows[0]?.total ?? 0);
    const order = orderClause(pageState.sortColumn, pageState.sortDirection);
    const parameters = [...where.parameters, pageState.pageSize, pageState.pageIndex * pageState.pageSize];
    const rowsResult = await db.query<LogRecord>(
      `SELECT log.log_id,log.operation_type,log.operation_content,log.app_type,log.user_id,log.user_name,
        log.term_id,log.physical_id,log.term_name,log.client_ip_address,
        to_char(log.log_time,'FMMM/FMDD/YYYY FMHH12:MI:SS AM') AS log_time_display,
        to_char(log.log_time,'YYYY/MM/DD HH24:MI:SS') AS log_time_csv,
        log.update_user_id
       FROM conmas_user_account_operation_log log
       WHERE ${where.sql}
       ORDER BY ${order}
       LIMIT $${parameters.length - 1} OFFSET $${parameters.length}`,
      parameters,
    );
    return show(res, render, {
      filters,
      rows: displayRows(rowsResult.rows),
      total,
      pageIndex: pageState.pageIndex,
      pageSize: pageState.pageSize,
      pageSizeOptions: settings.pageSizeOptions,
      totalPages: Math.ceil(total / pageState.pageSize),
      sortColumn: pageState.sortColumn,
      sortDirection: pageState.sortDirection,
      limitOfDownloadCount: settings.limitOfDownloadCount,
    });
  };

  app.get(`${root}/UserAccountOperationLog`, async (_req, res) => {
    try {
      return await list(res, {}, true, '');
    } catch (error) {
      return showErrorPage(res, render, {}, true, '', error);
    }
  });

  app.post(`${root}/UserAccountOperationLog`, async (req: Request, res: Response) => {
    const source = req.body as FormValues;
    const action = value(source, 'ActionCommonType');
    try {
      if (action === 'CsvType') {
        const settings = await loadPageSettings(db);
        const filters = readFilters(source, false);
        const pageState = readPageState(source, settings.defaultPageSize);
        const where = whereClause(filters);
        const order = orderClause(pageState.sortColumn, pageState.sortDirection);
        const parameters = [...where.parameters];
        const csvLimit = settings.limitOfDownloadCount;
        const limitClause = csvLimit > 0 ? ` LIMIT $${parameters.push(csvLimit + 1)}` : '';
        const rowsResult = await db.query<LogRecord>(
          `SELECT log.log_id,log.operation_type,log.operation_content,log.app_type,log.user_id,log.user_name,
            log.term_id,log.physical_id,log.term_name,log.client_ip_address,
            to_char(log.log_time,'FMMM/FMDD/YYYY FMHH12:MI:SS AM') AS log_time_display,
            to_char(log.log_time,'YYYY/MM/DD HH24:MI:SS') AS log_time_csv,
            log.update_user_id
           FROM conmas_user_account_operation_log log
           WHERE ${where.sql}
           ORDER BY ${order}${limitClause}`,
          parameters,
        );
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="uerAccountOperationLog.csv"');
        return res.send(Buffer.from(csvRows(rowsResult.rows, csvLimit), 'utf8'));
      }
      return await list(res, source, false, action === 'SearchType' ? 'SearchType' : 'PageType');
    } catch (error) {
      return showErrorPage(res, render, source, false, action, error);
    }
  });
}
