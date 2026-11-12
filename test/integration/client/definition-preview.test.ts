import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import session from 'express-session';
import type pg from 'pg';
import { registerClientRoutes } from '../../../src/routes/client.js';

test('GetDefinitionPreview matches the supplied authenticated no-op, not an invented image/PDF/sample response', async () => {
  let queries = 0;
  const db = {
    query: () => {
      queries++;
      throw new Error('Unexpected preview query');
    },
    connect: () => {
      queries++;
      throw new Error('Unexpected preview connection');
    },
  } as unknown as pg.Pool;
  const app = express(),
    store = new session.MemoryStore();
  app.use(express.urlencoded({ extended: false }));
  registerClientRoutes(app, db, store);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/ConMasWeb/Rests`;
    const initial = await fetch(base + '/Test/GetTest.aspx?fixture=preview');
    await initial.text();
    const cookie = initial.headers.get('set-cookie')!.split(';')[0];
    const sid = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1))
      .slice(2)
      .split('.')[0];
    const state = await new Promise<session.SessionData>((resolve, reject) =>
      store.get(sid, (error, data) => (error ? reject(error) : resolve(data!))),
    );
    for (const client of ['Designer', 'iPad']) {
      state.clientAccount = {
        userId: 'no-preview-roles',
        userName: 'Fixture',
        client,
        physicalId: 'unregistered-device',
        version: '',
        platform: 'Windows',
        address: '',
        sessionId: sid,
      };
      await new Promise<void>((resolve, reject) =>
        store.set(sid, state, (error) => (error ? reject(error) : resolve())),
      );
      for (const direct of [true, false]) {
        const path = direct ? '/gEtDeFiNiTiOnPrEvIeW.ASPX' : '/ConMasIReporter.aspx';
        for (const method of ['GET', 'POST']) {
          const params = new URLSearchParams({
            ...(direct ? {} : { command: 'GetDefinitionPreview' }),
            topId: 'not-an-int',
            sheetNo: '-1',
            urlSchemeMode: 'ignored',
            createReportMode: 'ignored',
            ResultType: 'ignored',
          });
          const url = base + path + (method === 'GET' ? '?' + params : '');
          const options = { method, ...(method === 'POST' ? { body: params } : {}) };
          const response = await fetch(url, { ...options, headers: { cookie } });
          assert.equal(response.status, 200);
          assert.match(response.headers.get('content-type')!, /^text\/xml/);
          assert.equal(response.headers.get('cache-control'), 'no-store');
          assert.equal(response.headers.get('content-disposition'), null);
          assert.equal(await response.text(), '');
          const anonymous = await fetch(url, options);
          assert.equal(anonymous.status, 200);
          assert.match(await anonymous.text(), /<code>5<\/code>.*no session\./);
        }
      }
    }
    for (const [name, value] of [
      ['origin', 'https://cross.invalid'],
      ['sec-fetch-site', 'cross-site'],
    ]) {
      const blocked = await fetch(base + '/GetDefinitionPreview.aspx', { headers: { cookie, [name]: value } });
      assert.equal(blocked.status, 403);
      assert.match(await blocked.text(), /<code>3<\/code>/);
    }
    const missingId = await fetch(base + '/GetDefinitionPreview.aspx', { headers: { cookie } });
    assert.equal(missingId.status, 200);
    assert.equal(await missingId.text(), '');
    assert.equal(queries, 0, 'the supplied no-op has no definition/terminal queries, locks or writes');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
