import type { Request, Response } from 'express';
import type pg from 'pg';
import { authenticate } from '../shared/authenticate.js';
import { clientParameter } from './client-account.js';
import { apiBase } from '../config/api.js';
import { apiEntitlements, apiLoginResult, logApiOperation, type ApiAccount } from '../models/api-account.js';
import { clientPasswordExpired } from '../models/client-account.js';
import { clientError } from '../services/client-xml.js';
import type { LoginContent } from '../shared/operation-log.js';

export async function apiAccountAction(db: pg.Pool, handler: string, req: Request, res: Response): Promise<boolean> {
  if (handler === 'Logout') {
    req.session.logoutContent = 'Logout';
    await new Promise<void>((resolve, reject) => req.session.save((error) => (error ? reject(error) : resolve())));
    await new Promise<void>((resolve, reject) => req.session.destroy((error) => (error ? reject(error) : resolve())));
    res.clearCookie('ASP.NET_SessionId', { path: apiBase }).send(clientError(0));
    return true;
  }
  if (handler !== 'Login') return false;
  // Failed login must not retain a previously authenticated API identity.
  delete req.session.apiAccount;
  const value = (name: string) => clientParameter(req, name);
  let account: ApiAccount = {
    userId: value('user'),
    userName: '',
    address: req.ip ?? '',
    sessionId: req.sessionID,
    freeDrawOnly: false,
  };
  let logContent: LoginContent = 'LoginAuthError';
  const respond = (code: number, remark: string, passwordExpired = false) => {
    logContent = code === 0 && !passwordExpired ? 'LoginSuccess' : code === 5 ? 'LoginLockError' : 'LoginAuthError';
    res.send(apiLoginResult(code, remark, passwordExpired));
  };
  try {
    const license = apiEntitlements();
    if (
      !(license.api || license.motionboard || (license.irPlus && value('extentions') === 'irplus')) ||
      (license.freeDrawOnly && license.freeDrawExpired)
    ) {
      res.send(clientError(11050));
      return true;
    }
    const role = (
      await db.query(
        `SELECT max(role_api_execute) AS allowed FROM mst_group
      WHERE group_id IN (SELECT group_id FROM mst_group_affiation WHERE user_id=$1)`,
        [account.userId],
      )
    ).rows[0];
    if (String(role?.allowed ?? '') !== '1') {
      res.send(clientError(3, 'Privilege Error'));
      return true;
    }
    if (!account.userId || account.userId.length > 100 || !value('password') || value('password').length > 256) {
      res.send(clientError(2));
      return true;
    }
    const settings = new Map<string, string>(
      (
        await db.query(`SELECT com_key,com_name,com_value FROM mst_common
      WHERE com_key IN ('SYSTEM','PASSWORD_SETTING') ORDER BY com_index`)
      ).rows.map((row) => [`${row.com_key}/${row.com_name}`, row.com_value ?? '']),
    );
    const result = await authenticate(
      db,
      account.userId,
      value('password'),
      process.env.CONMAS_LEGACY_KEY ?? '',
      'api',
    );
    if (result.logContent === 'LoginLockError') {
      respond(5, 'Account is Locked.');
      return true;
    }
    if (result.user && settings.get('SYSTEM/API_LOGIN_TYPE') === '1') {
      res.status(501).send(clientError(-1, 'API FollowLogin authentication has not been migrated.'));
      return true;
    }
    const passwordExpired =
      account.userId !== 'conmasadmin' &&
      (await clientPasswordExpired(
        db,
        account.userId,
        settings.get('PASSWORD_SETTING/PASSWORD_MAXIMUM_AGE') ?? '0',
      )) === '1';
    if (!result.user) {
      respond(1, 'AuthFailure', passwordExpired);
      return true;
    }
    account = {
      ...account,
      userId: result.user.user_id,
      userName: result.user.user_name,
      freeDrawOnly: license.freeDrawOnly,
    };
    if (passwordExpired) {
      respond(0, '', true);
      return true;
    }
    await new Promise<void>((resolve, reject) => req.session.save((error) => (error ? reject(error) : resolve())));
    await new Promise<void>((resolve, reject) =>
      req.session.regenerate((error) => (error ? reject(error) : resolve())),
    );
    account.sessionId = req.sessionID;
    req.session.apiAccount = account;
    respond(0, '');
    return true;
  } finally {
    await logApiOperation(db, account, logContent);
  }
}
