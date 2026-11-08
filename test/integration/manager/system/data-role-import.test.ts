import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { createApp } from '../../../helpers/app.js';
import { importRoles, roleImportRows } from '../../../../src/models/manager/system/data-role-import.js';

async function fixture(run: (db: pg.Pool, client: pg.PoolClient) => Promise<void>) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const db = {
    query: pool.query.bind(pool),
    connect: async () => ({ query: client.query.bind(client), release: () => {} }),
  } as unknown as pg.Pool;
  try {
    await client.query(`CREATE TEMP TABLE def_role (LIKE public.def_role INCLUDING ALL);
      CREATE TEMP TABLE rep_role (LIKE public.rep_role INCLUDING ALL);
      CREATE TEMP TABLE def_top (def_top_id integer PRIMARY KEY,def_top_org integer,rev_no integer);
      CREATE TEMP TABLE rep_top (rep_top_id integer PRIMARY KEY,def_top_id integer);`);
    await run(db, client);
  } finally {
    await client.query('DROP TABLE IF EXISTS pg_temp.def_role,pg_temp.rep_role,pg_temp.def_top,pg_temp.rep_top');
    client.release();
    await pool.end();
  }
}

test('role imports retain original XML field order, missing fields and format rejection', () => {
  assert.deepEqual(
    roleImportRows(
      '<conmas><repRole><roleRepRead>1</roleRepRead><groupId>3</groupId><action>D</action><repTopId>2</repTopId></repRole></conmas>',
      'xml',
      'report',
    ),
    [['D', '2', '3', '1', '', '']],
  );
  assert.deepEqual(roleImportRows('D,2,ALL,,,\r\n', 'csv', 'report'), [['D', '2', 'ALL', '', '', '']]);
  assert.throws(() => roleImportRows('<!DOCTYPE conmas><conmas/>', 'xml', 'definition'));
  assert.throws(() => roleImportRows('', 'csvZip', 'report'));
});

test(
  'report roles preserve row errors, merge, ignore behavior, audit and reserved ALL deletion',
  { skip: !process.env.DATABASE_URL },
  async () =>
    fixture(async (db, client) => {
      const run = (csv: string) => importRoles(db, csv, 'csv', 'report', 'actor', 'host');
      const results = await run(
        'A,1,2,1,0,1\nA,1,2,0,1,0\nA,1,3,2,0,0\nA,1,-2,1,0,0\nD,1,2\nU,1,2,{ignore},9,9\nM,1,3,{ignore},1,0\n',
      );
      assert.deepEqual(
        results.map((row) => row.code),
        ['0', '10020', '11020', '11030', '10010', '0', '11020'],
      );
      const role = (
        await client.query(
          'SELECT role_rep_read,role_rep_update,role_rep_delete,sys_regist_term,sys_regist_user FROM pg_temp.rep_role',
        )
      ).rows[0];
      assert.deepEqual(role, {
        role_rep_read: '1',
        role_rep_update: '0',
        role_rep_delete: '1',
        sys_regist_term: 'WEBAPI/host',
        sys_regist_user: 'actor',
      });
      assert.deepEqual(
        (await run('U,1,99,0,0,0\nM,1,2,0,1,0\nM,1,3,1,1,1\n')).map((row) => row.code),
        ['0', '0', '0'],
      );
      assert.equal(
        (await client.query('SELECT role_rep_update FROM pg_temp.rep_role WHERE group_id=2')).rows[0].role_rep_update,
        '1',
      );
      await client.query('INSERT INTO pg_temp.rep_role (rep_top_id,group_id) VALUES (1,-999),(2,2)');
      assert.equal((await run('D,1,ALL,,,\n'))[0].code, '0');
      assert.deepEqual(
        (await client.query('SELECT rep_top_id,group_id FROM pg_temp.rep_role ORDER BY rep_top_id,group_id')).rows,
        [
          { rep_top_id: 1, group_id: -999 },
          { rep_top_id: 2, group_id: 2 },
        ],
      );
      assert.equal((await run('D,2,2,garbage,ignored,values\n'))[0].code, '0');
      assert.equal((await client.query('SELECT 1 FROM pg_temp.rep_role WHERE rep_top_id=2')).rowCount, 0);
    }),
);

test(
  'definition roles propagate revisions and report permissions atomically with source mode defaults',
  { skip: !process.env.DATABASE_URL },
  async () =>
    fixture(async (db, client) => {
      await client.query(
        'INSERT INTO pg_temp.def_top VALUES (10,10,1),(11,10,2),(12,10,3),(20,20,1); INSERT INTO pg_temp.rep_top VALUES (100,10),(110,11),(120,12),(200,20)',
      );
      const run = (csv: string, options: Record<string, unknown> = {}) =>
        importRoles(db, csv, 'csv', 'definition', 'actor', 'host', options);
      const mode = { defRoleMode: '1', repRoleMode: '1', defRoleModeTarget: 'A,U,D,M', repRoleModeTarget: 'A,U,D,M' };
      assert.equal((await run('A,11,2,1,0,1,0,1,1,0\n', mode))[0].code, '0');
      assert.deepEqual((await client.query('SELECT def_top_id FROM pg_temp.def_role ORDER BY def_top_id')).rows, [
        { def_top_id: 11 },
        { def_top_id: 12 },
      ]);
      assert.deepEqual(
        (
          await client.query(
            'SELECT rep_top_id,role_rep_read,role_rep_update,role_rep_delete FROM pg_temp.rep_role ORDER BY rep_top_id',
          )
        ).rows,
        [
          { rep_top_id: 110, role_rep_read: '0', role_rep_update: '1', role_rep_delete: '0' },
          { rep_top_id: 120, role_rep_read: '0', role_rep_update: '1', role_rep_delete: '0' },
        ],
      );
      assert.equal((await run('M,11,2,{ignore},9,9,9,9,9,9\n', mode))[0].code, '0');
      assert.equal(
        (await client.query('SELECT role_def_read FROM pg_temp.def_role WHERE def_top_id=11')).rows[0].role_def_read,
        '1',
      );
      assert.equal((await run('U,11,2,0,1,0,1,0,0,1\n', { defRoleMode: '1', repRoleMode: '1' }))[0].code, '0');
      assert.equal(
        (await client.query("SELECT count(*)::int AS n FROM pg_temp.def_role WHERE role_def_read='0'")).rows[0].n,
        2,
      );
      assert.equal(
        (await client.query("SELECT count(*)::int AS n FROM pg_temp.rep_role WHERE role_rep_delete='1'")).rows[0].n,
        2,
      );
      await client.query('INSERT INTO pg_temp.rep_role (rep_top_id,group_id) VALUES (120,3)');
      assert.equal((await run('A,11,3,1,1,1,1,1,1,1\n', mode))[0].code, '10020');
      assert.equal((await client.query('SELECT 1 FROM pg_temp.def_role WHERE group_id=3')).rowCount, 0);
      assert.equal(
        (await client.query('SELECT 1 FROM pg_temp.rep_role WHERE rep_top_id=110 AND group_id=3')).rowCount,
        0,
      );
      assert.equal((await run('M,20,4,1,1,1,1,1,1,1\n'))[0].code, '0');
      assert.equal((await run('M,20,4,0,0,0,0,0,0,0\n'))[0].code, '0');
      assert.equal(
        (await client.query('SELECT role_def_read FROM pg_temp.def_role WHERE def_top_id=20 AND group_id=4')).rows[0]
          .role_def_read,
        '0',
      );
      await client.query(
        'INSERT INTO pg_temp.def_role (def_top_id,group_id) VALUES (11,-999); INSERT INTO pg_temp.rep_role (rep_top_id,group_id) VALUES (110,-999)',
      );
      assert.equal((await run('D,11,ALL,,,,,,,\n', mode))[0].code, '0');
      assert.deepEqual((await client.query('SELECT group_id FROM pg_temp.def_role WHERE def_top_id IN (11,12)')).rows, [
        { group_id: -999 },
      ]);
      assert.deepEqual(
        (await client.query('SELECT group_id FROM pg_temp.rep_role WHERE rep_top_id IN (110,120)')).rows,
        [{ group_id: -999 }],
      );
      assert.deepEqual(await run('not even csv', { defRoleModeTarget: 'U,invalid' }), [
        { code: '2', remark: '' },
        { code: '', remark: 'Invalid Parameter (defRoleModeTarget)' },
      ]);
    }),
);

test(
  'authenticated multipart role imports dispatch CSV and XML with CSRF before writes',
  { skip: !process.env.DATABASE_URL || !process.env.CONMAS_TEST_PASSWORD },
  async () =>
    fixture(async (db, client) => {
      await client.query('INSERT INTO pg_temp.def_top VALUES (10,10,1),(11,10,2)');
      const server = createApp(db).listen(0, '127.0.0.1');
      try {
        await new Promise<void>((resolve) => server.once('listening', resolve));
        const address = server.address();
        assert(address && typeof address !== 'string');
        const root = `http://127.0.0.1:${address.port}/ConMasManager`;
        const login = await fetch(root + '/Account/LogOn', {
          method: 'POST',
          body: new URLSearchParams({ UserName: 'conmasadmin', Password: process.env.CONMAS_TEST_PASSWORD! }),
          redirect: 'manual',
        });
        const cookie = login.headers.get('set-cookie')?.split(';')[0];
        assert(cookie);
        const page = await fetch(root + '/System/DataInput', { headers: { cookie } });
        assert.equal(page.status, 200);
        const token = (await page.text()).match(/name="__RequestVerificationToken" value="([^"]+)"/)?.[1];
        assert(token);
        const upload = async (command: string, text: string, format: string, csrf = token) => {
          const body = new FormData();
          body.set('DataInputType', command);
          body.set('type', format);
          body.set('encoding', '65001');
          body.set('__RequestVerificationToken', csrf);
          body.set('file1', new Blob([text]), 'roles.' + format);
          body.set('defRoleModeTarget', 'A');
          return fetch(root + '/System/DataInput?defRoleMode=1&defRoleModeTarget=M', {
            method: 'POST',
            headers: { cookie },
            body,
          });
        };
        const denied = await upload('RegistDefinitionRole', 'A,10,2,1,1,1,1,1,1,1\n', 'csv', 'bad');
        assert.equal(denied.status, 403);
        assert.equal((await client.query('SELECT 1 FROM pg_temp.def_role')).rowCount, 0);
        const definition = await upload('RegistDefinitionRole', 'A,10,2,1,1,1,1,1,1,1\n', 'csv');
        assert.equal(definition.status, 200);
        assert.match(await definition.text(), /Registration is successful/);
        assert.deepEqual((await client.query('SELECT def_top_id FROM pg_temp.def_role ORDER BY def_top_id')).rows, [
          { def_top_id: 10 },
          { def_top_id: 11 },
        ]);
        const report = await upload(
          'RegistReportRole',
          '<conmas><repRole><action>M</action><repTopId>100</repTopId><groupId>2</groupId><roleRepRead>1</roleRepRead><roleRepUpdate>0</roleRepUpdate><roleRepDelete>1</roleRepDelete></repRole></conmas>',
          'xml',
        );
        assert.equal(report.status, 200);
        assert.match(await report.text(), /Registration is successful/);
        assert.equal(
          (await client.query('SELECT sys_regist_user FROM pg_temp.rep_role WHERE rep_top_id=100 AND group_id=2'))
            .rows[0].sys_regist_user,
          'conmasadmin',
        );
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }
    }),
);
