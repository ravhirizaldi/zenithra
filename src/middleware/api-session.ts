import session from 'express-session';
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { apiBase, apiConfiguration } from '../config/api.js';
import { ManagerSessionStore } from '../shared/manager-session.js';
import { logApiOperation, type ApiAccount } from '../models/api-account.js';

declare module 'express-session' {
  interface SessionData {
    apiAccount?: ApiAccount;
  }
}

export function apiSession(db: pg.Pool | null, store?: session.Store) {
  const configuration = apiConfiguration();
  return session({
    name: 'ASP.NET_SessionId',
    secret: process.env.SESSION_SECRET ?? randomBytes(32).toString('hex'),
    store:
      store ??
      new ManagerSessionStore(async (data) => {
        if (db && data.apiAccount) await logApiOperation(db, data.apiAccount, data.logoutContent ?? 'LogoutTimeout');
      }, configuration.idleMs),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'strict', secure: configuration.secureCookie, path: apiBase },
  });
}
