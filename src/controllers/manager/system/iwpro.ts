import { text as pageText } from '../../../config/manager/system/resources.js';
import { licenseStatus } from '../../../shared/license-counts.js';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import type pg from 'pg';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { hasSystemPermission } from '../../../middleware/manager/system/permissions.js';

type FormValues = Record<string, unknown>;
type OAuthSession = NonNullable<Request['session']> & { iwproSettingError?: string; localSessonKey?: string };
type IwproFilters = {
  execTimeFrom: string;
  execTimeFromHour: string;
  execTimeTo: string;
  execTimeToHour: string;
  statusSuccess: boolean;
  statusRetrying: boolean;
  statusFailure: boolean;
  failureCount: string;
  ireporterUser: string;
  repTopId: string;
  officeId: string;
  cabinetId: string;
  baseFolderId: string;
  outputFolder: string;
  uploadFile: string;
  errorMessage: string;
};
type UploadLog = {
  log_id: string;
  status: number;
  rep_top_id: number;
  office_id: number | null;
  cabinet_id: number | null;
  base_folder_id: string | null;
  output_folder_path: string | null;
  output_folder_id: string | null;
  file_id: string | null;
  file_name: string | null;
  error_message: string | null;
  failure_count: number | null;
  ir_user_id: string | null;
  ir_user_name: string | null;
  update_time: string | null;
  is_in_progress: boolean;
};
type PageState = { pageIndex: number; pageSize: number; sortColumn: string; sortDirection: 'ASC' | 'DESC' };
type PageSizeOption = { value: number; text: string };
type PageRenderer = (res: Response, data: Record<string, unknown>) => unknown;

const root = '/ConMasManager/System';
const authEndpoint = 'https://account-fb.fujifilm.com/auth/realms/spf/protocol/openid-connect/auth';
const apiEndpoint = 'https://api.fbiwpro.fujifilm.com/v1/data-management';
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: false });
const builder = new XMLBuilder({ ignoreAttributes: false, format: true });
const sortableColumns: Record<string, true> = {
  sys_update_time: true,
  status: true,
  failure_count: true,
  ir_user_id: true,
  rep_top_id: true,
  office_id: true,
  cabinet_id: true,
  base_folder_id: true,
  folder_path: true,
  output_folder_path: true,
  file_name: true,
  error_message: true,
};
const defaultFilters: IwproFilters = {
  execTimeFrom: '',
  execTimeFromHour: '',
  execTimeTo: '',
  execTimeToHour: '',
  statusSuccess: true,
  statusRetrying: true,
  statusFailure: true,
  failureCount: '',
  ireporterUser: '',
  repTopId: '',
  officeId: '',
  cabinetId: '',
  baseFolderId: '',
  outputFolder: '',
  uploadFile: '',
  errorMessage: '',
};

function value(source: FormValues, key: string): string {
  const raw = source[key];
  const candidate = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  return typeof candidate === 'string' ? candidate : '';
}
function checked(source: FormValues, key: string, fallback: boolean): boolean {
  const raw = source[key];
  if (raw === undefined) return fallback;
  const candidates = Array.isArray(raw) ? raw : [raw];
  return candidates.some((candidate) => candidate === 'true' || candidate === 'on' || candidate === '1');
}

export function readIwproFilters(source: FormValues, isGet = false): IwproFilters {
  return {
    execTimeFrom: value(source, 'WhereData.ExecTimeFrom'),
    execTimeFromHour: value(source, 'WhereData.ExecTimeFromHour'),
    execTimeTo: value(source, 'WhereData.ExecTimeTo'),
    execTimeToHour: value(source, 'WhereData.ExecTimeToHour'),
    statusSuccess: checked(source, 'WhereData.StatusSuccess', isGet),
    statusRetrying: checked(source, 'WhereData.StatusRetrying', isGet),
    statusFailure: checked(source, 'WhereData.StatusFailure', isGet),
    failureCount: value(source, 'WhereData.FailureCount'),
    ireporterUser: value(source, 'WhereData.IreporterUser'),
    repTopId: value(source, 'WhereData.RepTopId'),
    officeId: value(source, 'WhereData.OfficeId'),
    cabinetId: value(source, 'WhereData.CabinetId'),
    baseFolderId: value(source, 'WhereData.BaseFolderId'),
    outputFolder: value(source, 'WhereData.OutputFolder'),
    uploadFile: value(source, 'WhereData.UploadFile'),
    errorMessage: value(source, 'WhereData.ErrorMessage'),
  };
}

function parseDate(input: string): string | null {
  const match = input.trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseTime(input: string): string {
  const match = input.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return '00:00:00';
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? 0);
  if (hour > 23 || minute > 59 || second > 59) return '00:00:00';
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
}

function fullWidthToHalfWidth(input: string): string {
  return input
    .replace(/[！＃＄％＆（）＊＋，－．／０-９：；＜＝＞？＠Ａ-Ｚ［］＾＿｀ａ-ｚ｛｜｝～]/g, (character) =>
      String.fromCharCode(character.charCodeAt(0) - 0xfee0),
    )
    .replaceAll('\u3000', ' ');
}

export function buildIwproUploadWhere(filters: IwproFilters): { sql: string; parameters: unknown[] } {
  const clauses: string[] = [];
  const parameters: unknown[] = [];
  const add = (clause: (index: number) => string, parameter: unknown) => {
    parameters.push(parameter);
    clauses.push(clause(parameters.length));
  };
  const from = parseDate(filters.execTimeFrom);
  const to = parseDate(filters.execTimeTo);
  if (from)
    add((index) => `log.sys_update_time >= $${index}::timestamp`, `${from} ${parseTime(filters.execTimeFromHour)}`);
  if (to) add((index) => `log.sys_update_time <= $${index}::timestamp`, `${to} ${parseTime(filters.execTimeToHour)}`);

  const statuses = [
    filters.statusSuccess ? 0 : null,
    filters.statusRetrying ? 1 : null,
    filters.statusFailure ? 2 : null,
  ].filter((status): status is number => status !== null);
  if (statuses.length > 0 && statuses.length < 3) add((index) => `log.status = ANY($${index}::numeric[])`, statuses);
  if (filters.failureCount) add((index) => `log.failure_count = $${index}`, filters.failureCount);
  if (filters.ireporterUser) {
    const pattern = `%${fullWidthToHalfWidth(filters.ireporterUser)}%`;
    add(
      (index) =>
        `(convert_full2half(log.ir_user_id) ILIKE $${index} OR EXISTS (SELECT 1 FROM mst_user uu WHERE log.ir_user_id = uu.user_id AND convert_full2half(uu.user_name) ILIKE $${index}))`,
      pattern,
    );
  }
  if (filters.repTopId) add((index) => `log.rep_top_id = $${index}`, filters.repTopId);
  if (filters.officeId) add((index) => `log.office_id = $${index}`, filters.officeId);
  if (filters.cabinetId) add((index) => `log.cabinet_id = $${index}`, filters.cabinetId);
  if (filters.baseFolderId) add((index) => `log.base_folder_id = $${index}`, filters.baseFolderId);
  if (filters.outputFolder) {
    const pattern = `%${fullWidthToHalfWidth(filters.outputFolder)}%`;
    parameters.push(pattern, filters.outputFolder);
    clauses.push(
      `(convert_full2half(log.output_folder_path) ILIKE $${parameters.length - 1} OR log.output_folder_id = $${parameters.length})`,
    );
  }
  if (filters.uploadFile) {
    const pattern = `%${fullWidthToHalfWidth(filters.uploadFile)}%`;
    parameters.push(pattern, filters.uploadFile);
    clauses.push(
      `(convert_full2half(log.file_name) ILIKE $${parameters.length - 1} OR log.file_id = $${parameters.length})`,
    );
  }
  if (filters.errorMessage)
    add(
      (index) => `convert_full2half(log.error_message) ILIKE $${index}`,
      `%${fullWidthToHalfWidth(filters.errorMessage)}%`,
    );
  return { sql: clauses.length ? clauses.join(' AND ') : '1=1', parameters };
}

export function buildIwproAuthorizationUrl(
  clientId: string,
  redirectUrl: string,
  completeUrl: string,
  nonce: string,
): URL {
  const state = Buffer.from(JSON.stringify({ redirectUrl, completeUrl })).toString('base64url');
  const url = new URL(authEndpoint);
  url.search = `response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUrl)}&scope=DXPF.ANY.USER%20SPF-ID.READ.USER&nonce=${encodeURIComponent(nonce)}&state=${encodeURIComponent(state)}`;
  return url;
}

function sessionError(req: Request): string {
  const session = req.session as OAuthSession | undefined;
  const message = session?.iwproSettingError ?? '';
  if (session) delete session.iwproSettingError;
  return message;
}
function iwproLocale(req: Request): string {
  return (req.session as OAuthSession | undefined)?.localSessonKey ?? 'en-US';
}

function setSessionError(req: Request, message: string): void {
  const session = req.session as OAuthSession | undefined;
  if (session) session.iwproSettingError = message;
}

function text(source: Record<string, unknown>, name: string): string {
  return typeof source[name] === 'string' ? (source[name] as string) : '';
}

function parseOAuth(xml: string | null | undefined): {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
  user: string;
} {
  if (!xml) return { accessToken: '', refreshToken: '', expiresIn: '', user: '' };
  const document = parser.parse(xml) as { conmas?: { oauth?: Record<string, unknown> } };
  const oauth = document.conmas?.oauth;
  if (!oauth || typeof oauth !== 'object') return { accessToken: '', refreshToken: '', expiresIn: '', user: '' };
  return {
    accessToken: text(oauth, 'accessToken'),
    refreshToken: text(oauth, 'refreshToken'),
    expiresIn: text(oauth, 'expiresIn'),
    user: text(oauth, 'user'),
  };
}

function linkageXml(accessToken: string, expiresIn: string, refreshToken: string, user: string): string {
  return builder.build({ conmas: { oauth: { accessToken, expiresIn, refreshToken, user } } });
}

async function authRedirectUrl(db: pg.Pool): Promise<string> {
  const result = await db.query<{ com_value: string }>(
    "SELECT com_value FROM mst_common WHERE com_key='IWPRO_SETTING' AND com_name='AUTH_REDIRECT_URL' ORDER BY com_index LIMIT 1",
  );
  return result.rows[0]?.com_value ?? '';
}

async function getClientId(db: pg.Pool): Promise<string> {
  const baseUrl = await authRedirectUrl(db);
  if (!baseUrl) throw new Error(pageText['GetClientId failed.']);
  const response = await fetch(`${baseUrl}/GetClientId`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${Buffer.from('cimtops').toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(pageText['GetClientId failed.']);
  const body = (await response.json()) as Record<string, unknown>;
  return typeof body.clientId === 'string' ? body.clientId : '';
}

async function apiJson(url: string, accessToken: string, locale: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}`, 'X-Locale': locale.slice(0, 2) || 'en' },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(pageText['IWpro API request failed.']);
  return (await response.json()) as Record<string, unknown>;
}

async function loginUserName(accessToken: string, locale: string): Promise<string> {
  const officeResponse = await apiJson(`${apiEndpoint}/offices/?page=1`, accessToken, locale);
  const offices = Array.isArray(officeResponse.offices) ? (officeResponse.offices as Record<string, unknown>[]) : [];
  const officeId = offices[0]?.officeId ?? offices[0]?.OfficeId;
  if (!Number.isSafeInteger(Number(officeId))) return '';
  const user = await apiJson(`${apiEndpoint}/offices/${Number(officeId)}/loginUser`, accessToken, locale);
  return typeof user.familyName === 'string' && typeof user.givenName === 'string'
    ? `${user.familyName} ${user.givenName}`
    : '';
}

function expiresAt(seconds: number): string {
  const date = new Date(Date.now() + seconds * 1000);
  if (!Number.isFinite(date.getTime())) throw new Error(pageText['Invalid token expiration.']);
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}

async function saveOAuth(db: pg.Pool, req: Request, xml: string): Promise<void> {
  const userId = req.session?.userId ?? '';
  const term = req.ip ?? '';
  await db.query(
    `INSERT INTO mst_external_linkage (key,xml_data,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time)
     VALUES ('iwpro',$1,$2,$3,now(),$2,$3,now())
     ON CONFLICT (key) DO UPDATE SET xml_data=EXCLUDED.xml_data,sys_update_term=EXCLUDED.sys_update_term,sys_update_user=EXCLUDED.sys_update_user,sys_update_time=now()`,
    [xml, term, userId],
  );
}

async function can(db: pg.Pool, req: Request): Promise<boolean> {
  return hasSystemPermission(db, req.session?.userId ?? '', 'system', 'read');
}

function showRoleError(
  renderPage: PageRenderer,
  res: Response,
  section: string,
  status = 403,
  error = 'Role authority is insufficient.',
) {
  return show(renderPage, res.status(status), section, 'RoleError', {
    mode: 'roleError',
    error,
    canEdit: false,
    canDelete: false,
  });
}

async function gate(
  db: pg.Pool,
  req: Request,
  res: Response,
  renderPage: PageRenderer,
  section: string,
): Promise<boolean> {
  if (!(await can(db, req))) {
    showRoleError(renderPage, res, section);
    return false;
  }
  try {
    if (!licenseStatus().freeDrawOnly) return true;
    showRoleError(renderPage, res, section);
  } catch {
    showRoleError(renderPage, res, section, 503, 'License information is unavailable.');
  }
  return false;
}

function show(
  renderPage: PageRenderer,
  res: Response,
  section: string,
  title: string,
  iwproPage: Record<string, unknown>,
) {
  return renderPage(res, {
    active: 'System',
    section,
    login: false,
    title,
    userName: res.locals.userName,
    iwproPage,
  });
}

async function showSetting(
  db: pg.Pool,
  req: Request,
  res: Response,
  renderPage: PageRenderer,
  error = '',
  status = 200,
) {
  const row = await db.query<{ xml_data: string }>("SELECT xml_data FROM mst_external_linkage WHERE key='iwpro'");
  const oauth = parseOAuth(row.rows[0]?.xml_data);
  return show(renderPage, res.status(status), 'IWproSetting', 'FUJIFILM IWpro linkage setting', {
    mode: 'settings',
    authenticated: Boolean(oauth.accessToken),
    user: oauth.user,
    error,
    canEdit: await can(db, req),
  });
}

function settingRedirect(req: Request, res: Response, message = '') {
  if (message) setSessionError(req, message);
  return res.redirect(`${root}/IWproSetting`);
}

function parsePageState(source: FormValues, defaultPageSize: number, pageSizes: number[]): PageState {
  const requestedSize = Number(value(source, 'PageData.PageSize'));
  const pageSize = pageSizes.includes(requestedSize) ? requestedSize : defaultPageSize;
  const requestedIndex = Number(value(source, 'PageData.PageIndex'));
  const pageIndex = Number.isSafeInteger(requestedIndex) && requestedIndex >= 0 ? Math.min(requestedIndex, 10000) : 0;
  const requestedColumn = value(source, 'PageData.SortColumn').toLowerCase();
  const sortColumn = Object.hasOwn(sortableColumns, requestedColumn) ? requestedColumn : 'sys_update_time';
  const requestedDirection = value(source, 'PageData.SortDirection').toUpperCase();
  const sortDirection = requestedDirection === 'ASC' ? 'ASC' : 'DESC';
  return { pageIndex, pageSize, sortColumn, sortDirection };
}

async function pageOptions(
  db: pg.Pool,
): Promise<{ pageSizes: number[]; pageSizeOptions: PageSizeOption[]; defaultPageSize: number }> {
  const [sizes, defaultSize] = await Promise.all([
    db.query<{ com_value: string; com_name: string }>(
      "SELECT com_value,com_name FROM mst_common WHERE com_key='PAGE_SIZE' ORDER BY com_index",
    ),
    db.query<{ com_value: string }>(
      "SELECT com_value FROM mst_common WHERE com_key='DEFAULT_PAGE_SIZE' ORDER BY com_index LIMIT 1",
    ),
  ]);
  const pageSizeOptions = sizes.rows.flatMap((row) => {
    const value = Number(row.com_value);
    return Number.isSafeInteger(value) && value > 0 && value <= 10000
      ? [{ value, text: row.com_name || row.com_value }]
      : [];
  });
  const pageSizes = [...new Set(pageSizeOptions.map((option) => option.value))];
  const configuredDefault = Number(defaultSize.rows[0]?.com_value);
  const fallback = pageSizes[0] ?? 20;
  const defaultPageSize =
    Number.isSafeInteger(configuredDefault) &&
    configuredDefault > 0 &&
    configuredDefault <= 10000 &&
    (!pageSizes.length || pageSizes.includes(configuredDefault))
      ? configuredDefault
      : fallback;
  if (!pageSizes.length) {
    pageSizes.push(defaultPageSize);
    pageSizeOptions.push({ value: defaultPageSize, text: String(defaultPageSize) });
  }
  return { pageSizes, pageSizeOptions, defaultPageSize };
}

async function downloadLimit(db: pg.Pool): Promise<number> {
  const result = await db.query<{ com_value: string }>(
    "SELECT com_value FROM mst_common WHERE com_key='CSV_DOWNLOAD_SETTING' AND com_name='LIMIT_OF_DOWNLOAD_COUNT' ORDER BY com_index LIMIT 1",
  );
  const count = Number(result.rows[0]?.com_value);
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

function poolDirectory(): string | null {
  const settings = process.env.CONMAS_CLIENT_SETTINGS?.trim();
  return settings ? path.join(settings, 'interface', 'report', 'IWpro', 'pool') : null;
}

export function buildIwproOrder(page: PageState): string {
  const column = Object.hasOwn(sortableColumns, page.sortColumn) ? page.sortColumn : 'sys_update_time';
  const direction = page.sortDirection === 'ASC' ? 'ASC' : 'DESC';
  return `log.${column} ${direction}, log.log_id`;
}

async function queryLogs(
  db: pg.Pool,
  filters: IwproFilters,
  page: PageState,
  withPage: boolean,
  limit = 0,
): Promise<{ rows: UploadLog[]; total: number }> {
  const where = buildIwproUploadWhere(filters);
  const total = withPage
    ? Number(
        (
          await db.query<{ total: string }>(
            `SELECT count(*) AS total FROM log_iwpro_upload log WHERE ${where.sql}`,
            where.parameters,
          )
        ).rows[0]?.total ?? 0,
      )
    : 0;
  const limitClause = limit > 0 ? ` LIMIT ${limit}` : '';
  const pagination = withPage ? ` OFFSET ${page.pageIndex * page.pageSize} LIMIT ${page.pageSize}` : limitClause;
  const order = buildIwproOrder(page);
  const result = await db.query<UploadLog>(
    `SELECT log.log_id,log.status,log.rep_top_id,log.office_id,log.cabinet_id,log.base_folder_id,log.output_folder_path,log.output_folder_id,log.file_id,log.file_name,log.error_message,log.failure_count,log.ir_user_id,u.user_name AS ir_user_name,to_char(log.sys_update_time,'YYYY/MM/DD HH24:MI:SS') AS update_time
     FROM log_iwpro_upload log LEFT JOIN mst_user u ON log.ir_user_id=u.user_id WHERE ${where.sql} ORDER BY ${order}${pagination}`,
    where.parameters,
  );
  const pool = withPage ? poolDirectory() : null;
  const rows = result.rows.map((row) => ({
    ...row,
    status: Number(row.status),
    rep_top_id: Number(row.rep_top_id),
    office_id: row.office_id === null ? null : Number(row.office_id),
    cabinet_id: row.cabinet_id === null ? null : Number(row.cabinet_id),
    failure_count: row.failure_count === null ? null : Number(row.failure_count),
    is_in_progress: Boolean(pool && existsSync(path.join(pool, `${row.rep_top_id}.xml`))),
  }));
  return { rows, total };
}

function csvValue(raw: unknown): string {
  return `"${String(raw ?? '').replaceAll('"', '""')}"`;
}

const csvHeaders = [
  'Execution date and time',
  'Status',
  'Number of failures',
  'i-Reporter users',
  'Document ID',
  'Office ID',
  'Cabinet ID',
  'Drawer ID or Folder ID',
  'Folder to be created under the folder or drawer',
  'linked files',
  'Contents of error',
];

async function csvContent(db: pg.Pool, rows: UploadLog[], limit: number, locale: string): Promise<Buffer> {
  const lines = [csvHeaders.map(csvValue).join(',')];
  let count = 0;
  for (const row of rows) {
    if (limit > 0 && count++ === limit) {
      lines.push(csvValue(`Truncated to ${limit.toLocaleString('en-US')} records.`));
      break;
    }
    const status = row.status === 0 ? 'Succeeded to link' : row.status === 1 ? 'Retrying to link' : 'Failed to link';
    lines.push(
      [
        row.update_time,
        status,
        row.failure_count,
        `${row.ir_user_id ?? ''}:${row.ir_user_name ?? ''}`,
        row.rep_top_id,
        row.office_id,
        row.cabinet_id,
        row.base_folder_id,
        row.output_folder_path ? `${row.output_folder_path}(ID:${row.output_folder_id ?? ''})` : '',
        `${row.file_name ?? ''}(ID:${row.file_id ?? ''})`,
        row.error_message,
      ]
        .map(csvValue)
        .join(','),
    );
  }
  const output = `${lines.join('\r\n')}\r\n`;
  const encoding =
    (
      await db.query<{ com_value: string }>(
        "SELECT com_value FROM mst_common WHERE com_key='ENCODING' AND com_locale=$1 ORDER BY com_index LIMIT 1",
        [locale],
      )
    ).rows[0]?.com_value ?? '';
  if (!encoding || encoding === '65001') return Buffer.from(output, 'utf8');
  let iconv: { encode(input: string, encoding: string): Buffer };
  try {
    // Resolve iconv-lite through Express's declared body-parser dependency.
    const appRequire = createRequire(import.meta.url);
    const expressRequire = createRequire(appRequire.resolve('express'));
    const bodyParserRequire = createRequire(expressRequire.resolve('body-parser'));
    iconv = bodyParserRequire('iconv-lite') as typeof iconv;
  } catch {
    throw new Error(`CSV encoding ${encoding} requires iconv-lite.`);
  }
  return iconv.encode(output, encoding === '932' ? 'shift_jis' : `cp${encoding}`);
}

async function renderUploadLog(
  db: pg.Pool,
  req: Request,
  res: Response,
  renderPage: PageRenderer,
  filters: IwproFilters,
  page: PageState,
  error = '',
  status = 200,
) {
  const [data, limit, canManage, options] = await Promise.all([
    queryLogs(db, filters, page, true),
    downloadLimit(db),
    can(db, req),
    pageOptions(db),
  ]);
  const pageCount = Math.ceil(data.total / page.pageSize);
  return show(renderPage, res.status(status), 'IWproUploadLog', 'FUJIFILM IWpro linkage log', {
    mode: 'uploadLog',
    rows: data.rows,
    total: data.total,
    pageIndex: page.pageIndex,
    pageSize: page.pageSize,
    pageSizes: options.pageSizes,
    pageSizeOptions: options.pageSizeOptions,
    pageCount,
    sortColumn: page.sortColumn,
    sortDirection: page.sortDirection,
    filters,
    downloadLimit: limit,
    canEdit: canManage,
    canDelete: canManage,
    error,
  });
}

function selectedLogIds(body: FormValues): string[] {
  const ids: string[] = [];
  for (let index = 0; index < 10000; index++) {
    const key = `UploadLogList[${index}].LogId`;
    const logId = value(body, key);
    if (!logId) break;
    if (checked(body, `UploadLogList[${index}].IsSelect`, false) && logId.length <= 64) ids.push(logId);
  }
  return ids;
}

async function rerunLog(db: pg.Pool, target: string): Promise<void> {
  const pool = poolDirectory();
  if (!pool)
    throw new Error(
      pageText['Client settings path is not configured. Set CONMAS_CLIENT_SETTINGS before rerunning IWpro uploads.'],
    );
  const row = (
    await db.query<{ rep_top_id: number; interface_xml: string | null }>(
      'SELECT rep_top_id,interface_xml FROM log_iwpro_upload WHERE log_id=$1',
      [target],
    )
  ).rows[0];
  if (!row) return;
  if (typeof row.interface_xml !== 'string' || !row.interface_xml)
    throw new Error(pageText['Upload log does not contain its rerun interface file.']);
  const document = parser.parse(row.interface_xml) as Record<string, unknown>;
  const rootName = Object.keys(document)[0];
  const content = rootName ? document[rootName] : null;
  if (content && typeof content === 'object' && !Array.isArray(content) && Object.hasOwn(content, 'failureCount')) {
    (content as Record<string, unknown>).failureCount = '0';
  }
  writeFileSync(path.join(pool, `${row.rep_top_id}.xml`), builder.build(document), 'utf8');
}

async function suspendLog(target: string): Promise<void> {
  const pool = poolDirectory();
  if (!pool)
    throw new Error(
      pageText['Client settings path is not configured. Set CONMAS_CLIENT_SETTINGS before suspending IWpro uploads.'],
    );
  if (!/^\d{1,10}$/.test(target)) return;
  const file = path.join(pool, `${target}.xml`);
  if (existsSync(file)) unlinkSync(file);
}

export function registerIwpro(app: Express, db: pg.Pool, renderPage: PageRenderer) {
  app.get(`${root}/IWproSetting`, async (req, res) => {
    if (!(await gate(db, req, res, renderPage, 'IWproSetting'))) return;
    try {
      return await showSetting(db, req, res, renderPage, sessionError(req));
    } catch {
      return show(renderPage, res.status(500), 'IWproSetting', 'FUJIFILM IWpro linkage setting', {
        mode: 'settings',
        authenticated: false,
        user: '',
        canEdit: false,
        error: pageText['Server error has been occurred.'],
      });
    }
  });

  app.post(`${root}/IWproSetting`, async (req, res) => {
    if (!(await gate(db, req, res, renderPage, 'IWproSetting'))) return;
    try {
      const action = value(req.body, 'act');
      if (action === 'delete') {
        await db.query("DELETE FROM mst_external_linkage WHERE key='iwpro'");
        return res.redirect(`${root}/IWproSetting`);
      }
      if (action !== 'auth') return res.redirect(`${root}/IWproSetting`);
      const clientId = await getClientId(db);
      if (!clientId) return settingRedirect(req, res, 'Authentication failure');
      const redirectUrl = await authRedirectUrl(db);
      const completeUrl = `${req.protocol}://${req.get('host')}${root}/IWproAuthCompleted`;
      return res.redirect(
        buildIwproAuthorizationUrl(clientId, redirectUrl, completeUrl, randomBytes(16).toString('hex')).toString(),
      );
    } catch {
      return settingRedirect(req, res, 'Server error has been occurred.');
    }
  });

  app.get(`${root}/IWproAuthCompleted`, async (req, res) => {
    if (!(await gate(db, req, res, renderPage, 'IWproSetting'))) return;
    const query = req.query as Record<string, unknown>;
    const error = value(query, 'error');
    if (error) return settingRedirect(req, res, 'Authentication failure');
    const accessToken = value(query, 'accessToken');
    const refreshToken = value(query, 'refreshToken');
    const rawExpiresIn = value(query, 'expiresIn');
    if (!accessToken || !/^-?\d+$/.test(rawExpiresIn))
      return settingRedirect(req, res, 'Server error has been occurred.');
    const seconds = Number(rawExpiresIn);
    if (!Number.isInteger(seconds) || seconds < -2147483648 || seconds > 2147483647)
      return settingRedirect(req, res, 'Server error has been occurred.');
    try {
      const user = await loginUserName(accessToken, iwproLocale(req));
      await saveOAuth(db, req, linkageXml(accessToken, expiresAt(seconds), refreshToken, user));
      return res.redirect(`${root}/IWproSetting`);
    } catch {
      return settingRedirect(req, res, 'Server error has been occurred.');
    }
  });

  app.get(`${root}/IWproUploadLog`, async (req, res) => {
    if (!(await gate(db, req, res, renderPage, 'IWproUploadLog'))) return;
    try {
      const { pageSizes, defaultPageSize } = await pageOptions(db);
      const page = parsePageState(req.query as Record<string, unknown>, defaultPageSize, pageSizes);
      return await renderUploadLog(
        db,
        req,
        res,
        renderPage,
        readIwproFilters(req.query as Record<string, unknown>, true),
        page,
      );
    } catch {
      return show(renderPage, res.status(500), 'IWproUploadLog', 'FUJIFILM IWpro linkage log', {
        mode: 'uploadLog',
        rows: [],
        total: 0,
        pageIndex: 0,
        pageSize: 20,
        pageSizes: [20],
        pageSizeOptions: [{ value: 20, text: '20' }],
        pageCount: 1,
        sortColumn: 'sys_update_time',
        sortDirection: 'DESC',
        filters: defaultFilters,
        downloadLimit: 0,
        canEdit: false,
        canDelete: false,
        error: pageText['Server error has been occurred.'],
      });
    }
  });

  app.post(`${root}/IWproUploadLog`, async (req, res) => {
    if (!(await gate(db, req, res, renderPage, 'IWproUploadLog'))) return;
    const filters = readIwproFilters(req.body as FormValues);
    try {
      const { pageSizes, defaultPageSize } = await pageOptions(db);
      const page = parsePageState(req.body as FormValues, defaultPageSize, pageSizes);
      const action = value(req.body, 'act');
      if (action === 'CSV') {
        const limit = await downloadLimit(db);
        const data = await queryLogs(db, filters, page, false, limit > 0 ? limit + 1 : 0);
        return res
          .status(200)
          .type('text/csv')
          .attachment('iwproUploadLog.csv')
          .send(await csvContent(db, data.rows, limit, iwproLocale(req)));
      }
      if (action === 'DELETE') {
        const ids = selectedLogIds(req.body as FormValues);
        if (ids.length) await db.query('DELETE FROM log_iwpro_upload WHERE log_id = ANY($1::text[])', [ids]);
      } else if (action === 'RERUN') {
        const target = value(req.body, 'TargetId');
        if (target.length > 64) return res.status(400).send(pageText['Invalid upload log ID.']);
        try {
          await rerunLog(db, target);
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : 'Server error has been occurred.';
          return await renderUploadLog(db, req, res, renderPage, filters, page, message, 400);
        }
      } else if (action === 'SUSPEND') {
        try {
          await suspendLog(value(req.body, 'TargetId'));
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : 'Server error has been occurred.';
          return await renderUploadLog(db, req, res, renderPage, filters, page, message, 400);
        }
      }
      if (action !== 'PAGE') page.pageIndex = 0;
      return await renderUploadLog(db, req, res, renderPage, filters, page);
    } catch {
      return show(renderPage, res.status(500), 'IWproUploadLog', 'FUJIFILM IWpro linkage log', {
        mode: 'uploadLog',
        rows: [],
        total: 0,
        pageIndex: 0,
        pageSize: 20,
        pageSizes: [20],
        pageSizeOptions: [{ value: 20, text: '20' }],
        pageCount: 1,
        sortColumn: 'sys_update_time',
        sortDirection: 'DESC',
        filters,
        downloadLimit: 0,
        canEdit: false,
        canDelete: false,
        error: pageText['Server error has been occurred.'],
      });
    }
  });
}
