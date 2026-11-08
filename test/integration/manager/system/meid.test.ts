import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { test } from 'node:test';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import {
  beginMeIdAuthorization,
  handleMeIdAccountCallback,
  meIdAuthorizeUrl,
  parseMeIdSetting,
  serializeMeIdSetting,
  validateMeIdAct,
  validateMeIdSettings,
  verifyMeIdIdToken,
} from '../../../../src/controllers/manager/system/meid.js';

const baseSettings = {
  AppClientId: 'app-client',
  AppTenantId: 'app-tenant',
  AppAllowSso: 0,
  ManagerClientId: 'manager-client',
  ManagerTenantId: 'manager-tenant',
  ManagerAllowSso: 1,
  ManagerRedirectUri: '',
};

test('MeID settings XML round-trips trimmed credentials and SSO flags', () => {
  const settings = {
    ...baseSettings,
    AppClientId: ' app & client ',
    ManagerRedirectUri: ' https://manager.example.test/callback ',
  };
  const xml = serializeMeIdSetting(settings);
  assert.match(xml, /app &amp; client/);
  assert.deepEqual(parseMeIdSetting(xml), {
    ...settings,
    AppClientId: 'app & client',
    ManagerRedirectUri: 'https://manager.example.test/callback',
  });
  assert.deepEqual(parseMeIdSetting(''), {
    ...baseSettings,
    AppClientId: '',
    AppTenantId: '',
    ManagerClientId: '',
    ManagerTenantId: '',
    ManagerAllowSso: 0,
  });
});

test('MeID edit and action validation follow source limits and current switch state', () => {
  const invalid = validateMeIdSettings({ ...baseSettings, AppClientId: 'x'.repeat(101), ManagerAllowSso: 2 });
  assert.equal(invalid.AppClientId, 'Please enter Client ID within 100 characters.');
  assert.equal(invalid.ManagerAllowSso, 'Input error');
  assert.equal(Object.keys(validateMeIdSettings({ ...baseSettings, AppClientId: 'x'.repeat(100) })).length, 0);

  const model = { ...baseSettings, Enable: false, AdminMsUser: '' };
  assert.equal(validateMeIdAct(model, 'apply').length, 0);
  assert.deepEqual(validateMeIdAct({ ...model, AppClientId: '' }, 'apply'), [
    'Please enter Setting for i-Reporter application  Client ID.',
  ]);
  assert.deepEqual(validateMeIdAct({ ...model, Enable: true }, 'edit'), ['Cannot Edit due to Switched.']);
  assert.deepEqual(validateMeIdAct(model, 'changeUser'), ['Cannot Change due to Not switched.']);
  assert.deepEqual(validateMeIdAct({ ...model, Enable: true }, 'changeUser'), [
    'Please select Microsoft User for conmasadmin',
  ]);
  assert.deepEqual(validateMeIdAct(model, 'rescission'), ['Cannot Setting due to Not switched.']);
});

test('MeID authorization URL uses the legacy form-post callback', () => {
  const url = new URL(
    meIdAuthorizeUrl({
      clientId: 'manager-client',
      tenantId: 'tenant-id',
      redirectUri: 'https://manager.example.test/ConMasManager/Account/LogOn',
      state: 'state-value',
      nonce: 'nonce-value',
    }),
  );
  assert.equal(url.hostname, 'login.microsoftonline.com');
  assert.equal(url.searchParams.get('response_type'), 'id_token');
  assert.equal(url.searchParams.get('response_mode'), 'form_post');
  assert.equal(url.searchParams.get('prompt'), 'login');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://manager.example.test/ConMasManager/Account/LogOn');
});
test('MeID account callback distinguishes password posts from unrecognized OIDC posts', async () => {
  let destination = '';
  const res = {
    redirect(url: string) {
      destination = url;
      return this;
    },
    sendStatus(status: number) {
      destination = String(status);
      return this;
    },
  } as unknown as Response;
  const request = (body: Record<string, string>) =>
    ({
      method: 'POST',
      path: '/ConMasManager/Account/LogOn',
      is: () => true,
      body,
    }) as unknown as Request;

  assert.equal(
    await handleMeIdAccountCallback({} as Pool, request({ UserName: 'admin', Password: 'fixture' }), res),
    false,
  );
  assert.equal(destination, '');
  assert.equal(
    await handleMeIdAccountCallback({} as Pool, request({ id_token: 'fixture-token', state: 'unknown-state' }), res),
    true,
  );
  assert.equal(destination, '400');
});
test('MeID form-post callback accepts a nonce-verified token when the session cookie is omitted', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: 'cookie-less-key', use: 'sig', alg: 'RS256' };
  let destination = '';
  const res = {
    redirect(url: string) {
      destination = url;
      return this;
    },
    sendStatus(status: number) {
      destination = String(status);
      return this;
    },
  } as unknown as Response;
  const initialRequest = {
    get: () => 'manager.example.test',
    protocol: 'https',
    session: { userId: 'conmasadmin' },
    sessionID: 'initiating-session',
    headers: { cookie: 'conmas_node_sid=original-cookie' },
  } as unknown as Request;
  beginMeIdAuthorization(initialRequest, res, baseSettings, 'MeIdAuthRegist');
  const authorize = new URL(destination);
  const state = authorize.searchParams.get('state') ?? '';
  const nonce = authorize.searchParams.get('nonce') ?? '';
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'cookie-less-key', typ: 'JWT' })).toString(
    'base64url',
  );
  const claims = Buffer.from(
    JSON.stringify({
      iss: 'https://login.microsoftonline.com/manager-tenant/v2.0',
      aud: 'manager-client',
      exp: Math.floor(Date.now() / 1000) + 600,
      nonce,
      preferred_username: 'admin@example.test',
      oid: 'cookie-less-object-id',
    }),
  ).toString('base64url');
  const content = `${header}.${claims}`;
  const token = `${content}.${signBytes('RSA-SHA256', Buffer.from(content), privateKey).toString('base64url')}`;
  const fetcher: typeof fetch = async (input) => {
    const uri = String(input);
    const body = uri.endsWith('.well-known/openid-configuration')
      ? { jwks_uri: 'https://login.microsoftonline.com/manager-tenant/discovery/keys' }
      : { keys: [publicJwk] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const db = {
    query: async (sql: string) => {
      if (sql.includes('mst_external_linkage')) return { rows: [{ xml_data: serializeMeIdSetting(baseSettings) }] };
      return { rows: [] };
    },
  } as unknown as Pool;
  const callbackRequest = {
    method: 'POST',
    path: '/ConMasManager/Account/LogOn',
    is: () => true,
    body: { state, id_token: token },
    headers: {},
    sessionID: 'cross-site-session',
  } as unknown as Request;

  assert.equal(await handleMeIdAccountCallback(db, callbackRequest, res, fetcher), true);
  assert.equal(destination, `/ConMasManager/System/MeIdAuthRegist?state=${state}`);
  assert.equal(destination.includes(token), false);
});

test('MeID token validation uses injected Microsoft metadata and signing-key fixtures', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture-key', use: 'sig', alg: 'RS256' };
  const tenantId = 'fixture-tenant';
  const nonce = 'fixture-nonce';
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture-key', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(
    JSON.stringify({
      iss: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      aud: 'manager-client',
      exp: Math.floor(Date.now() / 1000) + 600,
      nonce,
      preferred_username: 'admin@example.test',
      oid: 'fixture-object-id',
    }),
  ).toString('base64url');
  const content = `${header}.${claims}`;
  const signature = signBytes('RSA-SHA256', Buffer.from(content), privateKey).toString('base64url');
  const token = `${content}.${signature}`;
  const requested: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const uri = String(input);
    requested.push(uri);
    const body = uri.endsWith('.well-known/openid-configuration')
      ? { jwks_uri: 'https://login.microsoftonline.com/fixture-tenant/discovery/keys' }
      : { keys: [publicJwk] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  assert.deepEqual(await verifyMeIdIdToken(token, 'manager-client', tenantId, nonce, fetcher), {
    preferredUsername: 'admin@example.test',
    oid: 'fixture-object-id',
  });
  assert.deepEqual(requested, [
    'https://login.microsoftonline.com/fixture-tenant/.well-known/openid-configuration',
    'https://login.microsoftonline.com/fixture-tenant/discovery/keys',
  ]);
  await assert.rejects(verifyMeIdIdToken(token, 'manager-client', tenantId, 'wrong-nonce', fetcher), /nonce/);
});
