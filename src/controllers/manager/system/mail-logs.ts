import type { Express, Request, Response as ExpressResponse } from 'express';
import type pg from 'pg';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import nodemailer from 'nodemailer';
import { hasSystemPermission } from '../../../middleware/manager/system/permissions.js';

type FormValues = Record<string, unknown>;
export type MailLogFilters = {
  sendTimeFrom: string;
  sendTimeFromHour: string;
  sendTimeTo: string;
  sendTimeToHour: string;
  statusSuccess: boolean;
  statusFailure: boolean;
  notificationTypeApply: boolean;
  notificationTypeRemand: boolean;
  notificationTypeApprove: boolean;
  notificationTypeEdit: boolean;
  notificationTypeComplete: boolean;
  notificationTypeChange: boolean;
  notificationTypeTerminal: boolean;
  notificationTypeTerminalApprove: boolean;
  notificationTypeDefApply: boolean;
  notificationTypeDefRemand: boolean;
  notificationTypeDefApprove: boolean;
};
type NotificationFilter = Extract<keyof MailLogFilters, `notificationType${string}`>;
type MailLogAccess = { canRead: boolean; canDelete: boolean; canResend: boolean };
type SortColumn =
  | 'send_time'
  | 'status'
  | 'notification_type'
  | 'template_id'
  | 'destination'
  | 'subject'
  | 'content'
  | 'error_message';
type MailLogRecord = {
  log_id: string;
  status: string;
  notification_type: string;
  template_name: string;
  destination: unknown;
  subject: string | null;
  content: string | null;
  send_time_display: string | null;
  send_time_csv: string | null;
  error_message: string | null;
};
type Destination = { to: string[]; cc: string[]; bcc: string[] };
type MailLogDisplay = {
  logId: string;
  statusLabel: string;
  notificationType: string;
  templateName: string;
  destination: Destination;
  subject: string;
  content: string;
  contentShortend: string;
  sendTime: string;
  sendTimeCsv: string;
  errorMessage: string;
};
type PageState = { pageIndex: number; pageSize: number; sortColumn: SortColumn; sortDirection: 'ASC' | 'DESC' };
type MailDocument = { mail: Record<string, unknown> };

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: false });
const builder = new XMLBuilder({ ignoreAttributes: false, format: true });
const notificationFields: { field: NotificationFilter; formName: string; key: string }[] = [
  { field: 'notificationTypeApply', formName: 'NotificationTypeApply', key: 'Apply' },
  { field: 'notificationTypeRemand', formName: 'NotificationTypeRemand', key: 'Remand' },
  { field: 'notificationTypeApprove', formName: 'NotificationTypeApprove', key: 'Approve' },
  { field: 'notificationTypeEdit', formName: 'NotificationTypeEdit', key: 'Edit' },
  { field: 'notificationTypeComplete', formName: 'NotificationTypeComplete', key: 'Complete' },
  { field: 'notificationTypeChange', formName: 'NotificationTypeChange', key: 'Change' },
  { field: 'notificationTypeTerminal', formName: 'NotificationTypeTerminal', key: 'Terminal' },
  { field: 'notificationTypeTerminalApprove', formName: 'NotificationTypeTerminalApprove', key: 'TerminalApprove' },
  { field: 'notificationTypeDefApply', formName: 'NotificationTypeDefApply', key: 'DefApply' },
  { field: 'notificationTypeDefRemand', formName: 'NotificationTypeDefRemand', key: 'DefRemand' },
  { field: 'notificationTypeDefApprove', formName: 'NotificationTypeDefApprove', key: 'DefApprove' },
];
const notificationLabels: Record<string, string> = {
  apply: 'Application',
  remand: 'Rejection',
  approve: 'Approval',
  edit: 'Save in editing',
  complete: 'Completion',
  change: 'Change',
  terminal: 'Device application',
  terminalapprove: 'Device approval',
  defapply: 'Form application',
  defremand: 'Form rejection',
  defapprove: 'Form approval',
  schedule: 'Schedule registration notice',
};
const sortColumns: Record<string, SortColumn> = {
  send_time: 'send_time',
  status: 'status',
  notification_type: 'notification_type',
  template_id: 'template_id',
  destination: 'destination',
  subject: 'subject',
  content: 'content',
  error_message: 'error_message',
};
const pageSizeFallback = [{ value: 20, text: '20' }];
const defaultPageSize = 20;
const csvHeaders = [
  'Send date and time',
  'Status',
  'Notification type',
  'Name of template',
  'Destination',
  'Title',
  'Message',
  'Contents of error',
];
const mailTypes = [...notificationFields.map((item) => item.key), 'Schedule'];

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
  return (Array.isArray(raw) ? raw : [raw]).some((item) => item === 'true' || item === 'on' || item === '1');
}

function readFilters(source: FormValues, isGet: boolean): MailLogFilters {
  const filters: MailLogFilters = {
    sendTimeFrom: value(source, 'WhereData.SendTimeFrom'),
    sendTimeFromHour: value(source, 'WhereData.SendTimeFromHour'),
    sendTimeTo: value(source, 'WhereData.SendTimeTo'),
    sendTimeToHour: value(source, 'WhereData.SendTimeToHour'),
    statusSuccess: checked(source, 'WhereData.StatusSuccess', isGet),
    statusFailure: checked(source, 'WhereData.StatusFailure', isGet),
    notificationTypeApply: false,
    notificationTypeRemand: false,
    notificationTypeApprove: false,
    notificationTypeEdit: false,
    notificationTypeComplete: false,
    notificationTypeChange: false,
    notificationTypeTerminal: false,
    notificationTypeTerminalApprove: false,
    notificationTypeDefApply: false,
    notificationTypeDefRemand: false,
    notificationTypeDefApprove: false,
  };
  for (const field of notificationFields) filters[field.field] = checked(source, `WhereData.${field.formName}`, isGet);
  return filters;
}

function parseDate(input: string): string | null {
  const value = input.trim();
  let match = value.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  let year: number;
  let month: number;
  let day: number;
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
  return date ? `${date} ${parseTime(timeInput) ?? '00:00:00'}` : null;
}

export function buildMailLogWhere(filters: MailLogFilters): { sql: string; parameters: unknown[] } {
  const clauses = ['1=1'];
  const parameters: unknown[] = [];
  const add = (clause: (index: number) => string, parameter: unknown) => {
    parameters.push(parameter);
    clauses.push(clause(parameters.length));
  };
  const sendTimeFrom = dateTimeFilter(filters.sendTimeFrom, filters.sendTimeFromHour);
  if (sendTimeFrom) add((index) => `send_time >= $${index}::timestamp`, sendTimeFrom);
  const sendTimeTo = dateTimeFilter(filters.sendTimeTo, filters.sendTimeToHour);
  if (sendTimeTo) add((index) => `send_time <= $${index}::timestamp`, sendTimeTo);
  if (filters.statusSuccess !== filters.statusFailure)
    clauses.push(filters.statusSuccess ? 'error_message IS NULL' : 'error_message IS NOT NULL');
  const selectedTypes = notificationFields.filter((field) => filters[field.field]).map((field) => field.key);
  if (selectedTypes.length > 0 && selectedTypes.length !== mailTypes.length) {
    add((index) => `notification_type = ANY($${index}::text[])`, selectedTypes);
  }
  return { sql: clauses.join(' AND '), parameters };
}

function readPageState(
  source: FormValues,
  settings: { defaultPageSize: number; pageSizeOptions: { value: number; text: string }[] },
  action: string,
): PageState {
  if (action === 'SearchType')
    return { pageIndex: 0, pageSize: settings.defaultPageSize, sortColumn: 'send_time', sortDirection: 'DESC' };
  const requestedPageSize = Number(value(source, 'PageData.PageSize'));
  const pageSize = settings.pageSizeOptions.some((option) => option.value === requestedPageSize)
    ? requestedPageSize
    : settings.defaultPageSize;
  const requestedPageIndex = Number(value(source, 'PageData.PageIndex'));
  const pageIndex =
    Number.isSafeInteger(requestedPageIndex) && requestedPageIndex >= 0 ? Math.min(requestedPageIndex, 10000) : 0;
  const sortColumn = sortColumns[value(source, 'PageData.SortColumn').toLowerCase()] ?? 'send_time';
  const requestedDirection = value(source, 'PageData.SortDirection').toUpperCase();
  const sortDirection = requestedDirection === 'ASC' || requestedDirection === 'DESC' ? requestedDirection : 'DESC';
  return { pageIndex, pageSize, sortColumn, sortDirection };
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
    .filter((option) => Number.isSafeInteger(option.value) && option.value > 0 && option.value <= 10000)
    .filter((option, index, rows) => rows.findIndex((candidate) => candidate.value === option.value) === index);
  const configuredDefault = Number(defaultValue);
  const safeDefaultPageSize =
    Number.isSafeInteger(configuredDefault) && configuredDefault > 0 && configuredDefault <= 10000
      ? configuredDefault
      : (pageSizeOptions[0]?.value ?? defaultPageSize);
  if (!pageSizeOptions.length) pageSizeOptions.push({ value: safeDefaultPageSize, text: String(safeDefaultPageSize) });
  const configuredLimit = Number(downloadValue);
  const limitOfDownloadCount = Number.isSafeInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : 0;
  return { pageSizeOptions, defaultPageSize: safeDefaultPageSize, limitOfDownloadCount };
}

function destinationValue(value: unknown): Destination {
  const parsed = xmlObject(typeof value === 'string' ? JSON.parse(value) : value);
  const addresses = (key: 'to' | 'cc' | 'bcc') => {
    const items = parsed[key];
    return Array.isArray(items) ? items.map((item) => String(item ?? '')) : [];
  };
  return { to: addresses('to'), cc: addresses('cc'), bcc: addresses('bcc') };
}

function displayRows(rows: MailLogRecord[]): MailLogDisplay[] {
  return rows.map((row) => {
    const content = row.content ?? '';
    const notificationType = notificationLabels[row.notification_type.toLowerCase()];
    if (!notificationType) throw new Error('Unknown mail notification type.');
    return {
      logId: String(row.log_id),
      statusLabel: row.status === '0' ? 'Succeeded to send' : 'Failed to send',
      notificationType,
      templateName: row.template_name ?? '',
      destination: destinationValue(row.destination),
      subject: row.subject ?? '',
      content,
      contentShortend: content.length > 50 ? `${content.slice(0, 50)}...` : content,
      sendTime: row.send_time_display ?? '',
      sendTimeCsv: row.send_time_csv ?? '',
      errorMessage: row.error_message ?? '',
    };
  });
}

function csvRows(rows: MailLogDisplay[], limit: number): string {
  const lines = [csvHeaders.map((value) => `"${value.replaceAll('"', '""')}"`).join(',')];
  for (const row of rows.slice(0, limit > 0 ? limit : rows.length)) {
    const destinations = [
      row.destination.to.length ? `To:${row.destination.to.join(',')}` : '',
      row.destination.cc.length ? ` Cc:${row.destination.cc.join(',')}` : '',
      row.destination.bcc.length ? ` Bcc:${row.destination.bcc.join(',')}` : '',
    ].join('');
    lines.push(
      [
        row.sendTimeCsv,
        row.statusLabel,
        row.notificationType,
        row.templateName,
        destinations,
        row.subject,
        row.content,
        row.errorMessage,
      ]
        .map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`)
        .join(','),
    );
  }
  if (limit > 0 && rows.length > limit) {
    const truncation = `Truncated to ${limit.toLocaleString('en-US')} records.`;
    lines.push(`"${truncation.replaceAll('"', '""')}"`);
  }
  return `${lines.join('\r\n')}\r\n`;
}

function xmlObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function xmlText(parent: unknown, key: string): string {
  const value = xmlObject(parent)[key];
  return value == null ? '' : String(value);
}

async function loadMailDocument(db: pg.Pool): Promise<MailDocument> {
  const row = (await db.query<{ xml_data: string }>("SELECT xml_data FROM mst_mail WHERE mail_file_name='Mail.xml'"))
    .rows[0];
  if (!row?.xml_data) throw new Error('Mail settings record is missing.');
  const parsed = xmlObject(parser.parse(row.xml_data));
  const mail = xmlObject(parsed.mail);
  if (!Object.hasOwn(mail, 'smtp')) throw new Error('Mail.xml has an invalid structure.');
  return { mail };
}
async function saveMailDocument(db: pg.Pool, document: MailDocument): Promise<void> {
  try {
    await db.query("UPDATE mst_mail SET xml_data=$1 WHERE mail_file_name='Mail.xml'", [builder.build(document)]);
  } catch {
    // Preserve the legacy best-effort token-cache update.
  }
}

async function accessToken(db: pg.Pool, document: MailDocument): Promise<string> {
  const mail = xmlObject(document.mail);
  const oauth = xmlObject(mail.oauth);
  if (!Object.hasOwn(oauth, 'token')) return '';
  const token = xmlObject(oauth.token);
  const currentAccessToken = xmlText(token, 'accessToken');
  const refreshToken = xmlText(token, 'refreshToken');
  const expiresOn = Date.parse(xmlText(token, 'expiresOn'));
  if (!Number.isFinite(expiresOn)) throw new Error('Invalid OAuth token expiration date.');
  if (Date.now() <= expiresOn - 300000) return currentAccessToken;

  const provider = xmlText(oauth, 'provider');
  const tenant = xmlText(oauth, 'tenantId');
  const tokenUrl =
    provider === 'google'
      ? 'https://oauth2.googleapis.com/token'
      : `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: xmlText(oauth, 'clientId'),
      client_secret: xmlText(oauth, 'clientSecret'),
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (response.status !== 200) {
    delete oauth.token;
    delete oauth.user;
    await saveMailDocument(db, document);
    return '';
  }
  const refreshed = xmlObject(await response.json());
  const newAccessToken = typeof refreshed.access_token === 'string' ? refreshed.access_token : '';
  const expiresIn = Number(refreshed.expires_in);
  if (!newAccessToken || !Number.isSafeInteger(expiresIn)) throw new Error('OAuth token response is invalid.');
  const expiresAt = new Date(Date.now() + expiresIn * 1000);
  token.accessToken = newAccessToken;
  token.expiresOn = `${expiresAt.getFullYear()}/${String(expiresAt.getMonth() + 1).padStart(2, '0')}/${String(expiresAt.getDate()).padStart(2, '0')} ${String(expiresAt.getHours()).padStart(2, '0')}:${String(expiresAt.getMinutes()).padStart(2, '0')}:${String(expiresAt.getSeconds()).padStart(2, '0')}`;
  token.refreshToken = typeof refreshed.refresh_token === 'string' ? refreshed.refresh_token : refreshToken;
  oauth.token = token;
  await saveMailDocument(db, document);
  return newAccessToken;
}
async function sendMail(
  db: pg.Pool,
  document: MailDocument,
  record: { subject: string; content: string; priority: string; destination: Destination },
): Promise<void> {
  const mail = xmlObject(document.mail);
  const oauth = xmlObject(mail.oauth);
  const useOAuth = Object.hasOwn(mail, 'oauth');
  const mailPriority = record.priority === 'High' ? 'high' : record.priority === 'Low' ? 'low' : 'normal';
  if (!useOAuth) {
    const smtp = xmlObject(mail.smtp);
    const transporter = nodemailer.createTransport({
      host: xmlText(smtp, 'server'),
      port: Number(xmlText(smtp, 'port')),
      secure: false,
      requireTLS: xmlText(smtp, 'ssl') === 'true',
      auth: { user: xmlText(smtp, 'user'), pass: xmlText(smtp, 'pass') },
      connectionTimeout: 30000,
    });
    await transporter.sendMail({
      from: xmlText(smtp, 'user'),
      to: record.destination.to,
      cc: record.destination.cc,
      bcc: record.destination.bcc,
      subject: record.subject.replace(/[\r\n]/g, ' '),
      text: record.content,
      priority: mailPriority,
    });
    return;
  }

  const provider = xmlText(oauth, 'provider');
  if (provider !== 'google' && provider !== 'microsoft') throw new Error('Unknown mail OAuth provider.');
  const token = await accessToken(db, document);
  if (!token) throw new Error('Failed to acquire OAuth access token.');
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const subject = record.subject.replace(/[\r\n]/g, ' ');
  let response: globalThis.Response;
  if (provider === 'google') {
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
    const generated: unknown = await transport.sendMail({
      to: record.destination.to,
      cc: record.destination.cc,
      bcc: record.destination.bcc,
      subject,
      text: record.content,
      priority: mailPriority,
    });
    const generatedMessage =
      generated && typeof generated === 'object' && 'message' in generated ? generated.message : null;
    if (!Buffer.isBuffer(generatedMessage)) throw new Error('Could not prepare the mail message.');
    const raw = generatedMessage.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    const user = xmlText(oauth, 'user');
    response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(user)}/messages/send`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ raw }),
      signal: AbortSignal.timeout(30000),
    });
  } else {
    const recipients = (addresses: string[]) => addresses.map((address) => ({ emailAddress: { address } }));
    response = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({
        message: {
          subject,
          importance: mailPriority,
          body: { contentType: 'Text', content: record.content },
          toRecipients: recipients(record.destination.to),
          ccRecipients: recipients(record.destination.cc),
          bccRecipients: recipients(record.destination.bcc),
        },
        saveToSentItems: false,
      }),
    });
  }
  if (response.status !== (provider === 'google' ? 200 : 202)) {
    const body = await response.text();
    let message = body;
    try {
      const data = xmlObject(JSON.parse(body));
      const error = data.error;
      if (error && typeof error === 'object' && !Array.isArray(error)) message = xmlText(error, 'message') || body;
      else if (typeof error === 'string')
        message = `${error}${typeof data.error_description === 'string' && data.error_description ? `: ${data.error_description}` : ''}`;
    } catch {
      // Non-JSON provider responses keep the existing fallback body.
    }
    throw new Error(`${response.status}: ${message}`);
  }
}

async function insertMailLog(
  db: pg.Pool,
  record: {
    notificationType: string;
    templateId: string;
    templateName: string;
    destination: Destination;
    subject: string;
    content: string;
    priority: string;
    errorMessage: string | null;
    userId: string;
  },
): Promise<void> {
  const sequence = (await db.query<{ id: string }>("SELECT nextval('conmas_mail_send_log_seq')::text AS id")).rows[0]
    ?.id;
  if (!sequence) throw new Error('Mail send log sequence is unavailable.');
  const now = new Date();
  const logId = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}${sequence.padStart(20, '0')}`;
  await db.query(
    `INSERT INTO conmas_mail_send_log(
    log_id,notification_type,template_id,template_name,destination,subject,content,priority,send_time,error_message,ireporter_user
  ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now(),$9,$10)`,
    [
      logId,
      record.notificationType,
      record.templateId,
      record.templateName,
      JSON.stringify(record.destination),
      record.subject,
      record.content,
      record.priority,
      record.errorMessage,
      record.userId,
    ],
  );
}

function selectedLogIds(source: FormValues): string[] {
  const selected = new Map<number, { id: string; checked: boolean }>();
  for (const [key, raw] of Object.entries(source)) {
    const match = key.match(/^SendLogList\[(\d+)\]\.(IsSelect|LogId)$/);
    if (!match) continue;
    const index = Number(match[1]);
    const entry = selected.get(index) ?? { id: '', checked: false };
    const item = Array.isArray(raw) ? raw.at(-1) : raw;
    if (match[2] === 'LogId' && typeof item === 'string') entry.id = item;
    if (match[2] === 'IsSelect')
      entry.checked = (Array.isArray(raw) ? raw : [raw]).some(
        (item) => item === 'true' || item === 'on' || item === '1',
      );
    selected.set(index, entry);
  }
  return [...selected.values()].filter((item) => item.checked && /^\d{1,64}$/.test(item.id)).map((item) => item.id);
}

function show(
  res: ExpressResponse,
  render: (res: ExpressResponse, data: Record<string, unknown>) => unknown,
  page: Record<string, unknown>,
) {
  return render(res, {
    active: 'System',
    section: 'MailSendLog',
    login: false,
    title: 'E-mail transmission history',
    userName: res.locals.userName,
    mailLogPage: page,
  });
}

function showError(
  res: ExpressResponse,
  render: (res: ExpressResponse, data: Record<string, unknown>) => unknown,
  source: FormValues,
  isGet: boolean,
  action: string,
  access: MailLogAccess,
) {
  const settings = { defaultPageSize, pageSizeOptions: pageSizeFallback };
  const state = readPageState(source, settings, action);
  return show(res, render, {
    filters: readFilters(source, isGet),
    rows: [],
    total: 0,
    ...state,
    pageSizeOptions: pageSizeFallback,
    totalPages: 0,
    limitOfDownloadCount: 0,
    canDelete: access.canDelete,
    canResend: access.canResend,
    errorMessage: 'Server error has been occurred.',
  });
}

async function loadAccess(db: pg.Pool, userId: string): Promise<MailLogAccess> {
  const [canRead, canDelete, canResend] = await Promise.all([
    hasSystemPermission(db, userId, 'system', 'read'),
    hasSystemPermission(db, userId, 'system', 'delete'),
    hasSystemPermission(db, userId, 'system', 'edit'),
  ]);
  return { canRead, canDelete, canResend };
}

async function renderList(
  db: pg.Pool,
  res: ExpressResponse,
  render: (res: ExpressResponse, data: Record<string, unknown>) => unknown,
  source: FormValues,
  isGet: boolean,
  action: string,
  access: MailLogAccess,
) {
  const settings = await loadPageSettings(db);
  const filters = readFilters(source, isGet);
  const state = readPageState(source, settings, action);
  const where = buildMailLogWhere(filters);
  const count = await db.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM conmas_mail_send_log WHERE ${where.sql}`,
    where.parameters,
  );
  const total = Number(count.rows[0]?.total ?? 0);
  const parameters = [...where.parameters, state.pageSize, state.pageIndex * state.pageSize];
  const rows = await db.query<MailLogRecord>(
    `SELECT log_id,
    CASE WHEN error_message IS NULL THEN '0' ELSE '1' END AS status,
    notification_type,template_name,destination,subject,content,error_message,
    to_char(send_time,'FMMM/FMDD/YYYY FMHH12:MI:SS AM') AS send_time_display,
    to_char(send_time,'YYYY/MM/DD HH24:MI:SS') AS send_time_csv
    FROM conmas_mail_send_log WHERE ${where.sql} ORDER BY ${state.sortColumn} ${state.sortDirection}, log_id
    LIMIT $${parameters.length - 1} OFFSET $${parameters.length}`,
    parameters,
  );
  return show(res, render, {
    filters,
    rows: displayRows(rows.rows),
    total,
    ...state,
    pageSizeOptions: settings.pageSizeOptions,
    totalPages: Math.ceil(total / state.pageSize),
    limitOfDownloadCount: settings.limitOfDownloadCount,
    canDelete: access.canDelete,
    canResend: access.canResend,
    errorMessage: '',
  });
}

export function registerMailLogs(
  app: Express,
  db: pg.Pool,
  render: (res: ExpressResponse, data: Record<string, unknown>) => unknown,
) {
  const root = '/ConMasManager/System';
  const noAccess: MailLogAccess = { canRead: false, canDelete: false, canResend: false };

  app.get(`${root}/MailSendLog`, async (req: Request, res: ExpressResponse) => {
    let access: MailLogAccess;
    try {
      access = await loadAccess(db, req.session?.userId ?? '');
    } catch {
      return showError(res, render, {}, true, '', noAccess);
    }
    if (!access.canRead) return res.status(403).type('text/plain').send('Role authority is insufficient.');
    try {
      return await renderList(db, res, render, {}, true, '', access);
    } catch {
      return showError(res, render, {}, true, '', access);
    }
  });

  app.post(`${root}/MailSendLog`, async (req: Request, res: ExpressResponse) => {
    const source = req.body as FormValues;
    const action = value(source, 'ActionCommonType');
    const resendLogId = value(source, 'resendLogId');
    let access: MailLogAccess;
    try {
      access = await loadAccess(db, req.session?.userId ?? '');
    } catch {
      return showError(res, render, source, false, action, noAccess);
    }
    if (!access.canRead || (action === 'DeleteType' && !access.canDelete) || (resendLogId && !access.canResend))
      return res.status(403).type('text/plain').send('Role authority is insufficient.');

    try {
      if (action === 'CsvType') {
        const settings = await loadPageSettings(db);
        const filters = readFilters(source, false);
        const state = readPageState(source, settings, action);
        const where = buildMailLogWhere(filters);
        const parameters = [...where.parameters];
        const limitClause =
          settings.limitOfDownloadCount > 0 ? ` LIMIT $${parameters.push(settings.limitOfDownloadCount + 1)}` : '';
        const rows = await db.query<MailLogRecord>(
          `SELECT log_id,
          CASE WHEN error_message IS NULL THEN '0' ELSE '1' END AS status,
          notification_type,template_name,destination,subject,content,error_message,
          to_char(send_time,'FMMM/FMDD/YYYY FMHH12:MI:SS AM') AS send_time_display,
          to_char(send_time,'YYYY/MM/DD HH24:MI:SS') AS send_time_csv
          FROM conmas_mail_send_log WHERE ${where.sql} ORDER BY ${state.sortColumn} ${state.sortDirection}, log_id${limitClause}`,
          parameters,
        );
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="mailSendLog.csv"');
        return res.send(
          Buffer.concat([
            Buffer.from([0xef, 0xbb, 0xbf]),
            Buffer.from(csvRows(displayRows(rows.rows), settings.limitOfDownloadCount), 'utf8'),
          ]),
        );
      }

      if (action === 'DeleteType') {
        const ids = selectedLogIds(source);
        if (ids.length) await db.query('DELETE FROM conmas_mail_send_log WHERE log_id = ANY($1::text[])', [ids]);
      } else if (resendLogId) {
        const row = (
          await db.query<{
            log_id: string;
            notification_type: string;
            template_id: string;
            template_name: string;
            destination: unknown;
            subject: string | null;
            content: string | null;
            priority: string | null;
          }>(
            'SELECT log_id,notification_type,template_id,template_name,destination,subject,content,priority FROM conmas_mail_send_log WHERE log_id=$1',
            [resendLogId],
          )
        ).rows[0];
        if (row) {
          const record = {
            notificationType: row.notification_type,
            templateId: row.template_id ?? '',
            templateName: row.template_name ?? '',
            destination: destinationValue(row.destination),
            subject: row.subject ?? '',
            content: row.content ?? '',
            priority: row.priority ?? 'Normal',
          };
          const document = await loadMailDocument(db);
          if (
            Object.hasOwn(document.mail, 'oauth') &&
            !['google', 'microsoft'].includes(xmlText(document.mail.oauth, 'provider'))
          )
            throw new Error('Unknown mail OAuth provider.');
          try {
            await sendMail(db, document, record);
            await insertMailLog(db, { ...record, errorMessage: null, userId: req.session?.userId ?? '' });
          } catch (error) {
            await insertMailLog(db, {
              ...record,
              errorMessage: error instanceof Error ? error.message : String(error),
              userId: req.session?.userId ?? '',
            });
          }
        }
      }
      return await renderList(db, res, render, source, false, action, access);
    } catch {
      return showError(res, render, source, false, action, access);
    }
  });
}
