import { text as pageText } from '../../../config/manager/system/resources.js';
import { licenseStatus } from '../../../shared/license-counts.js';
import type { Express, Request, Response } from 'express';
import type pg from 'pg';
import { createCipheriv, createPrivateKey, randomBytes } from 'node:crypto';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { legacyDecrypt } from '../../../shared/legacy-auth.js';
import { hasSystemPermission } from '../../../middleware/manager/system/permissions.js';

type Render = (res: Response, data: Record<string, unknown>) => unknown;
type Provider = 'google' | 'box' | 'bim360';
type Permission = { read: boolean; edit: boolean; delete: boolean; status: number; error?: string };
type RecordValue = Record<string, unknown>;
type JsonResponse = { ok: boolean; status: number; body: RecordValue };
type GoogleCredentialRow = {
  credential_id: number;
  credential_type: number;
  credential: string | null;
  token: string | null;
  oauth_tmp_key: string | null;
};
type GoogleToken = Record<string, unknown> & { access_token?: string; refresh_token?: string };
type BoxToken = { access_token?: string };
type BimToken = { access_token?: string };
type HubProject = { ProjectId: string; ProjectName: string; Selected: boolean };
type Hub = { HubId: string; HubName: string; Projects: HubProject[] };
type CloudSession = {
  cloudGoogleOAuthState?: string;
  cloudBim360Credential?: { clientId: string; clientSecret: string };
};

const root = '/ConMasManager/System';
const googleCallbackPath = '/ConMasManager/SystemGoogleAuthCallback/IndexAsync';
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: false });
const builder = new XMLBuilder({ ignoreAttributes: false, format: true });
const providerDetails: Record<Provider, { route: string; title: string }> = {
  google: { route: 'GoogleCredentialSetting', title: pageText['Google authentication registration'] },
  box: { route: 'BoxCredentialSetting', title: pageText['Box linkage setting'] },
  bim360: { route: 'Bim360CredentialSetting', title: pageText['Autodesk Docs linkage setting'] },
};

function object(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};
}

function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function input(source: RecordValue | undefined, key: string): string {
  const value = source?.[key];
  return Array.isArray(value) ? text(value.at(-1)) : text(value);
}

function recordInput(source: RecordValue, key: string): string {
  return input(source, key).trim();
}

function encryptionKey(key: string): Buffer {
  const source = Buffer.from(key, 'utf8');
  const desKey = Buffer.alloc(8);
  for (let index = 0; index < source.length; index++) desKey[index % 8] ^= source[index];
  return Buffer.concat([desKey, desKey, desKey]);
}

function encrypt(value: string, key: string): string {
  const material = encryptionKey(key);
  const cipher = createCipheriv('des-ede3-cbc', material, material.subarray(0, 8));
  return Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]).toString('base64');
}

export function validateGoogleCredentialJson(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{') && !trimmed.endsWith('}'))
    return 'JSON format error (Violation of binding characters {}, [])';
  try {
    JSON.parse(trimmed);
    return '';
  } catch (error) {
    const message = error instanceof SyntaxError ? error.message : '';
    const position = Number(message.match(/position (\d+)/i)?.[1] ?? 0);
    const line = Number(message.match(/line (\d+)/i)?.[1] ?? trimmed.slice(0, position).split('\n').length);
    return `File fraud(Illegal part: , Injustice: ${line})`;
  }
}

export function validateBoxCredentialInput(clientId: string, clientSecret: string, enterpriseId: string): string {
  if (!clientId) return 'Please enter Client ID.';
  if (!clientSecret) return 'Please enter Client Secret.';
  if (!enterpriseId) return 'Please enter Enterprise ID.';
  return '';
}

async function access(req: Request, db: pg.Pool, provider: Provider): Promise<Permission> {
  const userId = req.session?.userId ?? '';
  const read = await hasSystemPermission(db, userId, 'system', 'read');
  if (!read)
    return { read: false, edit: false, delete: false, status: 403, error: pageText['Role authority is insufficient.'] };
  const [edit, remove] = await Promise.all([
    hasSystemPermission(db, userId, 'system', 'edit'),
    provider === 'google' ? false : hasSystemPermission(db, userId, 'system', 'delete'),
  ]);
  try {
    if (licenseStatus().freeDrawOnly)
      return {
        read: false,
        edit: false,
        delete: false,
        status: 403,
        error: pageText['Role authority is insufficient.'],
      };
    return { read: true, edit, delete: remove, status: 200 };
  } catch {
    return {
      read: false,
      edit: false,
      delete: false,
      status: 503,
      error: pageText['License information is unavailable.'],
    };
  }
}

function session(req: Request): typeof req.session & CloudSession {
  return req.session as typeof req.session & CloudSession;
}

function show(
  render: Render,
  res: Response,
  provider: Provider,
  mode: string,
  model: RecordValue = {},
  error = '',
  permission: Permission = { read: true, edit: false, delete: false, status: 200 },
) {
  const details = providerDetails[provider];
  return render(res, {
    active: 'System',
    section: details.route,
    login: false,
    title: details.title,
    userName: res.locals.userName,
    cloudCredentialsPage: {
      provider,
      mode,
      model,
      error,
      canEdit: permission.edit,
      canDelete: permission.delete,
      route: `${root}/${details.route}`,
    },
  });
}

function block(render: Render, res: Response, provider: Provider, permission: Permission) {
  res.status(permission.status);
  return show(
    render,
    res,
    provider,
    'unavailable',
    {},
    permission.error ?? 'Role authority is insufficient.',
    permission,
  );
}

function writeDenied(
  render: Render,
  res: Response,
  provider: Provider,
  permission: Permission,
  action: 'edit' | 'delete',
) {
  if (action === 'edit' ? permission.edit : permission.delete) return false;
  res.status(403);
  show(render, res, provider, 'unavailable', {}, 'Role authority is insufficient.', permission);
  return true;
}

function getCredentialType(value: unknown): number | null {
  const raw = text(value).trim();
  if (!/^[+-]?\d+$/.test(raw)) return null;
  const number = Number(raw);
  return Number.isInteger(number) && (number === 0 || number === 1) ? number : null;
}

async function toggleGoogleCredential(
  db: pg.Pool,
  type: number,
  userId: string,
  termId: string,
  credential?: string,
): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query<{ credential_id: number }>(
      'SELECT credential_id FROM mst_google_credential WHERE credential_type=$1 FOR UPDATE',
      [type],
    );
    const id = Number(existing.rows[0]?.credential_id ?? type + 1);
    if (credential !== undefined) {
      const encryptedCredential = encrypt(credential, 'google4ireporter');
      if (existing.rows[0]) {
        await client.query(
          `UPDATE mst_google_credential SET credential=$1,token=NULL,oauth_tmp_key=NULL,enabled=1,
          sys_update_term=$2,sys_update_user=$3,sys_update_time=now() WHERE credential_id=$4`,
          [encryptedCredential, termId, userId, id],
        );
      } else {
        await client.query(
          `INSERT INTO mst_google_credential
          (credential_id,credential_type,credential,token,oauth_tmp_key,enabled,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time)
          VALUES ($1,$2,$3,NULL,NULL,1,$4,$5,now(),$4,$5,now())`,
          [id, type, encryptedCredential, termId, userId],
        );
      }
    } else if (existing.rows[0]) {
      await client.query(
        'UPDATE mst_google_credential SET enabled=1,sys_update_term=$1,sys_update_user=$2,sys_update_time=now() WHERE credential_id=$3',
        [termId, userId, id],
      );
    } else {
      await client.query(
        `INSERT INTO mst_google_credential
        (credential_id,credential_type,credential,token,oauth_tmp_key,enabled,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time)
        VALUES ($1,$2,NULL,NULL,NULL,1,$3,$4,now(),$3,$4,now())`,
        [id, type, termId, userId],
      );
    }
    await client.query(
      'UPDATE mst_google_credential SET enabled=0,sys_update_term=$1,sys_update_user=$2,sys_update_time=now() WHERE credential_id<>$3',
      [termId, userId, id],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function selectedGoogleCredential(db: pg.Pool): Promise<GoogleCredentialRow | undefined> {
  return (
    await db.query<GoogleCredentialRow>(`SELECT credential_id,credential_type,credential,token,oauth_tmp_key
    FROM mst_google_credential WHERE enabled=1 ORDER BY credential_id LIMIT 1`)
  ).rows[0];
}

async function updateGoogleCredentialToken(
  db: pg.Pool,
  token: GoogleToken,
  userId: string,
  termId: string,
): Promise<void> {
  await db.query(
    `UPDATE mst_google_credential SET token=$1,oauth_tmp_key=NULL,sys_update_term=$2,sys_update_user=$3,sys_update_time=now()
    WHERE credential_type=1`,
    [encrypt(JSON.stringify(token), 'google4ireporter'), termId, userId],
  );
}

async function updateGoogleOAuthState(db: pg.Pool, state: string, userId: string, termId: string): Promise<void> {
  await db.query(
    `UPDATE mst_google_credential SET oauth_tmp_key=$1,sys_update_term=$2,sys_update_user=$3,sys_update_time=now()
    WHERE credential_type=1`,
    [encrypt(JSON.stringify(state), 'google4ireporter'), termId, userId],
  );
}

async function clearGoogleCredential(db: pg.Pool, userId: string, termId: string): Promise<void> {
  await db.query(
    `UPDATE mst_google_credential SET credential=NULL,token=NULL,oauth_tmp_key=NULL,
    sys_update_term=$1,sys_update_user=$2,sys_update_time=now() WHERE enabled=1`,
    [termId, userId],
  );
}

function googleClientInfo(credential: RecordValue): { clientId: string; clientSecret: string } {
  const client = object(credential.web ?? credential.installed);
  return { clientId: text(client.client_id), clientSecret: text(client.client_secret) };
}

async function googleUserEmail(accessToken: string): Promise<string> {
  const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) return '';
  return text(object(await response.json()).email);
}

async function refreshGoogleToken(
  clientId: string,
  clientSecret: string,
  token: GoogleToken,
): Promise<GoogleToken | undefined> {
  if (!token.refresh_token) return undefined;
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: token.refresh_token,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(30000),
  });
  const body = object(await response.json().catch(() => ({})));
  if (!response.ok || !text(body.access_token)) return undefined;
  return { ...token, ...body, refresh_token: text(body.refresh_token) || token.refresh_token };
}

async function googlePageModel(
  db: pg.Pool,
  userId: string,
  termId: string,
): Promise<{ model: RecordValue; error: string }> {
  const row = await selectedGoogleCredential(db);
  const type = row?.credential_type === 1 ? 1 : 0;
  const model: RecordValue = {
    CredentialType: type,
    EmailAddress: '',
    ServiceAccountKey: '',
    OAuthClientId: '',
    HasCredential: Boolean(row?.credential),
  };
  if (!row?.credential) return { model, error: '' };
  try {
    const credentialText = legacyDecrypt(row.credential, 'google4ireporter');
    const credential = object(JSON.parse(credentialText));
    if (type === 0) {
      const email = text(credential.client_email);
      const privateKey = text(credential.private_key);
      if (credential.type !== 'service_account' || !email || !privateKey)
        throw new Error(pageText['Invalid service account credential.']);
      createPrivateKey(privateKey);
      model.EmailAddress = email;
      model.ServiceAccountKey = text(credential.private_key_id);
      return { model, error: '' };
    }
    const client = googleClientInfo(credential);
    model.OAuthClientId = client.clientId;
    if (!row.token) return { model, error: '' };
    let token = object(JSON.parse(legacyDecrypt(row.token, 'google4ireporter'))) as GoogleToken;
    if (!text(token.access_token)) throw new Error(pageText['OAuth token is missing.']);
    let email = await googleUserEmail(text(token.access_token));
    if (!email && token.refresh_token) {
      const refreshed = await refreshGoogleToken(client.clientId, client.clientSecret, token);
      if (refreshed) {
        token = refreshed;
        await updateGoogleCredentialToken(db, token, userId, termId);
        email = await googleUserEmail(text(token.access_token));
      }
    }
    if (!email) throw new Error(pageText['Google authorization failed.']);
    model.EmailAddress = email;
    return { model, error: '' };
  } catch {
    await clearGoogleCredential(db, userId, termId);
    model.HasCredential = false;
    model.EmailAddress = '';
    model.ServiceAccountKey = '';
    model.OAuthClientId = '';
    return { model, error: pageText['Authentication failed'] };
  }
}

function oauthRedirectUri(req: Request): string {
  return `${req.protocol}://${req.get('host')}${googleCallbackPath}`;
}

function googleAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope:
      'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email',
    access_type: 'offline',
    prompt: 'consent',
    state,
  }).toString();
  return url.toString();
}

async function googleCallback(db: pg.Pool, req: Request, userId: string, termId: string): Promise<boolean> {
  const state = session(req).cloudGoogleOAuthState;
  const queryState = input(object(req.query), 'state');
  const code = input(object(req.query), 'code');
  delete session(req).cloudGoogleOAuthState;
  if (!state || !queryState || state !== queryState || !code) return false;
  const row = await db.query<GoogleCredentialRow>(`SELECT credential_id,credential_type,credential,token,oauth_tmp_key
    FROM mst_google_credential WHERE credential_type=1 AND enabled=1 LIMIT 1`);
  const credentialText = row.rows[0]?.credential;
  if (!credentialText) return false;
  const credential = object(JSON.parse(legacyDecrypt(credentialText, 'google4ireporter')));
  const client = googleClientInfo(credential);
  if (!client.clientId || !client.clientSecret) return false;
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code,
      redirect_uri: oauthRedirectUri(req),
      grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(30000),
  });
  const token = object(await response.json().catch(() => ({}))) as GoogleToken;
  if (!response.ok || !text(token.access_token)) return false;
  await updateGoogleCredentialToken(db, token, userId, termId);
  return true;
}

type LinkageCredential = {
  clientId: string;
  clientSecret: string;
  enterpriseId?: string;
  hubId?: string;
  projectIds?: string[];
};

function parseLinkage(xml: string | undefined, provider: 'box' | 'bim360'): LinkageCredential {
  if (!xml)
    return {
      clientId: '',
      clientSecret: '',
      ...(provider === 'box' ? { enterpriseId: '' } : { hubId: '', projectIds: [] }),
    };
  const conmas = object(parser.parse(xml).conmas);
  const credential = object(conmas.credential);
  const result: LinkageCredential = {
    clientId: text(credential.clientId),
    clientSecret: credential.clientSecret
      ? legacyDecrypt(text(credential.clientSecret), provider === 'box' ? 'box4ireporter' : 'bim3604ireporter')
      : '',
  };
  if (provider === 'box') result.enterpriseId = text(credential.enterpriseId);
  else {
    const hub = object(conmas.hub);
    const projects = object(hub.projects).project;
    const projectRows = Array.isArray(projects) ? projects : projects ? [projects] : [];
    result.hubId = text(hub.hubId);
    result.projectIds = projectRows.map((value) => text(object(value).projectId)).filter(Boolean);
  }
  return result;
}

export function buildBoxCredentialXml(clientId: string, clientSecret: string, enterpriseId: string): string {
  return builder.build({
    conmas: { credential: { clientId, clientSecret: encrypt(clientSecret, 'box4ireporter'), enterpriseId } },
  });
}

export function buildBim360CredentialXml(
  clientId: string,
  clientSecret: string,
  hubId: string,
  projectIds: string[],
): string {
  return builder.build({
    conmas: {
      credential: { clientId, clientSecret: encrypt(clientSecret, 'bim3604ireporter') },
      hub: { hubId, projects: { project: projectIds.map((projectId) => ({ projectId })) } },
    },
  });
}

async function loadLinkage(db: pg.Pool, key: 'box' | 'bim360'): Promise<LinkageCredential> {
  const row = (await db.query<{ xml_data: string }>('SELECT xml_data FROM mst_external_linkage WHERE "key"=$1', [key]))
    .rows[0];
  return parseLinkage(row?.xml_data, key);
}

async function saveLinkage(
  db: pg.Pool,
  key: 'box' | 'bim360',
  xml: string,
  userId: string,
  termId: string,
): Promise<void> {
  await db.query(
    `INSERT INTO mst_external_linkage
    ("key",xml_data,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time)
    VALUES ($1,$2,$3,$4,now(),$3,$4,now())
    ON CONFLICT ("key") DO UPDATE SET xml_data=EXCLUDED.xml_data,sys_update_term=EXCLUDED.sys_update_term,
      sys_update_user=EXCLUDED.sys_update_user,sys_update_time=now()`,
    [key, xml, termId, userId],
  );
}

async function deleteLinkage(db: pg.Pool, key: 'box' | 'bim360'): Promise<void> {
  await db.query('DELETE FROM mst_external_linkage WHERE "key"=$1', [key]);
}

async function requestJson(url: string, init: RequestInit = {}): Promise<JsonResponse> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
  const body = object(await response.json().catch(() => ({})));
  return { ok: response.ok, status: response.status, body };
}

async function boxToken(clientId: string, clientSecret: string, enterpriseId: string): Promise<BoxToken | undefined> {
  const response = await requestJson('https://api.box.com/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
      box_subject_type: 'enterprise',
      box_subject_id: enterpriseId,
    }),
  });
  return response.ok && text(response.body.access_token) ? (response.body as BoxToken) : undefined;
}

async function boxCurrentUser(token: string): Promise<{ name: string; login: string }> {
  const response = await requestJson('https://api.box.com/2.0/users/me', {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(pageText['Unable to read Box account.']);
  return { name: text(response.body.name), login: text(response.body.login) };
}
async function boxFolderExists(token: string, parentId: string, name: string): Promise<boolean> {
  let offset = 0;
  const authorization = { authorization: `Bearer ${token}` };
  for (;;) {
    const response = await requestJson(
      `https://api.box.com/2.0/folders/${encodeURIComponent(parentId)}/items?limit=100&offset=${offset}`,
      { headers: authorization },
    );
    if (!response.ok) throw new Error(pageText['Unable to read Box folder contents.']);
    const entries = Array.isArray(response.body.entries) ? response.body.entries.map(object) : [];
    if (entries.some((entry) => text(entry.type) === 'folder' && text(entry.name) === name)) return true;
    offset += entries.length;
    const total = Number(response.body.total_count);
    if (!entries.length || !Number.isFinite(total) || offset >= total) return false;
  }
}

function boxTemporaryFolderName(): string {
  const now = new Date();
  return `temp_${String(now.getFullYear()).padStart(4, '0')}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}${String(now.getMilliseconds()).padStart(3, '0')}`;
}

async function uniqueBoxTemporaryFolderName(token: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const name = boxTemporaryFolderName();
    if (!(await boxFolderExists(token, '0', name))) return name;
  }
  return undefined;
}

async function validateBoxWritable(
  clientId: string,
  clientSecret: string,
  enterpriseId: string,
): Promise<'invalid' | 'not-writable' | 'valid'> {
  const token = await boxToken(clientId, clientSecret, enterpriseId);
  if (!token?.access_token) return 'invalid';
  const folderName = await uniqueBoxTemporaryFolderName(token.access_token);
  if (!folderName) throw new Error(pageText['Unable to create temporary folder.']);
  let created: JsonResponse;
  try {
    created = await requestJson('https://api.box.com/2.0/folders', {
      method: 'POST',
      headers: { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: folderName, parent: { id: '0' } }),
    });
  } catch {
    return 'not-writable';
  }
  if (!created.ok || !text(created.body.id)) return 'not-writable';
  const deleted = await fetch(
    `https://api.box.com/2.0/folders/${encodeURIComponent(text(created.body.id))}?recursive=true`,
    {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!deleted.ok) throw new Error(pageText['Unable to delete temporary folder.']);
  return 'valid';
}

async function bimToken(clientId: string, clientSecret: string): Promise<BimToken | undefined> {
  try {
    const response = await requestJson('https://developer.api.autodesk.com/authentication/v2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
        scope: 'data:read data:write data:create',
      }),
    });
    return response.ok && text(response.body.access_token) ? (response.body as BimToken) : undefined;
  } catch {
    return undefined;
  }
}

async function bimGet(token: string, path: string): Promise<RecordValue> {
  const response = await requestJson(`https://developer.api.autodesk.com${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(pageText['Unable to read BIM360 data.']);
  return response.body;
}

function bimHubs(data: RecordValue): Hub[] {
  const rows = Array.isArray(data.data) ? data.data : [];
  return rows
    .map((value) => {
      const row = object(value);
      return { HubId: text(row.id), HubName: text(object(row.attributes).name), Projects: [] };
    })
    .filter((hub) => hub.HubId);
}

function bimProjects(data: RecordValue, selected: Set<string> = new Set()): HubProject[] {
  const rows = Array.isArray(data.data) ? data.data : [];
  return rows
    .map((value) => {
      const row = object(value);
      return {
        ProjectId: text(row.id),
        ProjectName: text(object(row.attributes).name),
        Selected: selected.has(text(row.id)),
      };
    })
    .filter((project) => project.ProjectId);
}

async function loadBimSelections(token: string, selectedProjects: string[] = []): Promise<Hub[]> {
  const hubs: Hub[] = [];
  try {
    const available = bimHubs(await bimGet(token, '/project/v1/hubs'));
    for (const hub of available) {
      hub.Projects = bimProjects(
        await bimGet(token, `/project/v1/hubs/${encodeURIComponent(hub.HubId)}/projects`),
        new Set(selectedProjects),
      );
      hubs.push(hub);
    }
  } catch {
    return hubs;
  }
  return hubs;
}

async function loadBimTarget(
  token: string,
  credential: LinkageCredential,
): Promise<{ HubId: string; HubName: string; Projects: HubProject[] }> {
  const target = { HubId: '', HubName: '', Projects: [] as HubProject[] };
  if (!credential.hubId) return target;
  try {
    const hubData = object((await bimGet(token, `/project/v1/hubs/${encodeURIComponent(credential.hubId)}`)).data);
    target.HubId = credential.hubId;
    target.HubName = text(object(hubData.attributes).name);
    for (const projectId of credential.projectIds ?? []) {
      try {
        const projectData = object(
          (
            await bimGet(
              token,
              `/project/v1/hubs/${encodeURIComponent(credential.hubId)}/projects/${encodeURIComponent(projectId)}`,
            )
          ).data,
        );
        target.Projects.push({
          ProjectId: projectId,
          ProjectName: text(object(projectData.attributes).name),
          Selected: true,
        });
      } catch {
        continue;
      }
    }
  } catch {
    return { HubId: '', HubName: '', Projects: [] };
  }
  return target;
}

function modelBox(credential: LinkageCredential, mode: string, account = { name: '', login: '' }): RecordValue {
  return {
    act: mode === 'edit' ? 'edit' : '',
    ClientId: credential.clientId,
    ClientSecret: mode === 'edit' ? credential.clientSecret : '',
    ClientSecretConfigured: Boolean(credential.clientSecret),
    EnterpriseId: credential.enterpriseId ?? '',
    ApplicationName: account.name,
    AccountId: account.login,
  };
}

function modelBim(
  credential: LinkageCredential,
  mode: string,
  target = { HubId: '', HubName: '', Projects: [] as HubProject[] },
): RecordValue {
  return {
    act: mode,
    ClientId: credential.clientId,
    ClientSecret: mode === 'edit' ? credential.clientSecret : '',
    ClientSecretConfigured: Boolean(credential.clientSecret),
    TargetHubAndProject: target,
  };
}

function selectedBimProjects(body: RecordValue): string[] {
  const selected: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    const match = key.match(/^SelectedProject\[([^\]]+)\]$/);
    if (match && ['1', 'true', 'on', 'yes'].includes(input({ value }, 'value').toLowerCase())) selected.push(match[1]);
  }
  return selected;
}

export function registerCloudCredentials(app: Express, db: pg.Pool, render: Render): void {
  app.get(`${root}/GoogleCredentialSetting`, async (req, res) => {
    const permission = await access(req, db, 'google');
    if (!permission.read) return block(render, res, 'google', permission);
    const requestedType = getCredentialType(req.query.credentialType);
    if (requestedType !== null) {
      if (input(object(req.query), '__RequestVerificationToken') !== (req.session?.csrfToken ?? '')) {
        res.status(403);
        return show(
          render,
          res,
          'google',
          'details',
          { CredentialType: requestedType },
          'Invalid form verification token.',
          permission,
        );
      }
      if (writeDenied(render, res, 'google', permission, 'edit')) return;
      await toggleGoogleCredential(db, requestedType, req.session.userId ?? '', req.ip ?? '');
      return res.redirect(`${root}/GoogleCredentialSetting`);
    }
    const result = await googlePageModel(db, req.session.userId ?? '', req.ip ?? '');
    return show(render, res, 'google', 'details', result.model, result.error, permission);
  });

  app.post(`${root}/GoogleCredentialSetting`, async (req, res) => {
    const permission = await access(req, db, 'google');
    if (!permission.read) return block(render, res, 'google', permission);
    if (writeDenied(render, res, 'google', permission, 'edit')) return;
    const type = getCredentialType(req.body?.CredentialType);
    if (type === null) {
      res.status(400);
      return show(
        render,
        res,
        'google',
        'details',
        { CredentialType: 0 },
        'Select a Google credential type.',
        permission,
      );
    }
    const content = req.file?.buffer.toString('utf8') ?? '';
    if (!content) {
      res.status(400);
      return show(
        render,
        res,
        'google',
        'details',
        { CredentialType: type },
        'File has not been specified.',
        permission,
      );
    }
    const validation = validateGoogleCredentialJson(content);
    if (validation) {
      res.status(400);
      return show(render, res, 'google', 'details', { CredentialType: type }, validation, permission);
    }
    const userId = req.session.userId ?? '';
    const termId = req.ip ?? '';
    await toggleGoogleCredential(db, type, userId, termId, content.trim());
    if (type === 1) {
      const credential = object(JSON.parse(content.trim()));
      const client = googleClientInfo(credential);
      if (!client.clientId || !client.clientSecret) {
        res.status(400);
        return show(render, res, 'google', 'details', { CredentialType: type }, 'Authentication failed', permission);
      }
      const state = randomBytes(32).toString('hex');
      session(req).cloudGoogleOAuthState = state;
      await updateGoogleOAuthState(db, state, userId, termId);
      return res.redirect(googleAuthorizeUrl(client.clientId, oauthRedirectUri(req), state));
    }
    return res.redirect(`${root}/GoogleCredentialSetting`);
  });

  app.get(googleCallbackPath, async (req, res) => {
    const permission = await access(req, db, 'google');
    if (!permission.read) return block(render, res, 'google', permission);
    if (writeDenied(render, res, 'google', permission, 'edit')) return;
    if (input(object(req.query), 'error')) {
      delete session(req).cloudGoogleOAuthState;
      return res.redirect(`${root}/GoogleCredentialSetting`);
    }
    try {
      const succeeded = await googleCallback(db, req, req.session.userId ?? '', req.ip ?? '');
      if (!succeeded) return res.redirect(`${root}/GoogleCredentialSetting`);
      return res.redirect(`${root}/GoogleCredentialSetting`);
    } catch {
      return res.redirect(`${root}/GoogleCredentialSetting`);
    }
  });

  app.get(`${root}/BoxCredentialSetting`, async (req, res) => {
    const permission = await access(req, db, 'box');
    if (!permission.read) return block(render, res, 'box', permission);
    const mode = input(object(req.query), 'act') === 'edit' ? 'edit' : 'details';
    if (mode === 'edit' && writeDenied(render, res, 'box', permission, 'edit')) return;
    let credential: LinkageCredential = { clientId: '', clientSecret: '', enterpriseId: '' };
    let account = { name: '', login: '' };
    try {
      credential = await loadLinkage(db, 'box');
      if (credential.clientId && credential.clientSecret && credential.enterpriseId) {
        const token = await boxToken(credential.clientId, credential.clientSecret, credential.enterpriseId);
        if (token?.access_token) account = await boxCurrentUser(token.access_token);
        else
          return show(
            render,
            res,
            'box',
            mode,
            modelBox({ clientId: '', clientSecret: '', enterpriseId: '' }, mode),
            '',
            permission,
          );
      }
      return show(render, res, 'box', mode, modelBox(credential, mode, account), '', permission);
    } catch {
      res.status(500);
      return show(render, res, 'box', mode, modelBox(credential, mode, account), 'Server error.', permission);
    }
  });

  app.post(`${root}/BoxCredentialSetting`, async (req, res) => {
    const permission = await access(req, db, 'box');
    if (!permission.read) return block(render, res, 'box', permission);
    const body = object(req.body);
    if (recordInput(body, 'act') === 'delete') {
      if (writeDenied(render, res, 'box', permission, 'delete')) return;
      await deleteLinkage(db, 'box');
      return res.redirect(`${root}/BoxCredentialSetting`);
    }
    if (writeDenied(render, res, 'box', permission, 'edit')) return;
    const clientId = recordInput(body, 'ClientId');
    const clientSecret = recordInput(body, 'ClientSecret');
    const enterpriseId = recordInput(body, 'EnterpriseId');
    const model = { ...modelBox({ clientId, clientSecret, enterpriseId }, 'edit') };
    const required = validateBoxCredentialInput(clientId, clientSecret, enterpriseId);
    if (required) {
      res.status(400);
      return show(render, res, 'box', 'edit', model, required, permission);
    }
    try {
      const result = await validateBoxWritable(clientId, clientSecret, enterpriseId);
      if (result === 'invalid') {
        res.status(400);
        return show(render, res, 'box', 'edit', model, 'Authentication failed', permission);
      }
      if (result === 'not-writable') {
        res.status(400);
        return show(render, res, 'box', 'edit', model, 'No permission to write for the Box application.', permission);
      }
      await saveLinkage(
        db,
        'box',
        buildBoxCredentialXml(clientId, clientSecret, enterpriseId),
        req.session.userId ?? '',
        req.ip ?? '',
      );
      return res.redirect(`${root}/BoxCredentialSetting`);
    } catch {
      res.status(500);
      return show(render, res, 'box', 'edit', model, 'Server error.', permission);
    }
  });

  app.get(`${root}/Bim360CredentialSetting`, async (req, res) => {
    const permission = await access(req, db, 'bim360');
    if (!permission.read) return block(render, res, 'bim360', permission);
    const mode = recordInput(object(req.query), 'act') === 'edit' ? 'edit' : 'details';
    if (mode === 'edit' && writeDenied(render, res, 'bim360', permission, 'edit')) return;
    let credential: LinkageCredential = { clientId: '', clientSecret: '', hubId: '', projectIds: [] };
    try {
      credential = await loadLinkage(db, 'bim360');
      if (!credential.clientId || !credential.clientSecret)
        return show(render, res, 'bim360', mode, modelBim(credential, mode), '', permission);
      const token = await bimToken(credential.clientId, credential.clientSecret);
      if (!token?.access_token)
        return show(render, res, 'bim360', mode, modelBim({ clientId: '', clientSecret: '' }, mode), '', permission);
      const target = await loadBimTarget(token.access_token, credential);
      return show(render, res, 'bim360', mode, modelBim(credential, mode, target), '', permission);
    } catch {
      res.status(500);
      return show(render, res, 'bim360', mode, modelBim(credential, mode), 'Server error.', permission);
    }
  });

  app.post(`${root}/Bim360CredentialSetting`, async (req, res) => {
    const permission = await access(req, db, 'bim360');
    if (!permission.read) return block(render, res, 'bim360', permission);
    const body = object(req.body);
    const act = recordInput(body, 'act');
    if (act === 'delete') {
      if (writeDenied(render, res, 'bim360', permission, 'delete')) return;
      await deleteLinkage(db, 'bim360');
      delete session(req).cloudBim360Credential;
      return res.redirect(`${root}/Bim360CredentialSetting`);
    }
    if (writeDenied(render, res, 'bim360', permission, 'edit')) return;
    const stored = session(req).cloudBim360Credential;
    const clientId = recordInput(body, 'ClientId') || stored?.clientId || '';
    const clientSecret = recordInput(body, 'ClientSecret') || stored?.clientSecret || '';
    const errorModel = modelBim({ clientId, clientSecret }, 'edit');
    if (act === 'cancel') return show(render, res, 'bim360', 'edit', errorModel, '', permission);
    if (act === 'certify') {
      if (!clientId || !clientSecret) {
        res.status(400);
        return show(
          render,
          res,
          'bim360',
          'edit',
          errorModel,
          clientId ? 'Please enter Client Secret.' : 'Please enter Client ID.',
          permission,
        );
      }
      try {
        const token = await bimToken(clientId, clientSecret);
        if (!token?.access_token) {
          res.status(400);
          return show(render, res, 'bim360', 'edit', errorModel, 'Authentication failed', permission);
        }
        const credential = await loadLinkage(db, 'bim360');
        const hubs = await loadBimSelections(token.access_token, credential.projectIds ?? []);
        const preferredHub = hubs.some((hub) => hub.HubId === credential.hubId)
          ? credential.hubId!
          : (hubs[0]?.HubId ?? '');
        const selections = hubs.map((hub) => ({
          ...hub,
          Projects: hub.Projects.map((project) => ({
            ...project,
            Selected: hub.HubId === preferredHub && (credential.projectIds ?? []).includes(project.ProjectId),
          })),
        }));
        session(req).cloudBim360Credential = { clientId, clientSecret };
        return show(
          render,
          res,
          'bim360',
          'certify',
          {
            act: 'certify',
            ClientId: clientId,
            ClientSecretConfigured: true,
            SelectedHubId: preferredHub,
            HubSelections: selections,
          },
          '',
          permission,
        );
      } catch {
        res.status(500);
        return show(
          render,
          res,
          'bim360',
          'certify',
          {
            act: 'certify',
            ClientId: clientId,
            ClientSecretConfigured: true,
            SelectedHubId: '',
            HubSelections: [],
          },
          'Server error.',
          permission,
        );
      }
    }
    if (act === 'regist') {
      if (!stored || !stored.clientId || !stored.clientSecret) {
        res.status(400);
        return show(
          render,
          res,
          'bim360',
          'edit',
          errorModel,
          'BIM360 credentials must be certified again.',
          permission,
        );
      }
      const selectedProjectIds = selectedBimProjects(body);
      const chosenHub = recordInput(body, 'SelectedHubId');
      if (!selectedProjectIds.length) {
        res.status(400);
        try {
          const token = await bimToken(stored.clientId, stored.clientSecret);
          const hubs = token?.access_token ? await loadBimSelections(token.access_token) : [];
          return show(
            render,
            res,
            'bim360',
            'certify',
            {
              act: 'certify',
              ClientId: stored.clientId,
              ClientSecretConfigured: true,
              SelectedHubId: chosenHub,
              HubSelections: hubs,
            },
            'Please select Project',
            permission,
          );
        } catch {
          res.status(500);
          return show(
            render,
            res,
            'bim360',
            'certify',
            {
              act: 'certify',
              ClientId: stored.clientId,
              ClientSecretConfigured: true,
              SelectedHubId: chosenHub,
              HubSelections: [],
            },
            'Server error.',
            permission,
          );
        }
      }
      await saveLinkage(
        db,
        'bim360',
        buildBim360CredentialXml(stored.clientId, stored.clientSecret, chosenHub, selectedProjectIds),
        req.session.userId ?? '',
        req.ip ?? '',
      );
      delete session(req).cloudBim360Credential;
      return res.redirect(`${root}/Bim360CredentialSetting`);
    }
    return res.redirect(`${root}/Bim360CredentialSetting`);
  });
}
