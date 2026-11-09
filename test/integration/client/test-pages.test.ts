import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import session from 'express-session';
import type pg from 'pg';
import { readFile } from 'node:fs/promises';
import { XMLParser } from 'fast-xml-parser';
import { registerClientRoutes } from '../../../src/routes/client.js';
import { registerApiRoutes } from '../../../src/routes/api.js';

const parser = new XMLParser({ parseTagValue: false });
async function fixture(
  run: (origin: string, store: session.MemoryStore, uploads: string[]) => Promise<void>,
  db: pg.Pool | null = null,
  environment = 'development',
  api = false,
) {
  const app = express(),
    store = new session.MemoryStore(),
    uploads: string[] = [];
  app.set('env', environment);
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    res.once('finish', () => {
      if (Array.isArray(req.files)) uploads.push(...req.files.map((file) => file.path));
    });
    next();
  });
  if (api) registerApiRoutes(app, db, store);
  else registerClientRoutes(app, db, store);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    await run(`http://127.0.0.1:${address.port}/${api ? 'ConMasAPI' : 'ConMasWeb'}/Rests`, store, uploads);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('diagnostic echo/session pages preserve query/form/repeated values, clear authentication, keep session identity and reject bad XML names', async () =>
  fixture(async (base, store) => {
    const response = await fetch(`${base}/test/gettest.ASPX?日本語=%3C%26&value=one&value=two`),
      cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    assert.equal(response.status, 200);
    const first = await response.text();
    assert.deepEqual(parser.parse(first).ConMas, { 日本語: '<&', value: 'one,two' });
    const sid = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1))
      .slice(2)
      .split('.')[0]!;
    const getSession = () =>
      new Promise<session.SessionData>((resolve, reject) =>
        store.get(sid, (error, data) => (error ? reject(error) : resolve(data!))),
      );
    const state = await getSession();
    state.clientAccount = {
      userId: 'fixture',
      userName: 'Fixture',
      physicalId: 'test',
      client: 'Designer',
      version: '8.2.25101',
      platform: 'windows',
      address: '127.0.0.1',
      sessionId: sid,
    };
    state.logoutContent = 'LogoutTimeout';
    await new Promise<void>((resolve, reject) => store.set(sid, state, (error) => (error ? reject(error) : resolve())));
    assert.equal(await (await fetch(`${base}/Test/SessionTest.aspx`, { headers: { cookie } })).text(), first);
    const post = await fetch(`${base}/Test/PostTest.aspx?ignored=query`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ value: 'form' }),
    });
    assert.deepEqual(parser.parse(await post.text()).ConMas, { value: 'form' });
    const cleared = await getSession();
    assert.equal(cleared.clientAccount, undefined);
    assert.equal(cleared.logoutContent, undefined);
    assert(cleared.cookie);
    const bad = await fetch(`${base}/Test/GetTest.aspx?bad%20name=x`, { headers: { cookie } });
    assert.equal(parser.parse(await bad.text()).data.message, 'Invalid XML element name.');
    assert.equal(
      await (await fetch(`${base}/Test/SessionTest.aspx`, { headers: { cookie } })).text(),
      '<ConMas><value>form</value></ConMas>',
    );
    const fresh = await fetch(`${base}/Test/SessionTest.aspx`);
    assert.equal(fresh.status, 200);
    assert.match(await fresh.text(), /<data type="error">/);
    const crossSite = await fetch(`${base}/Test/PostTest.aspx`, {
      method: 'POST',
      headers: { origin: 'https://other.invalid' },
      body: new URLSearchParams({ value: 'no' }),
    });
    assert.equal(crossSite.status, 403);
  }));

test('diagnostic XML upload accepts anonymous multipart first file, decodes BOM, cleans staging and preserves last success on malformed XML', async () =>
  fixture(async (base, _store, uploads) => {
    const body = new FormData();
    body.append(
      'arbitrary',
      new Blob([
        Buffer.concat([
          Buffer.from([0xff, 0xfe]),
          Buffer.from('<root><value>日本語 &amp; data</value></root>', 'utf16le'),
        ]),
      ]),
      'first.xml',
    );
    body.append('second', new Blob(['<ignored/>']), 'second.xml');
    const uploaded = await fetch(`${base}/Test/UploadTest.aspx`, { method: 'POST', body }),
      cookie = uploaded.headers.get('set-cookie')!.split(';')[0]!;
    const xml = await uploaded.text();
    assert.deepEqual(parser.parse(xml), { root: { value: '日本語 & data' } });
    assert.equal(await (await fetch(`${base}/Test/SessionTest.aspx`, { headers: { cookie } })).text(), xml);
    const invalid = new FormData();
    invalid.append('file', new Blob(['<!DOCTYPE root><root/>']), 'bad.xml');
    assert.match(
      await (
        await fetch(`${base}/Test/UploadTest.aspx`, { method: 'POST', body: invalid, headers: { cookie } })
      ).text(),
      /<data type="error">/,
    );
    assert.equal(await (await fetch(`${base}/Test/SessionTest.aspx`, { headers: { cookie } })).text(), xml);
    assert.match(await (await fetch(`${base}/Test/UploadTest.aspx`)).text(), /No uploaded file/);
    assert.equal(uploads.length, 3);
    for (const path of uploads) await assert.rejects(readFile(path), { code: 'ENOENT' });
    const unrelated = new FormData();
    unrelated.append('file', new Blob(['<root/>']), 'file.xml');
    const blocked = await fetch(`${base}/RegistDefinition.aspx`, { method: 'POST', body: unrelated });
    assert.match(await blocked.text(), /<code>5<\/code>/);
  }));

test('diagnostic Sample uses the source fixed user and DataSet XML, without an authentication/terminal gate', async () => {
  const db = {
    query: async (sql: string, params: unknown[]) => {
      assert.equal(sql, 'SELECT user_name FROM mst_user WHERE user_id=$1');
      assert.deepEqual(params, ['cimtops']);
      return { rows: [{ user_name: 'User & name' }] };
    },
  } as unknown as pg.Pool;
  await fixture(async (base) => {
    const response = await fetch(`${base}/Test/Sample.aspx`);
    assert.equal(response.status, 200);
    assert.equal(
      await response.text(),
      '<NewDataSet><Table><user_name>User &amp; name</user_name></Table></NewDataSet>',
    );
  }, db);
});

test('REST static pages serve only whitelisted project-local bodies byte-for-byte, with case-insensitive GET/HEAD and no database requirement', async () =>
  fixture(async (base) => {
    for (const path of ['Error.htm', 'Test/Test.htm', 'Test/system.htm']) {
      const response = await fetch(`${base}/${path.toUpperCase()}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type')!, /text\/html/);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile('public/ConMasWeb/Rests/' + path));
      const head = await fetch(`${base}/${path}`, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), '');
      const post = await fetch(`${base}/${path}`, { method: 'POST' });
      assert.equal(post.status, 405);
    }
    assert.equal((await fetch(`${base}/Web.config`)).status, 404);
  }));

test('production native HTML pages preserve original bytes, method gates and XML diagnostics', async () =>
  fixture(
    async (base) => {
      for (const path of ['Error.htm', 'Test/Test.htm', 'Test/system.htm']) {
        const file = 'public/ConMasWeb/Rests/' + path;
        const original = await readFile(file);
        const response = await fetch(`${base}/${path}`);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type')!, /text\/html/);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);
        assert.deepEqual(await readFile(file), original);
        assert.equal(await (await fetch(`${base}/${path}`, { method: 'HEAD' })).text(), '');
        assert.equal((await fetch(`${base}/${path}`, { method: 'POST' })).status, 405);
      }
      const diagnostic = await fetch(`${base}/Test/GetTest.aspx?value=fixture`);
      assert.match(diagnostic.headers.get('content-type')!, /text\/xml/);
      assert.equal(await diagnostic.text(), '<ConMas><value>fixture</value></ConMas>');
    },
    null,
    'production',
  ));

test('separate API static pages preserve original HTML/script bytes and security gates in every environment', async () => {
  for (const environment of ['development', 'production']) {
    await fixture(
      async (base) => {
        for (const path of ['Error.htm', 'Test/Test.htm', 'Test/js/jquery-1.7.1.min.js']) {
          const original = await readFile('public/ConMasAPI/Rests/' + path);
          const response = await fetch(`${base}/${path}`);
          assert.equal(response.status, 200);
          assert.match(response.headers.get('content-type')!, path.endsWith('.js') ? /javascript/ : /text\/html/);
          const body = Buffer.from(await response.arrayBuffer());
          assert.deepEqual(body, original);
          assert.equal(await (await fetch(`${base}/${path}`, { method: 'HEAD' })).text(), '');
          assert.equal((await fetch(`${base}/${path}`, { method: 'POST' })).status, 405);
          const blocked = await fetch(`${base}/${path}`, { headers: { origin: 'https://other.invalid' } });
          assert.equal(blocked.status, 403);
          assert.match(blocked.headers.get('content-type')!, /text\/xml/);
        }
      },
      null,
      environment,
      true,
    );
  }
});
