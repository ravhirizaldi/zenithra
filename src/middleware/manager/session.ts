import type { Express, RequestHandler } from 'express';
import session from 'express-session';
import type pg from 'pg';
import { randomBytes } from 'node:crypto';
import { base } from '../../config/manager.js';
import { ManagerSessionStore } from '../../shared/manager-session.js';
import { logManagerOperation } from '../../shared/operation-log.js';

export function configureSession(
  app: Express,
  database: pg.Pool | null,
  authEnabled: boolean,
  sessionStore?: session.Store,
): void {
  if (authEnabled) {
    app.use(
      session({
        name: 'conmas_node_sid',
        secret: process.env.SESSION_SECRET ?? randomBytes(32).toString('hex'),
        store:
          sessionStore ??
          new ManagerSessionStore(async (data) => {
            if (database && data.operationLogContext)
              await logManagerOperation(database, data.operationLogContext, data.logoutContent ?? 'LogoutTimeout');
          }),
        resave: false,
        saveUninitialized: false,
        cookie: { httpOnly: true, sameSite: 'lax', path: base },
      }),
    );
  }
}

export function requireSession(authEnabled: boolean): RequestHandler {
  return (req, res, next) => {
    if (!authEnabled) return next();
    res.set('Cache-Control', 'no-cache');
    if (req.session.userId) {
      const now = Date.now();
      if (
        req.session.userStart &&
        req.session.userEnd &&
        new Date(req.session.userStart).getTime() <= now &&
        new Date(req.session.userEnd).getTime() >= now
      )
        return next();
      return res.redirect(`${base}/Account/Dummy`);
    }
    return res.redirect(
      `${base}/Account/${/(?:^|;\s*)conmas_node_sid=/.test(req.get('cookie') ?? '') ? 'Dummy' : 'LogOn'}`,
    );
  };
}
