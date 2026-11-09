import type { Express, Request, Response } from 'express';
import type pg from 'pg';
import { createCipheriv } from 'node:crypto';
import { hostname } from 'node:os';
import { XMLParser } from 'fast-xml-parser';
import { legacyDecrypt, legacyDirectKey } from '../../../shared/legacy-auth.js';
import { licenseStatus } from '../../../shared/license-counts.js';
import { hasSystemPermission } from '../../../middleware/manager/system/permissions.js';
import { encodeExport } from '../../../models/manager/system/data-export.js';
import { currentMailLocale } from './mail.js';

type Param = { paramType: string; paramContent: string };
type KeyValue = { Key: string; Value: string };
type GeneralRequest = {
  Params: KeyValue[];
  Authentication: { Type: string; Username: string; Password: string; Token: string };
  AuthorizationHeader: KeyValue;
  Headers: KeyValue[];
  Body: { Type: string; Items: KeyValue[]; Raw: string; RawContentType: string };
};
type GeneralSettingModel = {
  WebhookId: number;
  WebhookTo: string;
  WebhookName: string;
  Endpoint: string;
  HttpMethod: string;
  RetryCount: number;
  GeneralRequestItem: GeneralRequest;
};
type WebhookSetting = {
  webhook_id: number;
  webhook_to: string;
  webhook_name: string;
  webhook_url: string;
  webhook_request: string;
  webhookParams: Param[];
  GeneralRequestItem: GeneralRequest;
  token: string;
  retry_cnt: number;
  error_occur: string;
  apply: boolean;
  remand: boolean;
  approve: boolean;
  edit: boolean;
  complete: boolean;
  change: boolean;
  terminal: boolean;
  terminalapprove: boolean;
  defapply: boolean;
  defremand: boolean;
  defapprove: boolean;
  schedule: boolean;
};
type GeneralLogContent = {
  url: string;
  queryStrings: Record<string, string>;
  headers: Record<string, string>;
  body: { type: string; formValues: Record<string, string>; rawContent: string; rawContentType: string };
};
type PageData = { pageIndex: number; pageSize: number; sortColumn: string; sortDirection: 'ASC' | 'DESC' };
type LogFilters = {
  SendTimeFrom: string;
  SendTimeFromHour: string;
  SendTimeTo: string;
  SendTimeToHour: string;
  StatusSuccess: boolean;
  StatusFailure: boolean;
  NotificationTypeApply: boolean;
  NotificationTypeRemand: boolean;
  NotificationTypeApprove: boolean;
  NotificationTypeEdit: boolean;
  NotificationTypeComplete: boolean;
  NotificationTypeChange: boolean;
  NotificationTypeTerminal: boolean;
  NotificationTypeTerminalApprove: boolean;
  NotificationTypeDefApply: boolean;
  NotificationTypeDefRemand: boolean;
  NotificationTypeDefApprove: boolean;
  NotificationTypeSchedule: boolean;
  TemplateName: string;
};
type WebhookLog = {
  LogId: string;
  InformTime: string;
  Status: string;
  NotificationType: string;
  NotificationTypeValue: string;
  WebhookId: string;
  WebhookName: string;
  ParamContent: string;
  ErrorMessage: string;
  IsParamContentGeneral: boolean;
  Parameters: Array<[string, string]>;
};
type WebhookView = Record<string, unknown> & { mode: string; error?: string; linked?: boolean };
type Render = (res: Response, data: Record<string, unknown>) => unknown;

declare module 'express-session' {
  interface SessionData {
    webhookListState?: PageData;
  }
}

const root = '/ConMasManager/System';
const webhookTargets = ['General', 'Workflow', 'Nocoder', 'Other'] as const;
const regularTargets = ['Other', 'Workflow', 'Nocoder'] as const;
const regularMethods = ['GET', 'POST'] as const;
const generalMethods = ['GET', 'POST', 'PUT', 'DELETE'] as const;
const retryRegular = [1, 2, 3, 4, 5];
const retryGeneral = [0, 1, 2, 3, 4, 5];
const paramTypes = [
  'def_top_id',
  'rep_top_id',
  'def_top_name',
  'rep_top_name',
  ...Array.from({ length: 10 }, (_, index) => `report_remarks${index + 1}`),
  ...Array.from({ length: 5 }, (_, index) => `system_key${index + 1}`),
  'login_user_id',
];
const notificationTypes = [
  ['Apply', 'Application', 'NotificationTypeApply'],
  ['Remand', 'Rejection', 'NotificationTypeRemand'],
  ['Approve', 'Approval', 'NotificationTypeApprove'],
  ['Edit', 'Save in editing', 'NotificationTypeEdit'],
  ['Complete', 'Completion', 'NotificationTypeComplete'],
  ['Change', 'Change', 'NotificationTypeChange'],
  ['Terminal', 'Device application', 'NotificationTypeTerminal'],
  ['TerminalApprove', 'Device approval', 'NotificationTypeTerminalApprove'],
  ['DefApply', 'Form application', 'NotificationTypeDefApply'],
  ['DefRemand', 'Form rejection', 'NotificationTypeDefRemand'],
  ['DefApprove', 'Form approval', 'NotificationTypeDefApprove'],
  ['Schedule', 'Schedule registration notice', 'NotificationTypeSchedule'],
] as const;
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: false,
  isArray: (name) => ['parameter', 'param', 'header', 'item'].includes(name),
});
type XmlObject = Record<string, unknown> & {
  webhook?: XmlObject;
  parameters?: XmlObject;
  params?: XmlObject;
  authorizationHeader?: XmlObject;
  headers?: XmlObject;
  items?: XmlObject;
};

const stringValue = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return stringValue(value[0]);
  return '';
};
const field = (source: Record<string, unknown>, key: string): string => stringValue(source[key]);
const truthy = (value: unknown): boolean =>
  Array.isArray(value)
    ? value.some(truthy)
    : ['true', '1', 'on', 'yes', 't'].includes(String(value ?? '').toLowerCase());
const booleanField = (source: Record<string, unknown>, key: string): boolean => truthy(source[key]);
const integer = (value: unknown, fallback: number): number => {
  const text = stringValue(value);
  return /^-?\d+$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : fallback;
};
const entries = (value: unknown): XmlObject[] =>
  Array.isArray(value) ? (value as XmlObject[]) : value && typeof value === 'object' ? [value as XmlObject] : [];
const xmlText = (value: unknown): string => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return stringValue((value as XmlObject)['#text']);
  return stringValue(value);
};
const escapeXml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
const xmlAttribute = (name: string, value: string): string => ` ${name}="${escapeXml(value)}"`;
const xmlHeader = '<?xml version="1.0" encoding="utf-8"?>\n';
const xmlNamespaces =
  ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"';

function defaultGeneralRequest(): GeneralRequest {
  return {
    Params: [{ Key: '', Value: '' }],
    Authentication: { Type: 'None', Username: '', Password: '', Token: '' },
    AuthorizationHeader: { Key: '', Value: '' },
    Headers: [{ Key: '', Value: '' }],
    Body: { Type: 'None', Items: [{ Key: '', Value: '' }], Raw: '', RawContentType: 'text/plain' },
  };
}
function defaultSetting(id = -1, webhookTo = ''): WebhookSetting {
  return {
    webhook_id: id,
    webhook_to: webhookTo,
    webhook_name: '',
    webhook_url: '',
    webhook_request: 'GET',
    webhookParams: [],
    GeneralRequestItem: defaultGeneralRequest(),
    token: '',
    retry_cnt: 1,
    error_occur: '',
    apply: webhookTo === 'Workflow',
    remand: false,
    approve: false,
    edit: false,
    complete: webhookTo === 'Nocoder',
    change: false,
    terminal: false,
    terminalapprove: false,
    defapply: false,
    defremand: false,
    defapprove: false,
    schedule: false,
  };
}

export function parseWebhookParameters(xml: string): Param[] {
  if (!xml) return [];
  const parsed = xmlParser.parse(xml) as XmlObject;
  return entries(parsed?.webhook?.parameters?.parameter).map((row) => ({
    paramType: xmlText(row.paramType),
    paramContent: xmlText(row.paramContent),
  }));
}
export function serializeWebhookParameters(parameters: Param[]): string {
  const rows = parameters.filter((item) => paramTypes.includes(item.paramType));
  const items = rows
    .map(
      (item) =>
        `    <parameter>\n      <paramType>${escapeXml(item.paramType)}</paramType>\n      <paramContent>${escapeXml(item.paramContent)}</paramContent>\n    </parameter>`,
    )
    .join('\n');
  return `${xmlHeader}<webhook${xmlNamespaces}>\n  <parameters>${items ? `\n${items}\n  ` : ''}</parameters>\n</webhook>`;
}

function parseKeyValues(value: unknown): KeyValue[] {
  return entries(value).map((item) => ({ Key: stringValue(item['@_key']), Value: stringValue(item['@_value']) }));
}
function parseGeneralRequest(xml: string): GeneralRequest {
  if (!xml) return defaultGeneralRequest();
  const node = (xmlParser.parse(xml) as XmlObject)?.webhook as XmlObject | undefined;
  if (!node) return defaultGeneralRequest();
  const auth = (node.authentication ?? {}) as XmlObject;
  const body = (node.body ?? {}) as XmlObject;
  const result: GeneralRequest = {
    Params: parseKeyValues(node.params?.param),
    Authentication: {
      Type: stringValue(auth['@_type']) || 'None',
      Username: stringValue(auth['@_username']),
      Password: stringValue(auth['@_password']),
      Token: stringValue(auth['@_token']),
    },
    AuthorizationHeader: {
      Key: stringValue(node.authorizationHeader?.['@_key']),
      Value: stringValue(node.authorizationHeader?.['@_value']),
    },
    Headers: parseKeyValues(node.headers?.header),
    Body: {
      Type: stringValue(body['@_type']) || 'None',
      Items: parseKeyValues(body.items?.item),
      Raw: stringValue(body['@_raw']),
      RawContentType: stringValue(body['@_rawContentTyp']) || 'text/plain',
    },
  };
  if (!result.Params.length) result.Params = [{ Key: '', Value: '' }];
  if (!result.Headers.length) result.Headers = [{ Key: '', Value: '' }];
  if (!result.Body.Items.length) result.Body.Items = [{ Key: '', Value: '' }];
  return result;
}
function serializeGeneralRequest(item: GeneralRequest): string {
  const auth = item.Authentication.Type;
  const authAttributes = [
    xmlAttribute('type', auth),
    ...(auth === 'BasicAuth'
      ? [xmlAttribute('username', item.Authentication.Username), xmlAttribute('password', item.Authentication.Password)]
      : []),
    ...(auth === 'BearerToken' ? [xmlAttribute('token', item.Authentication.Token)] : []),
  ].join('');
  const params = item.Params.filter((row) => row.Key !== '' && row.Value !== '')
    .map((row) => `    <param${xmlAttribute('key', row.Key)}${xmlAttribute('value', row.Value)} />`)
    .join('\n');
  const headers = item.Headers.filter((row) => row.Key !== '' && row.Value !== '')
    .map((row) => `    <header${xmlAttribute('key', row.Key)}${xmlAttribute('value', row.Value)} />`)
    .join('\n');
  const items = item.Body.Items.filter((row) => row.Key !== '' && row.Value !== '')
    .map((row) => `      <item${xmlAttribute('key', row.Key)}${xmlAttribute('value', row.Value)} />`)
    .join('\n');
  const authHeader =
    auth === 'None'
      ? ''
      : `\n  <authorizationHeader${xmlAttribute('key', item.AuthorizationHeader.Key)}${xmlAttribute('value', item.AuthorizationHeader.Value)} />`;
  const bodyAttributes = [
    xmlAttribute('type', item.Body.Type),
    ...(item.Body.Type === 'Raw'
      ? [xmlAttribute('raw', item.Body.Raw), xmlAttribute('rawContentTyp', item.Body.RawContentType)]
      : []),
  ].join('');
  const bodyItems = ['FormData', 'XWwwFormURLEncoded'].includes(item.Body.Type)
    ? `\n    <items>${items ? `\n${items}\n    ` : ''}</items>`
    : '';
  return `${xmlHeader}<webhook${xmlNamespaces}>\n  <params>${params ? `\n${params}\n  ` : ''}</params>\n  <authentication${authAttributes} />${authHeader}\n  <headers>${headers ? `\n${headers}\n  ` : ''}</headers>\n  <body${bodyAttributes}>${bodyItems}\n  </body>\n</webhook>`;
}

function encodeDesKey(key: string): Buffer {
  const output = Buffer.alloc(8);
  const bytes = Buffer.from(key, 'utf8');
  for (let index = 0; index < bytes.length; index++) output[index % 8] ^= bytes[index];
  return output;
}
function encryptWebhookToken(value: string): string {
  const desKey = encodeDesKey(legacyDirectKey());
  const cipher = createCipheriv('des-ede3-cbc', Buffer.concat([desKey, desKey, desKey]), desKey);
  return Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]).toString('base64');
}

function parseSettingRow(row: Record<string, unknown>): WebhookSetting {
  const id = Number(row.webhook_id);
  const webhookTo = stringValue(row.webhook_to);
  const setting = defaultSetting(id, webhookTo);
  setting.webhook_name = stringValue(row.webhook_name);
  setting.webhook_url = stringValue(row.webhook_url);
  setting.webhook_request = stringValue(row.webhook_request) || 'GET';
  setting.retry_cnt = Number(row.retry_cnt ?? 1);
  setting.error_occur = stringValue(row.error_occur);
  setting.apply = row.apply == null ? webhookTo === 'Workflow' : truthy(row.apply);
  setting.remand = truthy(row.remand);
  setting.approve = truthy(row.approve);
  setting.edit = truthy(row.edit);
  setting.complete = row.complete == null ? webhookTo === 'Nocoder' : truthy(row.complete);
  setting.change = truthy(row.change);
  setting.terminal = truthy(row.terminal);
  setting.terminalapprove = truthy(row.terminalapprove);
  setting.defapply = truthy(row.defapply);
  setting.defremand = truthy(row.defremand);
  setting.defapprove = truthy(row.defapprove);
  setting.schedule = truthy(row.schedule);
  const storedToken = stringValue(row.token);
  setting.token = storedToken ? legacyDecrypt(storedToken, legacyDirectKey()) : '';
  const stored = stringValue(row.webhook_paramtype);
  if (webhookTo === 'General') setting.GeneralRequestItem = parseGeneralRequest(stored);
  else setting.webhookParams = parseWebhookParameters(stored);
  return setting;
}
async function loadSetting(db: pg.Pool, id: number): Promise<WebhookSetting | null> {
  if (id === -1) return defaultSetting();
  const row = (await db.query('SELECT * FROM mst_webhook WHERE webhook_id = $1', [id])).rows[0] as
    Record<string, unknown> | undefined;
  return row ? parseSettingRow(row) : null;
}

export async function webhookIsLinked(db: Pick<pg.Pool, 'query'>): Promise<boolean> {
  try {
    const row = (
      await db.query('SELECT com_value FROM mst_common WHERE com_key=$1 AND com_name=$2 ORDER BY com_index LIMIT 1', [
        'WEBHOOK',
        'WEBHOOK_VALID_ENABLE',
      ])
    ).rows[0] as { com_value?: string } | undefined;
    return Number(row?.com_value) === 1;
  } catch {
    return false;
  }
}
export function validateWebhookSetting(
  setting: Pick<
    WebhookSetting,
    'webhook_to' | 'webhook_name' | 'webhook_url' | 'webhook_request' | 'retry_cnt' | 'webhookParams'
  >,
): string[] {
  const errors: string[] = [];
  if (!setting.webhook_name.trim()) errors.push('Webhook notification setting name is required.');
  if (!setting.webhook_url.trim()) errors.push('Webhook URL is required.');
  if (!setting.webhook_request.trim()) errors.push('Webhook request is required.');
  return errors;
}

export function validateGeneralWebhook(
  model: {
    WebhookTo: string;
    WebhookName: string;
    Endpoint: string;
    HttpMethod: string;
    RetryCount: number;
    GeneralRequestItem: GeneralRequest;
  },
  act = '',
): string[] {
  const errors: string[] = [];
  if (act && act !== 'testSend') return errors;
  if (!act && model.WebhookName === '') errors.push('Webhook notification setting name is required.');
  if (model.Endpoint === '') errors.push('Endpoint (URL) is required.');
  const checkPairs = (rows: KeyValue[], label: 'Params' | 'Headers' | 'Body') => {
    rows.forEach((row, index) => {
      if (row.Key === '' && row.Value !== '') errors.push(`${label}[${index}]: Key is required.`);
      if (row.Key !== '' && row.Value === '') errors.push(`${label}[${index}]: Value is required.`);
    });
  };
  checkPairs(model.GeneralRequestItem.Params, 'Params');
  checkPairs(model.GeneralRequestItem.Headers, 'Headers');
  if (['FormData', 'XWwwFormURLEncoded'].includes(model.GeneralRequestItem.Body.Type))
    checkPairs(model.GeneralRequestItem.Body.Items, 'Body');
  if (model.GeneralRequestItem.Authentication.Type === 'BasicAuth') {
    if (!model.GeneralRequestItem.Authentication.Username) errors.push('User name is required.');
    if (!model.GeneralRequestItem.Authentication.Password) errors.push('Password is required.');
  }
  if (model.GeneralRequestItem.Authentication.Type === 'BearerToken' && !model.GeneralRequestItem.Authentication.Token)
    errors.push('Token is required.');
  if (model.GeneralRequestItem.Body.Type === 'Raw' && !model.GeneralRequestItem.Body.RawContentType)
    errors.push('Content-Type is required.');
  return errors;
}

function parameterName(value: string): string {
  if (value === 'def_top_id') return 'FormsID';
  if (value === 'rep_top_id') return 'DocumentsID';
  if (value === 'def_top_name') return 'Form name';
  if (value === 'rep_top_name') return 'Input document name';
  if (value.startsWith('report_remarks')) return `Document remarks ${value.slice('report_remarks'.length)}`;
  if (value.startsWith('system_key')) return `System key ${value.slice('system_key'.length)}`;
  return value === 'login_user_id' ? 'Login UserId' : '';
}
function targetName(value: string): string {
  return (
    (
      { General: 'General', Nocoder: 'i-Repo Link', Workflow: 'i-Repo WorkFlow', Other: 'Other' } as Record<
        string,
        string
      >
    )[value] ?? '..'
  );
}
function generalValue(model: GeneralRequest): GeneralRequest {
  const result = structuredClone(model);
  result.Params = result.Params.filter((row) => row.Key !== '' && row.Value !== '');
  result.Headers = result.Headers.filter((row) => row.Key !== '' && row.Value !== '');
  if (result.Authentication.Type === 'None') {
    result.Authentication = { Type: 'None', Username: '', Password: '', Token: '' };
    result.AuthorizationHeader = { Key: '', Value: '' };
  } else if (result.Authentication.Type === 'BasicAuth') {
    result.Authentication.Token = '';
    result.AuthorizationHeader = {
      Key: 'Authorization',
      Value: `Basic ${Buffer.from(`${result.Authentication.Username}:${result.Authentication.Password}`, 'utf8').toString('base64')}`,
    };
  } else if (result.Authentication.Type === 'BearerToken') {
    result.Authentication.Username = '';
    result.Authentication.Password = '';
    result.AuthorizationHeader = { Key: 'Authorization', Value: `Bearer ${result.Authentication.Token}` };
  }
  if (result.Body.Type === 'None') result.Body = { Type: 'None', Items: [], Raw: '', RawContentType: '' };
  else if (['FormData', 'XWwwFormURLEncoded'].includes(result.Body.Type)) {
    result.Body.Items = result.Body.Items.filter((row) => row.Key !== '' && row.Value !== '');
    result.Body.Raw = '';
    result.Body.RawContentType = '';
  } else if (result.Body.Type === 'Raw') result.Body.Items = [];
  return result;
}

function indexedValues(body: Record<string, unknown>, prefix: string, first: string, second: string): KeyValue[] {
  const indexes = new Set<number>();
  const matcher = new RegExp(`^${prefix}\\[(\\d+)\\]\\.(?:${first}|${second})$`);
  for (const key of Object.keys(body)) {
    const match = matcher.exec(key);
    if (match) indexes.add(Number(match[1]));
  }
  return [...indexes]
    .sort((a, b) => a - b)
    .map((index) => ({
      Key: field(body, `${prefix}[${index}].${first}`),
      Value: field(body, `${prefix}[${index}].${second}`),
    }));
}
function readGeneralModel(
  body: Record<string, unknown>,
  id = -1,
): {
  WebhookId: number;
  WebhookTo: string;
  WebhookName: string;
  Endpoint: string;
  HttpMethod: string;
  RetryCount: number;
  GeneralRequestItem: GeneralRequest;
} {
  const initial = defaultGeneralRequest();
  const request = {
    Params: indexedValues(body, 'GeneralRequestItem.Params', 'Key', 'Value'),
    Authentication: {
      Type: field(body, 'GeneralRequestItem.Authentication.Type') || 'None',
      Username: field(body, 'GeneralRequestItem.Authentication.Username'),
      Password: field(body, 'GeneralRequestItem.Authentication.Password'),
      Token: field(body, 'GeneralRequestItem.Authentication.Token'),
    },
    AuthorizationHeader: {
      Key: field(body, 'GeneralRequestItem.AuthorizationHeader.Key'),
      Value: field(body, 'GeneralRequestItem.AuthorizationHeader.Value'),
    },
    Headers: indexedValues(body, 'GeneralRequestItem.Headers', 'Key', 'Value'),
    Body: {
      Type: field(body, 'GeneralRequestItem.Body.Type') || 'None',
      Items: indexedValues(body, 'GeneralRequestItem.Body.Items', 'Key', 'Value'),
      Raw: field(body, 'GeneralRequestItem.Body.Raw'),
      RawContentType: field(body, 'GeneralRequestItem.Body.RawContentType') || 'text/plain',
    },
  } satisfies GeneralRequest;
  if (!request.Params.length) request.Params = initial.Params;
  if (!request.Headers.length) request.Headers = initial.Headers;
  if (!request.Body.Items.length) request.Body.Items = initial.Body.Items;
  return {
    WebhookId: id,
    WebhookTo: field(body, 'WebhookTo') || 'General',
    WebhookName: field(body, 'WebhookName'),
    Endpoint: field(body, 'Endpoint'),
    HttpMethod: field(body, 'HttpMethod') || 'GET',
    RetryCount: integer(body.RetryCount, 1),
    GeneralRequestItem: request,
  };
}
function readRegularModel(body: Record<string, unknown>, id = -1): WebhookSetting {
  const initial = defaultSetting(id, field(body, 'webhook_to'));
  const indexes = new Set<number>();
  const matcher = /^webhookParameter\.parameters\[(\d+)\]\.(?:paramType|paramContent)$/;
  for (const key of Object.keys(body)) {
    const match = matcher.exec(key);
    if (match) indexes.add(Number(match[1]));
  }
  const params = [...indexes]
    .sort((a, b) => a - b)
    .map((index) => ({
      paramType: field(body, `webhookParameter.parameters[${index}].paramType`),
      paramContent: field(body, `webhookParameter.parameters[${index}].paramContent`),
    }));
  return {
    ...initial,
    webhook_id: integer(body.webhook_id, id),
    webhook_to: field(body, 'webhook_to'),
    webhook_name: field(body, 'webhook_name'),
    webhook_url: field(body, 'webhook_url'),
    webhook_request: field(body, 'webhook_request'),
    webhookParams: params.length ? params : [{ paramType: '', paramContent: '' }],
    token: field(body, 'token'),
    retry_cnt: integer(body.retry_cnt, 1),
    error_occur: field(body, 'error_occur'),
  };
}
function csvEscape(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function parseLogParameters(raw: string, isGeneral: boolean): Array<[string, string]> {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (isGeneral) {
      const body = value.body as Record<string, unknown> | undefined;
      const values = Object.entries((value.queryStrings ?? {}) as Record<string, unknown>);
      values.push(...Object.entries((body?.formValues ?? {}) as Record<string, unknown>));
      if (body?.rawContent) values.push(['', String(body.rawContent)]);
      return values.map(([key, item]) => [key, String(item ?? '')]);
    }
    return Object.entries(value).map(([key, item]) => [parameterName(key) || key, String(item ?? '')]);
  } catch {
    if (raw.startsWith('{')) return [];
    return raw.split(',').map((pair) => {
      const split = pair.indexOf(':');
      return split < 0
        ? [pair, '']
        : [parameterName(pair.slice(0, split)) || pair.slice(0, split), pair.slice(split + 1)];
    });
  }
}
function parseClassicLogParameters(raw: string): Record<string, string> {
  if (!raw) return {};
  try {
    if (raw.startsWith('{'))
      return Object.fromEntries(
        Object.entries(JSON.parse(raw) as Record<string, unknown>).map(([key, value]) => [key, String(value ?? '')]),
      );
  } catch {
    return {};
  }
  return Object.fromEntries(
    raw.split(',').map((pair) => {
      const split = pair.indexOf(':');
      return split < 0 ? [pair, ''] : [pair.slice(0, split), pair.slice(split + 1)];
    }),
  );
}
function generalLogContent(raw: string): GeneralLogContent {
  const value = JSON.parse(raw) as Partial<Omit<GeneralLogContent, 'body'>> & {
    body?: Partial<GeneralLogContent['body']>;
  };
  if (!value || typeof value.url !== 'string') throw new Error('Webhook log parameter content is invalid.');
  return {
    url: value.url,
    queryStrings: value.queryStrings ?? {},
    headers: value.headers ?? {},
    body: {
      type: String(value.body?.type ?? 'None'),
      formValues: value.body?.formValues ?? {},
      rawContent: String(value.body?.rawContent ?? ''),
      rawContentType: String(value.body?.rawContentType ?? 'text/plain'),
    },
  };
}
function isGeneralLog(raw: string): boolean {
  return raw.startsWith('{"url":');
}

function logSearch(body: Record<string, unknown>): LogFilters {
  const get = (key: string) => field(body, `WhereData.${key}`);
  const initial = !Object.keys(body).some((key) => key.startsWith('WhereData.'));
  const flag = (key: string) => initial || booleanField(body, `WhereData.${key}`);
  return {
    SendTimeFrom: get('SendTimeFrom'),
    SendTimeFromHour: get('SendTimeFromHour'),
    SendTimeTo: get('SendTimeTo'),
    SendTimeToHour: get('SendTimeToHour'),
    StatusSuccess: flag('StatusSuccess'),
    StatusFailure: flag('StatusFailure'),
    NotificationTypeApply: flag('NotificationTypeApply'),
    NotificationTypeRemand: flag('NotificationTypeRemand'),
    NotificationTypeApprove: flag('NotificationTypeApprove'),
    NotificationTypeEdit: flag('NotificationTypeEdit'),
    NotificationTypeComplete: flag('NotificationTypeComplete'),
    NotificationTypeChange: flag('NotificationTypeChange'),
    NotificationTypeTerminal: flag('NotificationTypeTerminal'),
    NotificationTypeTerminalApprove: flag('NotificationTypeTerminalApprove'),
    NotificationTypeDefApply: flag('NotificationTypeDefApply'),
    NotificationTypeDefRemand: flag('NotificationTypeDefRemand'),
    NotificationTypeDefApprove: flag('NotificationTypeDefApprove'),
    NotificationTypeSchedule: flag('NotificationTypeSchedule'),
    TemplateName: get('TemplateName'),
  };
}
function normalizeDate(value: string): string {
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value);
  if (!match) return '';
  const year = Number(match[1]),
    month = Number(match[2]),
    day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
  return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
}
function normalizeTime(value: string): string {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59 || Number(match[3] ?? '0') > 59) return '00:00:00';
  return `${match[1].padStart(2, '0')}:${match[2]}:${(match[3] ?? '00').padStart(2, '0')}`;
}
function logPageData(source: Record<string, unknown>, sizes: number[], defaultSize: number): PageData {
  const columnInput = field(source, 'PageData.SortColumn') || field(source, 'sortColumn') || 'inform_time';
  const sortColumns = ['inform_time', 'status', 'notification_type', 'webhook_id', 'paramcontent', 'error_message'];
  const sortColumn = sortColumns.includes(columnInput.toLowerCase()) ? columnInput.toLowerCase() : 'inform_time';
  const directionInput = (
    field(source, 'PageData.SortDirection') ||
    field(source, 'sortDirection') ||
    'DESC'
  ).toUpperCase();
  const size = integer(source['PageData.PageSize'] ?? source.pageSize, defaultSize);
  return {
    pageIndex: Math.max(0, Math.min(integer(source['PageData.PageIndex'] ?? source.pageIndex, 0), 10000)),
    pageSize: sizes.includes(size) ? size : sizes.includes(defaultSize) ? defaultSize : sizes[0],
    sortColumn,
    sortDirection: directionInput === 'ASC' ? 'ASC' : 'DESC',
  };
}
async function defaultPageSize(db: pg.Pool): Promise<number> {
  const row = (
    await db.query('SELECT com_value FROM mst_common WHERE com_key=$1 ORDER BY com_index LIMIT 1', [
      'DEFAULT_PAGE_SIZE',
    ])
  ).rows[0] as { com_value?: string } | undefined;
  const value = integer(row?.com_value, 20);
  return value > 0 ? value : 20;
}
async function webhookPageSizes(db: pg.Pool): Promise<number[]> {
  const rows = (await db.query("SELECT com_value FROM mst_common WHERE com_key='PAGE_SIZE' ORDER BY com_index")).rows;
  const values = rows.map((row) => integer(row.com_value, 0)).filter((value) => value > 0);
  return values.length ? [...new Set(values)] : [20, 50, 100, 200, 500];
}
function pageData(
  source: Record<string, unknown>,
  current: PageData | undefined,
  defaultSize: number,
  sizes: number[],
): PageData {
  const sortColumns = ['webhook_to', 'webhook_url', 'webhook_id'];
  const rawColumn =
    field(source, 'PageData.SortColumn') || field(source, 'sortColumn') || current?.sortColumn || 'webhook_id';
  const directionInput = (
    field(source, 'PageData.SortDirection') ||
    field(source, 'sortDirection') ||
    current?.sortDirection ||
    'ASC'
  ).toUpperCase();
  const requestedSize = integer(source['PageData.PageSize'] ?? source.pageSize, current?.pageSize ?? defaultSize);
  return {
    pageIndex: Math.max(
      0,
      Math.min(integer(source['PageData.PageIndex'] ?? source.pageIndex, current?.pageIndex ?? 0), 10000),
    ),
    pageSize: sizes.includes(requestedSize) ? requestedSize : sizes.includes(defaultSize) ? defaultSize : sizes[0],
    sortColumn: sortColumns.includes(rawColumn.toLowerCase()) ? rawColumn.toLowerCase() : 'webhook_id',
    sortDirection: directionInput === 'DESC' ? 'DESC' : 'ASC',
  };
}
function logWhere(filters: LogFilters): { sql: string; values: unknown[] } {
  const conditions: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    values.push(value);
    conditions.push(sql.replace('?', `$${values.length}`));
  };
  const from = normalizeDate(filters.SendTimeFrom);
  const to = normalizeDate(filters.SendTimeTo);
  if (from) add('inform_time >= ?::timestamp', `${from} ${normalizeTime(filters.SendTimeFromHour)}`);
  if (to) add('inform_time <= ?::timestamp', `${to} ${normalizeTime(filters.SendTimeToHour)}`);
  if (filters.StatusSuccess !== filters.StatusFailure)
    conditions.push(filters.StatusSuccess ? 'error_message IS NULL' : 'error_message IS NOT NULL');
  const selected = notificationTypes.filter(([, , property]) => filters[property]);
  if (selected.length > 0 && selected.length !== notificationTypes.length) {
    values.push(selected.map(([key]) => key));
    conditions.push(`notification_type = ANY($${values.length}::text[])`);
  }
  if (filters.TemplateName.trim()) add('webhook_name ILIKE ?', `%${filters.TemplateName}%`);
  return { sql: conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '', values };
}
function formatLog(row: Record<string, unknown>): WebhookLog {
  const raw = stringValue(row.paramcontent);
  const general = isGeneralLog(raw);
  const type = stringValue(row.notification_type);
  return {
    LogId: stringValue(row.log_id),
    InformTime: stringValue(row.inform_time),
    Status: row.error_message == null ? 'Succeeded to send' : 'Failed to send',
    NotificationType: notificationTypes.find(([key]) => key.toLowerCase() === type.toLowerCase())?.[1] ?? type,
    NotificationTypeValue: type,
    WebhookId: stringValue(row.webhook_id),
    WebhookName: stringValue(row.webhook_name),
    ParamContent: raw,
    ErrorMessage: stringValue(row.error_message),
    IsParamContentGeneral: general,
    Parameters: parseLogParameters(raw, general),
  };
}
async function fetchLogs(
  db: pg.Pool,
  filters: LogFilters,
  page: PageData,
  limit?: number,
): Promise<{ rows: WebhookLog[]; total: number }> {
  const where = logWhere(filters);
  const countRow = (await db.query(`SELECT count(*) AS total FROM conmas_webhook_send_log${where.sql}`, where.values))
    .rows[0] as { total: string };
  const total = Number(countRow?.total ?? 0);
  const sort = page.sortColumn === 'status' ? 'status' : page.sortColumn;
  const params = [...where.values];
  let pagination = '';
  if (limit !== undefined && limit > 0) {
    params.push(limit + 1);
    pagination = ` LIMIT $${params.length}`;
  } else if (limit === undefined) {
    params.push(page.pageSize, page.pageIndex * page.pageSize);
    pagination = ` LIMIT $${params.length - 1} OFFSET $${params.length}`;
  }
  const result = await db.query(
    `SELECT log_id, CASE WHEN error_message IS NULL THEN 0 ELSE 1 END AS status, notification_type, webhook_id, webhook_name,
      to_char(inform_time, 'YYYY/MM/DD HH24:MI:SS') AS inform_time, paramcontent, error_message
    FROM conmas_webhook_send_log${where.sql} ORDER BY ${sort} ${page.sortDirection}, log_id${pagination}`,
    params,
  );
  return { rows: result.rows.map((row) => formatLog(row as Record<string, unknown>)), total };
}
async function downloadLimit(db: pg.Pool): Promise<number> {
  const row = (
    await db.query('SELECT com_value FROM mst_common WHERE com_key=$1 AND com_name=$2 ORDER BY com_index LIMIT 1', [
      'CSV_DOWNLOAD_SETTING',
      'LIMIT_OF_DOWNLOAD_COUNT',
    ])
  ).rows[0] as { com_value?: string } | undefined;
  const value = Number(row?.com_value ?? 0);
  return Number.isSafeInteger(value) ? value : 0;
}
function csvLogContent(log: WebhookLog): string {
  if (log.IsParamContentGeneral)
    return parseLogParameters(log.ParamContent, true)
      .map(([key, value]) => (key ? `${key}:${value}` : value))
      .join(',');
  if (log.ParamContent.startsWith('{'))
    return Object.entries(parseClassicLogParameters(log.ParamContent))
      .map(([key, value]) => `${key}:${value}`)
      .join(',');
  return log.ParamContent;
}
function createCsv(rows: WebhookLog[], limit: number): string {
  const headers = [
    'Send date and time',
    'Status',
    'Notification type',
    'Name of webhook',
    'Parameter information',
    'Contents of error',
  ];
  const lines = [headers.map(csvEscape).join(',')];
  const count = limit > 0 ? Math.min(rows.length, limit) : rows.length;
  for (const log of rows.slice(0, count))
    lines.push(
      [log.InformTime, log.Status, log.NotificationType, log.WebhookName, csvLogContent(log), log.ErrorMessage]
        .map(csvEscape)
        .join(','),
    );
  if (limit > 0 && rows.length > limit)
    lines.push([`Truncated to ${limit.toLocaleString('en-US')} records.`].map(csvEscape).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
function checkParameterTriggers(parameters: Param[], setting: WebhookSetting): string[] {
  const errors: string[] = [];
  const add = (name: string, event: string) =>
    errors.push(`You cannot specify the webhook parameter ${name} for the ${event}.`);
  for (const parameter of parameters) {
    if (['def_top_id', 'def_top_name'].includes(parameter.paramType)) {
      if (setting.terminal) add(parameterName(parameter.paramType), 'Terminal notification');
      if (setting.terminalapprove) add(parameterName(parameter.paramType), 'Terminal approval notification');
      if (setting.schedule) add(parameterName(parameter.paramType), 'Schedule notification');
    } else if (['rep_top_id', 'rep_top_name'].includes(parameter.paramType)) {
      if (setting.terminal) add(parameterName(parameter.paramType), 'Terminal notification');
      if (setting.terminalapprove) add(parameterName(parameter.paramType), 'Terminal approval notification');
      if (setting.defapply) add(parameterName(parameter.paramType), 'Definition form apply');
      if (setting.defremand) add(parameterName(parameter.paramType), 'Definition form remand');
      if (setting.defapprove) add(parameterName(parameter.paramType), 'Definition form approve');
    } else if (
      (parameter.paramType.startsWith('report_remarks') || parameter.paramType.startsWith('system_key')) &&
      (setting.terminal ||
        setting.terminalapprove ||
        setting.defapply ||
        setting.defremand ||
        setting.defapprove ||
        setting.schedule)
    ) {
      if (setting.terminal) add(parameterName(parameter.paramType), 'Terminal notification');
      if (setting.terminalapprove) add(parameterName(parameter.paramType), 'Terminal approval notification');
      if (setting.defapply) add(parameterName(parameter.paramType), 'Definition form apply');
      if (setting.defremand) add(parameterName(parameter.paramType), 'Definition form remand');
      if (setting.defapprove) add(parameterName(parameter.paramType), 'Definition form approve');
      if (setting.schedule) add(parameterName(parameter.paramType), 'Schedule notification');
    }
  }
  return errors;
}
function checkEventTriggers(parameters: Param[], model: WebhookSetting): string[] {
  if (model.webhook_to === 'General') return [];
  const settings = defaultSetting(model.webhook_id, model.webhook_to);
  Object.assign(settings, model);
  return checkParameterTriggers(parameters, settings);
}
function readNotificationModel(body: Record<string, unknown>, id: number): WebhookSetting {
  const setting = defaultSetting(id);
  setting.apply = booleanField(body, 'apply');
  setting.remand = booleanField(body, 'remand');
  setting.approve = booleanField(body, 'approve');
  setting.edit = booleanField(body, 'edit');
  setting.complete = booleanField(body, 'complete');
  setting.change = booleanField(body, 'change');
  setting.terminal = booleanField(body, 'terminal');
  setting.terminalapprove = booleanField(body, 'terminalapprove');
  setting.defapply = booleanField(body, 'defapply');
  setting.defremand = booleanField(body, 'defremand');
  setting.defapprove = booleanField(body, 'defapprove');
  setting.schedule = booleanField(body, 'schedule');
  return setting;
}
function queryFormData(query: Request['query']): Record<string, unknown> {
  return query as Record<string, unknown>;
}
function settingDropdowns(_webhookTo: string) {
  return {
    webhookTargets,
    regularTargets,
    regularMethods,
    generalMethods,
    retryRegular,
    retryGeneral,
    paramOptions: paramTypes.map((value) => ({ value, label: parameterName(value) })),
  };
}

function uniqueEntries(entriesToCheck: KeyValue[]): Array<[string, string]> {
  const seen = new Set<string>();
  const result: Array<[string, string]> = [];
  for (const entry of entriesToCheck) {
    if (entry.Key === '' || entry.Value === '') continue;
    if (seen.has(entry.Key)) throw new Error(`Duplicate key: ${entry.Key}`);
    seen.add(entry.Key);
    result.push([entry.Key, entry.Value]);
  }
  return result;
}
function appendRawQuery(url: string, values: Record<string, string>): string {
  const query = Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  return query ? `${url}${url.includes('?') ? '&' : '?'}${query}` : url;
}
function responseBody(
  type: string,
  values: Array<[string, string]>,
  raw: string,
  rawContentType: string,
  headers: Headers,
): BodyInit | undefined {
  const params = new URLSearchParams(values);
  if (type === 'FormData') {
    const form = new FormData();
    for (const [key, value] of values) form.append(key, value);
    return form;
  }
  if (type === 'XWwwFormURLEncoded') {
    if (!headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded');
    return params.toString();
  }
  if (type === 'Raw' && raw !== '') {
    if (rawContentType && !headers.has('content-type')) headers.set('content-type', rawContentType);
    return raw;
  }
  return undefined;
}
async function sendRequest(options: {
  url: string;
  method: string;
  headers?: Record<string, string>;
  values?: Array<[string, string]>;
  bodyType?: string;
  raw?: string;
  rawContentType?: string;
  retries: number;
  attempts?: number;
  acceptAnyStatus?: boolean;
}): Promise<number> {
  const { url, method, retries, acceptAnyStatus = false } = options;
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) throw new Error('Invalid request method.');
  new URL(url);
  const headers = new Headers(options.headers ?? {});
  const values = options.values ?? [];
  if (options.bodyType === 'FormData' || options.bodyType === 'XWwwFormURLEncoded')
    uniqueEntries(values.map(([Key, Value]) => ({ Key, Value })));
  const attempts = acceptAnyStatus ? 1 : (options.attempts ?? Math.max(1, retries));
  let lastStatus = 0;
  let lastError = '';
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      let target = url;
      let body: BodyInit | undefined;
      const type = options.bodyType ?? 'None';
      if (method === 'GET' && type !== 'Raw') {
        if (values.length) {
          const parsed = new URL(target);
          for (const [key, value] of values) parsed.searchParams.append(key, value);
          target = parsed.toString();
        }
      } else {
        body = responseBody(type, values, options.raw ?? '', options.rawContentType ?? '', headers);
      }
      const response = await fetch(target, { method, headers, body });
      lastStatus = response.status;
      if (acceptAnyStatus || response.status === 200) return response.status;
      lastError = response.statusText || 'null';
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Request failed.';
    }
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (acceptAnyStatus) throw new Error(lastError || 'Request failed.');
  throw new Error(
    `webhook API request failed ${attempts} times. URL:${url} StatusCode:${lastStatus}(${lastStatus ? 'HTTP response' : 'request error'}) ErrorMessage:${lastError || 'null'}`,
  );
}
function classicTestParameters(params: Param[], userId: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const param of params) {
    if (!paramTypes.includes(param.paramType)) continue;
    if (Object.hasOwn(values, param.paramType)) throw new Error('Duplicate webhook parameter.');
    values[param.paramType] = param.paramContent.replace(/\{\w+\}/g, (match) =>
      match.slice(1, -1) === 'login_user_id' ? userId : '',
    );
  }
  return values;
}
function generalTestHeaders(model: GeneralRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  if (model.Authentication.Type !== 'None' && model.AuthorizationHeader.Key)
    headers[model.AuthorizationHeader.Key] = model.AuthorizationHeader.Value;
  for (const [key, value] of uniqueEntries(model.Headers)) {
    if (Object.hasOwn(headers, key)) throw new Error(`Duplicate header: ${key}`);
    headers[key] = value;
  }
  return headers;
}
function prepareGeneralModel(model: GeneralRequest): GeneralRequest {
  const prepared = structuredClone(model);
  if (prepared.Authentication.Type === 'BasicAuth') {
    prepared.AuthorizationHeader = {
      Key: 'Authorization',
      Value: `Basic ${Buffer.from(`${prepared.Authentication.Username}:${prepared.Authentication.Password}`, 'utf8').toString('base64')}`,
    };
  } else if (prepared.Authentication.Type === 'BearerToken') {
    prepared.AuthorizationHeader = { Key: 'Authorization', Value: `Bearer ${prepared.Authentication.Token}` };
  }
  return prepared;
}
async function sendRegularTest(model: WebhookSetting, userId: string): Promise<number> {
  const params = classicTestParameters(model.webhookParams, userId);
  return sendRequest({
    url: model.webhook_url,
    method: model.webhook_request,
    headers: model.token ? { Authorization: `Bearer ${model.token}` } : {},
    values: Object.entries(params),
    bodyType: 'XWwwFormURLEncoded',
    retries: model.retry_cnt,
    acceptAnyStatus: true,
  });
}
async function sendGeneralTest(model: GeneralSettingModel): Promise<number> {
  const item = prepareGeneralModel(model.GeneralRequestItem);
  const body = item.Body;
  return sendRequest({
    url: model.Endpoint,
    method: model.HttpMethod,
    headers: generalTestHeaders(item),
    values:
      body.Type === 'None' || body.Type === 'Raw' ? [] : uniqueEntries(body.Items).map(([Key, Value]) => [Key, Value]),
    bodyType: body.Type,
    raw: body.Raw,
    rawContentType: body.RawContentType,
    retries: model.RetryCount,
    acceptAnyStatus: true,
  });
}
function asObjectStringMap(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item ?? '')]));
}
function nextLogId(seq: unknown): string {
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  return `${stamp}${String(seq).padStart(20, '0')}`;
}
async function insertSendLog(
  db: pg.Pool,
  userId: string,
  setting: WebhookSetting,
  notificationType: string,
  parameter: string,
  errorMessage: string | null,
): Promise<void> {
  const sequence = (await db.query("SELECT nextval('conmas_webhook_send_history_seq') AS value")).rows[0]?.value;
  const logId = nextLogId(sequence);
  await db.query(
    `INSERT INTO conmas_webhook_send_log (log_id, notification_type, webhook_id, webhook_name, paramcontent, inform_time, message_id, error_message, ireporter_user)
    VALUES ($1,$2,$3,$4,$5,now(),NULL,$6,$7)`,
    [logId, notificationType, setting.webhook_id, setting.webhook_name, parameter, errorMessage, userId],
  );
}
async function resendWebhook(db: pg.Pool, userId: string, logId: string): Promise<void> {
  const row = (
    await db.query(
      'SELECT notification_type, webhook_id, paramcontent FROM conmas_webhook_send_log WHERE log_id = $1',
      [logId],
    )
  ).rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new Error('Webhook send log was not found.');
  const setting = await loadSetting(db, Number(row.webhook_id));
  if (!setting) throw new Error('Webhook setting was not found.');
  const type = stringValue(row.notification_type);
  const raw = stringValue(row.paramcontent);
  try {
    if (isGeneralLog(raw)) {
      const payload = generalLogContent(raw);
      const requestType = payload.body.type;
      const values =
        requestType === 'None' || requestType === 'Raw'
          ? []
          : Object.entries(asObjectStringMap(payload.body.formValues));
      const query = appendRawQuery(payload.url, asObjectStringMap(payload.queryStrings));
      await sendRequest({
        url: query,
        method: setting.webhook_request,
        headers: asObjectStringMap(payload.headers),
        values,
        bodyType: requestType === 'General' ? 'None' : requestType,
        raw: payload.body.rawContent,
        rawContentType: payload.body.rawContentType,
        retries: setting.retry_cnt,
        attempts: setting.retry_cnt + 1,
        acceptAnyStatus: false,
      });
      await insertSendLog(db, userId, setting, type, JSON.stringify(payload), null);
    } else {
      const params = parseClassicLogParameters(raw);
      await sendRequest({
        url: setting.webhook_url,
        method: setting.webhook_request,
        headers: setting.token ? { Authorization: `Bearer ${setting.token}` } : {},
        values: Object.entries(params),
        bodyType: 'XWwwFormURLEncoded',
        retries: setting.retry_cnt,
        acceptAnyStatus: false,
      });
      await insertSendLog(db, userId, setting, type, JSON.stringify(params), null);
    }
  } catch (error) {
    await insertSendLog(db, userId, setting, type, raw, error instanceof Error ? error.message : 'Request failed.');
    throw error;
  }
}

export function registerWebhook(app: Express, db: pg.Pool, render: Render): void {
  const show = (res: Response, section: 'WebhookList' | 'WebhookSendLog', page: WebhookView) =>
    render(res, {
      active: 'System',
      section,
      login: false,
      title:
        section === 'WebhookSendLog'
          ? 'Webhook send log'
          : page.mode === 'list'
            ? 'Webhook List'
            : page.mode === 'edit' || page.mode === 'generalEdit'
              ? 'Application linkage settingEdit'
              : page.mode === 'notificationEdit'
                ? 'Notification SettingsEdit'
                : 'Webhook notice setting',
      userName: res.locals.userName,
      webhookPage: {
        ...page,
        parameterName,
        targetName,
        backHref: ['list', 'denied', 'sendLog'].includes(page.mode) ? undefined : root + '/WebhookList',
      },
    });
  const denied = (res: Response, section: 'WebhookList' | 'WebhookSendLog', message = 'You do not have permission.') =>
    show(res.status(403), section, { mode: 'denied', error: message, linked: false });
  const allowed = async (req: Request, scope: 'system' | 'data', action: 'read' | 'edit' | 'create' | 'delete') => {
    const userId = req.session?.userId;
    return userId ? hasSystemPermission(db, userId, scope, action) : true;
  };
  const licenseBlocked = (res: Response, section: 'WebhookList' | 'WebhookSendLog', unavailable = false) =>
    show(unavailable ? res.status(503) : res, section, {
      mode: 'denied',
      error: unavailable ? 'License information is unavailable.' : 'Role authority is insufficient.',
      linked: false,
    });
  app.use((req, res, next) => {
    if (!req.path.toLowerCase().includes('webhook')) return next();
    const section = /sendlog/i.test(req.path) ? 'WebhookSendLog' : 'WebhookList';
    try {
      if (!licenseStatus().freeDrawOnly) return next();
    } catch {
      return licenseBlocked(res, section, true);
    }
    return licenseBlocked(res, section);
  });
  const isLinked = () => webhookIsLinked(db);
  const controlFlags = async (req: Request) => {
    const [canSystemEdit, canSystemDelete, canDataCreate, canDataDelete] = await Promise.all([
      allowed(req, 'system', 'edit'),
      allowed(req, 'system', 'delete'),
      allowed(req, 'data', 'create'),
      allowed(req, 'data', 'delete'),
    ]);
    return { canSystemEdit, canSystemDelete, canDataCreate, canDataDelete };
  };

  app.get(`${root}/WebhookList`, async (req, res) => {
    if (!(await allowed(req, 'data', 'read'))) return denied(res, 'WebhookList');
    const linked = await isLinked();
    const defaultSize = await defaultPageSize(db);
    const source = queryFormData(req.query);
    const sizes = await webhookPageSizes(db);
    const requested = pageData(source, req.session?.webhookListState, defaultSize, sizes);
    const total = Number((await db.query('SELECT count(*) AS total FROM mst_webhook')).rows[0]?.total ?? 0);
    const pages = Math.ceil(total / requested.pageSize);
    requested.pageIndex = Math.min(requested.pageIndex, Math.max(0, pages - 1));
    const columns: Record<string, string> = {
      webhook_to: 'webhook_to',
      webhook_url: 'webhook_url',
      webhook_id: 'webhook_id',
    };
    const rows = (
      await db.query(
        `SELECT webhook_id, webhook_to, webhook_url, webhook_name FROM mst_webhook ORDER BY ${columns[requested.sortColumn]} ${requested.sortDirection}, webhook_id LIMIT $1 OFFSET $2`,
        [requested.pageSize, requested.pageIndex * requested.pageSize],
      )
    ).rows;
    if (req.session) req.session.webhookListState = requested;
    const flags = await controlFlags(req);
    return show(res, 'WebhookList', {
      mode: 'list',
      linked,
      items: rows,
      total,
      pages,
      page: requested,
      pageSizes: sizes,
      ...flags,
      error: '',
    });
  });

  app.post(`${root}/WebhookList`, async (req, res) => {
    if (!(await allowed(req, 'data', 'read'))) return denied(res, 'WebhookList');
    const body = req.body as Record<string, unknown>;
    const act = field(body, 'act');
    if (act === 'delete') {
      if (!(await allowed(req, 'data', 'delete'))) return denied(res, 'WebhookList');
      const selected: number[] = [];
      for (const [key, value] of Object.entries(body)) {
        const match = /^webhookList\[(\d+)\]\.IsSelect$/.exec(key);
        if (!match || !truthy(value)) continue;
        const id = integer(body[`webhookList[${match[1]}].webhookId`], 0);
        if (id > 0) selected.push(id);
      }
      if (!selected.length) return res.status(400).send('Select a webhook setting to delete.');
      await db.query('DELETE FROM mst_webhook WHERE webhook_id = ANY($1::int[])', [selected]);
    }
    const defaultSize = await defaultPageSize(db);
    const sizes = await webhookPageSizes(db);
    const requested = pageData(body, req.session?.webhookListState, defaultSize, sizes);
    const total = Number((await db.query('SELECT count(*) AS total FROM mst_webhook')).rows[0]?.total ?? 0);
    const pages = Math.ceil(total / requested.pageSize);
    requested.pageIndex = Math.min(requested.pageIndex, Math.max(0, pages - 1));
    const sort = { webhook_to: 'webhook_to', webhook_url: 'webhook_url', webhook_id: 'webhook_id' }[
      requested.sortColumn
    ];
    const rows = (
      await db.query(
        `SELECT webhook_id, webhook_to, webhook_url, webhook_name FROM mst_webhook ORDER BY ${sort} ${requested.sortDirection}, webhook_id LIMIT $1 OFFSET $2`,
        [requested.pageSize, requested.pageIndex * requested.pageSize],
      )
    ).rows;
    if (req.session) req.session.webhookListState = requested;
    const flags = await controlFlags(req);
    return show(res, 'WebhookList', {
      mode: 'list',
      linked: await isLinked(),
      items: rows,
      total,
      pages,
      page: requested,
      pageSizes: sizes,
      ...flags,
      error: '',
    });
  });

  app.get(`${root}/WebhookChat`, async (req, res) => {
    if (!(await allowed(req, 'system', 'read'))) return denied(res, 'WebhookList');
    const id = integer(req.query.id, 0);
    if (id !== -1 && id <= 0) return res.status(400).send('Invalid webhook ID.');
    const setting = await loadSetting(db, id);
    if (!setting) return res.status(404).send('Webhook setting was not found.');
    const flags = await controlFlags(req);
    return show(res, 'WebhookList', { mode: 'chat', linked: await isLinked(), setting, ...flags, error: '' });
  });

  app.get(`${root}/EditWebhookSetting`, async (req, res) => {
    const id = integer(req.query.id, 0);
    if (id !== -1 && id <= 0) return res.status(400).send('Invalid webhook ID.');
    if (!(await allowed(req, 'system', 'edit')) || (id === -1 && !(await allowed(req, 'data', 'create'))))
      return denied(res, 'WebhookList');
    const setting = await loadSetting(db, id);
    if (!setting) return res.status(404).send('Webhook setting was not found.');
    const requestedType = field(req.query as Record<string, unknown>, 'webhookTo');
    if (requestedType === 'General' || (id === -1 && !requestedType))
      return res.redirect(`${root}/EditWebhookSettingGeneral?id=${id}`);
    if (requestedType && !regularTargets.includes(requestedType as (typeof regularTargets)[number]))
      return res.status(400).send('Invalid webhook notification address.');
    if (requestedType) {
      setting.webhook_to = requestedType;
      if (setting.webhook_to !== 'General' && !setting.webhookParams.length)
        setting.webhookParams =
          requestedType === 'Nocoder' || requestedType === 'Workflow'
            ? [
                { paramType: 'def_top_id', paramContent: '{def_top_id}' },
                { paramType: 'rep_top_id', paramContent: '{rep_top_id}' },
                { paramType: 'login_user_id', paramContent: '{login_user_id}' },
              ]
            : [{ paramType: '', paramContent: '' }];
    }
    if (!setting.webhookParams.length) setting.webhookParams = [{ paramType: '', paramContent: '' }];
    const flags = await controlFlags(req);
    return show(res, 'WebhookList', {
      mode: 'edit',
      linked: await isLinked(),
      setting,
      selectedType: setting.webhook_to,
      ...settingDropdowns(setting.webhook_to),
      ...flags,
      errors: [],
      error: '',
    });
  });

  app.post(`${root}/EditWebhookSetting`, async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const setting = readRegularModel(body);
    const id = setting.webhook_id;
    if (id !== -1 && id <= 0) return res.status(400).send('Invalid webhook ID.');
    if (!(await allowed(req, 'system', 'edit')) || (id === -1 && !(await allowed(req, 'data', 'create'))))
      return denied(res, 'WebhookList');
    const act = field(body, 'act');
    if (act === 'addParam') {
      if (setting.webhookParams.length < 20) setting.webhookParams.push({ paramType: '', paramContent: '' });
      return show(res, 'WebhookList', {
        mode: 'edit',
        linked: await isLinked(),
        setting,
        selectedType: setting.webhook_to,
        ...settingDropdowns(setting.webhook_to),
        ...(await controlFlags(req)),
        errors: [],
        error: '',
      });
    }
    if (act === 'initParam') {
      setting.webhookParams =
        setting.webhook_to === 'Nocoder' || setting.webhook_to === 'Workflow'
          ? [
              { paramType: 'def_top_id', paramContent: '{def_top_id}' },
              { paramType: 'rep_top_id', paramContent: '{rep_top_id}' },
              { paramType: 'login_user_id', paramContent: '{login_user_id}' },
            ]
          : [{ paramType: '', paramContent: '' }];
      return show(res, 'WebhookList', {
        mode: 'edit',
        linked: await isLinked(),
        setting,
        selectedType: setting.webhook_to,
        ...settingDropdowns(setting.webhook_to),
        ...(await controlFlags(req)),
        errors: [],
        error: '',
      });
    }
    if (setting.webhook_to === 'General') return res.redirect(`${root}/EditWebhookSettingGeneral?id=${id}`);
    const errors = validateWebhookSetting(setting);
    if (errors.length)
      return show(res.status(400), 'WebhookList', {
        mode: 'edit',
        linked: await isLinked(),
        setting,
        selectedType: setting.webhook_to,
        ...settingDropdowns(setting.webhook_to),
        ...(await controlFlags(req)),
        errors,
        error: '',
      });
    if (act === 'testSend') {
      try {
        const status = await sendRegularTest(setting, req.session?.userId ?? '');
        return show(res, 'WebhookList', {
          mode: 'edit',
          linked: await isLinked(),
          setting,
          selectedType: setting.webhook_to,
          ...settingDropdowns(setting.webhook_to),
          ...(await controlFlags(req)),
          errors: [],
          error: `Http Status Code : ${status}`,
        });
      } catch {
        return show(res.status(400), 'WebhookList', {
          mode: 'edit',
          linked: await isLinked(),
          setting,
          selectedType: setting.webhook_to,
          ...settingDropdowns(setting.webhook_to),
          ...(await controlFlags(req)),
          errors: [],
          error: 'Failed to send',
        });
      }
    }
    try {
      const params = setting.webhookParams.filter((item) => paramTypes.includes(item.paramType));
      if (id === -1) {
        const sequence = (await db.query("SELECT nextval('mst_webhook_id_seq') AS value")).rows[0]?.value;
        const newId = Number(sequence);
        const xml = serializeWebhookParameters(params);
        const token = setting.token ? encryptWebhookToken(setting.token) : null;
        await db.query(
          `INSERT INTO mst_webhook (webhook_id, webhook_to, webhook_name, webhook_url, webhook_request, webhook_paramtype, token, retry_cnt, error_occur, apply, complete, sys_regist_term, sys_regist_user, sys_update_term, sys_update_user)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$12,$13)`,
          [
            newId,
            setting.webhook_to,
            setting.webhook_name,
            setting.webhook_url,
            setting.webhook_request,
            xml,
            token,
            setting.retry_cnt,
            setting.error_occur,
            setting.webhook_to === 'Workflow' ? true : null,
            setting.webhook_to === 'Nocoder' ? true : null,
            hostname(),
            req.session?.userId ?? '',
          ],
        );
        return res.redirect(`${root}/WebhookChat?id=${newId}`);
      }
      const existing = await loadSetting(db, id);
      if (!existing) return res.status(404).send('Webhook setting was not found.');
      const conflicts = checkParameterTriggers(params, existing);
      if (conflicts.length)
        return show(res.status(400), 'WebhookList', {
          mode: 'edit',
          linked: await isLinked(),
          setting,
          selectedType: setting.webhook_to,
          ...settingDropdowns(setting.webhook_to),
          ...(await controlFlags(req)),
          errors: conflicts,
          error: '',
        });
      const token = setting.token ? encryptWebhookToken(setting.token) : null;
      await db.query(
        `UPDATE mst_webhook SET webhook_to=$1, webhook_name=$2, webhook_url=$3, webhook_request=$4, webhook_paramtype=$5, token=$6, retry_cnt=$7, error_occur=$8,
        sys_update_term=$9, sys_update_user=$10, sys_update_time=now() WHERE webhook_id=$11`,
        [
          setting.webhook_to,
          setting.webhook_name,
          setting.webhook_url,
          setting.webhook_request,
          serializeWebhookParameters(params),
          token,
          setting.retry_cnt,
          setting.error_occur,
          hostname(),
          req.session?.userId ?? '',
          id,
        ],
      );
      return res.redirect(`${root}/WebhookChat?id=${id}`);
    } catch {
      return show(res.status(400), 'WebhookList', {
        mode: 'edit',
        linked: await isLinked(),
        setting,
        selectedType: setting.webhook_to,
        ...settingDropdowns(setting.webhook_to),
        ...(await controlFlags(req)),
        errors: [],
        error: 'Failed to update the webhook setting.',
      });
    }
  });

  app.get(`${root}/EditWebhookSettingGeneral`, async (req, res) => {
    const id = integer(req.query.id, 0);
    if (id !== -1 && id <= 0) return res.status(400).send('Invalid webhook ID.');
    if (!(await allowed(req, 'system', 'edit')) || (id === -1 && !(await allowed(req, 'data', 'create'))))
      return denied(res, 'WebhookList');
    const stored = await loadSetting(db, id);
    if (!stored) return res.status(404).send('Webhook setting was not found.');
    if (id !== -1 && stored.webhook_to !== 'General')
      return res.redirect(`${root}/EditWebhookSetting?id=${id}&webhookTo=${encodeURIComponent(stored.webhook_to)}`);
    const setting = id === -1 ? defaultSetting(-1, 'General') : stored;
    const flags = await controlFlags(req);
    return show(res, 'WebhookList', {
      mode: 'generalEdit',
      linked: await isLinked(),
      setting,
      ...settingDropdowns('General'),
      general: {
        WebhookId: id,
        WebhookTo: 'General',
        WebhookName: setting.webhook_name,
        Endpoint: setting.webhook_url,
        HttpMethod: setting.webhook_request,
        RetryCount: setting.retry_cnt || 1,
        GeneralRequestItem: setting.GeneralRequestItem,
      },
      errors: [],
      error: '',
      ...flags,
    });
  });

  app.post(`${root}/EditWebhookSettingGeneral`, async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const id = integer(body.WebhookId, -2);
    if (id !== -1 && id <= 0) return res.status(400).send('Invalid webhook ID.');
    if (!(await allowed(req, 'system', 'edit')) || (id === -1 && !(await allowed(req, 'data', 'create'))))
      return denied(res, 'WebhookList');
    const model = readGeneralModel(body, id);
    const act = field(body, 'act');
    if (model.WebhookTo !== 'General')
      return res.redirect(`${root}/EditWebhookSetting?id=${id}&webhookTo=${encodeURIComponent(model.WebhookTo)}`);
    const errors = validateGeneralWebhook(model, act);
    const flags = await controlFlags(req);
    const renderModel = (res2: Response, messages = errors, error = '') =>
      show(res2, 'WebhookList', {
        mode: 'generalEdit',
        linked: false,
        setting: defaultSetting(id, 'General'),
        ...settingDropdowns('General'),
        general: model,
        errors: messages,
        error,
        ...flags,
      });
    if (errors.length) return renderModel(res.status(400));
    if (act === 'testSend') {
      try {
        const status = await sendGeneralTest(model);
        return renderModel(res, [], `Http Status Code : ${status}`);
      } catch {
        return renderModel(res.status(400), [], 'Failed to send');
      }
    }
    try {
      const old = id === -1 ? null : await loadSetting(db, id);
      if (id !== -1 && !old) return res.status(404).send('Webhook setting was not found.');
      const savedItem = generalValue(prepareGeneralModel(model.GeneralRequestItem));
      const endpoint = model.Endpoint.includes('?')
        ? model.Endpoint.slice(0, model.Endpoint.indexOf('?'))
        : model.Endpoint;
      const xml = serializeGeneralRequest(savedItem);
      if (id === -1) {
        const sequence = (await db.query("SELECT nextval('mst_webhook_id_seq') AS value")).rows[0]?.value;
        const newId = Number(sequence);
        await db.query(
          `INSERT INTO mst_webhook (webhook_id, webhook_to, webhook_name, webhook_url, webhook_request, webhook_paramtype, retry_cnt,
          sys_regist_term, sys_regist_user, sys_update_term, sys_update_user) VALUES ($1,'General',$2,$3,$4,$5,$6,$7,$8,$7,$8)`,
          [
            newId,
            model.WebhookName,
            endpoint,
            model.HttpMethod,
            xml,
            model.RetryCount,
            hostname(),
            req.session?.userId ?? '',
          ],
        );
        return res.redirect(`${root}/WebhookChat?id=${newId}`);
      }
      await db.query(
        `UPDATE mst_webhook SET webhook_to='General', webhook_name=$1, webhook_url=$2, webhook_request=$3, webhook_paramtype=$4, retry_cnt=$5,
        sys_update_term=$6, sys_update_user=$7, sys_update_time=now() WHERE webhook_id=$8`,
        [
          model.WebhookName,
          endpoint,
          model.HttpMethod,
          xml,
          model.RetryCount,
          hostname(),
          req.session?.userId ?? '',
          id,
        ],
      );
      return res.redirect(`${root}/WebhookChat?id=${id}`);
    } catch {
      return renderModel(res.status(400), [], 'Failed to update the webhook setting.');
    }
  });

  app.get(`${root}/EditWebhookNotification`, async (req, res) => {
    const id = integer(req.query.id, 0);
    if (id <= 0) return res.status(400).send('Invalid webhook ID.');
    if (!(await allowed(req, 'system', 'edit'))) return denied(res, 'WebhookList');
    const setting = await loadSetting(db, id);
    if (!setting) return res.status(404).send('Webhook setting was not found.');
    return show(res, 'WebhookList', {
      mode: 'notificationEdit',
      linked: await isLinked(),
      setting,
      ...(await controlFlags(req)),
      errors: [],
      error: '',
    });
  });

  app.post(`${root}/EditWebhookNotification`, async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const id = integer(body.webhook_id, 0);
    if (id <= 0) return res.status(400).send('Invalid webhook ID.');
    if (!(await allowed(req, 'system', 'edit'))) return denied(res, 'WebhookList');
    if (field(body, 'isCanceled')) return res.redirect(`${root}/WebhookChat?id=${id}`);
    const submitted = readNotificationModel(body, id);
    const setting = await loadSetting(db, id);
    if (!setting) return res.status(404).send('Webhook setting was not found.');
    const errors = checkEventTriggers(setting.webhookParams, { ...setting, ...submitted });
    if (errors.length)
      return show(res.status(400), 'WebhookList', {
        mode: 'notificationEdit',
        linked: await isLinked(),
        setting: { ...setting, ...submitted },
        ...(await controlFlags(req)),
        errors,
        error: '',
      });
    try {
      await db.query(
        `UPDATE mst_webhook SET apply=$1, remand=$2, approve=$3, edit=$4, complete=$5, change=$6, terminal=$7, terminalapprove=$8,
        defapply=$9, defremand=$10, defapprove=$11, schedule=$12, sys_update_term=$13, sys_update_user=$14, sys_update_time=now() WHERE webhook_id=$15`,
        [
          submitted.apply,
          submitted.remand,
          submitted.approve,
          submitted.edit,
          submitted.complete,
          submitted.change,
          submitted.terminal,
          submitted.terminalapprove,
          submitted.defapply,
          submitted.defremand,
          submitted.defapprove,
          submitted.schedule,
          hostname(),
          req.session?.userId ?? '',
          id,
        ],
      );
      return res.redirect(`${root}/WebhookChat?id=${id}`);
    } catch {
      return show(res.status(400), 'WebhookList', {
        mode: 'notificationEdit',
        linked: await isLinked(),
        setting: { ...setting, ...submitted },
        ...(await controlFlags(req)),
        errors: [],
        error: 'Failed to update notification settings.',
      });
    }
  });

  app.get(`${root}/WebhookSendLog`, async (req, res) => {
    if (!(await allowed(req, 'system', 'read'))) return denied(res, 'WebhookSendLog');
    const source = queryFormData(req.query);
    const filters = logSearch(source);
    const defaultSize = await defaultPageSize(db);
    const sizes = await webhookPageSizes(db);
    const page = logPageData(source, sizes, defaultSize);
    if (!Object.hasOwn(source, 'PageData.PageSize') && !Object.hasOwn(source, 'pageSize')) page.pageSize = defaultSize;
    const requestedIndex = page.pageIndex;
    const result = await fetchLogs(db, filters, page);
    const pages = Math.ceil(result.total / page.pageSize);
    page.pageIndex = Math.min(page.pageIndex, Math.max(0, pages - 1));
    const data = page.pageIndex === requestedIndex ? result : await fetchLogs(db, filters, page);
    return show(res, 'WebhookSendLog', {
      mode: 'sendLog',
      linked: await isLinked(),
      filters,
      logs: data.rows,
      total: result.total,
      page,
      pages,
      pageSizes: sizes,
      limitOfDownloadCount: await downloadLimit(db),
      ...(await controlFlags(req)),
      error: '',
    });
  });

  app.post(`${root}/WebhookSendLog`, async (req, res) => {
    if (!(await allowed(req, 'system', 'read'))) return denied(res, 'WebhookSendLog');
    const body = req.body as Record<string, unknown>;
    const filters = logSearch(body);
    const defaultSize = await defaultPageSize(db);
    const sizes = await webhookPageSizes(db);
    const page = logPageData(body, sizes, defaultSize);
    if (!Object.hasOwn(body, 'PageData.PageSize') && !Object.hasOwn(body, 'pageSize')) page.pageSize = defaultSize;
    const action = field(body, 'ActionCommonType');
    const resendId = field(body, 'resendLogId');
    if (action === 'CsvType') {
      const limit = await downloadLimit(db);
      const unpaged = {
        ...page,
        pageIndex: 0,
        pageSize: limit > 0 ? limit : 100000,
        sortColumn: page.sortColumn || 'inform_time',
      };
      const data = await fetchLogs(db, filters, unpaged, Math.max(0, limit));
      const locale = await currentMailLocale(db, req);
      const encoding = String(
        (
          await db.query(
            "SELECT com_value FROM mst_common WHERE com_key='ENCODING' AND com_locale=$1 ORDER BY com_index LIMIT 1",
            [locale],
          )
        ).rows[0]?.com_value || '65001',
      );
      const bytes = encodeExport(createCsv(data.rows, limit), 'csv', encoding);
      return res
        .status(200)
        .type('text/csv')
        .attachment('webhookSendLog.csv')
        .send(encoding === '65001' ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]) : bytes);
    }
    if (action === 'DeleteType') {
      if (!(await allowed(req, 'system', 'delete'))) return denied(res, 'WebhookSendLog');
      const selected: string[] = [];
      for (const [key, value] of Object.entries(body)) {
        const match = /^SendLogList\[(\d+)\]\.IsSelect$/.exec(key);
        if (!match || !truthy(value)) continue;
        const id = field(body, `SendLogList[${match[1]}].LogId`);
        if (/^\d{1,64}$/.test(id)) selected.push(id);
      }
      if (!selected.length) return res.status(400).send('Select a webhook send log to delete.');
      await db.query('DELETE FROM conmas_webhook_send_log WHERE log_id = ANY($1::text[])', [selected]);
    } else if (resendId) {
      if (!(await allowed(req, 'system', 'edit'))) return denied(res, 'WebhookSendLog');
      if (!/^\d{1,64}$/.test(resendId)) return res.status(400).send('Invalid webhook send log ID.');
      try {
        await resendWebhook(db, req.session?.userId ?? '', resendId);
      } catch {
        return res.redirect(`${root}/WebhookSendLog`);
      }
    }
    if (action === 'SearchType') {
      page.pageIndex = 0;
      page.pageSize = defaultSize;
      page.sortColumn = 'inform_time';
      page.sortDirection = 'DESC';
    }
    const requestedIndex = page.pageIndex;
    const result = await fetchLogs(db, filters, page);
    const pages = Math.ceil(result.total / page.pageSize);
    page.pageIndex = Math.min(page.pageIndex, Math.max(0, pages - 1));
    const rows = page.pageIndex === requestedIndex ? result.rows : (await fetchLogs(db, filters, page)).rows;
    return show(res, 'WebhookSendLog', {
      mode: 'sendLog',
      linked: await isLinked(),
      filters,
      logs: rows,
      total: result.total,
      page,
      pages,
      pageSizes: sizes,
      scrollX: Math.max(0, integer(body.ScrollXPoint, 0)),
      scrollY: Math.max(0, integer(body.ScrollYPoint, 0)),
      limitOfDownloadCount: await downloadLimit(db),
      ...(await controlFlags(req)),
      error: '',
    });
  });
}
