import session from 'express-session';
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { ClientAccount } from '../models/client-account.js';
import { ManagerSessionStore } from '../shared/manager-session.js';
import { logClientOperation } from '../shared/operation-log.js';
import { clientBase, clientConfiguration } from '../config/client.js';
import { cleanupReportUpload } from '../models/client-report-upload.js';

declare module 'express-session' {
  interface SessionData {
    clientAccount?: ClientAccount;
  }
}

export function clientSession(db: pg.Pool | null, store?: session.Store) {
  return session({
    name: 'ASP.NET_SessionId',
    secret: process.env.SESSION_SECRET ?? randomBytes(32).toString('hex'),
    store:
      store ??
      new ManagerSessionStore(async (data) => {
        await cleanupReportUpload(data.clientReportUpload);
        if (db && data.clientAccount)
          await logClientOperation(db, data.clientAccount, data.logoutContent ?? 'LogoutTimeout');
      }, clientConfiguration().idleMs),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'strict', path: clientBase },
  });
}
