import { text as pageText } from '../../../config/manager/system/resources.js';
import { licenseStatus } from '../../../shared/license-counts.js';
import type { Express, Request, Response } from 'express';
import type pg from 'pg';
import { createHash, createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto';
import { hostname } from 'node:os';
import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';
import { hasSystemPermission } from '../../../middleware/manager/system/permissions.js';
export type MeIdSettings = {
  AppClientId: string;
  AppTenantId: string;
  AppAllowSso: number;
  ManagerClientId: string;
  ManagerTenantId: string;
  ManagerAllowSso: number;
  ManagerRedirectUri: string;
};

type MeIdMode = 'details' | 'edit' | 'roleError';
export type MeIdAuthAction = 'MeIdAuthRegist' | 'MeIdAuthEdit';
type PendingMeIdAuth = {
  action: MeIdAuthAction;
  clientId: string;
  tenantId: string;
  nonce: string;
  sessionID: string;
  userId: string;
  originalSessionCookieHash: string;
  callbackHadOriginalSessionCookie: boolean;
  expiresAt: number;
  identity?: MeIdIdentity;
  error?: string;
  received: boolean;
};
type MeIdIdentity = { preferredUsername: string; oid: string };
type MeIdPageValues = { settings?: MeIdSettings; enable?: boolean; adminMsUser?: string; canEdit?: boolean };
type MeIdPageModel = MeIdSettings & { Enable: boolean; AdminMsUser: string };
type LoadedMeIdPage = { settings: MeIdSettings; enable: boolean; adminMsUser: string };
type Render = (res: Response, data: Record<string, unknown>) => unknown;

const root = '/ConMasManager/System';
const accountLogOn = '/ConMasManager/Account/LogOn';
const sessionCookieName = 'conmas_node_sid';
const settingParser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: false });
const settingBuilder = new XMLBuilder({ ignoreAttributes: false, format: true });
const pendingMeIdAuth = new Map<string, PendingMeIdAuth>();
const pendingMeIdAuthLifetime = 10 * 60 * 1000;

const emptyMeIdSettings = (): MeIdSettings => ({
  AppClientId: '',
  AppTenantId: '',
  AppAllowSso: 0,
  ManagerClientId: '',
  ManagerTenantId: '',
  ManagerAllowSso: 0,
  ManagerRedirectUri: '',
});
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
function requestCookie(req: Request, name: string): string {
  for (const pair of (req.headers.cookie ?? '').split(';')) {
    const separator = pair.indexOf('=');
    if (separator >= 0 && pair.slice(0, separator).trim() === name) return pair.slice(separator + 1).trim();
  }
  return '';
}
const hashCookie = (value: string): string => createHash('sha256').update(value).digest('hex');
const bodyText = (body: Record<string, unknown>, key: string): string => text(body[key]);
const field = (node: unknown, key: string): string => text(object(node)[key]);
function expirePendingMeIdAuth(): void {
  const now = Date.now();
  for (const [state, pending] of pendingMeIdAuth) {
    if (pending.expiresAt <= now) pendingMeIdAuth.delete(state);
  }
}

const pendingMeIdAuthCleanup = setInterval(expirePendingMeIdAuth, 60_000);
pendingMeIdAuthCleanup.unref();

export function parseMeIdSetting(xml: string): MeIdSettings {
  if (!xml.trim()) return emptyMeIdSettings();
  if (XMLValidator.validate(xml) !== true) throw new Error(pageText['MeID settings XML is invalid.']);
  const rootNode = object(settingParser.parse(xml).conmas);
  const app = object(rootNode.app);
  const manager = object(rootNode.manager);
  return {
    AppClientId: field(app, 'clientId'),
    AppTenantId: field(app, 'tenantId'),
    AppAllowSso: field(app, 'allowSso') === '1' ? 1 : 0,
    ManagerClientId: field(manager, 'clientId'),
    ManagerTenantId: field(manager, 'tenantId'),
    ManagerAllowSso: field(manager, 'allowSso') === '1' ? 1 : 0,
    ManagerRedirectUri: field(manager, 'redirectUri'),
  };
}

export function serializeMeIdSetting(settings: MeIdSettings): string {
  return settingBuilder.build({
    conmas: {
      app: {
        clientId: settings.AppClientId.trim(),
        tenantId: settings.AppTenantId.trim(),
        allowSso: settings.AppAllowSso,
      },
      manager: {
        clientId: settings.ManagerClientId.trim(),
        tenantId: settings.ManagerTenantId.trim(),
        allowSso: settings.ManagerAllowSso,
        redirectUri: settings.ManagerRedirectUri.trim(),
      },
    },
  });
}

export function validateMeIdSettings(
  settings: MeIdSettings,
  initialErrors: Record<string, string> = {},
): Record<string, string> {
  const errors = { ...initialErrors };
  for (const [name, label] of [
    ['AppClientId', 'Client ID'],
    ['AppTenantId', 'Tenant ID'],
    ['ManagerClientId', 'Client ID'],
    ['ManagerTenantId', 'Tenant ID'],
  ] as const) {
    const value = settings[name];
    if (value.trim() && value.trim().length > 100) errors[name] = `Please enter ${label} within 100 characters.`;
  }
  if (settings.AppAllowSso !== 0 && settings.AppAllowSso !== 1) errors.AppAllowSso = 'Input error';
  if (settings.ManagerAllowSso !== 0 && settings.ManagerAllowSso !== 1) errors.ManagerAllowSso = 'Input error';
  return errors;
}

export function validateMeIdAct(model: MeIdPageModel, act: string): string[] {
  const errors: string[] = [];
  const failed = (reason: string, operation: string) => errors.push(`Cannot ${operation} due to ${reason}.`);
  if (act === 'edit' && model.Enable) failed('Switched', 'Edit');
  else if (act === 'changeUser') {
    if (!model.Enable) failed('Not switched', 'Change');
    else if (!model.AdminMsUser) errors.push('Please select Microsoft User for conmasadmin');
  } else if (act === 'apply') {
    if (model.Enable) failed('Switched', 'Setting');
    else {
      if (!model.AppClientId) errors.push('Please enter Setting for i-Reporter application  Client ID.');
      if (!model.AppTenantId) errors.push('Please enter Setting for i-Reporter application  Tenant ID.');
      if (!model.ManagerClientId) errors.push('Please enter Setting for ConMas Manager  Client ID.');
      if (!model.ManagerTenantId) errors.push('Please enter Setting for ConMas Manager  Tenant ID.');
    }
  } else if (act === 'rescission' && !model.Enable) failed('Not switched', 'Setting');
  return errors;
}

export function meIdAuthorizeUrl(input: {
  clientId: string;
  tenantId: string;
  redirectUri: string;
  state: string;
  nonce: string;
}): string {
  if (!input.clientId || !input.tenantId) throw new Error(pageText['Client ID or Tenant ID is not set.']);
  const authorize = new URL(
    `https://login.microsoftonline.com/${encodeURIComponent(input.tenantId)}/oauth2/v2.0/authorize`,
  );
  authorize.search = new URLSearchParams({
    client_id: input.clientId,
    response_type: 'id_token',
    redirect_uri: input.redirectUri,
    scope: 'openid profile',
    response_mode: 'form_post',
    state: input.state,
    nonce: input.nonce,
    prompt: 'login',
  }).toString();
  return authorize.toString();
}

async function jsonResponse(fetcher: typeof fetch, uri: string): Promise<Record<string, unknown>> {
  const response = await fetcher(uri, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(pageText['Microsoft identity metadata request failed.']);
  return object(await response.json());
}

export async function verifyMeIdIdToken(
  idToken: string,
  clientId: string,
  tenantId: string,
  nonce: string,
  fetcher: typeof fetch = fetch,
): Promise<MeIdIdentity> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error(pageText['Microsoft identity token is invalid.']);
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = object(JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')));
    claims = object(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')));
  } catch {
    throw new Error(pageText['Microsoft identity token is invalid.']);
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string')
    throw new Error(pageText['Microsoft identity token is invalid.']);

  const discoveryUri = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/.well-known/openid-configuration`;
  const discovery = await jsonResponse(fetcher, discoveryUri);
  if (typeof discovery.jwks_uri !== 'string') throw new Error(pageText['Microsoft signing keys are unavailable.']);
  const jwksUri = new URL(discovery.jwks_uri);
  if (jwksUri.origin !== 'https://login.microsoftonline.com')
    throw new Error(pageText['Microsoft signing keys are unavailable.']);
  const keySet = await jsonResponse(fetcher, jwksUri.toString());
  const keys = Array.isArray(keySet.keys) ? keySet.keys.map(object) : [];
  const jwk = keys.find((key) => key.kid === header.kid && key.kty === 'RSA' && (!key.use || key.use === 'sig'));
  if (!jwk) throw new Error(pageText['Microsoft signing key was not found.']);
  let signatureValid: boolean;
  try {
    const modulus = jwk.n;
    const exponent = jwk.e;
    if (typeof modulus !== 'string' || typeof exponent !== 'string') throw new Error();
    signatureValid = verifySignature(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      createPublicKey({ key: { kty: 'RSA', n: modulus, e: exponent }, format: 'jwk' }),
      Buffer.from(parts[2], 'base64url'),
    );
  } catch {
    throw new Error(pageText['Microsoft identity token is invalid.']);
  }
  if (!signatureValid) throw new Error(pageText['Microsoft identity token is invalid.']);

  const expectedIssuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
  const audience = claims.aud;
  const audienceValid = audience === clientId || (Array.isArray(audience) && audience.includes(clientId));
  const now = Date.now() / 1000;
  const expiresAt = Number(claims.exp);
  const notBefore = claims.nbf === undefined ? Number.NEGATIVE_INFINITY : Number(claims.nbf);
  const invalidNotBefore = claims.nbf !== undefined && (!Number.isFinite(notBefore) || notBefore > now + 300);
  if (
    claims.iss !== expectedIssuer ||
    !audienceValid ||
    !Number.isFinite(expiresAt) ||
    now > expiresAt + 300 ||
    invalidNotBefore
  ) {
    throw new Error(pageText['Microsoft identity token claims are invalid.']);
  }
  if (claims.nonce === undefined || String(claims.nonce) !== nonce)
    throw new Error(pageText['Microsoft identity token nonce does not match.']);
  if (
    claims.preferred_username === undefined ||
    claims.preferred_username === null ||
    claims.oid === undefined ||
    claims.oid === null
  ) {
    throw new Error(pageText['Microsoft identity token is missing user claims.']);
  }
  return { preferredUsername: String(claims.preferred_username), oid: String(claims.oid) };
}

async function loadMeIdPage(db: pg.Pool): Promise<LoadedMeIdPage> {
  const [linkage, switchSetting, admin] = await Promise.all([
    db.query<{ xml_data: string }>('SELECT xml_data FROM mst_external_linkage WHERE key=$1', ['meid']),
    db.query<{ com_value: string }>(
      'SELECT com_value FROM mst_common WHERE com_key=$1 AND com_name=$2 ORDER BY com_index LIMIT 1',
      ['LOGIN_SETTING', 'ENABLE_MEID'],
    ),
    db.query<{ meid_upn: string }>('SELECT meid_upn FROM mst_user WHERE user_id=$1 LIMIT 1', ['conmasadmin']),
  ]);
  const settings = parseMeIdSetting(text(linkage.rows[0]?.xml_data));
  return { settings, enable: switchSetting.rows[0]?.com_value === '1', adminMsUser: text(admin.rows[0]?.meid_upn) };
}

function queryText(req: Request, key: string): string {
  return typeof req.query[key] === 'string' ? (req.query[key] as string) : '';
}

function detailRedirect(code = ''): string {
  return `${root}/DetailsMeIdSetting${code ? `?${new URLSearchParams({ error: code })}` : ''}`;
}

const callbackError: Record<string, string> = {
  registrationFailed: 'Failed to switch to Microsoft Entra ID login.',
  managerUserChangeFailed: 'Failed to change the Microsoft Entra ID user for conmasadmin.',
  switchedBeforeEdit: 'Cannot Edit due to Switched.',
};

function editForm(body: Record<string, unknown>): { settings: MeIdSettings; errors: Record<string, string> } {
  const settings: MeIdSettings = {
    AppClientId: bodyText(body, 'AppClientId'),
    AppTenantId: bodyText(body, 'AppTenantId'),
    AppAllowSso: 0,
    ManagerClientId: bodyText(body, 'ManagerClientId'),
    ManagerTenantId: bodyText(body, 'ManagerTenantId'),
    ManagerAllowSso: 0,
    ManagerRedirectUri: bodyText(body, 'ManagerRedirectUri'),
  };
  const errors: Record<string, string> = {};
  for (const name of ['AppAllowSso', 'ManagerAllowSso'] as const) {
    const raw = body[name];
    if (raw === undefined) continue;
    if (typeof raw !== 'string' || !/^[+-]?\d+$/.test(raw.trim()) || !Number.isSafeInteger(Number(raw)))
      errors[name] = 'Input error';
    else settings[name] = Number(raw);
  }
  return { settings, errors };
}

async function saveMeIdSettings(db: pg.Pool, settings: MeIdSettings, req: Request, userId: string): Promise<void> {
  const now = new Date();
  await db.query(
    `INSERT INTO mst_external_linkage
      (key,xml_data,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time)
    VALUES ($1,$2,$3,$4,$5,$3,$4,$5)
    ON CONFLICT (key) DO UPDATE SET xml_data=EXCLUDED.xml_data,
      sys_update_term=EXCLUDED.sys_update_term,sys_update_user=EXCLUDED.sys_update_user,sys_update_time=EXCLUDED.sys_update_time`,
    ['meid', serializeMeIdSetting(settings), req.ip, userId, now],
  );
}

async function updateCommonValue(client: pg.PoolClient, value: string, userId: string): Promise<void> {
  const term = hostname();
  const updated = await client.query(
    `UPDATE mst_common SET com_value=$1,sys_update_term=$2,sys_update_user=$3,sys_update_time=now()
    WHERE com_key=$4 AND com_name=$5`,
    [value, term, userId, 'LOGIN_SETTING', 'ENABLE_MEID'],
  );
  if ((updated.rowCount ?? 0) === 0) {
    await client.query(
      `INSERT INTO mst_common
        (com_key,com_index,com_name,com_value,com_locale,sys_regist_time,sys_regist_term,sys_regist_user,sys_update_time,sys_update_term,sys_update_user)
      VALUES ($1,0,$2,$3,'',now(),$4,$5,now(),$4,$5)`,
      ['LOGIN_SETTING', 'ENABLE_MEID', value, term, userId],
    );
  }
}

async function saveAzureUser(
  db: pg.Pool,
  userId: string,
  identity: MeIdIdentity,
  enableLogin: boolean,
): Promise<boolean> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const duplicate = await client.query(
      `SELECT user_id FROM mst_user
      WHERE user_id<>$1 AND ((meid_oid=$2 AND $2<>'') OR (meid_upn=$3 AND $3<>'')) LIMIT 1`,
      [userId, identity.oid, identity.preferredUsername],
    );
    if (duplicate.rows.length) {
      await client.query('ROLLBACK');
      return false;
    }
    const updated = await client.query(
      `UPDATE mst_user SET meid_upn=$1,meid_oid=$2,sys_update_term=$3,sys_update_user=$4,sys_update_time=now()
      WHERE user_id=$5`,
      [identity.preferredUsername, identity.oid, hostname(), userId, userId],
    );
    if ((updated.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    if (enableLogin) await updateCommonValue(client, '1', userId);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function beginMeIdAuthorization(
  req: Request,
  res: Response,
  settings: MeIdSettings,
  action: MeIdAuthAction,
): unknown {
  const host = req.get('host');
  const userId = typeof req.session?.userId === 'string' ? req.session.userId : '';
  if (!req.session || !req.sessionID || !userId || !host)
    throw new Error(pageText['Microsoft identity authorization requires an active session and host.']);
  const state = randomBytes(32).toString('hex');
  const nonce = randomBytes(32).toString('hex');
  const url = meIdAuthorizeUrl({
    clientId: settings.ManagerClientId,
    tenantId: settings.ManagerTenantId,
    redirectUri: settings.ManagerRedirectUri || `${req.protocol}://${host}${accountLogOn}`,
    state,
    nonce,
  });
  expirePendingMeIdAuth();
  const originalCookie = requestCookie(req, sessionCookieName);
  pendingMeIdAuth.set(state, {
    action,
    clientId: settings.ManagerClientId,
    tenantId: settings.ManagerTenantId,
    nonce,
    sessionID: req.sessionID,
    userId,
    originalSessionCookieHash: originalCookie ? hashCookie(originalCookie) : '',
    callbackHadOriginalSessionCookie: false,
    expiresAt: Date.now() + pendingMeIdAuthLifetime,
    received: false,
  });
  return res.redirect(url);
}
export async function handleMeIdAccountCallback(
  db: pg.Pool,
  req: Request,
  res: Response,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  if (req.method !== 'POST' || req.path !== accountLogOn || !req.is('application/x-www-form-urlencoded')) return false;
  expirePendingMeIdAuth();
  const body = object(req.body);
  const state = bodyText(body, 'state');
  const pending = pendingMeIdAuth.get(state);
  if (!pending) {
    if (!bodyText(body, 'id_token') && !bodyText(body, 'error') && !bodyText(body, 'error_description')) return false;
    res.sendStatus(400);
    return true;
  }
  if (pending.received) {
    res.sendStatus(400);
    return true;
  }
  const oidcError = bodyText(body, 'error') || bodyText(body, 'error_description');
  const idToken = bodyText(body, 'id_token');
  if (oidcError || !idToken) {
    pending.error = oidcError || 'invalid_response';
  } else {
    try {
      const data = await loadMeIdPage(db);
      if (
        data.enable !== (pending.action === 'MeIdAuthEdit') ||
        data.settings.ManagerClientId !== pending.clientId ||
        data.settings.ManagerTenantId !== pending.tenantId
      ) {
        throw new Error(pageText['Microsoft identity settings changed during authorization.']);
      }
      pending.identity = await verifyMeIdIdToken(idToken, pending.clientId, pending.tenantId, pending.nonce, fetcher);
    } catch {
      pending.error = 'invalid_token';
    }
  }
  const callbackCookie = requestCookie(req, sessionCookieName);
  pending.callbackHadOriginalSessionCookie = Boolean(
    callbackCookie &&
    pending.originalSessionCookieHash &&
    hashCookie(callbackCookie) === pending.originalSessionCookieHash,
  );
  pending.nonce = '';
  pending.received = true;
  res.redirect(`${root}/${pending.action}?${new URLSearchParams({ state })}`);
  return true;
}

export function registerMeId(app: Express, db: pg.Pool, render: Render): void {
  const show = (
    res: Response,
    mode: MeIdMode,
    values: MeIdPageValues = {},
    errors: string[] = [],
    fieldErrors: Record<string, string> = {},
  ) =>
    render(res, {
      active: 'System',
      section: 'DetailsMeIdSetting',
      login: false,
      title: pageText['Microsoft Entra ID Linkage Setting'],
      userName: res.locals.userName,
      meIdPage: {
        mode,
        settings: emptyMeIdSettings(),
        enable: false,
        adminMsUser: '',
        canEdit: false,
        errors,
        fieldErrors,
        ...values,
      },
    });
  const permitted = async (req: Request, res: Response, action: 'read' | 'edit'): Promise<boolean> => {
    try {
      const userId = typeof req.session?.userId === 'string' ? req.session.userId : '';
      if (
        (action === 'edit' && userId !== 'conmasadmin') ||
        !(await hasSystemPermission(db, userId, 'system', action))
      ) {
        show(res, 'roleError', {}, ['Role authority is insufficient.']);
        return false;
      }
      if (!licenseStatus().freeDrawOnly) return true;
      show(res.status(403), 'roleError', {}, ['Role authority is insufficient.']);
      return false;
    } catch {
      show(res.status(500), 'roleError', {}, ['Server error has been occurred.']);
      return false;
    }
  };
  const showDetails = async (req: Request, res: Response, data: LoadedMeIdPage, errors: string[] = []) => {
    const userId = typeof req.session?.userId === 'string' ? req.session.userId : '';
    const canEdit = userId === 'conmasadmin' && (await hasSystemPermission(db, userId, 'system', 'edit'));
    return show(
      res,
      'details',
      {
        settings: data.settings,
        enable: data.enable,
        adminMsUser: data.adminMsUser,
        canEdit,
      },
      errors,
    );
  };
  const completeAuth = async (req: Request, res: Response, action: MeIdAuthAction): Promise<unknown> => {
    if (!(await permitted(req, res, 'edit'))) return undefined;
    const failure = action === 'MeIdAuthRegist' ? 'registrationFailed' : 'managerUserChangeFailed';
    const state = queryText(req, 'state');
    const userId = typeof req.session?.userId === 'string' ? req.session.userId : '';
    expirePendingMeIdAuth();
    const pending = pendingMeIdAuth.get(state);
    if (
      !pending ||
      !pending.received ||
      pending.action !== action ||
      pending.userId !== userId ||
      (pending.callbackHadOriginalSessionCookie && pending.sessionID !== req.sessionID)
    ) {
      return res.redirect(detailRedirect(failure));
    }
    pendingMeIdAuth.delete(state);
    if (pending.error || !pending.identity) return res.redirect(detailRedirect(failure));
    try {
      const data = await loadMeIdPage(db);
      if (
        data.enable !== (action === 'MeIdAuthEdit') ||
        data.settings.ManagerClientId !== pending.clientId ||
        data.settings.ManagerTenantId !== pending.tenantId
      )
        return res.redirect(detailRedirect(failure));
      if (!(await saveAzureUser(db, userId, pending.identity, action === 'MeIdAuthRegist')))
        return res.redirect(detailRedirect(failure));
      return res.redirect(detailRedirect());
    } catch {
      return res.redirect(detailRedirect(failure));
    }
  };

  app.get(`${root}/DetailsMeIdSetting`, async (req, res) => {
    if (!(await permitted(req, res, 'read'))) return;
    try {
      const code = queryText(req, 'error');
      return await showDetails(req, res, await loadMeIdPage(db), callbackError[code] ? [callbackError[code]] : []);
    } catch {
      return show(res.status(500), 'details', { settings: emptyMeIdSettings() }, ['Server error has been occurred.']);
    }
  });

  app.post(`${root}/DetailsMeIdSetting`, async (req, res) => {
    if (!(await permitted(req, res, 'edit'))) return;
    try {
      const data = await loadMeIdPage(db);
      const model = { ...data.settings, Enable: data.enable, AdminMsUser: data.adminMsUser };
      const act = bodyText(req.body, 'act');
      const errors = validateMeIdAct(model, act);
      if (errors.length) return showDetails(req, res, data, errors);
      const userId = req.session?.userId ?? '';
      if (act === 'edit') return res.redirect(`${root}/EditMeIdSetting`);
      if (act === 'changeUser' || act === 'apply') {
        try {
          return beginMeIdAuthorization(req, res, data.settings, act === 'apply' ? 'MeIdAuthRegist' : 'MeIdAuthEdit');
        } catch {
          return showDetails(req, res, data, ['Server error has been occurred.']);
        }
      }
      if (act === 'rescission') {
        const client = await db.connect();
        try {
          await client.query('BEGIN');
          await updateCommonValue(client, '0', userId);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
        if (data.settings.ManagerTenantId) {
          const signOut = new URL(
            `https://login.microsoftonline.com/${encodeURIComponent(data.settings.ManagerTenantId)}/oauth2/logout`,
          );
          signOut.searchParams.set(
            'post_logout_redirect_uri',
            `${req.protocol}://${req.get('host')}${root}/DetailsMeIdSetting`,
          );
          return res.redirect(signOut.toString());
        }
        return res.redirect(`${root}/DetailsMeIdSetting`);
      }
      return showDetails(req, res, data);
    } catch {
      return show(res.status(500), 'details', {}, ['Server error has been occurred.']);
    }
  });

  app.get(`${root}/EditMeIdSetting`, async (req, res) => {
    if (!(await permitted(req, res, 'edit'))) return;
    try {
      const data = await loadMeIdPage(db);
      if (data.enable) return res.redirect(detailRedirect('switchedBeforeEdit'));
      return show(res, 'edit', {
        settings: data.settings,
        enable: false,
        adminMsUser: data.adminMsUser,
        canEdit: true,
      });
    } catch {
      return show(res.status(500), 'edit', { settings: emptyMeIdSettings() }, ['Server error has been occurred.']);
    }
  });

  app.post(`${root}/EditMeIdSetting`, async (req, res) => {
    if (!(await permitted(req, res, 'edit'))) return;
    const parsed = editForm(req.body);
    try {
      const data = await loadMeIdPage(db);
      if (data.enable)
        return show(res, 'edit', { settings: parsed.settings, enable: true, canEdit: true }, [
          'Cannot Edit due to Switched.',
        ]);
      const errors = validateMeIdSettings(parsed.settings, parsed.errors);
      if (Object.keys(errors).length)
        return show(res, 'edit', { settings: parsed.settings, enable: false, canEdit: true }, [], errors);
      await saveMeIdSettings(db, parsed.settings, req, req.session?.userId ?? '');
      return res.redirect(`${root}/DetailsMeIdSetting`);
    } catch {
      return show(res.status(500), 'edit', { settings: parsed.settings, enable: false, canEdit: true }, [
        'Server error has been occurred.',
      ]);
    }
  });

  app.get(`${root}/MeIdAuthRegist`, async (req, res) => completeAuth(req, res, 'MeIdAuthRegist'));
  app.get(`${root}/MeIdAuthEdit`, async (req, res) => completeAuth(req, res, 'MeIdAuthEdit'));
}
