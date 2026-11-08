import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { createApp } from '../../../helpers/app.js';
import {
  importLabelMasters,
  labelMasterImportRows,
} from '../../../../src/models/manager/system/data-label-master-import.js';

async function fixture(run: (db: pg.Pool, client: pg.PoolClient, keyMode: (value: string) => void) => Promise<void>) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  let mode = '0';
  const db = {
    query: async (text: string, values?: unknown[]) =>
      text.includes("com_name='MST_GROUP_KEY_MODE'")
        ? { rows: [{ com_value: mode }] }
        : text.startsWith('SELECT group_id FROM mst_group WHERE system_key=')
          ? client.query(text, values)
          : pool.query(text, values),
    connect: async () => ({ query: client.query.bind(client), release: () => {} }),
  } as unknown as pg.Pool;
  try {
    await client.query(`CREATE TEMP SEQUENCE mst_label_def_mst_label_id_seq START 100;
      CREATE TEMP SEQUENCE mst_label_rep_mst_label_id_seq START 700;
      CREATE TEMP TABLE mst_label_def (LIKE public.mst_label_def INCLUDING ALL);
      CREATE TEMP TABLE mst_label_rep (LIKE public.mst_label_rep INCLUDING ALL);
      CREATE TEMP TABLE def_label_role (LIKE public.def_label_role INCLUDING ALL);
      CREATE TEMP TABLE rep_label_role (LIKE public.rep_label_role INCLUDING ALL);
      CREATE TEMP TABLE mst_group (group_id integer PRIMARY KEY,system_key text,deleted integer);
      INSERT INTO pg_temp.mst_group VALUES (10,'first',0),(20,'second',1);`);
    const sequence = (
      await client.query(
        "SELECT 'mst_label_def_mst_label_id_seq'::regclass::oid='pg_temp.mst_label_def_mst_label_id_seq'::regclass::oid AS private_def,'mst_label_rep_mst_label_id_seq'::regclass::oid='pg_temp.mst_label_rep_mst_label_id_seq'::regclass::oid AS private_rep",
      )
    ).rows[0];
    assert.deepEqual(sequence, { private_def: true, private_rep: true });
    await run(db, client, (value) => {
      mode = value;
    });
  } finally {
    await client.query(
      'DROP TABLE IF EXISTS pg_temp.mst_label_def,pg_temp.mst_label_rep,pg_temp.def_label_role,pg_temp.rep_label_role,pg_temp.mst_group; DROP SEQUENCE IF EXISTS pg_temp.mst_label_def_mst_label_id_seq,pg_temp.mst_label_rep_mst_label_id_seq',
    );
    client.release();
    await pool.end();
  }
}

test('label-master XML retains optional fields and source names', () => {
  assert.deepEqual(
    labelMasterImportRows(
      '<conmas><definitionLabelMaster><labelName>A&amp;B</labelName><action>A</action><labelIconId>1</labelIconId><displayNumber>2</displayNumber></definitionLabelMaster></conmas>',
      'xml',
      'def',
    ),
    [['A', '', '', 'A&B', '1', '', '2', '', '']],
  );
  assert.equal(labelMasterImportRows('D,1,,,,,\r\n', 'csv', 'rep')[0].length, 7);
  assert.throws(() => labelMasterImportRows('<!DOCTYPE conmas><conmas/>', 'xml', 'rep'));
});

test(
  'label-master validation retains precedence, optional auto-delete and independent database errors',
  { skip: !process.env.DATABASE_URL },
  async () =>
    fixture(async (db, client) => {
      const rows = labelMasterImportRows(
        'A,1,,name,1,,0\nA,,,,1,,0\nA,,,name,,,0\nA,,,name,11,,0\nA,,999,name,1,,0\nA,,,name,1,,-1\nA,,,name,1,,0,999\nD,1,,,,,,,bad\nA,,,bad display,1,,\nA,,,valid,1,,0,20,2\n',
        'csv',
        'def',
      );
      const result = await importLabelMasters(db, rows, 'def', 'actor', 'host');
      assert.deepEqual(
        result.map((row) => row.code),
        ['11020', '11010', '11020', '11020', '11020', '11030', '11020', '11030', '10020', '0'],
      );
      const label = (
        await client.query('SELECT label_name,auto_delete,sys_regist_term,sys_regist_user FROM pg_temp.mst_label_def')
      ).rows[0];
      assert.deepEqual(label, {
        label_name: 'valid',
        auto_delete: 0,
        sys_regist_term: 'WEBAPI/host',
        sys_regist_user: 'actor',
      });
      assert.deepEqual((await client.query('SELECT group_id FROM pg_temp.def_label_role')).rows, [{ group_id: 20 }]);
    }),
);

test(
  'definition label moves rebuild descendants while rename, role and ignore rules match source',
  { skip: !process.env.DATABASE_URL },
  async () =>
    fixture(async (db, client) => {
      const run = (csv: string) =>
        importLabelMasters(db, labelMasterImportRows(csv, 'csv', 'def'), 'def', 'actor', 'host');
      assert.deepEqual(
        (
          await run('M,100,,Root,1,note,1,10,1\nM,110,,Other,2,,2\nM,101,100,Child,3,,3\nM,102,101,Grand/child,4,,4\n')
        ).map((row) => row.code),
        ['0', '0', '0', '0'],
      );
      assert.equal((await run('U,100,{ignore},Renamed,{ignore},{ignore},{ignore},,2\n'))[0].code, '0');
      assert.equal(
        (await client.query('SELECT label_name_path FROM pg_temp.mst_label_def WHERE mst_label_id=102')).rows[0]
          .label_name_path,
        'Root/Child/Grand/child',
      );
      assert.equal(
        (await client.query('SELECT auto_delete FROM pg_temp.mst_label_def WHERE mst_label_id=100')).rows[0]
          .auto_delete,
        1,
      );
      assert.equal((await client.query('SELECT 1 FROM pg_temp.def_label_role WHERE mst_label_id=100')).rowCount, 1);
      assert.equal((await run('U,101,110,{ignore},{ignore},{ignore},{ignore}\n'))[0].code, '0');
      assert.deepEqual(
        (await client.query('SELECT label_id_path,label_name_path FROM pg_temp.mst_label_def WHERE mst_label_id=102'))
          .rows[0],
        { label_id_path: '110/101/102', label_name_path: 'Other/Child/Grand/child' },
      );
      assert.equal((await run('U,100,{ignore},Rolled back,1,,0,10;10\n'))[0].code, '10020');
      assert.equal(
        (await client.query('SELECT label_name FROM pg_temp.mst_label_def WHERE mst_label_id=100')).rows[0].label_name,
        'Renamed',
      );
      assert.equal((await client.query('SELECT 1 FROM pg_temp.def_label_role WHERE mst_label_id=100')).rowCount, 1);
      assert.equal((await run('U,100,{ignore},{ignore},{ignore},{ignore},{ignore},-1\n'))[0].code, '0');
      assert.equal((await client.query('SELECT 1 FROM pg_temp.def_label_role WHERE mst_label_id=100')).rowCount, 0);
      assert.equal((await run('A,,,sequence collision,1,,0\n'))[0].code, '10020');
      assert.equal((await run('D,102,,,,,\n'))[0].code, '0');
      assert.equal((await client.query('SELECT 1 FROM pg_temp.mst_label_def WHERE mst_label_id=102')).rowCount, 0);
    }),
);

test(
  'report label imports retain binder protection, key-mode prepass and installed sequence behavior',
  { skip: !process.env.DATABASE_URL },
  async () =>
    fixture(async (db, client, keyMode) => {
      const run = (csv: string) =>
        importLabelMasters(db, labelMasterImportRows(csv, 'csv', 'rep'), 'rep', 'actor', 'host');
      assert.equal((await run('A,,,Report,1,,0,10\n'))[0].code, '0');
      assert.deepEqual((await client.query('SELECT mst_label_id FROM pg_temp.mst_label_rep')).rows, [
        { mst_label_id: 100 },
      ]);
      assert.equal(
        (await client.query('SELECT last_value::int FROM pg_temp.mst_label_rep_mst_label_id_seq')).rows[0].last_value,
        100,
      );
      await client.query('UPDATE pg_temp.mst_label_rep SET binder_rep_id=77 WHERE mst_label_id=100');
      const binder = (await run('U,100,{ignore},Changed,1,,0\n'))[0];
      assert.equal(binder.code, '11000');
      assert.equal(binder.remark, 'Field Error(labelName).');
      keyMode('1');
      assert.equal((await run('U,100,{ignore},{ignore},2,,0,second;missing\n'))[0].code, '0');
      assert.deepEqual((await client.query('SELECT group_id FROM pg_temp.rep_label_role')).rows, [{ group_id: 20 }]);
      assert.equal((await run('U,100,{ignore},{ignore},2,,0,-1\n'))[0].code, '0');
      assert.deepEqual((await client.query('SELECT group_id FROM pg_temp.rep_label_role')).rows, [{ group_id: 20 }]);
      await assert.rejects(run('M,200,,Before abort,1,,0,first\nD,100,,,,,\n'));
      assert.equal((await client.query('SELECT 1 FROM pg_temp.mst_label_rep WHERE mst_label_id=200')).rowCount, 0);
      assert.equal((await run("U,100,{ignore},{ignore},2,,0,key');DELETE FROM mst_group;--\n"))[0].code, '0');
      assert.equal((await client.query('SELECT 1 FROM pg_temp.mst_group')).rowCount, 2);
      keyMode('0');
      assert.equal((await run('U,100,{ignore},{ignore},2,,0,-1\n'))[0].code, '0');
      assert.equal((await client.query('SELECT 1 FROM pg_temp.rep_label_role')).rowCount, 0);
      assert.equal((await run('M,5000,,Explicit ID,1,,0\nA,,,Shared allocator,1,,0\n'))[1].code, '0');
      assert.deepEqual(
        (await client.query('SELECT mst_label_id FROM pg_temp.mst_label_rep ORDER BY mst_label_id')).rows,
        [{ mst_label_id: 100 }, { mst_label_id: 101 }, { mst_label_id: 5000 }],
      );
    }),
);

test(
  'cyclic label moves roll back instead of leaving an endless recursive hierarchy',
  { skip: !process.env.DATABASE_URL },
  async () =>
    fixture(async (db, client) => {
      const run = (csv: string) =>
        importLabelMasters(db, labelMasterImportRows(csv, 'csv', 'def'), 'def', 'actor', 'host');
      await run('M,1,,Root,1,,0\nM,2,1,Child,1,,0\n');
      assert.equal((await run('U,1,2,Root,1,,0\n'))[0].code, '10020');
      assert.equal(
        (await client.query('SELECT upper_label_id FROM pg_temp.mst_label_def WHERE mst_label_id=1')).rows[0]
          .upper_label_id,
        null,
      );
    }),
);

test(
  'authenticated label-master imports dispatch original CSV/XML command names with CSRF',
  { skip: !process.env.DATABASE_URL || !process.env.CONMAS_TEST_PASSWORD },
  async () =>
    fixture(async (db, client) => {
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
        const upload = (command: string, text: string, format: string, csrf = token) => {
          const body = new FormData();
          body.set('DataInputType', command);
          body.set('type', format);
          body.set('encoding', '65001');
          body.set('__RequestVerificationToken', csrf);
          body.set('file1', new Blob([text]), 'labels.' + format);
          return fetch(root + '/System/DataInput', { method: 'POST', headers: { cookie }, body });
        };
        assert.equal((await upload('RegistDefenitionLabelMaster', 'A,,,Not written,1,,0', 'csv', 'bad')).status, 403);
        assert.equal((await client.query('SELECT 1 FROM pg_temp.mst_label_def')).rowCount, 0);
        const definition = await upload('RegistDefenitionLabelMaster', 'A,,,Definition label,1,,0', 'csv');
        assert.equal(definition.status, 200);
        assert.match(await definition.text(), /Registration is successful/);
        const report = await upload(
          'RegistReportLabelMaster',
          '<conmas><reportLabelMaster><action>M</action><labelId>400</labelId><labelName>Report label</labelName><labelIconId>2</labelIconId><displayNumber>4</displayNumber></reportLabelMaster></conmas>',
          'xml',
        );
        assert.equal(report.status, 200);
        assert.match(await report.text(), /Registration is successful/);
        assert.equal(
          (await client.query('SELECT sys_regist_user FROM pg_temp.mst_label_rep WHERE mst_label_id=400')).rows[0]
            .sys_regist_user,
          'conmasadmin',
        );
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }
    }),
);
