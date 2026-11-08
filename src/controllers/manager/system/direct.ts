import { licenseStatus } from '../../../shared/license-counts.js';
import type { Express, Request, Response } from 'express';
import type pg from 'pg';
import { setTimeout as sleep } from 'node:timers/promises';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { legacyDecrypt, legacyDirectKey } from '../../../shared/legacy-auth.js';
import { hasSystemPermission } from '../../../middleware/manager/system/permissions.js';

type Xml = Record<string, unknown>;
type DirectSetting = {
  clientId: string;
  clientSecret: string;
  redirectUrl: string;
  refreshToken: string;
  notification: Record<string, boolean>;
};
type Destination = { destinationType: string; domainId: string; destinationDirect: string; domainName?: string };
type DirectTemplate = { templateId: string; templateName: string; content: string; destinations: Destination[] };
type DirectSettingForm = { clientId: string; clientSecret: string; redirectUrl: string };
type Render = (res: Response, data: Record<string, unknown>) => unknown;
type DirectLogFilters = Record<string, string | boolean>;
type DirectLogRow = Record<string, string | number | boolean | null>;

declare module 'express-session' {
  interface SessionData {
    directAuthorization?: { state: string; model: DirectSettingForm };
  }
}

const root = '/ConMasManager/System';
const templateKeys = [
  'Apply',
  'Remand',
  'Approve',
  'Edit',
  'Complete',
  'Change',
  'Terminal',
  'TerminalApprove',
  'DefApply',
  'DefRemand',
  'DefApprove',
  'Schedule',
] as const;
const notificationFields = [
  'apply',
  'remand',
  'approve',
  'edit',
  'complete',
  'change',
  'terminal',
  'terminalapprove',
  'defapply',
  'defremand',
  'defapprove',
  'schedule',
] as const;
const destinationTypes = [
  'direct',
  'login_user',
  'applicant',
  'approver',
  'cluster_role_holder',
  'report_role_holder',
  ...Array.from({ length: 10 }, (_, index) => `report_remarks${index + 1}`),
  'report_cluster_value',
  'def_applicant',
  'def_approver',
  'def_update_role',
  'rep_create_role',
  'terminal_applicant',
  'schedule_user',
  'talk_name',
] as const;
const templateNames: Record<(typeof templateKeys)[number], string> = {
  Apply: 'Application',
  Remand: 'Rejection',
  Approve: 'Approval',
  Edit: 'Save in editing',
  Complete: 'Completion',
  Change: 'Change',
  Terminal: 'Device application',
  TerminalApprove: 'Device approval',
  DefApply: 'Form application',
  DefRemand: 'Form rejection',
  DefApprove: 'Form approval',
  Schedule: 'Schedule registration notice',
};
const destinationNames: Record<string, string> = {
  direct: 'Direct input',
  login_user: 'Log-in user',
  applicant: 'Applicant ID',
  approver: 'Approver',
  cluster_role_holder: 'Authority group for cluster.',
  report_role_holder: 'Authority group for document.',
  report_cluster_value: 'Inpput value',
  def_applicant: 'Form applicant',
  def_approver: 'Form approver',
  def_update_role: 'User having authority of editing form',
  rep_create_role: 'User having authority of issuing',
  terminal_applicant: 'Applicant of device',
  schedule_user: 'Schedule person',
  talk_name: 'direct group talk name',
};
for (let index = 1; index <= 10; index++) destinationNames[`report_remarks${index}`] = `Document remarks ${index}`;
const notificationNames: Record<string, string> = {
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
const directParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: false,
  isArray: (name) => name === 'template' || name === 'destination',
});
const directBuilder = new XMLBuilder({ ignoreAttributes: false, format: true, suppressEmptyNode: false });
const emptyNotification = (): Record<string, boolean> =>
  Object.fromEntries(notificationFields.map((field) => [field, false]));
const emptyDestination = (): Destination => ({ destinationType: '', domainId: '', destinationDirect: '' });
const emptyTemplate = (): DirectTemplate => ({
  templateId: '',
  templateName: '',
  content: '',
  destinations: Array.from({ length: 10 }, emptyDestination),
});
const asObject = (value: unknown): Xml =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Xml) : {};
const asText = (value: unknown): string => (typeof value === 'string' ? value : value == null ? '' : String(value));
const field = (body: Record<string, unknown>, key: string): string => asText(body[key]);
const entries = (value: unknown): Xml[] =>
  Array.isArray(value) ? value.map(asObject) : value && typeof value === 'object' ? [value as Xml] : [];
const bool = (value: unknown): boolean =>
  Array.isArray(value) ? value.some(bool) : value === true || value === 'true' || value === '1' || value === 1;

class DirectApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirectApiError';
  }
}

function directXmlKey(): Buffer {
  const key = Buffer.alloc(8);
  const bytes = Buffer.from(legacyDirectKey(), 'utf8');
  for (let index = 0; index < bytes.length; index++) key[index % 8] ^= bytes[index];
  return key;
}

function encryptDirectXml(xml: string): string {
  const key = directXmlKey();
  const cipher = createCipheriv('des-ede3-cbc', Buffer.concat([key, key, key]), key);
  return Buffer.concat([cipher.update(xml, 'utf8'), cipher.final()]).toString('base64');
}

function parseXml(xml: string): Xml {
  const parsed = asObject(directParser.parse(xml));
  if (!Object.keys(parsed).length) throw new Error('Direct settings XML is empty.');
  return parsed;
}

function xmlRoot(document: Xml): Xml {
  const rootNode = asObject(document.direct);
  document.direct = rootNode;
  return rootNode;
}

function directSetting(document: Xml): DirectSetting {
  const rootNode = xmlRoot(document);
  const notification = { ...emptyNotification(), ...asObject(rootNode.notification) };
  for (const name of notificationFields) notification[name] = bool(notification[name]);
  return {
    clientId: asText(rootNode.clientId),
    clientSecret: asText(rootNode.clientSecret),
    redirectUrl: asText(rootNode.redirectUrl),
    refreshToken: asText(rootNode.refreshToken),
    notification: notification as Record<string, boolean>,
  };
}

function setDirectSetting(document: Xml, setting: DirectSetting): void {
  const rootNode = xmlRoot(document);
  rootNode.clientId = setting.clientId;
  rootNode.clientSecret = setting.clientSecret;
  rootNode.redirectUrl = setting.redirectUrl;
  rootNode.refreshToken = setting.refreshToken;
  rootNode.notification = Object.fromEntries(
    notificationFields.map((name) => [name, setting.notification[name] ? 'true' : 'false']),
  );
}

function templateSetting(document: Xml): { templates: DirectTemplate[]; defaultTemplateId: string } {
  const rootNode = xmlRoot(document);
  return {
    templates: entries(asObject(rootNode.templates).template).map((item) => ({
      templateId: asText(item.templateId),
      templateName: asText(item.templateName),
      content: asText(item.content),
      destinations: entries(asObject(item.destinations).destination).map((destination) => ({
        destinationType: asText(destination.destinationType),
        domainId: asText(destination.domainId),
        destinationDirect: asText(destination.destinationDirect),
      })),
    })),
    defaultTemplateId: asText(rootNode.defaultTemplateId),
  };
}

function setTemplateSetting(document: Xml, templates: DirectTemplate[], defaultTemplateId: string): void {
  const rootNode = xmlRoot(document);
  rootNode.templates = {
    template: templates.map((template) => ({
      templateId: template.templateId,
      templateName: template.templateName,
      content: template.content,
      destinations: {
        destination: template.destinations.map((destination) => ({
          destinationType: destination.destinationType,
          destinationDirect: destination.destinationDirect,
          domainId: destination.domainId,
        })),
      },
    })),
  };
  rootNode.defaultTemplateId = defaultTemplateId;
}

function denyUnavailableDirect(res: Response): boolean {
  try {
    if (!licenseStatus().freeDrawOnly) return false;
    res.status(403).type('text/plain').send('Role authority is insufficient.');
  } catch {
    res.status(503).type('text/plain').send('License information is unavailable.');
  }
  return true;
}

async function requirePermission(
  db: pg.Pool,
  req: Request,
  res: Response,
  scope: 'system' | 'user',
  action: 'read' | 'edit' | 'create' | 'delete',
): Promise<boolean> {
  if (!(await hasSystemPermission(db, req.session?.userId ?? '', scope, action))) {
    res.status(403).type('text/plain').send('Role error.');
    return false;
  }
  return true;
}

async function loadDirectDocument(db: pg.Pool, key: string, encrypted: boolean): Promise<Xml> {
  const row = (await db.query<{ xml_data: string | null }>('SELECT xml_data FROM mst_direct WHERE key=$1', [key]))
    .rows[0];
  if (!row?.xml_data) return { direct: {} };
  const xml = encrypted ? legacyDecrypt(row.xml_data, legacyDirectKey()) : row.xml_data;
  return parseXml(xml);
}

async function saveDirectDocument(
  db: pg.Pool,
  key: string,
  document: Xml,
  encrypted: boolean,
  req: Request,
): Promise<void> {
  const plain = directBuilder.build(document);
  const xml = encrypted ? encryptDirectXml(plain) : plain;
  const userId = req.session?.userId ?? '';
  const term = req.ip ?? '';
  await db.query(
    `INSERT INTO mst_direct(key,xml_data,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time)
    VALUES($1,$2,$3,$4,now(),$3,$4,now())
    ON CONFLICT(key) DO UPDATE SET xml_data=EXCLUDED.xml_data,sys_update_term=EXCLUDED.sys_update_term,sys_update_user=EXCLUDED.sys_update_user,sys_update_time=now()`,
    [key, xml, term, userId],
  );
}

export async function directIsLinked(db: pg.Pool): Promise<boolean> {
  try {
    const document = await loadDirectDocument(db, 'Setting', true);
    return Boolean(directSetting(document).refreshToken);
  } catch {
    return false;
  }
}

function callbackUrl(redirectUrl: string): string {
  return `${redirectUrl.replace(/\/+$/, '').replace(/\/System\/DirectAuth$/, '')}/System/DirectAuth`;
}

async function directRequest(
  url: string,
  method: 'GET' | 'POST',
  accessToken = '',
  form?: Record<string, string>,
  json?: string,
): Promise<string> {
  let status = 'unknown';
  let errorMessage = 'null';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const headers: Record<string, string> = {};
      if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
      if (json !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(url, {
        method,
        headers,
        body: json ?? (form ? new URLSearchParams(form) : undefined),
      });
      if (response.status === 200) return await response.text();
      status = `${response.status}(${response.statusText})`;
      errorMessage = 'null';
    } catch (error) {
      status = '0(0)';
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    if (attempt < 2) await sleep(300);
  }
  throw new DirectApiError(
    `direct API request failed 3 times. URL:${url} StatusCode:${status} ErrorMessage:${errorMessage}`,
  );
}

async function directJson(
  url: string,
  method: 'GET' | 'POST',
  accessToken = '',
  form?: Record<string, string>,
  json?: string,
): Promise<Xml> {
  const body = await directRequest(url, method, accessToken, form, json);
  const parsed = JSON.parse(body) as unknown;
  return asObject(parsed);
}

async function accessToken(db: pg.Pool, req: Request, settingDocument?: Xml): Promise<string> {
  const document = settingDocument ?? (await loadDirectDocument(db, 'Setting', true));
  const setting = directSetting(document);
  if (!setting.refreshToken) return '';
  const result = await directJson('https://direct4b.com/oauth2/token', 'POST', '', {
    client_id: setting.clientId,
    client_secret: setting.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: setting.refreshToken,
  });
  const token = asText(result.access_token);
  const refreshToken = asText(result.refresh_token);
  if (!token || !refreshToken) throw new Error('Direct token response is incomplete.');
  setting.refreshToken = refreshToken;
  setDirectSetting(document, setting);
  await saveDirectDocument(db, 'Setting', document, true, req);
  return token;
}

async function directDomains(db: pg.Pool, req: Request): Promise<{ value: string; label: string }[]> {
  const token = await accessToken(db, req);
  if (!token) return [];
  const response = await directRequest('https://restapi.direct4b.com/albero-app-server/domains', 'GET', token);
  const domains = JSON.parse(response) as Xml[];
  return domains
    .filter((domain) => Number(asObject(domain.role).type) !== 30 && !bool(domain.frozen))
    .sort((a, b) => {
      const left = BigInt(asText(a.domain_id) || '0');
      const right = BigInt(asText(b.domain_id) || '0');
      return left < right ? -1 : left > right ? 1 : 0;
    })
    .map((domain) => ({ value: asText(domain.domain_id), label: asText(domain.domain_name) }));
}

function selectedDirectDestinationOptions(key: string): { value: string; label: string }[] {
  const options: string[] = ['direct'];
  if (key !== 'TerminalApprove') options.push('login_user');
  if (['Apply', 'Remand', 'Approve', 'Change'].includes(key))
    options.push('applicant', 'approver', 'cluster_role_holder');
  if (!['TerminalApprove', 'DefApply', 'DefRemand', 'DefApprove', 'Schedule', 'Terminal'].includes(key)) {
    options.push('report_role_holder', ...Array.from({ length: 10 }, (_, index) => `report_remarks${index + 1}`));
  }
  if (key === 'Change') options.push('report_cluster_value');
  if (['DefApply', 'DefRemand', 'DefApprove'].includes(key))
    options.push('def_applicant', 'def_approver', 'def_update_role', 'rep_create_role');
  if (key === 'TerminalApprove') options.push('terminal_applicant');
  if (key === 'Schedule') options.push('schedule_user');
  options.push('talk_name');
  return [{ value: '', label: '' }, ...options.map((value) => ({ value, label: destinationNames[value] ?? value }))];
}

function validateTemplate(template: DirectTemplate): string[] {
  const errors: string[] = [];
  if (!template.templateName.trim()) errors.push('Template name is required.');
  else if (template.templateName.includes(',')) errors.push("Template name must not contain ','.");
  if (!template.content.trim()) errors.push('Message body is required.');
  return errors;
}

function readTemplateModel(body: Record<string, unknown>): {
  key: string;
  template: DirectTemplate;
  isDefaultTemplate: boolean;
  testDomainId: string;
  testMailAddress: string;
  testTemplateName: string;
  testContent: string;
} {
  const templateId = field(body, 'template.templateId');
  const destinations = Array.from({ length: 10 }, (_, index) => ({
    destinationType: field(body, `template.destinations[${index}].destinationType`),
    domainId: field(body, `template.destinations[${index}].domainId`),
    destinationDirect: field(body, `template.destinations[${index}].destinationDirect`),
  }));
  return {
    key: field(body, 'key'),
    template: {
      templateId,
      templateName: field(body, 'template.templateName'),
      content: field(body, 'template.content'),
      destinations,
    },
    isDefaultTemplate: bool(body.isDefaultTemplate),
    testDomainId: field(body, 'testDomainId'),
    testMailAddress: field(body, 'testMailAddress'),
    testTemplateName: field(body, 'testTemplateName'),
    testContent: field(body, 'testContent'),
  };
}

function completeTemplate(template: DirectTemplate): DirectTemplate {
  const destinations = template.destinations.slice(0, 10);
  while (destinations.length < 10) destinations.push(emptyDestination());
  return { ...template, destinations };
}

function directDateTime(date: string, time: string, dateFormat: string): string | null {
  if (!date) return null;
  const parts = date.split(/[./-]/);
  if (parts.length !== 3 || parts.some((part) => !/^\d+$/.test(part))) return null;
  const formatParts = dateFormat.match(/yy|y|mm|m|dd|d/g)?.map((part) => part[0]);
  const order =
    formatParts?.length === 3
      ? formatParts
      : parts[0].length === 4
        ? ['y', 'm', 'd']
        : parts[0].length > 2
          ? ['d', 'm', 'y']
          : ['m', 'd', 'y'];
  const year = Number(parts[order.indexOf('y')]);
  const month = Number(parts[order.indexOf('m')]);
  const day = Number(parts[order.indexOf('d')]);
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const dateCheck = new Date(Date.UTC(year, month - 1, day));
  if (dateCheck.getUTCFullYear() !== year || dateCheck.getUTCMonth() !== month - 1 || dateCheck.getUTCDate() !== day)
    return null;
  const clock = time.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  const hour = clock ? Number(clock[1]) : 0;
  const minute = clock ? Number(clock[2]) : 0;
  const second = clock ? Number(clock[3] ?? 0) : 0;
  if (hour > 23 || minute > 59 || second > 59) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
}

const notificationFilterKeys: [string, string][] = [
  ['Apply', 'NotificationTypeApply'],
  ['Remand', 'NotificationTypeRemand'],
  ['Approve', 'NotificationTypeApprove'],
  ['Edit', 'NotificationTypeEdit'],
  ['Complete', 'NotificationTypeComplete'],
  ['Change', 'NotificationTypeChange'],
  ['Terminal', 'NotificationTypeTerminal'],
  ['TerminalApprove', 'NotificationTypeTerminalApprove'],
  ['DefApply', 'NotificationTypeDefApply'],
  ['DefRemand', 'NotificationTypeDefRemand'],
  ['DefApprove', 'NotificationTypeDefApprove'],
  ['Schedule', 'NotificationTypeSchedule'],
];
const destinationFilterKeys: [string, string][] = [
  ['direct', 'DestinationTypeDirect'],
  ['login_user', 'DestinationTypeLoginUser'],
  ['applicant', 'DestinationTypeApplicant'],
  ['approver', 'DestinationTypeApprover'],
  ['cluster_role_holder', 'DestinationTypeClusterRoleHolder'],
  ['report_role_holder', 'DestinationTypeReportRoleHolder'],
  ...Array.from(
    { length: 10 },
    (_, index) => [`report_remarks${index + 1}`, `DestinationTypeReportRemarks${index + 1}`] as [string, string],
  ),
  ['report_cluster_value', 'DestinationTypeReportClusterValue'],
  ['def_applicant', 'DestinationTypeDefApplicant'],
  ['def_approver', 'DestinationTypeDefApprover'],
  ['def_update_role', 'DestinationTypeDefUpdateRole'],
  ['rep_create_role', 'DestinationTypeRepCreateRole'],
  ['terminal_applicant', 'DestinationTypeTerminalApplicant'],
  ['schedule_user', 'DestinationTypeScheduleUser'],
  ['talk_name', 'DestinationTypeTalkName'],
];
const sortableColumns: Record<string, string> = {
  send_time: 'send_time',
  status: 'status',
  notification_type: 'notification_type',
  template_id: 'template_id',
  destination_type: 'destination_type',
  destination_mail_address: 'destination_mail_address',
  destination_group_talk_id: 'destination_group_talk_id',
  content: 'content',
  error_message: 'error_message',
};

function readLogFilters(body: Record<string, unknown>, defaults = false): DirectLogFilters {
  const filters: DirectLogFilters = {
    SendTimeFrom: field(body, 'WhereData.SendTimeFrom'),
    SendTimeFromHour: field(body, 'WhereData.SendTimeFromHour'),
    SendTimeTo: field(body, 'WhereData.SendTimeTo'),
    SendTimeToHour: field(body, 'WhereData.SendTimeToHour'),
    DateFormat: field(body, 'WhereData.DateFormat'),
    TemplateName: field(body, 'WhereData.TemplateName'),
  };
  for (const [, key] of notificationFilterKeys) filters[key] = defaults || bool(body[`WhereData.${key}`]);
  for (const [, key] of destinationFilterKeys) filters[key] = defaults || bool(body[`WhereData.${key}`]);
  filters.StatusSuccess = defaults || bool(body['WhereData.StatusSuccess']);
  filters.StatusFailure = defaults || bool(body['WhereData.StatusFailure']);
  return filters;
}

function logWhere(filters: DirectLogFilters, values: unknown[]): string {
  const clauses: string[] = [];
  const dateFormat = String(filters.DateFormat ?? '');
  const from = directDateTime(String(filters.SendTimeFrom ?? ''), String(filters.SendTimeFromHour ?? ''), dateFormat);
  const to = directDateTime(String(filters.SendTimeTo ?? ''), String(filters.SendTimeToHour ?? ''), dateFormat);
  if (from) {
    values.push(from);
    clauses.push(`send_time >= $${values.length}`);
  }
  if (to) {
    values.push(to);
    clauses.push(`send_time <= $${values.length}`);
  }
  if (Boolean(filters.StatusSuccess) !== Boolean(filters.StatusFailure))
    clauses.push(filters.StatusSuccess ? 'error_message IS NULL' : 'error_message IS NOT NULL');
  const notifications = notificationFilterKeys.filter(([, key]) => Boolean(filters[key])).map(([value]) => value);
  if (notifications.length && notifications.length !== templateKeys.length) {
    values.push(notifications);
    clauses.push(`notification_type = ANY($${values.length}::text[])`);
  }
  const destinations = destinationFilterKeys.filter(([, key]) => Boolean(filters[key])).map(([value]) => value);
  if (destinations.length && destinations.length !== destinationTypes.length) {
    values.push(destinations);
    clauses.push(`destination_type = ANY($${values.length}::text[])`);
  }
  const name = String(filters.TemplateName ?? '').trim();
  if (name) {
    values.push(`%${name}%`);
    clauses.push(`template_name ILIKE $${values.length}`);
  }
  return clauses.length ? ` AND ${clauses.join(' AND ')}` : '';
}

async function directLogRows(
  db: pg.Pool,
  filters: DirectLogFilters,
  sortColumn: string,
  sortDirection: string,
  limit?: number,
  offset = 0,
): Promise<DirectLogRow[]> {
  const values: unknown[] = [];
  const where = logWhere(filters, values);
  const column = sortableColumns[sortColumn] ?? 'send_time';
  const direction = sortDirection === 'ASC' ? 'ASC' : 'DESC';
  let pagination = '';
  if (limit !== undefined) {
    values.push(limit);
    pagination += ` LIMIT $${values.length}`;
  }
  if (offset > 0) {
    values.push(offset);
    pagination += ` OFFSET $${values.length}`;
  }
  const result = await db.query(
    `SELECT log_id,CASE WHEN error_message IS NULL THEN 0 ELSE 1 END AS status,notification_type,template_id,template_name,destination_type,destination_mail_address,destination_group_talk_id,content,send_time,to_char(send_time,'YYYY/MM/DD HH24:MI') AS send_time_formatted,to_char(send_time,'YYYY/MM/DD HH24:MI:SS') AS send_time_csv,error_message
    FROM conmas_direct_send_log WHERE 1=1${where} ORDER BY ${column} ${direction},log_id${pagination}`,
    values,
  );
  return result.rows as DirectLogRow[];
}

function presentDirectLog(row: DirectLogRow): DirectLogRow {
  const notification = String(row.notification_type ?? '');
  const destination = String(row.destination_type ?? '');
  const content = String(row.content ?? '');
  const sendTime = String(row.send_time_formatted ?? '');
  return {
    ...row,
    NotificationType: templateNames[notification as keyof typeof templateNames] ?? notification,
    DestinationType: destination === 'test' ? 'Test sending' : (destinationNames[destination] ?? destination),
    SendTime: sendTime,
    Status: row.error_message == null ? 'Succeeded to send' : 'Failed to send',
    Content: content,
    ContentShortend: content.length > 50 ? `${content.substring(0, 50)}...` : content,
  };
}

async function directDownloadLimit(db: pg.Pool): Promise<number> {
  const value = (
    await db.query<{ com_value: string }>(
      "SELECT com_value FROM mst_common WHERE com_key='CSV_DOWNLOAD_SETTING' AND com_name='LIMIT_OF_DOWNLOAD_COUNT' ORDER BY com_index LIMIT 1",
    )
  ).rows[0]?.com_value;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit > 0 ? limit : 0;
}

function csv(value: unknown): string {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

async function directCsv(
  db: pg.Pool,
  filters: DirectLogFilters,
  sortColumn: string,
  sortDirection: string,
): Promise<{ data: Buffer; limit: number }> {
  const limit = await directDownloadLimit(db);
  const rows = await directLogRows(db, filters, sortColumn, sortDirection, limit ? limit + 1 : undefined);
  const truncated = limit > 0 && rows.length > limit;
  const exportRows = truncated ? rows.slice(0, limit) : rows;
  const headings = [
    'Send date and time',
    'Status',
    'Notification type',
    'Name of template',
    'Destination type',
    'Destination user email address',
    'Destination group talk ID',
    'Message',
    'Error message',
  ];
  const configuredEncoding =
    (
      await db.query<{ com_value: string }>(
        "SELECT com_value FROM mst_common WHERE com_key='ENCODING' ORDER BY com_index LIMIT 1",
      )
    ).rows[0]?.com_value || '65001';
  if (configuredEncoding !== '65001')
    throw new Error(
      `Direct send log CSV encoding ${configuredEncoding} is unsupported; a matching encoder is required.`,
    );
  const lines = [headings.map(csv).join(',')];
  for (const raw of exportRows) {
    const row = presentDirectLog(raw);
    lines.push(
      [
        row.send_time_csv,
        row.Status,
        row.NotificationType,
        row.template_name,
        row.DestinationType,
        row.destination_mail_address,
        row.destination_group_talk_id,
        row.Content,
        row.error_message,
      ]
        .map(csv)
        .join(','),
    );
  }
  if (truncated) lines.push(csv(`Truncated to ${limit.toLocaleString('en-US')} records.`));
  return { data: Buffer.from(lines.join('\r\n') + '\r\n', 'utf8'), limit };
}

async function deleteDirectLogs(db: pg.Pool, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await db.query('DELETE FROM conmas_direct_send_log WHERE log_id = ANY($1::text[])', [ids]);
}

async function sendMessage(access: string, talkId: string, content: string): Promise<string> {
  const result = await directJson(
    `https://restapi.direct4b.com/albero-app-server/talks/${encodeURIComponent(talkId)}/messages`,
    'POST',
    access,
    undefined,
    JSON.stringify({ type: 1, content }),
  );
  const id = asText(result.message_id);
  if (!id) throw new Error('Direct message response is incomplete.');
  return id;
}

async function createPairTalk(access: string, domainId: string, email: string): Promise<string> {
  const result = await directJson('https://restapi.direct4b.com/albero-app-server/talks/pair', 'POST', access, {
    domain_id: domainId,
    email,
  });
  const id = asText(result.talk_id);
  if (!id) throw new Error('Direct talk response is incomplete.');
  return id;
}

async function insertDirectLog(
  db: pg.Pool,
  req: Request,
  values: {
    notificationType: string;
    templateId: string;
    templateName: string;
    destinationType: string;
    domainId?: string;
    mailAddress?: string;
    talkId?: string;
    content: string;
    messageId?: string;
    errorMessage?: string;
  },
): Promise<void> {
  const sequence =
    (await db.query<{ nextval: string }>("SELECT nextval('conmas_direct_send_history_seq') AS nextval")).rows[0]
      ?.nextval ?? '0';
  const now = new Date();
  const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const logId = `${timestamp}${sequence.padStart(20, '0')}`;
  await db.query(
    `INSERT INTO conmas_direct_send_log(log_id,notification_type,template_id,template_name,destination_type,destination_domain_id,destination_mail_address,destination_group_talk_id,content,send_time,message_id,error_message,ireporter_user)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$10,$11,$12)`,
    [
      logId,
      values.notificationType,
      values.templateId,
      values.templateName,
      values.destinationType,
      values.domainId ?? null,
      values.mailAddress ?? null,
      values.talkId ?? null,
      values.content,
      values.messageId ?? null,
      values.errorMessage ?? null,
      req.session?.userId ?? '',
    ],
  );
}

async function sendDirectByMail(
  db: pg.Pool,
  req: Request,
  token: string,
  key: string,
  templateId: string,
  templateName: string,
  destinationType: string,
  domainId: string,
  mailAddress: string,
  content: string,
): Promise<void> {
  try {
    const talkId = await createPairTalk(token, domainId, mailAddress);
    const messageId = await sendMessage(token, talkId, content);
    await insertDirectLog(db, req, {
      notificationType: key,
      templateId,
      templateName,
      destinationType,
      domainId,
      mailAddress,
      content,
      messageId,
    });
  } catch (error) {
    if (!(error instanceof DirectApiError)) throw error;
    await insertDirectLog(db, req, {
      notificationType: key,
      templateId,
      templateName,
      destinationType,
      domainId,
      mailAddress,
      content,
      errorMessage: error.message,
    });
    throw error;
  }
}

async function sendDirectByTalk(
  db: pg.Pool,
  req: Request,
  token: string,
  key: string,
  templateId: string,
  templateName: string,
  destinationType: string,
  talkId: string,
  content: string,
): Promise<void> {
  try {
    const messageId = await sendMessage(token, talkId, content);
    await insertDirectLog(db, req, {
      notificationType: key,
      templateId,
      templateName,
      destinationType,
      talkId,
      content,
      messageId,
    });
  } catch (error) {
    if (!(error instanceof DirectApiError)) throw error;
    await insertDirectLog(db, req, {
      notificationType: key,
      templateId,
      templateName,
      destinationType,
      talkId,
      content,
      errorMessage: error.message,
    });
    throw error;
  }
}

function show(
  render: Render,
  res: Response,
  mode: string,
  page: Record<string, unknown>,
  section = 'DirectChat',
  status = 200,
): unknown {
  return render(res.status(status), {
    active: 'System',
    section,
    login: false,
    title: String(page.title ?? 'Direct settings'),
    userName: res.locals.userName,
    directPage: { mode, ...page },
  });
}

function logPageDefaults(
  filters: DirectLogFilters,
  pageIndex: number,
  pageSize: number,
  sortColumn: string,
  sortDirection: string,
  rows: DirectLogRow[],
  total: number,
  limit: number,
): Record<string, unknown> {
  return {
    title: 'Direct send log',
    filters,
    pageIndex,
    pageSize,
    pageSizes: [10, 20, 50, 100],
    sortColumn,
    sortDirection,
    rows: rows.map(presentDirectLog),
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    limit,
  };
}

function integer(value: unknown, fallback: number, minimum = 0, maximum = 10000): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum ? Math.min(number, maximum) : fallback;
}

function toDirectUser(row: Record<string, unknown>): Record<string, unknown> {
  return {
    userId: asText(row.user_id),
    userName: asText(row.user_name),
    directUser: {
      user_id: asText(row.direct_user_id),
      ...Object.fromEntries(
        Array.from({ length: 5 }, (_, index) => {
          const number = index + 1;
          return [
            [`direct_user${number}_domain_id`, asText(row[`direct_user${number}_domain_id`])],
            [`direct_user${number}_mail_address`, asText(row[`direct_user${number}_mail_address`])],
          ];
        }).flat(),
      ),
      direct_group_talk_domain_id: asText(row.direct_group_talk_domain_id),
      direct_group_talk_id: asText(row.direct_group_talk_id),
    },
  };
}

async function loadDirectUser(db: pg.Pool, userId: string): Promise<Record<string, unknown> | undefined> {
  const row = (
    await db.query(
      `SELECT u.user_id,u.user_name,du.user_id AS direct_user_id,du.direct_user1_domain_id,du.direct_user1_mail_address,
      du.direct_user2_domain_id,du.direct_user2_mail_address,du.direct_user3_domain_id,du.direct_user3_mail_address,
      du.direct_user4_domain_id,du.direct_user4_mail_address,du.direct_user5_domain_id,du.direct_user5_mail_address,
      du.direct_group_talk_domain_id,du.direct_group_talk_id
    FROM mst_user u LEFT JOIN mst_direct_user du ON du.user_id=u.user_id WHERE u.user_id=$1`,
      [userId],
    )
  ).rows[0] as Record<string, unknown> | undefined;
  return row ? toDirectUser(row) : undefined;
}

function validateDirectUser(user: Record<string, unknown>): string[] {
  const direct = asObject(user.directUser);
  const errors: string[] = [];
  for (let index = 1; index <= 5; index++) {
    const domain = asText(direct[`direct_user${index}_domain_id`]);
    const address = asText(direct[`direct_user${index}_mail_address`]);
    if (!domain.trim() && address.trim()) errors.push(`Direct user ${index}: select a domain.`);
    if (domain.trim() && !address.trim()) errors.push(`Direct user ${index}: mail address is required.`);
  }
  const talkDomain = asText(direct.direct_group_talk_domain_id);
  const talkId = asText(direct.direct_group_talk_id);
  if (!talkDomain.trim() && talkId.trim()) errors.push('Group talk: select a domain.');
  if (talkDomain.trim() && !talkId.trim()) errors.push('Group talk ID is required.');
  return errors;
}

function readDirectUser(body: Record<string, unknown>): Record<string, unknown> {
  const directUser: Record<string, string> = { user_id: field(body, 'user.directUser.user_id') };
  for (let index = 1; index <= 5; index++) {
    directUser[`direct_user${index}_domain_id`] = field(body, `user.directUser.direct_user${index}_domain_id`);
    directUser[`direct_user${index}_mail_address`] = field(body, `user.directUser.direct_user${index}_mail_address`);
  }
  directUser.direct_group_talk_domain_id = field(body, 'user.directUser.direct_group_talk_domain_id');
  directUser.direct_group_talk_id = field(body, 'user.directUser.direct_group_talk_id');
  return {
    userId: field(body, 'user.userId'),
    userName: field(body, 'user.userName'),
    directUser,
  };
}

async function saveDirectUser(db: pg.Pool, req: Request, user: Record<string, unknown>): Promise<void> {
  const direct = asObject(user.directUser);
  const id = asText(user.userId);
  const userId = req.session?.userId ?? '';
  const term = req.ip ?? '';
  const values: unknown[] = [id];
  const columns = ['user_id'];
  for (let index = 1; index <= 5; index++) {
    for (const suffix of ['domain_id', 'mail_address']) {
      columns.push(`direct_user${index}_${suffix}`);
      values.push(asText(direct[`direct_user${index}_${suffix}`]) || null);
    }
  }
  columns.push('direct_group_talk_domain_id', 'direct_group_talk_id');
  values.push(asText(direct.direct_group_talk_domain_id) || null, asText(direct.direct_group_talk_id) || null);
  columns.push(
    'sys_regist_term',
    'sys_regist_user',
    'sys_regist_time',
    'sys_update_term',
    'sys_update_user',
    'sys_update_time',
  );
  values.push(term, userId, new Date(), term, userId, new Date());
  const placeholders = values.map((_, index) => `$${index + 1}`);
  const updateColumns = columns.slice(1, 13).map((column) => `${column}=EXCLUDED.${column}`);
  updateColumns.push(
    'sys_update_term=EXCLUDED.sys_update_term',
    'sys_update_user=EXCLUDED.sys_update_user',
    'sys_update_time=now()',
  );
  await db.query(
    `INSERT INTO mst_direct_user(${columns.join(',')}) VALUES(${placeholders.join(',')}) ON CONFLICT(user_id) DO UPDATE SET ${updateColumns.join(',')}`,
    values,
  );
}

async function copyDirectMailAddresses(db: pg.Pool, req: Request, body: Record<string, unknown>): Promise<void> {
  const domainId = field(body, 'copyDomainId');
  const selected = Array.from({ length: 5 }, (_, index) => bool(body[`isCopyMailAddressDirectUser[${index}]`]));
  const slots = selected.flatMap((checked, index) => (checked ? [index + 1] : []));
  if (!domainId || !slots.length) throw new Error('Select a destination domain and at least one Direct user slot.');
  const client = await db.connect();
  const term = req.ip ?? '';
  const userId = req.session?.userId ?? '';
  const slotColumns = slots.flatMap((index) => [`direct_user${index}_domain_id`, `direct_user${index}_mail_address`]);
  const setSlots = slots.flatMap((index, slotIndex) => [
    `direct_user${index}_domain_id=$${slotIndex + 1}`,
    `direct_user${index}_mail_address=u.e_mail`,
  ]);
  const parameters = [...slots.map(() => domainId), term, userId];
  const domainValues = slots.map((_, index) => `$${index + 1}`);
  const metadata = `$${slots.length + 1},$${slots.length + 2},now(),$${slots.length + 1},$${slots.length + 2},now()`;
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE mst_direct_user du SET ${setSlots.join(',')},sys_update_term=$${slots.length + 1},sys_update_user=$${slots.length + 2},sys_update_time=now()
      FROM mst_user u WHERE du.user_id=u.user_id AND u.e_mail IS NOT NULL AND LENGTH(u.e_mail)>0`,
      parameters,
    );
    await client.query(
      `INSERT INTO mst_direct_user(user_id,${slotColumns.join(',')},sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time)
      SELECT u.user_id,${domainValues.flatMap((value) => [value, 'u.e_mail']).join(',')},${metadata} FROM mst_user u
      WHERE u.e_mail IS NOT NULL AND LENGTH(u.e_mail)>0 AND NOT EXISTS(SELECT 1 FROM mst_direct_user du WHERE du.user_id=u.user_id)`,
      parameters,
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function directSearchUser(
  db: pg.Pool,
  req: Request,
  domainId: string,
  userName: string,
  email: string,
): Promise<Record<string, string>[]> {
  const token = await accessToken(db, req);
  if (!token) return [];
  const result: Record<string, string>[] = [];
  for (let offset = 0; ; offset += 20) {
    const query = new URLSearchParams({ limit: '20', offset: String(offset) });
    const body = await directJson(
      `https://restapi.direct4b.com/rest/1/domains/${encodeURIComponent(domainId)}/members?${query}`,
      'GET',
      token,
    );
    const members = Array.isArray(body.contents) ? body.contents.map(asObject) : [];
    result.push(...members.map((member) => ({ name: asText(member.name), email: asText(member.email) })));
    if (members.length < 20) break;
  }
  return result.filter(
    (member) => (!userName || member.name.includes(userName)) && (!email || member.email.includes(email)),
  );
}

async function directSearchGroupTalk(
  db: pg.Pool,
  req: Request,
  domainId: string,
  talkName: string,
): Promise<Record<string, string>[]> {
  const token = await accessToken(db, req);
  if (!token) return [];
  const response = await directRequest('https://restapi.direct4b.com/albero-app-server/talks', 'GET', token);
  const talks = JSON.parse(response) as Xml[];
  return talks
    .filter((talk) => asText(talk.type) === 'group' && (domainId == null || asText(talk.domain_id) === domainId))
    .map((talk) => ({
      talk_id: asText(talk.talk_id),
      name: asText(talk.name),
      users: Array.isArray(talk.users) ? talk.users.map((user) => asText(asObject(user).name)).join(',') : '',
      domain_id: asText(talk.domain_id),
      type: asText(talk.type),
    }))
    .filter((talk) => !talkName || talk.name.includes(talkName));
}

async function permissionFlags(
  db: pg.Pool,
  req: Request,
  scope: 'system' | 'user',
  actions: ('read' | 'edit' | 'create' | 'delete')[],
): Promise<Record<string, boolean>> {
  const flags: Record<string, boolean> = {};
  for (const action of actions) flags[action] = await hasSystemPermission(db, req.session?.userId ?? '', scope, action);
  return flags;
}

export function registerDirect(app: Express, db: pg.Pool, render: Render): void {
  const showDirect = (
    res: Response,
    mode: string,
    page: Record<string, unknown>,
    section = 'DirectChat',
    status = 200,
  ) => show(render, res, mode, page, section, status);
  const can = (req: Request, res: Response, scope: 'system' | 'user', action: 'read' | 'edit' | 'create' | 'delete') =>
    requirePermission(db, req, res, scope, action);

  app.get(`${root}/DirectChat`, async (req, res) => {
    if (denyUnavailableDirect(res)) return;
    if (!(await can(req, res, 'system', 'read'))) return;
    try {
      const document = await loadDirectDocument(db, 'Setting', true);
      const setting = directSetting(document);
      let directUserName = '';
      if (setting.refreshToken) {
        const token = await accessToken(db, req, document);
        if (token)
          directUserName = asText(
            (await directJson('https://restapi.direct4b.com/albero-app-server/users/me', 'GET', token)).display_name,
          );
      }
      const templates: Record<string, unknown>[] = [];
      for (const key of templateKeys) {
        const templateDocument = await loadDirectDocument(db, key, false);
        const settingForTemplate = templateSetting(templateDocument);
        templates.push({
          key,
          label: templateNames[key],
          defaultTemplateId: settingForTemplate.defaultTemplateId,
          templates: settingForTemplate.templates,
        });
      }
      return showDirect(res, 'chat', {
        title: 'Direct notice setting',
        setting: { ...setting, directUserName },
        linked: Boolean(setting.refreshToken),
        templates,
        notifications: notificationFields.map((key) => ({
          key,
          label: notificationNames[key],
          enabled: setting.notification[key],
        })),
        permissions: await permissionFlags(db, req, 'system', ['read', 'edit', 'create', 'delete']),
        error: '',
      });
    } catch {
      return showDirect(
        res,
        'chat',
        {
          title: 'Direct notice setting',
          setting: { ...directSetting({ direct: {} }), directUserName: '' },
          linked: false,
          templates: [],
          notifications: notificationFields.map((key) => ({ key, label: notificationNames[key], enabled: false })),
          permissions: await permissionFlags(db, req, 'system', ['read', 'edit', 'create', 'delete']),
          error: 'Server error.',
        },
        'DirectChat',
        500,
      );
    }
  });

  app.post(`${root}/DirectChat`, async (req, res) => {
    if (denyUnavailableDirect(res)) return;
    if (!(await can(req, res, 'system', 'delete'))) return;
    if (field(req.body as Record<string, unknown>, 'act') !== 'delete') return res.sendStatus(400);
    try {
      const document = await loadDirectDocument(db, 'Setting', true);
      const setting = directSetting(document);
      setting.clientId = '';
      setting.clientSecret = '';
      setting.redirectUrl = '';
      setting.refreshToken = '';
      setDirectSetting(document, setting);
      await saveDirectDocument(db, 'Setting', document, true, req);
      return res.redirect(`${root}/DirectChat`);
    } catch {
      return res.status(500).type('text/plain').send('The Direct link could not be deleted.');
    }
  });

  app.get(`${root}/EditDirectSetting`, async (req, res) => {
    if (denyUnavailableDirect(res)) return;
    if (!(await can(req, res, 'system', 'edit'))) return;
    try {
      const setting = directSetting(await loadDirectDocument(db, 'Setting', true));
      return showDirect(res, 'settingEdit', {
        title: 'Direct application link Edit',
        model: { clientId: setting.clientId, clientSecret: setting.clientSecret, redirectUrl: setting.redirectUrl },
        error: '',
        errors: {},
      });
    } catch {
      return showDirect(
        res,
        'settingEdit',
        {
          title: 'Direct application link Edit',
          model: { clientId: '', clientSecret: '', redirectUrl: '' },
          error: 'Server error.',
          errors: {},
        },
        'DirectChat',
        500,
      );
    }
  });

  app.post(`${root}/EditDirectSetting`, async (req, res) => {
    if (denyUnavailableDirect(res)) return;
    if (!(await can(req, res, 'system', 'edit'))) return;
    const model: DirectSettingForm = {
      clientId: field(req.body as Record<string, unknown>, 'clientId'),
      clientSecret: field(req.body as Record<string, unknown>, 'clientSecret'),
      redirectUrl: field(req.body as Record<string, unknown>, 'redirectUrl'),
    };
    const errors: Record<string, string> = {};
    if (!model.clientId.trim()) errors.clientId = 'Client ID is required.';
    if (!model.clientSecret.trim()) errors.clientSecret = 'Client Secret is required.';
    if (!model.redirectUrl.trim()) errors.redirectUrl = 'Redirect URL is required.';
    if (Object.keys(errors).length)
      return showDirect(res.status(400), 'settingEdit', {
        title: 'Direct application link Edit',
        model,
        error: '',
        errors,
      });
    try {
      const state = randomBytes(16).toString('hex');
      req.session.directAuthorization = { state, model };
      const scope =
        'openid direct.users.me.readonly direct.domains.readonly management.read talks.read talks.write messages.write files members.read offline_access';
      const url = new URL('https://direct4b.com/oauth2/authorize');
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: model.clientId,
        scope,
        redirect_uri: callbackUrl(model.redirectUrl),
        state,
        prompt: 'consent',
      }).toString();
      return res.redirect(url.toString());
    } catch {
      return showDirect(res.status(500), 'settingEdit', {
        title: 'Direct application link Edit',
        model,
        error: 'Direct application link could not be updated.',
        errors: {},
      });
    }
  });

  app.get(`${root}/DirectAuth`, async (req, res) => {
    if (!(await can(req, res, 'system', 'edit'))) return;
    const pending = req.session?.directAuthorization;
    const model = pending?.model ?? { clientId: '', clientSecret: '', redirectUrl: '' };
    const query = req.query;
    const code = typeof query.code === 'string' ? query.code : '';
    const state = typeof query.state === 'string' ? query.state : '';
    if (!code || !pending || state !== pending.state) {
      return showDirect(res.status(400), 'settingEdit', {
        title: 'Direct application link Edit',
        model,
        error: 'Direct application link could not be updated.',
        errors: {},
      });
    }
    try {
      const response = await directJson('https://direct4b.com/oauth2/token', 'POST', '', {
        client_id: model.clientId,
        client_secret: model.clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: callbackUrl(model.redirectUrl),
      });
      const refreshToken = asText(response.refresh_token);
      if (!refreshToken) throw new Error('Direct token response is incomplete.');
      const document = await loadDirectDocument(db, 'Setting', true);
      const setting = directSetting(document);
      setting.clientId = model.clientId;
      setting.clientSecret = model.clientSecret;
      setting.redirectUrl = model.redirectUrl;
      setting.refreshToken = refreshToken;
      setDirectSetting(document, setting);
      await saveDirectDocument(db, 'Setting', document, true, req);
      delete req.session.directAuthorization;
      return res.redirect(`${root}/DirectChat`);
    } catch {
      return showDirect(res.status(502), 'settingEdit', {
        title: 'Direct application link Edit',
        model,
        error: 'Direct application link could not be updated.',
        errors: {},
      });
    }
  });

  app.get(`${root}/EditDirectNotification`, async (req, res) => {
    if (denyUnavailableDirect(res)) return;
    if (!(await can(req, res, 'system', 'edit'))) return;
    try {
      const setting = directSetting(await loadDirectDocument(db, 'Setting', true));
      return showDirect(res, 'notificationEdit', {
        title: 'Notification settings Edit',
        notifications: notificationFields.map((key) => ({
          key,
          label: notificationNames[key],
          enabled: setting.notification[key],
        })),
        error: '',
      });
    } catch {
      return showDirect(res.status(500), 'notificationEdit', {
        title: 'Notification settings Edit',
        notifications: notificationFields.map((key) => ({ key, label: notificationNames[key], enabled: false })),
        error: 'Server error.',
      });
    }
  });

  app.post(`${root}/EditDirectNotification`, async (req, res) => {
    if (denyUnavailableDirect(res)) return;
    if (!(await can(req, res, 'system', 'edit'))) return;
    try {
      const document = await loadDirectDocument(db, 'Setting', true);
      const setting = directSetting(document);
      for (const key of notificationFields)
        setting.notification[key] = field(req.body as Record<string, unknown>, `notification.${key}`) === 'true';
      setDirectSetting(document, setting);
      await saveDirectDocument(db, 'Setting', document, true, req);
      return res.redirect(`${root}/DirectChat`);
    } catch {
      return showDirect(res.status(500), 'notificationEdit', {
        title: 'Notification settings Edit',
        notifications: notificationFields.map((key) => ({ key, label: notificationNames[key], enabled: false })),
        error: 'Notification settings could not be updated.',
      });
    }
  });

  app.get(`${root}/EditDirectTemplate`, async (req, res) => {
    if (denyUnavailableDirect(res)) return;
    const templateId = typeof req.query.templateId === 'string' ? req.query.templateId : '';
    const key = typeof req.query.id === 'string' ? req.query.id : '';
    const permission = templateId ? 'edit' : 'create';
    if (!templateKeys.includes(key as (typeof templateKeys)[number]))
      return res.status(400).type('text/plain').send('Invalid Direct template type.');
    if (!(await can(req, res, 'system', permission))) return;
    try {
      const document = await loadDirectDocument(db, key, false);
      const data = templateSetting(document);
      const found = data.templates.find((template) => template.templateId === templateId);
      const template = completeTemplate(found ?? emptyTemplate());
      const domains = await directDomains(db, req);
      const defaults = template.destinations.map((destination) =>
        [{ value: '', label: '' }, ...domains].map((domain) => ({
          ...domain,
          selected: domain.value === destination.domainId,
        })),
      );
      return showDirect(res, 'templateEdit', {
        title: `${templateNames[key as keyof typeof templateNames]} template ${templateId ? 'Edit' : 'Register'}`,
        key,
        label: templateNames[key as keyof typeof templateNames],
        template,
        isDefaultTemplate: Boolean(templateId && data.defaultTemplateId === templateId),
        domains,
        destinationOptions: selectedDirectDestinationOptions(key),
        domainLists: defaults,
        testDomainSelectList: [{ value: '', label: '' }, ...domains],
        error: '',
        errors: {},
        permissions: await permissionFlags(db, req, 'system', ['edit', 'create']),
      });
    } catch {
      return showDirect(res.status(500), 'templateEdit', {
        title: 'Direct template Edit',
        key,
        label: templateNames[key as keyof typeof templateNames],
        template: emptyTemplate(),
        isDefaultTemplate: false,
        domains: [],
        destinationOptions: selectedDirectDestinationOptions(key),
        domainLists: Array.from({ length: 10 }, () => [{ value: '', label: '' }]),
        testDomainSelectList: [{ value: '', label: '' }],
        error: 'Server error.',
        errors: {},
        permissions: {},
      });
    }
  });

  app.post(`${root}/EditDirectTemplate`, async (req, res) => {
    if (denyUnavailableDirect(res)) return;
    const body = req.body as Record<string, unknown>;
    const model = readTemplateModel(body);
    if (!templateKeys.includes(model.key as (typeof templateKeys)[number]))
      return res.status(400).type('text/plain').send('Invalid Direct template type.');
    const permission = model.template.templateId ? 'edit' : 'create';
    if (!(await can(req, res, 'system', permission))) return;
    try {
      const document = await loadDirectDocument(db, model.key, false);
      const data = templateSetting(document);
      const existingIndex = data.templates.findIndex((template) => template.templateId === model.template.templateId);
      if (model.template.templateId && existingIndex < 0)
        return res.status(404).type('text/plain').send('Direct template not found.');
      const errors = validateTemplate(model.template);
      if (errors.length) {
        const domains = await directDomains(db, req);
        return showDirect(res.status(400), 'templateEdit', {
          title: `${templateNames[model.key as keyof typeof templateNames]} template Edit`,
          ...model,
          label: templateNames[model.key as keyof typeof templateNames],
          domains,
          destinationOptions: selectedDirectDestinationOptions(model.key),
          domainLists: model.template.destinations.map((destination) =>
            [{ value: '', label: '' }, ...domains].map((domain) => ({
              ...domain,
              selected: domain.value === destination.domainId,
            })),
          ),
          testDomainSelectList: [{ value: '', label: '' }, ...domains],
          error: errors.join(' '),
          errors: {},
          permissions: await permissionFlags(db, req, 'system', ['edit', 'create']),
        });
      }
      const templateId = model.template.templateId || randomUUID();
      const saved = completeTemplate({ ...model.template, templateId });
      saved.destinations = saved.destinations.filter((destination) =>
        destinationTypes.includes(destination.destinationType as (typeof destinationTypes)[number]),
      );
      saved.destinations = saved.destinations.map((destination) => {
        if (destination.destinationType === 'direct' || destination.destinationType === 'talk_name') return destination;
        if (
          destination.destinationType.startsWith('report_remarks') ||
          destination.destinationType === 'report_cluster_value'
        )
          return { ...destination, destinationDirect: '' };
        return { ...destination, domainId: '', destinationDirect: '' };
      });
      if (existingIndex >= 0) data.templates[existingIndex] = saved;
      else data.templates.push(saved);
      if (model.isDefaultTemplate) data.defaultTemplateId = templateId;
      else if (data.defaultTemplateId === templateId) data.defaultTemplateId = '';
      setTemplateSetting(document, data.templates, data.defaultTemplateId);
      await saveDirectDocument(db, model.key, document, false, req);
      return res.redirect(`${root}/DetailsDirectTemplate?id=${encodeURIComponent(`${model.key},${templateId}`)}`);
    } catch {
      return showDirect(res.status(500), 'templateEdit', {
        title: 'Direct template Edit',
        ...model,
        label: templateNames[model.key as keyof typeof templateNames] ?? model.key,
        domains: [],
        destinationOptions: selectedDirectDestinationOptions(model.key),
        domainLists: Array.from({ length: 10 }, () => [{ value: '', label: '' }]),
        testDomainSelectList: [{ value: '', label: '' }],
        error: 'Server error.',
        errors: {},
        permissions: {},
      });
    }
  });

  app.post(`${root}/TestSendDirect`, async (req, res) => {
    if (denyUnavailableDirect(res)) return;
    if (!(await can(req, res, 'system', 'edit'))) return;
    const body = req.body as Record<string, unknown>;
    const key = field(body, 'key');
    const templateId = field(body, 'template.templateId');
    const domainId = field(body, 'testDomainId');
    const mailAddress = field(body, 'testMailAddress');
    const content = field(body, 'testContent');
    const templateName = field(body, 'testTemplateName');
    if (!templateKeys.includes(key as (typeof templateKeys)[number]))
      return res.json({ result: 'NG', error_message: 'Invalid Direct template type.' });
    if (!domainId || !mailAddress || !content)
      return res.json({
        result: 'NG',
        error_message: 'Select a domain, enter a mail address, and enter a message body.',
      });
    try {
      const token = await accessToken(db, req);
      if (!token) return res.json({ result: 'NG', error_message: 'not linked to direct.' });
      await sendDirectByMail(db, req, token, key, templateId, templateName, 'test', domainId, mailAddress, content);
      return res.json({ result: 'OK' });
    } catch (error) {
      return res
        .status(502)
        .json({ result: 'NG', error_message: error instanceof Error ? error.message : 'Server error.' });
    }
  });

  app.get(`${root}/DetailsDirectTemplate`, async (req, res) => {
    if (denyUnavailableDirect(res)) return;
    if (!(await can(req, res, 'system', 'read'))) return;
    const parts = (typeof req.query.id === 'string' ? req.query.id : '').split(',');
    const key = parts[0] ?? '';
    const templateId = parts[1] ?? '';
    if (!templateKeys.includes(key as (typeof templateKeys)[number]) || !templateId)
      return res.status(400).type('text/plain').send('Invalid Direct template identifier.');
    try {
      const templateDoc = await loadDirectDocument(db, key, false);
      const data = templateSetting(templateDoc);
      const template = data.templates.find((item) => item.templateId === templateId);
      if (!template) return res.status(404).type('text/plain').send('Direct template not found.');
      const domains = await directDomains(db, req);
      const labels = new Map(domains.map((domain) => [domain.value, domain.label]));
      template.destinations = template.destinations.map((destination) => ({
        ...destination,
        domainName: labels.get(destination.domainId) ?? '',
      }));
      return showDirect(res, 'templateDetails', {
        title: `${templateNames[key as keyof typeof templateNames]} template details`,
        key,
        label: templateNames[key as keyof typeof templateNames],
        template,
        isDefaultTemplate: data.defaultTemplateId === templateId,
        destinationNames,
        permissions: await permissionFlags(db, req, 'system', ['read', 'edit', 'delete']),
        error: '',
      });
    } catch {
      return showDirect(res.status(500), 'templateDetails', {
        title: 'Direct template details',
        key,
        label: templateNames[key as keyof typeof templateNames],
        template: emptyTemplate(),
        isDefaultTemplate: false,
        destinationNames,
        permissions: {},
        error: 'Server error.',
      });
    }
  });

  app.post(`${root}/DetailsDirectTemplate`, async (req, res) => {
    if (denyUnavailableDirect(res)) return;
    if (!(await can(req, res, 'system', 'delete'))) return;
    const body = req.body as Record<string, unknown>;
    const parts = field(body, 'id').split(',');
    const key = parts[0] ?? '';
    const templateId = parts[1] ?? '';
    if (field(body, 'act') !== 'delete' || !templateKeys.includes(key as (typeof templateKeys)[number]) || !templateId)
      return res.sendStatus(400);
    try {
      const document = await loadDirectDocument(db, key, false);
      const data = templateSetting(document);
      if (!data.templates.some((template) => template.templateId === templateId))
        return res.status(404).type('text/plain').send('Direct template not found.');
      data.templates = data.templates.filter((template) => template.templateId !== templateId);
      if (data.defaultTemplateId === templateId) data.defaultTemplateId = '';
      setTemplateSetting(document, data.templates, data.defaultTemplateId);
      await saveDirectDocument(db, key, document, false, req);
      return res.redirect(`${root}/DirectChat`);
    } catch {
      return res.status(500).type('text/plain').send('Direct template could not be deleted.');
    }
  });

  app.get(`${root}/DirectSendLog`, async (req, res) => {
    if (denyUnavailableDirect(res)) return;
    if (!(await can(req, res, 'system', 'read'))) return;
    try {
      const filters = readLogFilters({}, true);
      const sizeOptions = await loadPageSizes(db);
      const defaultSize = await defaultPageSize(db, sizeOptions);
      const pageSize = defaultSize;
      const total = Number(
        (await db.query(`SELECT count(*) AS count FROM conmas_direct_send_log WHERE 1=1${logWhere(filters, [])}`))
          .rows[0]?.count ?? 0,
      );
      const rows = await directLogRows(db, filters, 'send_time', 'DESC', pageSize, 0);
      return showDirect(
        res,
        'sendLog',
        {
          ...logPageDefaults(filters, 0, pageSize, 'send_time', 'DESC', rows, total, await directDownloadLimit(db)),
          pageSizes: sizeOptions,
          permissions: await permissionFlags(db, req, 'system', ['read', 'edit', 'delete']),
          error: '',
        },
        'DirectSendLog',
      );
    } catch {
      return showDirect(
        res.status(500),
        'sendLog',
        {
          ...logPageDefaults(readLogFilters({}, true), 0, 20, 'send_time', 'DESC', [], 0, 0),
          permissions: {},
          error: 'Server error.',
        },
        'DirectSendLog',
      );
    }
  });

  app.post(`${root}/DirectSendLog`, async (req, res) => {
    if (denyUnavailableDirect(res)) return;
    const body = req.body as Record<string, unknown>;
    const action = field(body, 'ActionCommonType');
    const requiredAction =
      action === 'DeleteType' ? 'delete' : action === 'ResendType' || field(body, 'resendLogId') ? 'edit' : 'read';
    if (!(await can(req, res, 'system', requiredAction))) return;
    const filters = readLogFilters(body);
    const sizes = await loadPageSizes(db);
    const pageSizeDefault = await defaultPageSize(db, sizes);
    let pageSize = integer(body['PageData.PageSize'], pageSizeDefault, 1, 1000);
    if (!sizes.includes(pageSize)) pageSize = pageSizeDefault;
    let pageIndex = integer(body['PageData.PageIndex'], 0, 0, 10000);
    const sortColumnValue = field(body, 'PageData.SortColumn');
    const sortColumn = sortableColumns[sortColumnValue] ? sortColumnValue : 'send_time';
    const sortDirection = field(body, 'PageData.SortDirection') === 'ASC' ? 'ASC' : 'DESC';
    try {
      if (action === 'CsvType') {
        const download = await directCsv(db, filters, sortColumn, sortDirection);
        res
          .status(200)
          .type('text/csv; charset=utf-8')
          .set('Content-Disposition', 'attachment; filename="directSendLog.csv"');
        return res.send(download.data);
      }
      if (action === 'SearchType') pageIndex = 0;
      else if (action === 'DeleteType') {
        const ids: string[] = [];
        for (let index = 0; index < 1000; index++) {
          if (field(body, `SendLogList[${index}].IsSelect`) === 'true') {
            const id = field(body, `SendLogList[${index}].LogId`);
            if (id) ids.push(id);
          }
          if (!Object.hasOwn(body, `SendLogList[${index}].LogId`)) break;
        }
        await deleteDirectLogs(db, ids);
      } else if (field(body, 'resendLogId')) {
        const id = field(body, 'resendLogId');
        const row = (
          await db.query(
            'SELECT notification_type,template_id,template_name,destination_type,destination_domain_id,destination_mail_address,destination_group_talk_id,content FROM conmas_direct_send_log WHERE log_id=$1',
            [id],
          )
        ).rows[0] as DirectLogRow | undefined;
        if (row) {
          const token = await accessToken(db, req);
          if (!token) throw new Error('Resend failed. not linked to direct.');
          const key = asText(row.notification_type);
          if (row.destination_mail_address)
            await sendDirectByMail(
              db,
              req,
              token,
              key,
              asText(row.template_id),
              asText(row.template_name),
              asText(row.destination_type),
              asText(row.destination_domain_id),
              asText(row.destination_mail_address),
              asText(row.content),
            );
          else if (row.destination_group_talk_id)
            await sendDirectByTalk(
              db,
              req,
              token,
              key,
              asText(row.template_id),
              asText(row.template_name),
              asText(row.destination_type),
              asText(row.destination_group_talk_id),
              asText(row.content),
            );
        }
      }
      const countValues: unknown[] = [];
      const where = logWhere(filters, countValues);
      const total = Number(
        (await db.query(`SELECT count(*) AS count FROM conmas_direct_send_log WHERE 1=1${where}`, countValues)).rows[0]
          ?.count ?? 0,
      );
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      pageIndex = Math.min(pageIndex, totalPages - 1);
      const rows = await directLogRows(db, filters, sortColumn, sortDirection, pageSize, pageIndex * pageSize);
      return showDirect(
        res,
        'sendLog',
        {
          ...logPageDefaults(
            filters,
            pageIndex,
            pageSize,
            sortColumn,
            sortDirection,
            rows,
            total,
            await directDownloadLimit(db),
          ),
          pageSizes: sizes,
          permissions: await permissionFlags(db, req, 'system', ['read', 'edit', 'delete']),
          error: '',
        },
        'DirectSendLog',
      );
    } catch (error) {
      if (action === 'CsvType' && error instanceof Error && error.message.includes('matching encoder is required')) {
        return res.status(503).type('text/plain').send(error.message);
      }
      return res.redirect(`${root}/DirectSendLog`);
    }
  });

  app.get(`${root}/UserDirectList`, async (req, res) => {
    if (denyUnavailableDirect(res)) return;
    if (!(await can(req, res, 'user', 'read'))) return;
    const query = req.query;
    const searchId = typeof query.searchId === 'string' ? query.searchId : '';
    const searchName = typeof query.searchName === 'string' ? query.searchName : '';
    const searchGroupId =
      typeof query.searchGroupId === 'string' && /^-?\d+$/.test(query.searchGroupId) ? query.searchGroupId : '-1';
    const pageSizes = await loadPageSizes(db);
    const pageSize = await normalizePageSize(db, typeof query.pageSize === 'string' ? query.pageSize : '', pageSizes);
    const pageIndex = integer(query.pageIndex, 0, 0, 10000);
    return showUserDirectList(req, res, {
      searchId,
      searchName,
      searchGroupId,
      pageSize,
      pageIndex,
      pageSizes,
      error: '',
    });
  });

  app.post(`${root}/UserDirectList`, async (req, res) => {
    if (denyUnavailableDirect(res)) return;
    const body = req.body as Record<string, unknown>;
    const action = field(body, 'act');
    if (!(await can(req, res, 'user', action === 'copyMailAddress' ? 'edit' : 'read'))) return;
    const pageSizes = await loadPageSizes(db);
    const searchId = field(body, 'searchId');
    const searchName = field(body, 'searchName');
    const searchGroupId = /^-?\d+$/.test(field(body, 'searchGroupId')) ? field(body, 'searchGroupId') : '-1';
    const pageSize = await normalizePageSize(db, field(body, 'pageSize'), pageSizes);
    let pageIndex = integer(body.pageIndex, 0, 0, 10000);
    let error = '';
    if (action === 'copyMailAddress') {
      try {
        await copyDirectMailAddresses(db, req, body);
      } catch (cause) {
        error = cause instanceof Error ? cause.message : 'Mail addresses could not be copied.';
      }
    } else pageIndex = 0;
    return showUserDirectList(req, res, { searchId, searchName, searchGroupId, pageSize, pageIndex, pageSizes, error });
  });

  async function showUserDirectList(
    req: Request,
    res: Response,
    input: {
      searchId: string;
      searchName: string;
      searchGroupId: string;
      pageSize: number;
      pageIndex: number;
      pageSizes: number[];
      error: string;
    },
  ): Promise<unknown> {
    const values: unknown[] = ['conmasadmin'];
    let where = 'u.user_id<>$1';
    if (input.searchId) {
      values.push(`%${input.searchId}%`);
      where += ` AND u.user_id LIKE $${values.length}`;
    }
    if (input.searchName) {
      values.push(`%${input.searchName}%`);
      where += ` AND u.user_name LIKE $${values.length}`;
    }
    if (input.searchGroupId !== '-1') {
      values.push(input.searchGroupId);
      where += ` AND u.user_id IN (SELECT user_id FROM mst_group_affiation WHERE group_id=$${values.length})`;
    }
    const total = Number(
      (await db.query(`SELECT count(*) AS count FROM mst_user u WHERE ${where}`, values)).rows[0]?.count ?? 0,
    );
    const pageCount = Math.max(1, Math.ceil(total / input.pageSize));
    const pageIndex = Math.min(input.pageIndex, pageCount - 1);
    const listValues = [...values, input.pageSize, pageIndex * input.pageSize];
    const rows = (
      await db.query(
        `SELECT u.user_id,u.user_name,du.user_id AS direct_user_id,du.direct_user1_domain_id,du.direct_user1_mail_address,
      du.direct_user2_domain_id,du.direct_user2_mail_address,du.direct_user3_domain_id,du.direct_user3_mail_address,
      du.direct_user4_domain_id,du.direct_user4_mail_address,du.direct_user5_domain_id,du.direct_user5_mail_address,
      du.direct_group_talk_domain_id,du.direct_group_talk_id FROM mst_user u LEFT JOIN mst_direct_user du ON du.user_id=u.user_id
      WHERE ${where} ORDER BY u.user_id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        listValues,
      )
    ).rows;
    const groups = (
      await db.query(
        'SELECT group_id,group_name_path FROM mst_group WHERE deleted=0 AND group_id > -999 ORDER BY group_id_path',
      )
    ).rows;
    const domains = await directDomains(db, req).catch(() => []);
    const groupName =
      input.searchGroupId === '-1'
        ? 'All groups'
        : asText(
            groups.find((group) => String(group.group_id) === input.searchGroupId)?.group_name_path ?? 'All groups',
          );
    return showDirect(
      res,
      'userList',
      {
        title: 'User management - Direct linkage',
        users: rows.map((row) => {
          const user = toDirectUser(row);
          asObject(user.directUser).direct_group_talk_id = asText(row.direct_group_talk_domain_id);
          return user;
        }),
        filters: { ...input, pageIndex, groupName },
        groups: [{ group_id: '-1', group_name_path: 'All groups' }, ...groups],
        domains,
        pageSizes: input.pageSizes,
        total,
        totalPages: pageCount,
        pageIndex,
        error: input.error,
        permissions: await permissionFlags(db, req, 'user', ['read', 'edit']),
      },
      'UserList',
    );
  }

  app.get(`${root}/DetailsUserDirect`, async (req, res) => {
    if (denyUnavailableDirect(res)) return;
    if (!(await can(req, res, 'user', 'read'))) return;
    const id = typeof req.query.id === 'string' ? req.query.id : '';
    const user = await loadDirectUser(db, id);
    if (!user) return res.status(404).type('text/plain').send('User not found.');
    const domains = await directDomains(db, req).catch(() => []);
    const labels = new Map(domains.map((domain) => [domain.value, domain.label]));
    const direct = asObject(user.directUser);
    const recipients = Array.from({ length: 5 }, (_, index) => {
      const number = index + 1;
      return {
        label: `Direct user ${number}`,
        domainId: asText(direct[`direct_user${number}_domain_id`]),
        domainName: labels.get(asText(direct[`direct_user${number}_domain_id`])) ?? '',
        mailAddress: asText(direct[`direct_user${number}_mail_address`]),
      };
    });
    return showDirect(
      res,
      'userDetails',
      {
        title: 'User Direct linkage details',
        user,
        recipients,
        talk: {
          domainId: asText(direct.direct_group_talk_domain_id),
          domainName: labels.get(asText(direct.direct_group_talk_domain_id)) ?? '',
          talkId: asText(direct.direct_group_talk_id),
        },
        permissions: await permissionFlags(db, req, 'user', ['read', 'edit']),
        error: '',
      },
      'UserList',
    );
  });

  app.get(`${root}/EditUserDirect`, async (req, res) => {
    if (denyUnavailableDirect(res)) return;
    if (!(await can(req, res, 'user', 'edit'))) return;
    const id = typeof req.query.id === 'string' ? req.query.id : '';
    const user = await loadDirectUser(db, id);
    if (!user) return res.status(404).type('text/plain').send('User not found.');
    const direct = asObject(user.directUser);
    if (!asText(direct.user_id)) direct.user_id = asText(user.userId);
    const domains = await directDomains(db, req).catch(() => []);
    const domainLists = Array.from({ length: 6 }, (_, index) => {
      const selected =
        index < 5 ? asText(direct[`direct_user${index + 1}_domain_id`]) : asText(direct.direct_group_talk_domain_id);
      return [{ value: '', label: '' }, ...domains].map((domain) => ({
        ...domain,
        selected: domain.value === selected,
      }));
    });
    return showDirect(
      res,
      'userEdit',
      { title: 'User Direct linkage Edit', user, domains, domainLists, error: '', errors: {} },
      'UserList',
    );
  });

  app.post(`${root}/EditUserDirect`, async (req, res) => {
    if (denyUnavailableDirect(res)) return;
    if (!(await can(req, res, 'user', 'edit'))) return;
    const body = req.body as Record<string, unknown>;
    const user = readDirectUser(body);
    if (!user.userId) return res.status(400).type('text/plain').send('User ID is required.');
    if (!(await loadDirectUser(db, asText(user.userId))))
      return res.status(404).type('text/plain').send('User not found.');
    const errors = validateDirectUser(user);
    const domains = await directDomains(db, req).catch(() => []);
    const direct = asObject(user.directUser);
    const domainLists = Array.from({ length: 6 }, (_, index) => {
      const selected =
        index < 5 ? asText(direct[`direct_user${index + 1}_domain_id`]) : asText(direct.direct_group_talk_domain_id);
      return [{ value: '', label: '' }, ...domains].map((domain) => ({
        ...domain,
        selected: domain.value === selected,
      }));
    });
    if (errors.length)
      return showDirect(
        res.status(400),
        'userEdit',
        { title: 'User Direct linkage Edit', user, domains, domainLists, error: errors.join(' '), errors: {} },
        'UserList',
      );
    try {
      await saveDirectUser(db, req, user);
      return res.redirect(`${root}/DetailsUserDirect?id=${encodeURIComponent(asText(user.userId))}`);
    } catch {
      return showDirect(
        res.status(500),
        'userEdit',
        { title: 'User Direct linkage Edit', user, domains, domainLists, error: 'Server error.', errors: {} },
        'UserList',
      );
    }
  });

  app.post(`${root}/SearchDirectUser`, async (req, res) => {
    if (denyUnavailableDirect(res)) return;
    if (!(await can(req, res, 'user', 'edit'))) return;
    const body = req.body as Record<string, unknown>;
    try {
      return res.json(
        await directSearchUser(
          db,
          req,
          field(body, 'searchUserDomainId'),
          field(body, 'searchUserName'),
          field(body, 'searchMailAddress'),
        ),
      );
    } catch {
      return res.status(500).json({ error: 'Server error.' });
    }
  });

  app.post(`${root}/SearchDirectGroupTalk`, async (req, res) => {
    if (denyUnavailableDirect(res)) return;
    if (!(await can(req, res, 'user', 'edit'))) return;
    const body = req.body as Record<string, unknown>;
    try {
      return res.json(
        await directSearchGroupTalk(db, req, field(body, 'searchTalkDomainId'), field(body, 'searchTalkName')),
      );
    } catch {
      return res.status(500).json({ error: 'Server error.' });
    }
  });
}

async function loadPageSizes(db: pg.Pool): Promise<number[]> {
  const rows = (await db.query("SELECT com_value FROM mst_common WHERE com_key='PAGE_SIZE' ORDER BY com_index")).rows;
  const values = rows.map((row) => Number(row.com_value)).filter((value) => Number.isSafeInteger(value) && value > 0);
  return values.length ? values : [10, 20, 50, 100];
}

async function defaultPageSize(db: pg.Pool, sizes: number[]): Promise<number> {
  const value = Number(
    (await db.query("SELECT com_value FROM mst_common WHERE com_key='DEFAULT_PAGE_SIZE' ORDER BY com_index LIMIT 1"))
      .rows[0]?.com_value ?? 20,
  );
  return sizes.includes(value) ? value : sizes.includes(20) ? 20 : (sizes[0] ?? 20);
}

async function normalizePageSize(db: pg.Pool, value: string, sizes: number[]): Promise<number> {
  const configured = await defaultPageSize(db, sizes);
  const requested = Number(value);
  return Number.isSafeInteger(requested) && sizes.includes(requested) ? requested : configured;
}
