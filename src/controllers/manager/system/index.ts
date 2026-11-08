import type { Express, RequestHandler } from 'express';
import type pg from 'pg';
import { base, menus } from '../../../config/manager.js';
import type { RenderPage } from '../../../services/manager/page.js';
import { listUsers } from '../../../models/manager/system/users.js';
import { listCommonSettings } from '../../../models/manager/system/common.js';
import { firstSystemMenuHref, type SystemMenuEntry } from '../../../services/manager/system/navigation.js';
import { normalizeSystemMode, systemIndexTargets } from '../../../services/manager/system/modes.js';

export function registerSystemController(
  app: Express,
  database: pg.Pool | null,
  page: RenderPage,
  requireAuth: RequestHandler,
): void {
  app.get(`${base}/System/Details`, (req, res) => {
    const mode = normalizeSystemMode(req.query.mode);
    const targets: Record<string, { edit?: string; create?: string; temp?: string }> = {
      user: { edit: 'DetailsUser', create: 'CreateUser' },
      group: { edit: 'DetailsGroup', create: 'CreateGroup' },
      term: { edit: 'DetailsTerm', create: 'CreateTerm' },
      mail: { edit: 'EditMailBase', create: 'CreateMailTemplate', temp: 'DetailsMailTemplate' },
      upload: { create: 'CreateUpload' },
      com: { edit: 'DetailsCom', create: 'CreateCom' },
      dataInput: { edit: 'DataInput', create: 'DataInput' },
      dataOutput: { edit: 'DataOutput' },
      task: { edit: 'EditTask', create: 'EditTask' },
      lockManage: { edit: 'LockManagement' },
      operationLog: { edit: 'OperationLog' },
      userAccountOperationLog: { edit: 'UserAccountOperationLog' },
      license: { edit: 'DetailsLicense', temp: 'DetailsLicense' },
      voiceCommonGrammar: { edit: 'VoiceCommonGrammar', create: 'VoiceCommonGrammar' },
      direct: { edit: 'EditDirectNotification', create: 'EditDirectTemplate', temp: 'DetailsDirectTemplate' },
      directLog: { edit: 'DirectSendLog' },
      userDirect: { edit: 'DetailsUserDirect' },
      webhook: { edit: 'WebhookChat' },
      webhookLog: { edit: 'WebhookSendLog' },
      googleCredentials: { edit: 'GoogleCredentialSetting' },
      box: { edit: 'BoxCredentialSetting' },
      bim360: { edit: 'Bim360CredentialSetting' },
      irfd: { edit: 'IrfdTemplateList' },
      mbCloud: { edit: 'MbCloudSetting' },
      mbCloudLog: { edit: 'MbCloudSendLog' },
      mailLog: { edit: 'MailSendLog' },
      edgeOCR: { edit: 'EdgeOCRCredentialSetting', temp: 'ConfirmEdgeOCRCredentialSetting' },
    };
    const target = targets[mode];
    const act = String(req.query.act ?? '');
    const route =
      mode === 'userDirect' && act === 'editDirect'
        ? 'EditUserDirect'
        : act === 'create'
          ? target?.create
          : act === 'temp'
            ? target?.temp
            : (target?.edit ?? target?.temp ?? target?.create);
    if (!route) return res.status(404).type('text/plain').send('Unknown System detail action.');
    const query = new URLSearchParams();
    if (typeof req.query.id === 'string') query.set('id', req.query.id);
    return res.redirect(`${base}/System/${route}${query.size ? `?${query}` : ''}`);
  });
  app.get(`${base}/System/UserList`, requireAuth, async (req, res) => {
    if (!database) return page(res, { active: 'System', section: 'UserList', login: false, title: 'Users' });
    const data = await listUsers(database, req.query);
    return page(res, {
      active: 'System',
      section: 'UserList',
      login: false,
      title: 'Users',
      userName: req.session?.userName,
      ...data,
    });
  });
  if (!database) {
    app.get(`${base}/System/GroupList`, requireAuth, (_req, res) =>
      page(res, { active: 'System', section: 'GroupList', login: false, title: 'Groups' }),
    );
    app.get(`${base}/System/TermList`, requireAuth, (_req, res) =>
      page(res, { active: 'System', section: 'TermList', login: false, title: 'Devices' }),
    );
  }
  app.get(`${base}/System/ComList`, requireAuth, async (req, res) => {
    if (!database) return page(res, { active: 'System', section: 'ComList', login: false, title: 'Common Master' });
    const systemTable = await listCommonSettings(database, req.query);
    return page(res, {
      active: 'System',
      section: 'ComList',
      login: false,
      title: 'Common Master',
      userName: req.session?.userName,
      systemTable,
    });
  });
}

export function registerIndexController(
  app: Express,
  database: pg.Pool | null,
  authEnabled: boolean,
  page: RenderPage,
  requireAuth: RequestHandler,
): void {
  for (const [label, route] of menus) {
    const pathname = route.split('?')[0];
    if (pathname === 'DefReport' || pathname === 'InputReport' || pathname === 'Label') continue;
    const [controller] = pathname.split('/');
    const paths = pathname.includes('/')
      ? [`${base}/${pathname}`]
      : [`${base}/${pathname}`, `${base}/${pathname}/Index`];
    app.get(paths, requireAuth, (req, res) => {
      if (database && controller === 'System') {
        const mode = req.query.mode;
        if (mode !== undefined) {
          const target = systemIndexTargets[normalizeSystemMode(mode)];
          return target
            ? res.redirect(`${base}/System/${target}`)
            : res.status(404).type('text/plain').send('Unknown System menu mode.');
        }
        const firstLink = firstSystemMenuHref((res.locals.systemMenu as SystemMenuEntry[] | undefined) ?? []);
        if (firstLink) return res.redirect(firstLink);
        return authEnabled
          ? res.status(403).type('text/plain').send('No System menu is available.')
          : res.redirect(`${base}/System/UserList`);
      }
      return page(res, {
        base,
        menus,
        active: controller,
        section: controller === 'System' ? 'UserList' : '',
        login: false,
        title: label,
        userName: req.session?.userName,
      });
    });
  }
}
