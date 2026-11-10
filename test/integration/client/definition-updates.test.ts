import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import session from 'express-session';
import pg from 'pg';
import { XMLParser } from 'fast-xml-parser';
import { getDefinitionUpdateList } from '../../../src/models/client-definition-updates.js';
import { registerClientRoutes } from '../../../src/routes/client.js';

const parser = new XMLParser({ parseTagValue: false, trimValues: false }),
  enabled = { skip: !process.env.DATABASE_URL },
  now = new Date(2026, 10, 10, 12, 34, 30),
  date = '2026/11/10 11:00:00';
function tops(xml: string): Record<string, string>[] {
  const result = parser.parse(xml).conmas.tops.top;
  return result ? (Array.isArray(result) ? result : [result]) : [];
}
async function fixture(run: (db: pg.Pool) => Promise<void>) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }),
    connection = await pool.connect();
  try {
    await connection.query(`SET search_path=pg_temp,pg_catalog;
      CREATE TEMP TABLE def_top (def_top_id integer PRIMARY KEY,def_top_org integer,public_status numeric,
        deleted numeric DEFAULT 0,use_start_date timestamp,use_end_date timestamp,sys_update_time timestamp);
      CREATE TEMP TABLE def_current (def_top_id integer,def_top_org integer);
      CREATE TEMP TABLE mst_terminal (term_id integer,term_type text,physical_id text,approver text,deleted integer,term_name text);
      INSERT INTO pg_temp.mst_terminal VALUES (1,'iPad','fixture-device','approver',0,'Fixture');`);
    await run({ query: connection.query.bind(connection) } as unknown as pg.Pool);
  } finally {
    connection.release(true);
    await pool.end();
  }
}
async function definition(
  db: pg.Pool,
  id: number,
  options: {
    org?: number;
    status?: number | null;
    deleted?: number;
    start?: Date;
    end?: Date;
    updated?: Date | null;
    current?: boolean;
  } = {},
) {
  await db.query(
    `INSERT INTO pg_temp.def_top (def_top_id,def_top_org,public_status,deleted,use_start_date,use_end_date,sys_update_time)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      id,
      options.org ?? id,
      options.status === undefined ? 2 : options.status,
      options.deleted ?? 0,
      options.start ?? null,
      options.end ?? null,
      options.updated === undefined ? new Date(2026, 10, 10, 11) : options.updated,
    ],
  );
  if (options.current !== false)
    await db.query('INSERT INTO pg_temp.def_current VALUES ($1,$2)', [id, options.org ?? id]);
}
const full = (id: number, useDateType = '1', deleted = false, updated = date) => ({
  defTopId: String(id),
  lastUpdateDate: updated,
  useDateType,
  ...(deleted ? { deleted: '1' } : {}),
});

test('update lists validate literal int32 IDs before SQL, retaining missing versus malformed error codes', async () => {
  const db = {
    query: () => {
      throw new Error('Unexpected query');
    },
  } as unknown as pg.Pool;
  assert.equal(parser.parse(await getDefinitionUpdateList(db, '')).conmas.error.code, '2');
  for (const value of [
    ' ',
    '1,',
    ',1',
    '1,,2',
    '1.0',
    '1e2',
    '2147483648',
    '-2147483649',
    '1);DELETE FROM def_top--',
    '1 OR 1=1',
    '<&',
  ]) {
    assert.deepEqual(
      parser.parse(await getDefinitionUpdateList(db, value)).conmas.error,
      { code: '-1', remarks: { remark: 'server error.' } },
      value,
    );
  }
});

test('future-start operation/reservation branches use requested IDs, minute boundaries and parameterized SQL', async () => {
  for (const [operation, reserved, type, deleted] of [
    ['7', false, '1', false],
    ['1', false, '0', false],
    ['1', true, '1', true],
    [null, true, '1', false],
  ] as const) {
    const calls: { text: string; values?: unknown[] }[] = [];
    const db = {
      query: async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        if (calls.length === 1)
          return { rows: [{ def_top_id: '1', public_status: '2', deleted: '0', update_date: date }] };
        if (calls.length === 2)
          return {
            rows: [{ def_top_id: '2', use_start_date: new Date(2026, 10, 11), update_date: date, deleted: '0' }],
          };
        return { rows: [{ operation_id: operation, reserved }] };
      },
    } as unknown as pg.Pool;
    assert.deepEqual(tops(await getDefinitionUpdateList(db, '1', now)), [full(1, type, deleted)]);
    assert.deepEqual(calls[0].values, [[1]]);
    assert.deepEqual(calls[1].values, ['1']);
    assert.deepEqual(calls[2].values, [
      '1',
      new Date(2026, 10, 10, 12, 34),
      new Date(2026, 10, 10, 12, 34, 59),
      new Date(2026, 10, 10, 12, 35),
    ]);
    assert(calls.every(({ text }) => text.startsWith('SELECT')));
  }
});

test(
  'published revisions resolve every current published candidate, preserve ordering/deleted timestamps and never write definitions',
  enabled,
  async () =>
    fixture(async (db) => {
      await definition(db, 1, { org: 10, deleted: 1, current: false, updated: new Date(2026, 10, 10, 9) });
      await definition(db, 2, { org: 10 });
      await definition(db, 3, { org: 10, updated: new Date(2026, 10, 10, 10) });
      await definition(db, 4, { status: 1, updated: new Date(2026, 10, 10, 8) });
      await definition(db, 5, { org: 10, status: 1 });
      await definition(db, 6, { deleted: 1 });
      await definition(db, 7, { status: null, deleted: 1 });
      await db.query('INSERT INTO pg_temp.def_current VALUES (2,10),(999,10)');
      const before = (await db.query('SELECT * FROM pg_temp.def_top ORDER BY def_top_id')).rows;
      assert.deepEqual(tops(await getDefinitionUpdateList(db, '4,1,6,7,99,99', now)), [
        full(1, '1', false, '2026/11/10 09:00:00'),
        full(1, '1', false, '2026/11/10 09:00:00'),
        full(6, '1', true),
        full(4, '0', false, '2026/11/10 08:00:00'),
        full(7, '0', true),
        { defTopId: '99', deleted: '1' },
      ]);
      assert.deepEqual(tops(await getDefinitionUpdateList(db, '2,2', now)), [
        full(2, '1', false, '2026/11/10 10:00:00'),
        full(2),
      ]);
      assert.deepEqual((await db.query('SELECT * FROM pg_temp.def_top ORDER BY def_top_id')).rows, before);
    }),
);

test(
  'missing IDs/current rows, raw duplicate IDs and unpublished/null dates retain legacy response shapes',
  enabled,
  async () =>
    fixture(async (db) => {
      assert.deepEqual(tops(await getDefinitionUpdateList(db, '88,99', now)), []);
      await definition(db, 1, { current: false });
      await definition(db, 2, { status: 1, updated: null });
      await definition(db, 3, { status: 2, updated: null });
      await definition(db, 4, { org: 1, status: 1 });
      assert.deepEqual(tops(await getDefinitionUpdateList(db, '1,2,99', now)), [
        { defTopId: '1', deleted: '1' },
        full(2, '0', false, ''),
        { defTopId: '99', deleted: '1' },
      ]);
      assert.deepEqual(tops(await getDefinitionUpdateList(db, '01, +2 ,99,99', now)), [
        { defTopId: '1', deleted: '1' },
        full(2, '0', false, ''),
        { defTopId: '01', deleted: '1' },
        { defTopId: ' +2 ', deleted: '1' },
        { defTopId: '99', deleted: '1' },
      ]);
      await assert.rejects(getDefinitionUpdateList(db, '3', now), /Invalid definition update date/);
      await definition(db, -2147483648, { status: 1 });
      await definition(db, 2147483647, { status: 1 });
      assert.equal(tops(await getDefinitionUpdateList(db, '-2147483648,2147483647', now)).length, 2);
    }),
);

test(
  'validity windows retain no/start/end/both rules, inclusive seconds and the source in-window deletion quirk',
  enabled,
  async () =>
    fixture(async (db) => {
      const cases: [Date | undefined, Date | undefined, Date, string, boolean][] = [
        [undefined, undefined, now, '1', false],
        [new Date(2026, 10, 10, 12, 34), undefined, now, '1', false],
        [new Date(2026, 10, 10, 12, 34, 30), undefined, now, '1', false],
        [new Date(2026, 10, 10, 12, 34, 30, 999), undefined, now, '1', false],
        [new Date(2026, 10, 10, 12, 35), undefined, now, '1', false],
        [undefined, new Date(2026, 10, 10, 12, 34), new Date(2026, 10, 10, 12, 34, 59), '1', false],
        [undefined, new Date(2026, 10, 10, 12, 34), new Date(2026, 10, 10, 12, 34, 59, 1), '0', true],
        [new Date(2026, 10, 10, 12, 34, 30), new Date(2026, 10, 10, 12, 34), now, '1', true],
        [new Date(2026, 10, 10, 12, 34), new Date(2026, 10, 10, 12, 34), new Date(2026, 10, 10, 12, 34, 59), '1', true],
        [
          new Date(2026, 10, 10, 12, 34),
          new Date(2026, 10, 10, 12, 34),
          new Date(2026, 10, 10, 12, 34, 59, 1),
          '0',
          false,
        ],
        [new Date(2026, 10, 10, 12, 35), new Date(2026, 10, 10, 13), now, '0', false],
      ];
      for (const [index, [start, end, clock, type, deleted]] of cases.entries()) {
        const id = index + 1;
        await definition(db, id, { start, end });
        assert.deepEqual(
          tops(await getDefinitionUpdateList(db, String(id), clock)),
          [full(id, type, deleted)],
          String(id),
        );
      }
      await db.query('UPDATE pg_temp.def_top SET deleted=1 WHERE def_top_id=11');
      assert.deepEqual(tops(await getDefinitionUpdateList(db, '11', now)), [full(11, '0', true)]);
    }),
);

test(
  'operation lookup uses publication/deletion, whole-minute validity, update/ID ordering and current reservation',
  enabled,
  async () =>
    fixture(async (db) => {
      await definition(db, 1, { org: 10, current: false });
      await definition(db, 2, { org: 10, start: new Date(2026, 10, 10, 12, 35) });
      assert.deepEqual(tops(await getDefinitionUpdateList(db, '1', now)), [full(1, '0')]);
      await definition(db, 3, { org: 10, current: false, start: new Date(2026, 10, 10, 12, 34, 1) });
      await definition(db, 4, { org: 10, current: false, end: new Date(2026, 10, 10, 12, 34, 58) });
      await definition(db, 5, { org: 10, current: false, deleted: 1 });
      await definition(db, 6, { org: 10, current: false, status: 1 });
      assert.deepEqual(tops(await getDefinitionUpdateList(db, '1', now)), [full(1, '0')]);
      await db.query('UPDATE pg_temp.def_top SET use_end_date=$1 WHERE def_top_id=4', [
        new Date(2026, 10, 10, 12, 34, 59),
      ]);
      assert.deepEqual(tops(await getDefinitionUpdateList(db, '1', now)), [full(1)]);
      await db.query('UPDATE pg_temp.def_top SET sys_update_time=$1 WHERE def_top_id=1', [
        new Date(2026, 10, 10, 11, 1),
      ]);
      assert.deepEqual(tops(await getDefinitionUpdateList(db, '1', now)), [full(1, '0')]);
      assert.deepEqual(tops(await getDefinitionUpdateList(db, '2', now)), [full(2)]);
    }),
);

test(
  'dispatcher/direct GET/form POST preserve native sessions, approved terminals, XML/errors and cross-site protection',
  enabled,
  async () =>
    fixture(async (db) => {
      await definition(db, 1);
      await definition(db, 2, { status: 1 });
      const app = express(),
        store = new session.MemoryStore();
      app.use(express.urlencoded({ extended: false }));
      registerClientRoutes(app, db, store);
      const server = app.listen(0, '127.0.0.1');
      try {
        await new Promise<void>((resolve) => server.once('listening', resolve));
        const address = server.address();
        assert(address && typeof address !== 'string');
        const base = `http://127.0.0.1:${address.port}/ConMasWeb/Rests`,
          command = 'GetDefinitionUpdateList';
        const initial = await fetch(`${base}/Test/GetTest.aspx`),
          cookie = initial.headers.get('set-cookie')!.split(';')[0]!,
          sid = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1))
            .slice(2)
            .split('.')[0]!;
        await initial.text();
        const state = await new Promise<session.SessionData>((resolve, reject) =>
          store.get(sid, (error, data) => (error ? reject(error) : resolve(data!))),
        );
        state.clientAccount = {
          userId: 'no-report-roles',
          userName: 'Fixture',
          client: 'iPad',
          physicalId: 'fixture-device',
          version: '8.2',
          platform: 'Windows',
          address: '127.0.0.1',
          sessionId: sid,
        };
        const save = () =>
          new Promise<void>((resolve, reject) => store.set(sid, state, (error) => (error ? reject(error) : resolve())));
        await save();
        for (const direct of [false, true])
          for (const method of ['GET', 'POST']) {
            const path = direct ? '/getdefinitionupdatelist.ASPX' : '/ConMasIReporter.aspx';
            const parameters = new URLSearchParams({
              ...(direct ? {} : { command }),
              defTopId: '1',
              defTopOrg: 'unused',
              urlSchemeMode: 'ignored',
            });
            const result = await fetch(base + path + (method === 'GET' ? '?' + parameters : ''), {
              method,
              headers: { cookie },
              ...(method === 'POST' ? { body: parameters } : {}),
            });
            assert.equal(result.status, 200);
            assert.match(result.headers.get('content-type')!, /^text\/xml; charset=utf-8/);
            assert.equal(result.headers.get('cache-control'), 'no-store');
            const xml = await result.text();
            assert.match(xml, /<tops>/);
            assert.deepEqual(tops(xml), [full(1)]);
            const anonymous = await fetch(base + path + '?' + (direct ? '' : `command=${command}&`) + 'defTopId=1');
            assert.equal(parser.parse(await anonymous.text()).conmas.error.code, '5');
          }
        const combined = await fetch(`${base}/${command}.aspx?defTopId=1`, {
          method: 'POST',
          headers: { cookie },
          body: new URLSearchParams({ defTopId: '2' }),
        });
        assert.deepEqual(tops(await combined.text()), [full(1), full(2, '0')]);
        for (const [parameters, code] of [
          [{}, '2'],
          [{ topId: '1' }, '2'],
          [{ defTopId: 'bad' }, '-1'],
        ] as const) {
          const result = await fetch(`${base}/${command}.aspx`, {
            method: 'POST',
            headers: { cookie },
            body: new URLSearchParams(parameters),
          });
          assert.equal(result.status, 200);
          assert.equal(parser.parse(await result.text()).conmas.error.code, code);
        }
        for (const terminalState of ['pending', 'deleted', 'missing']) {
          await db.query('UPDATE pg_temp.mst_terminal SET approver=$1,deleted=$2', [
            terminalState === 'pending' ? '' : 'approver',
            terminalState === 'deleted' ? 1 : 0,
          ]);
          state.clientAccount.physicalId = terminalState === 'missing' ? 'unknown' : 'fixture-device';
          await save();
          const result = await fetch(`${base}/${command}.aspx`, { headers: { cookie } });
          assert.equal(parser.parse(await result.text()).conmas.error.code, '3');
        }
        const crossSiteHeaders: Record<string, string>[] = [
          { origin: 'https://other.invalid' },
          { 'sec-fetch-site': 'cross-site' },
        ];
        for (const headers of crossSiteHeaders) {
          const result = await fetch(`${base}/${command}.aspx?defTopId=1`, { headers: { cookie, ...headers } });
          assert.equal(result.status, 403);
          assert.equal(parser.parse(await result.text()).conmas.error.code, '3');
        }
        state.clientAccount.physicalId = 'fixture-device';
        await save();
        await db.query("UPDATE pg_temp.mst_terminal SET approver='approver',deleted=0");
        await db.query('DROP TABLE pg_temp.def_current');
        const failed = await fetch(`${base}/${command}.aspx?defTopId=1`, { headers: { cookie } });
        assert.equal(failed.status, 200);
        assert.deepEqual(parser.parse(await failed.text()).conmas.error, {
          code: '-1',
          remarks: { remark: 'server error.' },
        });
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }
    }),
);
