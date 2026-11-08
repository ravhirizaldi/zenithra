import type { Express } from 'express';
import type pg from 'pg';
import { base } from '../../../config/manager.js';
import type { RenderPage } from '../../../services/manager/page.js';
import { authenticate } from '../../../shared/authenticate.js';
import { logManagerOperation, managerLogContext } from '../../../shared/operation-log.js';
import { handleMeIdAccountCallback } from '../system/meid.js';

export function registerAccountController(
  app: Express,
  database: pg.Pool | null,
  authEnabled: boolean,
  page: RenderPage,
): void {
  app.get(`${base}/Account/LogOn`, (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (typeof req.query.timeout === 'string' && req.query.timeout)
      return res.redirect(`${base}/Account/LogOff?timeout=true`);
    if (!authEnabled || req.session.userId) return res.redirect(`${base}/`);
    return page(res, { active: '', section: '', login: true, title: 'Log In' });
  });
  app.post(`${base}/Account/LogOn`, async (req, res) => {
    if (!authEnabled || !database)
      return res.status(501).type('text/plain').send('Authentication is disabled for the local catalog.');
    if (await handleMeIdAccountCallback(database, req, res)) return;
    const userId = typeof req.body.UserName === 'string' ? req.body.UserName.trim() : '';
    const password = typeof req.body.Password === 'string' ? req.body.Password : '';
    if (!userId || userId.length > 100 || !password || password.length > 256) {
      return page(res.status(400), {
        active: '',
        section: '',
        login: true,
        title: 'Log In',
        loginError: 'Enter a valid user name and password.',
      });
    }
    const legacyKey = process.env.CONMAS_LEGACY_KEY;
    if (!legacyKey) return res.status(503).type('text/plain').send('Password encryption key is not configured.');
    const result = await authenticate(database, userId, password, legacyKey);
    if (!result.user) {
      if (result.logContent) {
        const context = managerLogContext(req, userId, '');
        if (await logManagerOperation(database, context, result.logContent)) req.session.operationLogContext = context;
      }
      return page(res.status(401), { active: '', section: '', login: true, title: 'Log In', loginError: result.error });
    }
    await new Promise<void>((resolve, reject) =>
      req.session.regenerate((error) => (error ? reject(error) : resolve())),
    );
    req.session.userId = result.user.user_id;
    req.session.userName = result.user.user_name;
    req.session.userStart = result.user.use_start_time.toISOString();
    req.session.userEnd = result.user.use_end_time.toISOString();
    const context = managerLogContext(req, result.user.user_id, result.user.user_name);
    if (await logManagerOperation(database, context, 'LoginSuccess')) req.session.operationLogContext = context;
    return res.redirect(`${base}/`);
  });
  app.get(`${base}/Account/Dummy`, (_req, res) =>
    res.set('Cache-Control', 'no-store').render('manager/account/session-timeout', { base }),
  );
  app.get(`${base}/Account/LogOff`, async (req, res) => {
    if (!authEnabled)
      return page(res, { active: '', section: '', login: true, title: 'Local preview closed', loggedOut: true });
    req.session.logoutContent = 'Logout';
    await new Promise<void>((resolve, reject) => req.session.save((error) => (error ? reject(error) : resolve())));
    await new Promise<void>((resolve, reject) => req.session.destroy((error) => (error ? reject(error) : resolve())));
    res.clearCookie('conmas_node_sid', { path: base });
    return res.redirect(`${base}/Account/LogOn`);
  });
}
