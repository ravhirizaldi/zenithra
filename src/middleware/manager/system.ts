import type { Express, RequestHandler } from 'express';
import type pg from 'pg';
import { randomBytes } from 'node:crypto';
import multer from 'multer';
import { base } from '../../config/manager.js';
import { systemPermissionMap, type SystemPermissionAction, type SystemPermissionScope } from './system/permissions.js';
import { loadNavigationFlags } from '../../models/manager/system/navigation.js';
import { systemMenuFor } from '../../services/manager/system/navigation.js';
import { systemUploadBody } from './system/upload-body.js';
import { labelPermissions } from '../../models/manager/labels/index.js';

type SystemPermissionRequirement = { scope: SystemPermissionScope; action: SystemPermissionAction };

function systemRoutePermission(
  path: string,
  method: string,
  body: Record<string, unknown>,
): SystemPermissionRequirement | null {
  const route = path.slice(path.lastIndexOf('/') + 1);
  switch (route) {
    case 'UserList':
      return { scope: 'user', action: 'read' };
    case 'CreateUser':
      return { scope: 'user', action: 'create' };
    case 'EditUser':
      return { scope: 'user', action: 'edit' };
    case 'DetailsUser':
      return { scope: 'user', action: method === 'POST' ? (body.act === 'delete' ? 'delete' : 'edit') : 'read' };
    case 'GetStamp':
      return { scope: 'user', action: 'read' };
    case 'GroupList':
      return { scope: 'group', action: 'read' };
    case 'DetailsGroup':
      return { scope: 'group', action: method === 'POST' && body.act === 'delete' ? 'delete' : 'read' };
    case 'CreateGroup':
      return { scope: 'group', action: 'create' };
    case 'EditGroup':
      return { scope: 'group', action: 'edit' };
    case 'EditDefaultRole':
    case 'EditFdRole':
      return { scope: 'group', action: method === 'POST' ? 'edit' : 'read' };
    case 'TermList':
      return {
        scope: 'terminal',
        action:
          method === 'POST' && body.ConMasAction === 'DeleteAction'
            ? 'delete'
            : method === 'POST' && body.ConMasAction === 'ApproveAction'
              ? 'edit'
              : 'read',
      };
    case 'DetailsTerm':
      return { scope: 'terminal', action: method === 'POST' && body.act === 'delete' ? 'delete' : 'read' };
    case 'CreateTerm':
      return { scope: 'terminal', action: 'create' };
    case 'EditTerm':
      return { scope: 'terminal', action: 'edit' };
    case 'SearchUser':
    case 'SearchUserDirect':
      return { scope: 'terminal', action: 'read' };
    case 'UserAccountOperationLog':
      return { scope: 'data', action: 'read' };
    default:
      return null;
  }
}

export function registerSystemMiddleware(
  app: Express,
  database: pg.Pool | null,
  authEnabled: boolean,
  requireAuth: RequestHandler,
): void {
  app.use(base, async (req, res, next) => {
    const labelPath =
      req.path === '/Label' ||
      req.path.startsWith('/Label/') ||
      ['/Common/LabelManagerListView', '/Common/LabelSelectListView'].includes(req.path);
    const libraryPath = req.path === '/Library' || req.path.startsWith('/Library/');
    const outputPath = req.path === '/DataOutput' || req.path.startsWith('/DataOutput/');
    const documentPath =
      req.path === '/' ||
      req.path === '/InputReport' ||
      req.path.startsWith('/InputReport/') ||
      req.path === '/Common/LabelListView';
    if (
      !req.path.startsWith('/System') &&
      req.path !== '/SystemGoogleAuthCallback/IndexAsync' &&
      !labelPath &&
      !libraryPath &&
      !outputPath &&
      !documentPath
    )
      return res.status(503).type('text/plain').send('This section is disabled while System is being ported.');
    if (database && req.session?.userId)
      res.locals.labelPermissions = await labelPermissions(database, req.session.userId);
    return next();
  });
  app.use(`${base}/System`, requireAuth, async (req, res, next) => {
    if (!authEnabled || !database || !req.session?.userId) return next();
    try {
      const userId = req.session.userId;
      const permissions = await systemPermissionMap(database, userId);
      res.locals.systemPermissionMap = permissions;
      if (userId !== 'conmasadmin' && !permissions.systemTab)
        return res.status(403).type('text/plain').send('System permissions for this account have not been ported.');
      const flags = await loadNavigationFlags(database);
      res.locals.systemMenu = systemMenuFor(userId, permissions, flags);
      return next();
    } catch (error) {
      return next(error);
    }
  });
  const systemMultipart = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 4 * 1024 * 1024, files: 1, fields: 1000 },
  });
  const licenseMultipart = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 4 * 1024 * 1024, files: 2, fields: 1000 },
  }).fields([
    { name: 'uploadLicenseFile', maxCount: 1 },
    { name: 'pdfLicenseFile', maxCount: 1 },
  ]);
  app.use(`${base}/System`, (req, res, next) => {
    if (!req.is('multipart/form-data')) return next();
    const route = req.originalUrl.split('?')[0].split('/').pop();
    if (route === 'CreateUser' || route === 'EditUser') {
      return systemMultipart.fields([
        { name: 'file', maxCount: 1 },
        { name: 'approval_sign', maxCount: 1 },
      ])(req, res, (error) => {
        if (error) return next(error);
        const files = req.files as Record<string, Express.Multer.File[]> | undefined;
        req.file = files?.file?.[0] ?? files?.approval_sign?.[0];
        return next();
      });
    }
    if (route === 'UploadLicense') return licenseMultipart(req, res, next);
    if (route === 'DataInput' || route === 'CreateUpload') return systemUploadBody(req, res, next);
    if (route === 'EdgeOCRCredentialSetting') return systemMultipart.single('file1')(req, res, next);
    if (
      [
        'UploadList',
        'CreateUpload',
        'DataInput',
        'DataOutput',
        'DataOutputView',
        'GoogleCredentialSetting',
        'EdgeOCRCredentialSetting',
        'ConfirmEdgeOCRCredentialSetting',
      ].includes(route ?? '')
    )
      return next();
    return systemMultipart.none()(req, res, next);
  });
  app.use(`${base}/System`, (req, res, next) => {
    if (!authEnabled || !database || !req.session?.userId || req.session.userId === 'conmasadmin') return next();
    if (req.path === '/EditAdmin')
      return res.status(403).type('text/plain').send('System permissions for this account have not been ported.');
    const permissions = res.locals.systemPermissionMap;
    const required = systemRoutePermission(req.originalUrl.split('?')[0], req.method, req.body ?? {});
    if (required && !permissions?.[required.scope]?.[required.action])
      return res.status(403).type('text/plain').send('System permissions for this account have not been ported.');
    return next();
  });
  app.use(`${base}/System`, (req, res, next) => {
    if (authEnabled) {
      req.session.csrfToken ??= randomBytes(32).toString('hex');
      res.locals.csrfToken = req.session.csrfToken;
      res.locals.userName = req.session.userName;
      if (req.method !== 'GET' && req.body?.__RequestVerificationToken !== req.session.csrfToken)
        return res.status(403).send('Invalid form verification token.');
    }
    return next();
  });
}
