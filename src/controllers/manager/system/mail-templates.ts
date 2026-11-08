import type { Express, Request, Response } from 'express';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import {
  currentMailLocale,
  mailLicensePrerequisite,
  mailStrings,
  mailTypes,
  parseMailXml,
  serializeMailXml,
  sendSystemMail,
  templateModel,
  type MailDocument,
  type MailLabels,
  type MailXml,
} from './mail.js';
import { hasSystemPermission } from '../../../middleware/manager/system/permissions.js';
import { licenseStatus } from '../../../shared/license-counts.js';

export { mailTypes, templateModel } from './mail.js';

type Xml = MailXml;
type MailPage = {
  mode: string;
  type?: string;
  typeTitle?: string;
  id?: string;
  model?: Xml;
  labels: MailLabels;
  locale: string;
  canEdit?: boolean;
  canDelete?: boolean;
  error?: string;
  errors?: string[];
  fieldErrors?: Record<string, string>;
  testMailAddress?: string;
  legends?: { column: string; legend: string }[];
  sendTypes?: { value: string; text: string }[];
  autocomplete?: string;
  action?: string;
};
type Recipient = { type: string; value: string; name?: string };

const root = '/ConMasManager/System';
const entries = (value: unknown): Xml[] =>
  Array.isArray(value) ? value : value && typeof value === 'object' ? [value as Xml] : [];
const text = (body: Record<string, unknown>, key: string): string => {
  const value = body[key];
  return typeof value === 'string' ? value : Array.isArray(value) ? String(value.at(-1) ?? '') : '';
};
const checked = (body: Record<string, unknown>, key: string): boolean => {
  const value = body[key];
  return Array.isArray(value) ? value.some((item) => String(item) === 'true') : value === 'true';
};

function session(req: Request): { userId?: string; localSessonKey?: string; mailNotice?: string } | undefined {
  return (req as Request & { session?: { userId?: string; localSessonKey?: string; mailNotice?: string } }).session;
}

function templateTitle(type: string, mode: string, labels: MailLabels): string {
  const keys: Record<string, keyof MailLabels> = {
    Apply: 'notification_apply',
    Remand: 'notification_remand',
    Approve: 'notification_approve',
    Edit: 'notification_edit',
    Complete: 'notification_complete',
    Change: 'notification_change',
    Terminal: 'notification_terminal',
    TerminalApprove: 'notification_terminal',
    DefApply: 'notification_def_apply',
    DefRemand: 'notification_def_remand',
    DefApprove: 'notification_def_approve',
  };
  return type === 'TerminalApprove' && mode !== 'DetailsMailTemplate' ? '' : (labels[keys[type]] ?? '');
}

function mailEditData(base: Xml, type: string, labels: MailLabels) {
  const formQueries = base.formQuery as Record<string, Xml> | undefined;
  const queryKeys = Object.keys(formQueries ?? {}).filter((key) => !key.startsWith('@'));
  const storedQuery = ['Edit', 'Complete'].includes(type) ? queryKeys.at(-1) : queryKeys[0];
  let queryName = storedQuery ?? '';
  let columns: string[];
  let specialSendTypes: string[] | undefined;
  if (type === 'Terminal') {
    queryName = 'queryTerminal';
    columns = ['user_id', 'user_name', 'url'];
  } else if (type === 'TerminalApprove') {
    queryName = 'queryTerminal';
    columns = [
      'applicant',
      'applicant_name',
      'applicant_time',
      'applicant_comment',
      'terminal_id',
      'terminal_physical_id',
      'terminal_name',
    ];
    specialSendTypes = ['', 'direct', 'applicant'];
  } else if (type.startsWith('Def')) {
    queryName = 'xxxx';
    columns = [
      'def_top_id',
      'def_top_name',
      'def_applicant',
      'def_applicant_name',
      'def_applicant_date',
      'def_applicant_comment',
      'def_approver',
      'def_approver_name',
      'def_approver_date',
      'def_approver_comment',
      'sys_update_time',
      'user_id',
      'user_name',
      'def_url',
    ];
    specialSendTypes = [
      '',
      'direct',
      'login_user',
      'def_applicant',
      'def_approver',
      'def_update_role',
      'rep_create_role',
    ];
  } else {
    const queryIndex = queryKeys.indexOf(queryName);
    const query = formQueries?.[queryName];
    columns = entries(query?.legend?.param)
      .map((parameter) => String(parameter['@_column'] ?? ''))
      .filter(Boolean);
    if (queryIndex >= 0 && queryIndex < 2)
      columns.push(...Array.from({ length: 10 }, (_, index) => `top_remarks${index + 1}`));
  }
  const legends = columns.map((column) => ({
    column,
    legend: String(labels[`legend_${column}` as keyof typeof labels] ?? column),
  }));
  const sendTypes = (
    specialSendTypes ?? ['', ...Object.keys(base.send ?? {}).filter((key) => !key.startsWith('@'))]
  ).map((value) => {
    const key = value.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
    return {
      value,
      text:
        value === ''
          ? ''
          : String(
              labels[`sendType_${key}` as keyof MailLabels] ??
                labels[`legend_${key}` as keyof MailLabels] ??
                labels[`notification_${key}` as keyof MailLabels] ??
                value,
            ),
    };
  });
  return {
    queryName,
    storedQuery: storedQuery ?? '',
    legends,
    sendTypes,
    defaultTemp: ['Terminal', 'TerminalApprove'].includes(type) || type.startsWith('Def'),
  };
}

function withRecipientOptions(model: Xml, options: { value: string; text: string }[]): Xml {
  const apply = (field: string) =>
    (Array.isArray(model[field]) ? model[field] : []).map((item: Recipient) => ({
      ...item,
      name: options.find((option) => option.value === item.type)?.text ?? '',
    }));
  model.tos = apply('tos');
  model.ccs = apply('ccs');
  model.bccs = apply('bccs');
  return model;
}

function recipientRows(model: Xml): Xml {
  for (const field of ['tos', 'ccs', 'bccs']) {
    model[field] = Array.isArray(model[field]) ? model[field] : [];
    const recipients = model[field] as Recipient[];
    while (recipients.length < 10) recipients.push({ type: '', value: '' });
  }
  return model;
}

function postModel(body: Record<string, unknown>, id: string, defaultTemp: boolean): Xml {
  const model: Xml = {
    id,
    name: text(body, 'mailTemp.name'),
    subject: text(body, 'mailTemp.subject'),
    body: text(body, 'mailTemp.body'),
    priority: text(body, 'mailTemp.priority') || 'Normal',
    defaultTemp: defaultTemp || checked(body, 'mailTemp.defaultTemp'),
    tos: [],
    ccs: [],
    bccs: [],
  };
  for (const field of ['tos', 'ccs', 'bccs']) {
    for (let index = 0; index < 10; index++) {
      (model[field] as Recipient[]).push({
        type: text(body, `mailTemp.${field}[${index}].type`),
        value: text(body, `mailTemp.${field}[${index}].value`),
      });
    }
  }
  return model;
}

function templateValidation(model: Xml, legends: { column: string; legend: string }[], labels: MailLabels) {
  const errors: string[] = [];
  const fieldErrors: Record<string, string> = {};
  for (const [field, label] of [
    ['name', labels.templateFieldName],
    ['subject', labels.templateFieldSubject],
    ['body', labels.templateFieldBody],
  ]) {
    if (!String(model[field] ?? '').trim()) fieldErrors[`mailTemp.${field}`] = labels.required.replace('{0}', label);
  }
  const validColumns = new Set(legends.map((item) => item.column));
  for (const content of [model.subject, model.body]) {
    const reported = new Set<string>();
    for (const match of String(content).matchAll(/{(.+?)}/g)) {
      const column = match[1];
      if (column && !validColumns.has(column) && !reported.has(column)) {
        errors.push(labels.spellMiss.replace('{0}', column));
        reported.add(column);
      }
    }
  }
  return { errors, fieldErrors };
}
function mailStatusCode(error: unknown): unknown {
  if (error && typeof error === 'object') {
    if ('responseCode' in error && error.responseCode !== undefined) return error.responseCode;
    if ('statusCode' in error && error.statusCode !== undefined) return error.statusCode;
  }
  return undefined;
}

function addressError(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      if (current.message) messages.push(current.message);
      current = current.cause;
    } else {
      messages.push(String(current));
      break;
    }
  }
  return messages.join(' ==> ');
}

export function saveTemplate(
  document: MailDocument,
  model: Xml,
  locale: string,
  create: boolean,
  queryName: string,
): string {
  const mail = document.mail;
  const templates = entries(mail.template);
  mail.template = templates;
  const id = create ? randomUUID() : String(model.id ?? '');
  let node = templates.find((item) => item['@_id'] === id);
  if (create) {
    node = {
      '@_id': id,
      '@_priority': model.priority,
      name: [],
      form: { subject: [], body: [] },
      formQuery: { '@_type': queryName },
      send: { to: { address: [] }, cc: { address: [] }, bcc: { address: [] } },
    };
    templates.push(node);
  }
  if (!node) throw new Error('Template not found.');
  if (model.defaultTemp) mail['@_default'] = id;
  else if (!create && mail['@_default'] === id) mail['@_default'] = '';
  node['@_priority'] = model.priority;
  for (const [parent, key, value] of [
    [node, 'name', model.name],
    [node.form, 'subject', model.subject],
    [node.form, 'body', model.body],
  ] as [Xml, string, string][]) {
    const values = entries(parent[key]);
    const row = values.find((item) => item['@_locale'] === locale);
    if (row) row['#text'] = value;
    else values.push({ '@_locale': locale, '#text': value });
    parent[key] = values;
  }
  node.send ??= {};
  for (const [field, xmlKey] of [
    ['tos', 'to'],
    ['ccs', 'cc'],
    ['bccs', 'bcc'],
  ]) {
    const channel = node.send[xmlKey] ?? {};
    channel.address = entries(model[field])
      .filter((item) => item.type && (item.type !== 'direct' || item.value))
      .map((item) => ({
        '@_type': item.type,
        '#text': item.type === 'direct' ? item.value : '',
      }));
    node.send[xmlKey] = channel;
  }
  return id;
}

export function registerMailTemplates(
  app: Express,
  db: pg.Pool,
  render: (res: Response, data: Record<string, unknown>) => unknown,
) {
  const show = (res: Response, page: MailPage) =>
    render(res, {
      active: 'System',
      section: 'MailList',
      login: false,
      title: `${page.typeTitle ?? ''}${page.mode === 'CreateMailTemplate' ? page.labels.createTemplate : page.mode === 'EditMailTemplate' ? page.labels.editTemplate : page.labels.detailsTemplate}`,
      userName: res.locals.userName,
      mailPage: { mode: 'template', locale: page.locale, labels: page.labels, templatePage: page },
    });
  const deny = (res: Response, locale: string, labels: MailLabels, message: string, status: number) =>
    show(res.status(status), {
      mode: 'denied',
      locale,
      labels,
      errors: [message],
    });
  const gate = async (
    req: Request,
    res: Response,
    locale: string,
    action: 'read' | 'edit' | 'create' | 'delete',
    labels: MailLabels,
  ): Promise<boolean> => {
    if (!(await hasSystemPermission(db, session(req)?.userId ?? '', 'system', action))) {
      deny(res, locale, labels, labels.roleError, 403);
      return false;
    }
    try {
      if (!licenseStatus().freeDrawOnly) return true;
    } catch {
      deny(res, locale, labels, 'License information is unavailable.', 503);
      return false;
    }
    deny(res, locale, labels, mailLicensePrerequisite, 403);
    return false;
  };
  const load = async (file: string) => {
    const row = (
      await db.query<{ xml_data: string }>('SELECT xml_data FROM mst_mail WHERE mail_file_name = $1', [file])
    ).rows[0];
    if (!row?.xml_data) throw new Error('Mail settings record is missing.');
    return parseMailXml(row.xml_data);
  };
  const save = async (file: string, document: MailDocument, userId: string, term: string) =>
    db.query(
      'UPDATE mst_mail SET xml_data = $1, sys_update_user = $2, sys_update_term = $3, sys_update_time = now() WHERE mail_file_name = $4',
      [serializeMailXml(document), userId, term, file],
    );
  const detailsId = (value: string) => {
    const separator = value.indexOf(',');
    return separator < 0 ? ['', ''] : [value.slice(0, separator), value.slice(separator + 1)];
  };
  const can = async (userId: string, action: 'edit' | 'delete') => hasSystemPermission(db, userId, 'system', action);
  const editData = async (type: string, locale: string) => {
    const document = await load('Mail.xml');
    return { base: document.mail, baseDocument: document, ...mailEditData(document.mail, type, mailStrings(locale)) };
  };
  const showPage = (res: Response, locale: string, page: Omit<MailPage, 'labels' | 'locale'>) => {
    const labels = mailStrings(locale);
    if (page.mode === 'DetailsMailTemplate') labels.send = labels.detailsSend;
    if (page.mode === 'CreateMailTemplate') {
      labels.send = labels.createSend;
      labels.testSend = labels.createTestSend;
    }
    if (page.mode === 'EditMailTemplate') {
      labels.send = labels.editSend;
      labels.testSend = labels.editTestSend;
      labels.defaultTempNote = labels.editDefaultTempNote;
    }
    return show(res, {
      ...page,
      locale,
      labels,
      typeTitle: page.type ? templateTitle(page.type, page.mode, labels) : '',
    });
  };

  app.get(`${root}/DetailsMailTemplate`, async (req, res) => {
    const locale = await currentMailLocale(db, req);
    const labels = mailStrings(locale);
    if (!(await gate(req, res, locale, 'read', labels))) return;
    const [type, id] = detailsId(text(req.query as Record<string, unknown>, 'id'));
    if (!mailTypes.includes(type)) return showPage(res, locale, { mode: 'denied', errors: [labels.serverError] });
    try {
      const document = await load(`Mail${type}.xml`);
      const node = entries(document.mail.template).find((item) => item['@_id'] === id);
      if (!node) return showPage(res, locale, { mode: 'denied', errors: [labels.serverError] });
      const model = withRecipientOptions(
        templateModel(node, String(document.mail['@_default'] ?? ''), locale),
        mailEditData((await load('Mail.xml')).mail, type, labels).sendTypes,
      );
      return showPage(res, locale, {
        mode: 'DetailsMailTemplate',
        type,
        id,
        model,
        canEdit: await can(session(req)?.userId ?? '', 'edit'),
        canDelete: await can(session(req)?.userId ?? '', 'delete'),
      });
    } catch {
      return showPage(res, locale, { mode: 'denied', errors: [labels.serverError] });
    }
  });

  app.post(`${root}/DetailsMailTemplate`, async (req, res) => {
    const locale = await currentMailLocale(db, req);
    const labels = mailStrings(locale);
    const [type, id] = detailsId(text(req.body, 'id'));
    const deleting = text(req.body, 'act') === 'delete';
    if (!(await gate(req, res, locale, deleting ? 'delete' : 'read', labels))) return;
    if (!mailTypes.includes(type)) return showPage(res, locale, { mode: 'denied', errors: [labels.serverError] });
    try {
      const file = `Mail${type}.xml`;
      const document = await load(file);
      const templates = entries(document.mail.template);
      if (!templates.some((item) => item['@_id'] === id))
        return showPage(res, locale, { mode: 'denied', errors: [labels.serverError] });
      if (deleting) {
        document.mail.template = templates.filter((item) => item['@_id'] !== id);
        await save(file, document, session(req)?.userId ?? '', req.ip ?? '');
        if (session(req)) session(req)!.mailNotice = labels.deleteSuccess;
        return res.redirect(`${root}/MailList`);
      }
      return res.redirect(`${root}/DetailsMailTemplate?id=${encodeURIComponent(`${type},${id}`)}`);
    } catch {
      return showPage(res, locale, { mode: 'denied', errors: [labels.serverError] });
    }
  });

  app.get(`${root}/CreateMailTemplate`, async (req, res) => {
    const locale = await currentMailLocale(db, req);
    const labels = mailStrings(locale);
    if (!(await gate(req, res, locale, 'create', labels))) return;
    const type = text(req.query as Record<string, unknown>, 'id');
    if (!mailTypes.includes(type)) return showPage(res, locale, { mode: 'denied', errors: [labels.serverError] });
    try {
      const data = await editData(type, locale);
      const model = recipientRows({
        id: '',
        name: '',
        subject: '',
        body: '',
        priority: 'Normal',
        defaultTemp: data.defaultTemp,
        tos: [],
        ccs: [],
        bccs: [],
        formQuery: data.queryName,
      });
      return showPage(res, locale, {
        mode: 'CreateMailTemplate',
        type,
        id: '',
        model,
        legends: data.legends,
        sendTypes: data.sendTypes,
        autocomplete: await autocompleteSetting(db),
        action: `${root}/CreateMailTemplate?id=${encodeURIComponent(type)}`,
      });
    } catch {
      return showPage(res, locale, { mode: 'denied', errors: [labels.serverError] });
    }
  });

  app.post(`${root}/CreateMailTemplate`, async (req, res) => {
    const locale = await currentMailLocale(db, req);
    const labels = mailStrings(locale);
    if (!(await gate(req, res, locale, 'create', labels))) return;
    const type = text(req.body, 'targetMailType') || text(req.query as Record<string, unknown>, 'id');
    if (!mailTypes.includes(type)) return showPage(res, locale, { mode: 'denied', errors: [labels.serverError] });
    try {
      const data = await editData(type, locale);
      const model = recipientRows(postModel(req.body, '', data.defaultTemp));
      const { errors, fieldErrors } = templateValidation(model, data.legends, labels);
      if (errors.length || Object.keys(fieldErrors).length)
        return showPage(res, locale, {
          mode: 'CreateMailTemplate',
          type,
          id: '',
          model,
          legends: data.legends,
          sendTypes: data.sendTypes,
          autocomplete: await autocompleteSetting(db),
          action: `${root}/CreateMailTemplate?id=${encodeURIComponent(type)}`,
          errors,
          fieldErrors,
          testMailAddress: text(req.body, 'testMailAddress'),
        });
      if (text(req.body, 'act') === 'testSend') {
        try {
          await sendSystemMail(
            db,
            data.baseDocument,
            {
              subject: model.subject as string,
              body: `${model.body}${data.base.signature ?? ''}`,
              priority: model.priority as string,
              to: [text(req.body, 'testMailAddress')],
            },
            session(req)?.userId ?? '',
            req.ip ?? '',
          );
          return showPage(res, locale, {
            mode: 'CreateMailTemplate',
            type,
            id: '',
            model,
            legends: data.legends,
            sendTypes: data.sendTypes,
            autocomplete: await autocompleteSetting(db),
            action: `${root}/CreateMailTemplate?id=${encodeURIComponent(type)}`,
            testMailAddress: text(req.body, 'testMailAddress'),
          });
        } catch (error) {
          const message =
            error instanceof Error
              ? `${error.message}${error.cause instanceof Error ? ` ${error.cause.message}` : ''}`
              : String(error);
          return showPage(res, locale, {
            mode: 'CreateMailTemplate',
            type,
            id: '',
            model,
            legends: data.legends,
            sendTypes: data.sendTypes,
            autocomplete: await autocompleteSetting(db),
            action: `${root}/CreateMailTemplate?id=${encodeURIComponent(type)}`,
            testMailAddress: text(req.body, 'testMailAddress'),
            errors: [labels.testSendFailed, message],
          });
        }
      }
      const document = await load(`Mail${type}.xml`);
      const id = saveTemplate(document, model, locale, true, data.storedQuery);
      await save(`Mail${type}.xml`, document, session(req)?.userId ?? '', req.ip ?? '');
      return res.redirect(`${root}/DetailsMailTemplate?id=${encodeURIComponent(`${type},${id}`)}`);
    } catch {
      return showPage(res, locale, { mode: 'denied', errors: [labels.serverError] });
    }
  });

  app.get(`${root}/EditMailTemplate`, async (req, res) => {
    const locale = await currentMailLocale(db, req);
    const labels = mailStrings(locale);
    if (!(await gate(req, res, locale, 'edit', labels))) return;
    const query = req.query as Record<string, unknown>;
    const type = text(query, 'type');
    const id = text(query, 'id');
    if (!mailTypes.includes(type)) return showPage(res, locale, { mode: 'denied', errors: [labels.serverError] });
    try {
      const document = await load(`Mail${type}.xml`);
      const node = entries(document.mail.template).find((item) => item['@_id'] === id);
      if (!node) return showPage(res, locale, { mode: 'denied', errors: [labels.serverError] });
      const data = await editData(type, locale);
      const model = recipientRows(
        withRecipientOptions(templateModel(node, String(document.mail['@_default'] ?? ''), locale), data.sendTypes),
      );
      model.formQuery = data.queryName;
      if (data.defaultTemp) model.defaultTemp = true;
      return showPage(res, locale, {
        mode: 'EditMailTemplate',
        type,
        id,
        model,
        legends: data.legends,
        sendTypes: data.sendTypes,
        autocomplete: await autocompleteSetting(db),
        action: `${root}/EditMailTemplate?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`,
      });
    } catch {
      return showPage(res, locale, { mode: 'denied', errors: [labels.serverError] });
    }
  });

  app.post(`${root}/EditMailTemplate`, async (req, res) => {
    const locale = await currentMailLocale(db, req);
    const labels = mailStrings(locale);
    if (!(await gate(req, res, locale, 'edit', labels))) return;
    const type = text(req.body, 'targetMailType') || text(req.query as Record<string, unknown>, 'type');
    const id = text(req.body, 'mailTemp.id') || text(req.query as Record<string, unknown>, 'id');
    if (!mailTypes.includes(type)) return showPage(res, locale, { mode: 'denied', errors: [labels.serverError] });
    try {
      const data = await editData(type, locale);
      const model = recipientRows(postModel(req.body, id, data.defaultTemp));
      const { errors, fieldErrors } = templateValidation(model, data.legends, labels);
      const action = `${root}/EditMailTemplate?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`;
      if (errors.length || Object.keys(fieldErrors).length)
        return showPage(res, locale, {
          mode: 'EditMailTemplate',
          type,
          id,
          model,
          legends: data.legends,
          sendTypes: data.sendTypes,
          autocomplete: await autocompleteSetting(db),
          action,
          errors,
          fieldErrors,
          testMailAddress: text(req.body, 'testMailAddress'),
        });
      if (text(req.body, 'act') === 'testSend') {
        try {
          await sendSystemMail(
            db,
            data.baseDocument,
            {
              subject: model.subject as string,
              body: `${model.body}${data.base.signature ?? ''}`,
              priority: model.priority as string,
              to: [text(req.body, 'testMailAddress')],
            },
            session(req)?.userId ?? '',
            req.ip ?? '',
          );
          return showPage(res, locale, {
            mode: 'EditMailTemplate',
            type,
            id,
            model,
            legends: data.legends,
            sendTypes: data.sendTypes,
            autocomplete: await autocompleteSetting(db),
            action,
            testMailAddress: text(req.body, 'testMailAddress'),
          });
        } catch (error) {
          const statusCode = mailStatusCode(error);
          const failure =
            statusCode === undefined
              ? error instanceof Error
                ? `${error.message}${error.cause instanceof Error ? ` ${error.cause.message}` : ''}`
                : String(error)
              : `Error Message: ${addressError(error)}`;
          const details = [failure];
          if (statusCode !== undefined) details.push(`SMTP Status Code: ${String(statusCode)}`);
          return showPage(res, locale, {
            mode: 'EditMailTemplate',
            type,
            id,
            model,
            legends: data.legends,
            sendTypes: data.sendTypes,
            autocomplete: await autocompleteSetting(db),
            action,
            testMailAddress: text(req.body, 'testMailAddress'),
            errors: [labels.testSendFailed, ...details],
          });
        }
      }
      const file = `Mail${type}.xml`;
      const document = await load(file);
      const savedId = saveTemplate(document, model, locale, false, data.storedQuery);
      await save(file, document, session(req)?.userId ?? '', req.ip ?? '');
      return res.redirect(`${root}/DetailsMailTemplate?id=${encodeURIComponent(`${type},${savedId}`)}`);
    } catch {
      return showPage(res, locale, { mode: 'denied', errors: [labels.serverError] });
    }
  });
}

async function autocompleteSetting(db: pg.Pool): Promise<'on' | 'off'> {
  const row = (
    await db.query<{ com_value: string }>(
      'SELECT com_value FROM mst_common WHERE com_key = $1 AND com_name = $2 ORDER BY com_index LIMIT 1',
      ['SYSTEM', 'AUTOCOMPLETE'],
    )
  ).rows[0];
  return row?.com_value === '0' ? 'off' : 'on';
}
