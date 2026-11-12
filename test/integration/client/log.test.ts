import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import express from 'express';
import session from 'express-session';
import pg from 'pg';
import { putClientLog } from '../../../src/models/client-log.js';
import { registerClientRoutes } from '../../../src/routes/client.js';
import { root } from '../../../src/config/manager.js';

test(
  'PutLog preserves approved-terminal empty-file responses, mode/interval gates, BOM decoding and private append-only storage',
  { skip: !process.env.DATABASE_URL },
  async () => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const client = await pool.connect();
    const directory = await mkdtemp('/tmp/opencode/client-log-');
    const upload = join(directory, 'upload');
    const target = join(directory, 'operations');
    try {
      await client.query(`CREATE TEMP TABLE mst_terminal (LIKE public.mst_terminal INCLUDING ALL);
        CREATE TEMP TABLE mst_common (LIKE public.mst_common INCLUDING ALL);
        INSERT INTO pg_temp.mst_terminal (term_id,term_type,physical_id,deleted,approver) VALUES
        (1,'iPad','approved',0,'fixture'),(2,'iPad','pending',0,NULL),(3,'iPad','deleted',1,'fixture')`);
      const db = { query: client.query.bind(client) } as unknown as pg.Pool;
      const now = new Date(2026, 10, 12, 12);
      const send = (
        params: Record<string, string> = {},
        file: string | undefined = upload,
        identity: string | undefined = '../../fixture/device',
      ) => putClientLog(db, identity, params, file, now, target);
      await writeFile(upload, '\uFEFFfirst & value\n');
      assert.match(
        await putClientLog(db, undefined, { client: 'iPad', terminalId: 'approved' }, undefined, now, target),
        /<code>0<\/code>/,
      );
      for (const terminalId of ['pending', 'deleted', 'unknown', "' OR 1=1--"])
        assert.equal(
          await putClientLog(db, undefined, { client: 'iPad', terminalId }, undefined, now, target),
          '<conmas/>',
        );
      assert.equal(
        await putClientLog(db, undefined, { client: 'Designer', terminalId: 'approved' }, undefined, now, target),
        '<conmas/>',
      );
      assert.equal(await send(), '<conmas/>');
      await assert.rejects(stat(target), { code: 'ENOENT' });
      assert.equal(await send({ intervalLog: 'true' }), '<conmas/>');
      assert.equal(await send({ intervalLog: '1' }), '<conmas/>');
      const filename = createHash('sha256').update('../../fixture/device').digest('hex') + '.20261112.log';
      assert.deepEqual(await readdir(target), [filename]);
      assert.equal(await readFile(join(target, filename), 'utf8'), 'first & value\n\r\n');
      assert.equal((await stat(join(target, filename))).mode & 0o777, 0o600);
      assert.equal((await stat(target)).mode & 0o777, 0o700);
      await writeFile(upload, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('日本語', 'utf16le')]));
      await client.query(
        "INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (1,'IPAD_SETTING','LOG_OUTPUT_MODE','1')",
      );
      await send();
      assert.equal(await readFile(join(target, filename), 'utf8'), 'first & value\n\r\n日本語\r\n');
      const encodings = [
        Buffer.from([0xfe, 0xff, 0x65, 0xe5]),
        Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x00, 0xf6, 0x01, 0x00]),
        Buffer.from([0x00, 0x00, 0xfe, 0xff, 0x00, 0x01, 0xf6, 0x00]),
        Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x00, 0xd8, 0x00, 0x00, 0xff]),
      ];
      for (const data of encodings) {
        await writeFile(upload, data);
        await send();
      }
      assert.equal(
        await readFile(join(target, filename), 'utf8'),
        'first & value\n\r\n日本語\r\n日\r\n😀\r\n😀\r\n��\r\n',
      );
      await assert.rejects(putClientLog(db, undefined, {}, upload, now, target), /session identity/);
      await assert.rejects(send({}, join(directory, 'missing')), { code: 'ENOENT' });
      await unlink(join(target, filename));
      await symlink(upload, join(target, filename));
      await assert.rejects(send(), { code: 'ELOOP' });
      assert.deepEqual(await readFile(upload), encodings.at(-1));
      assert.equal((await client.query('SELECT count(*) FROM pg_temp.mst_terminal')).rows[0].count, '3');
    } finally {
      client.release(true);
      await pool.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

async function fixture(
  db: pg.Pool,
  run: (base: string, cookie: string, uploads: string[], failures: unknown[], physicalId: string) => Promise<void>,
) {
  const app = express(),
    store = new session.MemoryStore(),
    uploads: string[] = [],
    failures: unknown[] = [];
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    res.once('finish', () => {
      if (Array.isArray(req.files)) uploads.push(...req.files.map((file) => file.path));
      if (res.locals.requestFailure) failures.push(res.locals.requestFailure);
    });
    next();
  });
  registerClientRoutes(app, db, store);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/ConMasWeb/Rests`;
    const init = await fetch(base + '/Test/GetTest.aspx?fixture=1');
    await init.text();
    const cookie = init.headers.get('set-cookie')!.split(';')[0];
    const id = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1))
      .slice(2)
      .split('.')[0];
    const state = await new Promise<session.SessionData>((resolve, reject) =>
      store.get(id, (error, data) => (error ? reject(error) : resolve(data!))),
    );
    state.clientAccount = {
      userId: 'fixture',
      userName: 'Fixture',
      physicalId: 'log-' + randomUUID(),
      client: 'iPad',
      version: '',
      platform: 'Windows',
      address: '',
      sessionId: id,
    };
    await new Promise<void>((resolve, reject) => store.set(id, state, (error) => (error ? reject(error) : resolve())));
    await run(base, cookie, uploads, failures, state.clientAccount.physicalId);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    for (const path of uploads) await rm(path, { force: true });
  }
}

test('PutLog direct/dispatcher multipart keeps first-file semantics, safe errors, anonymous gates and upload cleanup', async () => {
  let mode = '0';
  const db = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.startsWith('SELECT approver')) {
        assert.deepEqual(params, ['iPad', 'approved']);
        return { rows: [{ approver: 'fixture' }] };
      }
      assert.match(sql, /SELECT com_value FROM mst_common/);
      return { rows: [{ com_value: mode }] };
    },
  } as unknown as pg.Pool;
  await fixture(db, async (base, cookie, uploads, failures, physicalId) => {
    const noFile = await fetch(base + '/pUtLoG.ASPX?client=iPad&terminalId=approved');
    assert.match(await noFile.text(), /<code>0<\/code>/);
    assert.deepEqual(failures, [{ type: 'UnknownError', code: 'CLIENT_FILE_HANDLE', definitionId: undefined }]);
    const form = (command = 'PutLog') => {
      const body = new FormData();
      body.append('command', command);
      body.append('file', new Blob(['fixture log contents']), 'first.txt');
      body.append('second', new Blob(['ignored contents']), 'second.txt');
      return body;
    };
    for (const path of ['/PutLog.aspx', '/ConMasIReporter.aspx']) {
      const response = await fetch(base + path, { method: 'POST', body: form() });
      assert.match(response.headers.get('content-type')!, /^text\/xml/);
      assert.equal(await response.text(), '<conmas/>');
    }
    const denied = await fetch(base + '/ConMasIReporter.aspx', { method: 'POST', body: form('RegistDefinition') });
    assert.match(await denied.text(), /<code>5<\/code>/);
    mode = '1';
    const anonymous = await fetch(base + '/PutLog.aspx', { method: 'POST', body: form() });
    const failure = await anonymous.text();
    assert.match(failure, /<code>-1<\/code>/);
    assert(!failure.includes('fixture log contents'));
    assert(!JSON.stringify(failures).includes('contents'));
    assert.equal(
      (
        await fetch(base + '/PutLog.aspx', {
          method: 'POST',
          headers: { origin: 'https://cross.invalid' },
          body: form(),
        })
      ).status,
      403,
    );
    // Use a generated session identity; remove only its exact output file after this isolated success.
    const now = new Date();
    const day = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const output = join(
      root,
      'logs/operationLogs',
      createHash('sha256').update(physicalId).digest('hex') + '.' + day + '.log',
    );
    try {
      const saved = await fetch(base + '/ConMasIReporter.aspx', { method: 'POST', headers: { cookie }, body: form() });
      assert.equal(await saved.text(), '<conmas/>');
      assert.equal(await readFile(output, 'utf8'), 'fixture log contents\r\n');
    } finally {
      await rm(output, { force: true });
    }
    assert.equal(uploads.length, 10);
    for (const path of uploads) await assert.rejects(readFile(path), { code: 'ENOENT' });
  });
});

test('GetDocumentList direct/dispatcher enforce session/terminal gates and clear only the current master-sync marker', async () => {
  let approved = true;
  const queries: { sql: string; params?: unknown[] }[] = [];
  const db = {
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql.startsWith('SELECT term_id')) return { rows: [{ term_id: 12, approver: approved ? 'fixture' : null }] };
      if (sql.startsWith('DELETE FROM custom_master_synching_terminal')) {
        assert.deepEqual(params, [12]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('mst_common') || sql.includes('mst_label_common_document')) return { rows: [], rowCount: 0 };
      throw new Error('Unexpected fixture query');
    },
  } as unknown as pg.Pool;
  await fixture(db, async (base, cookie) => {
    assert.match(await (await fetch(base + '/GetDocumentList.aspx')).text(), /<code>5<\/code>/);
    assert.equal(queries.length, 0);
    for (const path of ['/gEtDoCuMeNtLiSt.ASPX', '/ConMasIReporter.aspx?command=GetDocumentList']) {
      const response = await fetch(base + path, { headers: { cookie } });
      assert.equal(await response.text(), '<conmas><localLabels/><localFiles/></conmas>');
    }
    assert.equal(queries.filter((q) => q.sql.startsWith('DELETE')).length, 2);
    approved = false;
    assert.match(
      await (await fetch(base + '/GetDocumentList.aspx', { headers: { cookie } })).text(),
      /<code>3<\/code>/,
    );
    assert.equal(queries.filter((q) => q.sql.startsWith('DELETE')).length, 3);
  });
});
