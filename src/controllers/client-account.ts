import type { Request, Response } from 'express';
import type pg from 'pg';
import { XMLParser } from 'fast-xml-parser';
import { authenticate } from '../shared/authenticate.js';
import { clientBase, clientConfiguration, designerInstallerUrl, validClientVersion } from '../config/client.js';
import { readLicenseFields, readLicenseXml } from '../shared/license-counts.js';
import {
  clientCommonSettings,
  clientPasswordExpired,
  clientTerminal,
  clientUserInfo,
  registerClientTerminal,
  changeClientTerminal,
  type ClientAccount,
} from '../models/client-account.js';
import { logClientOperation } from '../shared/operation-log.js';
import { clientElement, clientError } from '../services/client-xml.js';
import { requestFailure } from '../middleware/request-log.js';

// ASP.NET Request.Params combines query then form values, including duplicate scalar fields.
export function clientParameter(req: Request, name: string): string {
  const entries = [req.query[name], req.body?.[name]].flat().filter((value) => value !== undefined);
  return entries.every((value) => typeof value === 'string') ? entries.join(',') : '';
}

export async function clientLogin(db: pg.Pool, req: Request, res: Response): Promise<void> {
  const configuration = clientConfiguration();
  const settings = await clientCommonSettings(db);
  const value = (name: string) => clientParameter(req, name);
  let authenticated = false;
  let menuVersion: unknown = undefined;
  let account: ClientAccount = {
    userId: value('user'),
    userName: '',
    client: value('client'),
    physicalId: value('terminalId'),
    version: value('version'),
    platform: value('platform'),
    address: req.ip ?? '',
    sessionId: req.sessionID,
  };
  const respond = async (code: number, remark = '', extra = '') => {
    const events = {
      0: 'LoginSuccess',
      1: 'LoginAuthError',
      2: 'LoginVersionError',
      3: 'LoginTerminalApplyError',
      4: 'LoginTerminalApproveError',
      5: 'LoginLockError',
    } as const;
    await logClientOperation(db, account, events[code as keyof typeof events] ?? 'LoginError');
    res.send(
      `<conmas><loginResult>${clientElement('code', code)}${authenticated ? clientElement('serverVersion', configuration.serverVersion) : ''}${clientElement('remark', remark)}${menuVersion === undefined ? '' : clientElement('menuVersion', menuVersion)}</loginResult>${extra}</conmas>`,
    );
  };
  if (
    configuration.authType !== 'STD' ||
    value('authenticationType') === '2' ||
    value('mode') === 'AD' ||
    value('authenticationType') === '1'
  ) {
    await respond(8);
    return;
  }
  if (
    settings.get('LOGIN_SETTING/ENABLE_MEID') === '1' &&
    settings.get('TABLET_SETTING/MEID_IR_LOGIN_ENABLE') !== '1'
  ) {
    await respond(1);
    return;
  }
  if (
    !account.userId ||
    account.userId.length > 100 ||
    !value('password') ||
    value('password').length > 256 ||
    !account.physicalId ||
    account.physicalId.length > 200 ||
    !account.version ||
    !['Designer', 'iPad'].includes(account.client)
  ) {
    res.send(clientError(2));
    return;
  }
  if (value('newPassword')) {
    res.status(501).send(clientError(-1, 'Client password changes have not been migrated.'));
    return;
  }
  const fields = readLicenseFields();
  const minimum = account.client === 'Designer' ? configuration.designerVersion : configuration.ipadVersion;
  const limited = (name: string) =>
    /^[+-]?\d+$/.test(fields.get(name) ?? '') && Number(fields.get(name)) > 0 && Number(fields.get(name)) <= 2147483647;
  const installer = designerInstallerUrl(`${req.protocol}://${req.get('host')}`, value('appLanguage'));
  if (
    !validClientVersion(minimum, account.version) ||
    (account.client === 'Designer' &&
      ((limited('i-RepoScanLimited') &&
        configuration.scanDesignerVersion &&
        !validClientVersion(configuration.scanDesignerVersion, account.version)) ||
        (limited('i-RepoEdgeOCRLimited') &&
          configuration.edgeOcrDesignerVersion &&
          !validClientVersion(configuration.edgeOcrDesignerVersion, account.version))))
  ) {
    await respond(2, account.client === 'Designer' ? installer : minimum);
    return;
  }
  const key = process.env.CONMAS_LEGACY_KEY;
  if (!key) {
    res.status(503).send(clientError(-1, 'Password encryption key is not configured.'));
    return;
  }
  const result = await authenticate(db, account.userId, value('password'), key, 'client');
  if (!result.user) {
    const lockHidden =
      (
        await db.query(
          "SELECT com_value FROM mst_common WHERE com_key='ACCOUNT_LOCK_SETTING' AND com_name='RESPONSE_TYPE' ORDER BY com_index LIMIT 1",
        )
      ).rows[0]?.com_value === '1';
    await respond(result.logContent === 'LoginLockError' && !lockHidden ? 5 : 1, 'AuthFailure');
    return;
  }
  if (fields.get('FreeDrawOnly') === '1') {
    await new Promise<void>((resolve, reject) => req.session.destroy((error) => (error ? reject(error) : resolve())));
    await respond(7, 'FreeDraw Only');
    return;
  }
  account = { ...account, userId: result.user.user_id, userName: result.user.user_name };
  await new Promise<void>((resolve, reject) => req.session.regenerate((error) => (error ? reject(error) : resolve())));
  account.sessionId = req.sessionID;
  req.session.clientAccount = account;
  authenticated = true;
  const terminal = await clientTerminal(db, account);
  const versions = new Map(
    (await db.query('SELECT data_id,data_version FROM common_data_version ORDER BY data_id DESC')).rows.map((row) => [
      row.data_id,
      row.data_version,
    ]),
  );
  menuVersion = versions.get('CustomMenu');
  const expiry = await clientPasswordExpired(
    db,
    account.userId,
    settings.get('PASSWORD_SETTING/PASSWORD_MAXIMUM_AGE') ?? '0',
  );
  const get = (key: string, fallback = '') => settings.get(key) || fallback;
  const extra =
    `<iPadSetting><customMaster>${clientElement('isAutoUpdating', get('IPAD_SETTING/AUTO_CUSTOM_MASTER_UPDATING') === '1' ? '1' : '0')}${versions.has('CustomMasterlabel') ? clientElement('lastUpdateLabel', versions.get('CustomMasterlabel')) : ''}${versions.has('CustomMaster') ? clientElement('lastUpdateMaster', versions.get('CustomMaster')) : ''}</customMaster>${clientElement('internalImageFormat', get('IPAD_SETTING/INTERNAL_IMAGE_FORMAT', 'png'))}${clientElement('internalImageSize', get('IPAD_SETTING/INTERNAL_IMAGE_SIZE', '0'))}${clientElement('responseMessageMode', get('IPAD_SETTING/RESPONSE_MESSAGE_MODE', '0'))}${clientElement('logOutputMode', get('IPAD_SETTING/LOG_OUTPUT_MODE', '0'))}</iPadSetting>` +
    (account.userId === 'conmasadmin'
      ? ''
      : `<passwordSetting>${clientElement('enablePasswordChange', get('PASSWORD_SETTING/ENABLE_PASSWORD_CHANGE') === '1' ? '1' : '0')}${clientElement('passwordExpiration', expiry)}</passwordSetting>`) +
    clientElement('definitionApproveMode', get('DEFINITION_SETTING/APPROVE_MODE') === '1' ? '1' : '0');
  await respond(terminal.code, '', extra);
}

export async function clientAccountAction(db: pg.Pool, command: string, req: Request, res: Response): Promise<boolean> {
  if (command === 'Logout') {
    req.session.logoutContent = 'Logout';
    await new Promise<void>((resolve, reject) => req.session.save((error) => (error ? reject(error) : resolve())));
    await new Promise<void>((resolve, reject) => req.session.destroy((error) => (error ? reject(error) : resolve())));
    res.clearCookie('ASP.NET_SessionId', { path: clientBase });
    res.send(clientError(0));
    return true;
  }
  if (command === 'GetAuthenticationType') {
    const settings = await clientCommonSettings(db);
    const type =
      clientConfiguration().authType === 'AD' ? '1' : settings.get('LOGIN_SETTING/ENABLE_MEID') === '1' ? '2' : '0';
    if (type === '2')
      res.status(501).send(clientError(-1, 'Microsoft Entra ID client authentication has not been migrated.'));
    else res.send(`<conmas>${clientElement('authenticationType', type)}</conmas>`);
    return true;
  }
  if (command === 'Login') {
    await clientLogin(db, req, res);
    return true;
  }
  const account = req.session.clientAccount;
  if (!account) {
    res.send(clientError(5, 'no session.'));
    return true;
  }
  if (command === 'ApprovalTerminal' || command === 'RemoveTerminal') {
    try {
      res.send(await changeClientTerminal(db, account, command === 'ApprovalTerminal'));
    } catch (error) {
      requestFailure(res, error);
      res.send(clientError(-1, 'server error.'));
    }
    return true;
  }
  if (command === 'GetDesignerInstallerUrl') {
    res.send(
      `<conmas>${clientElement('url', designerInstallerUrl(`${req.protocol}://${req.get('host')}`, clientParameter(req, 'appLanguage')))}</conmas>`,
    );
    return true;
  }
  if (command === 'GetUserInfo') {
    res.send(await clientUserInfo(db, account));
    return true;
  }
  if (command === 'RegistTerminal') {
    const comment = clientParameter(req, 'comment');
    if (comment.length > 1000) res.send(clientError(2));
    else {
      await registerClientTerminal(db, account, comment, clientParameter(req, 'useBiometrics'));
      res.send(clientError(0, ''));
    }
    return true;
  }
  if (command === 'GetLicense') {
    if ((await clientTerminal(db, account)).code !== 0) res.send(clientError(3));
    else {
      const parser = new XMLParser({ parseTagValue: false });
      const encrypted = parser.parse(readLicenseXml())?.ConMas?.license;
      if (typeof encrypted !== 'string' || !encrypted) throw new Error('Invalid effective license XML.');
      res.send(`<conmas>${clientElement('license', encrypted)}</conmas>`);
    }
    return true;
  }
  return false;
}
