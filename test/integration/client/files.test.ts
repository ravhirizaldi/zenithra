import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import {
  getClientBackgroundPdf,
  getClientExcel,
  getClientSheetBackground,
  getClientMessageImage,
  getClientMasterImage,
} from '../../../src/models/client-files.js';

async function fixture(run: (db: pg.Pool, client: pg.PoolClient) => Promise<void>): Promise<void> {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const db = {
    query: client.query.bind(client),
    connect: async () => ({ query: client.query.bind(client), release() {} }),
  } as unknown as pg.Pool;
  try {
    await client.query(`CREATE TEMP TABLE def_top (def_top_id integer,def_file bytea,def_file_type text,background_image_file bytea);
      CREATE TEMP TABLE def_top_backup (LIKE pg_temp.def_top);
      CREATE TEMP TABLE rep_top (rep_top_id integer,def_top_id integer,def_file bytea,def_file_type text,background_image_file bytea);
      CREATE TEMP TABLE def_sheet (def_top_id integer,def_sheet_no integer,background_image_file bytea);
      CREATE TEMP TABLE mst_message (LIKE public.mst_message INCLUDING ALL);
      CREATE TEMP TABLE mst_custom_default_record (LIKE public.mst_custom_default_record INCLUDING ALL);
      CREATE TEMP TABLE mst_custom_record (LIKE public.mst_custom_record INCLUDING ALL);
      ALTER TABLE pg_temp.mst_custom_record ADD COLUMN field1 bytea, ADD COLUMN field2 bytea;
      CREATE TEMP TABLE mst_custom_table (LIKE public.mst_custom_table INCLUDING ALL);
      CREATE TEMP TABLE mst_common (LIKE public.mst_common INCLUDING ALL);
      CREATE TEMP TABLE custom_master_synching_terminal (LIKE public.custom_master_synching_terminal INCLUDING ALL);
      INSERT INTO pg_temp.def_top VALUES (1,'definition','xlsx','definition-pdf');
      INSERT INTO pg_temp.def_top_backup VALUES (1,'backup','xls','backup-pdf');
      INSERT INTO pg_temp.rep_top VALUES (2,1,'report','xlsm','report-pdf');
      INSERT INTO pg_temp.def_sheet VALUES (1,0,'sheet-png');`);
    await run(db, client);
  } finally {
    client.release(true);
    await pool.end();
  }
}

test('binary IDs reject non-int32/injected inputs before querying', async () => {
  const db = {
    query: () => {
      throw new Error('Unexpected query');
    },
  } as unknown as pg.Pool;
  for (const text of ['1.5', '2147483648', '-2147483649', '1 OR 1=1', 'NaN']) {
    await assert.rejects(getClientExcel(db, text, ''), /Invalid binary request integer/);
    await assert.rejects(getClientExcel(db, '', text), /Invalid binary request integer/);
    await assert.rejects(getClientBackgroundPdf(db, text, ''), /Invalid binary request integer/);
    await assert.rejects(getClientSheetBackground(db, text, '0'), /Invalid binary request integer/);
    await assert.rejects(getClientSheetBackground(db, '1', text), /Invalid binary request integer/);
  }
  await assert.rejects(getClientSheetBackground(db, '', '0'), /Invalid binary request integer/);
});

test(
  'Excel downloads preserve definition/backup and report-definition/report/backup precedence',
  { skip: !process.env.DATABASE_URL },
  async () =>
    fixture(async (db, client) => {
      const bytes = async (topId: string, repTopId = '') => (await getClientExcel(db, topId, repTopId)).data.toString();
      assert.equal(await bytes('1'), 'definition');
      assert.equal((await getClientExcel(db, ' +1 ', '')).filename, 'excel.xlsx');
      assert.equal(await bytes('invalid but ignored', '2'), 'definition');
      await client.query('UPDATE pg_temp.def_top SET def_file=NULL');
      assert.equal(await bytes('1'), 'backup');
      assert.equal(await bytes('1', '2'), 'report');
      await client.query('UPDATE pg_temp.rep_top SET def_file=NULL');
      assert.equal(await bytes('1', '2'), 'backup');
      await client.query('UPDATE pg_temp.def_top_backup SET def_file=NULL');
      assert.deepEqual(await getClientExcel(db, '1', ''), { data: Buffer.alloc(0), filename: 'empty' });
      assert.deepEqual(await getClientExcel(db, '', ''), { data: Buffer.alloc(0), filename: 'empty' });
      assert.deepEqual(await getClientExcel(db, '99', ''), { data: Buffer.alloc(0), filename: 'empty' });
      // A specified missing report does not fall back to the explicit topId in Excel mode.
      await client.query("UPDATE pg_temp.def_top SET def_file='definition'");
      assert.equal(await bytes('1', '99'), '');
    }),
);

test(
  'message images preserve source missing/empty errors, raw bytes and attachment names',
  { skip: !process.env.DATABASE_URL },
  async () =>
    fixture(async (db, client) => {
      await client.query(
        "INSERT INTO pg_temp.mst_message (message_id,image_file,image_file_name) VALUES (1,'image','image.png'),(2,NULL,NULL),(3,''::bytea,'empty.png')",
      );
      assert.deepEqual(await getClientMessageImage(db, ' +1 '), { data: Buffer.from('image'), filename: 'image.png' });
      for (const id of ['2', '3', '4'])
        assert.match((await getClientMessageImage(db, id)) as string, /<code>8<\/code>/);
      for (const id of ['', '1.5', '2147483648', '1 OR 1=1'])
        assert.match((await getClientMessageImage(db, id)) as string, /<code>2<\/code>/);
    }),
);

test(
  'master images use validated modern fields, suppress fallback on default rows and preserve legacy binary behavior',
  { skip: !process.env.DATABASE_URL },
  async () =>
    fixture(async (db, client) => {
      await client.query(
        "INSERT INTO pg_temp.mst_custom_default_record (record_id,master_id,field0001,field0002,field1001) VALUES (1,1,'modern text','text','modern1001'),(2,2,NULL,NULL,NULL),(3,3,NULL,NULL,''::bytea)",
      );
      await client.query(
        "INSERT INTO pg_temp.mst_custom_record (record_id,master_id,record_key,field1,field2) VALUES (1,1,'one','legacy','legacy2'),(2,1,'two','suppressed','suppressed'),(4,1,'four','old','old2')",
      );
      const image = (id: string, field: string) => getClientMasterImage(db, id, field, 'fixture', null);
      assert.deepEqual(await image(' +1 ', '01001'), { data: Buffer.from('modern1001'), filename: 'image_ +1 _01001' });
      assert.deepEqual(await image('1', '1001'), { data: Buffer.from('modern1001'), filename: 'image_1_1001' });
      for (const [id, field] of [
        ['1', '2'],
        ['2', '1'],
        ['99', '1'],
      ])
        assert.deepEqual(await image(id, field), { data: Buffer.alloc(0), filename: 'empty' });
      assert.deepEqual(await image('3', '1001'), { data: Buffer.alloc(0), filename: 'image_3_1001' });
      assert.deepEqual(await image('4', '1'), { data: Buffer.from('old'), filename: 'image_4_1' });
      for (const field of ['0', '-1', '101', '1000', '1006'])
        await assert.rejects(image('1', field), /Invalid master image field/);
      for (const [id, field] of [
        ['', '1'],
        ['1', ''],
        ['1 OR 1=1', '1'],
        ['1', '1;DROP'],
        ['1', '2147483648'],
      ])
        assert.match((await image(id, field)) as string, /<code>2<\/code>/);
    }),
);

test(
  'cloud mobile master images enforce sync capacity, renew existing markers and roll back expiry cleanup on rejection',
  { skip: !process.env.DATABASE_URL },
  async () =>
    fixture(async (db, client) => {
      const platform = process.env.CONMAS_PLATFORM;
      process.env.CONMAS_PLATFORM = 'cloud';
      try {
        await client.query(`INSERT INTO pg_temp.mst_custom_table (master_id,master_key,mobile_save) VALUES (1,'mobile',1),(2,'offline',0);
      INSERT INTO pg_temp.mst_custom_default_record (record_id,master_id,field1001) VALUES (1,1,'mobile'),(2,2,'offline');
      INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (1,'CUSTOM_MASTER','SYNC_TERMINAL_LIMIT','1'),(2,'CUSTOM_MASTER','SYNC_LIMIT_TIME','60');
      INSERT INTO pg_temp.custom_master_synching_terminal (term_id,sys_update_time) VALUES (999,now()-interval '2 minutes')`);
        const image = (id: string, terminal: number) => getClientMasterImage(db, id, '1001', 'fixture', terminal);
        assert.deepEqual(await image('1', 10), { data: Buffer.from('mobile'), filename: 'image_1_1001' });
        assert.deepEqual(
          (
            await client.query(
              'SELECT term_id,sys_regist_user,sys_update_user FROM pg_temp.custom_master_synching_terminal',
            )
          ).rows,
          [{ term_id: 10, sys_regist_user: 'fixture', sys_update_user: 'fixture' }],
        );
        await client.query(
          "UPDATE pg_temp.custom_master_synching_terminal SET sys_update_time=now()-interval '10 seconds'",
        );
        assert.equal(typeof (await image('1', 10)), 'object');
        await client.query(
          "INSERT INTO pg_temp.custom_master_synching_terminal (term_id,sys_update_time) VALUES (999,now()-interval '2 minutes')",
        );
        assert.match((await image('1', 11)) as string, /<code>17009<\/code>.*<remark>1<\/remark>/);
        assert.equal((await client.query('SELECT * FROM pg_temp.custom_master_synching_terminal')).rowCount, 2);
        assert.equal(typeof (await image('2', 11)), 'object');
        assert.equal((await client.query('SELECT * FROM pg_temp.custom_master_synching_terminal')).rowCount, 2);
        await client.query(
          "UPDATE pg_temp.custom_master_synching_terminal SET sys_update_time=now()-interval '2 minutes'",
        );
        assert.equal(typeof (await image('1', 11)), 'object');
        assert.deepEqual((await client.query('SELECT term_id FROM pg_temp.custom_master_synching_terminal')).rows, [
          { term_id: 11 },
        ]);
      } finally {
        if (platform === undefined) delete process.env.CONMAS_PLATFORM;
        else process.env.CONMAS_PLATFORM = platform;
      }
    }),
);

test(
  'empty non-null Excel binaries stop legacy fallback and retain filename=empty',
  { skip: !process.env.DATABASE_URL },
  async () =>
    fixture(async (db, client) => {
      await client.query('UPDATE pg_temp.def_top SET def_file=$1', [Buffer.alloc(0)]);
      assert.deepEqual(await getClientExcel(db, '1', ''), { data: Buffer.alloc(0), filename: 'empty' });
      assert.deepEqual(await getClientExcel(db, '', '2'), { data: Buffer.alloc(0), filename: 'empty' });
      await client.query('UPDATE pg_temp.def_top SET def_file=NULL');
      await client.query('UPDATE pg_temp.rep_top SET def_file=$1', [Buffer.alloc(0)]);
      assert.deepEqual(await getClientExcel(db, '', '2'), { data: Buffer.alloc(0), filename: 'empty' });
    }),
);

test(
  'PDF downloads preserve report/definition/backup precedence, null versus empty and explicit top fallback',
  { skip: !process.env.DATABASE_URL },
  async () =>
    fixture(async (db, client) => {
      const bytes = async (topId: string, repTopId = '') =>
        (await getClientBackgroundPdf(db, topId, repTopId)).toString();
      assert.equal(await bytes('1'), 'definition-pdf');
      assert.equal(await bytes('1', '2'), 'report-pdf');
      await client.query('UPDATE pg_temp.rep_top SET background_image_file=$1', [Buffer.alloc(0)]);
      assert.equal(await bytes('', '2'), 'definition-pdf');
      await client.query('UPDATE pg_temp.def_top SET background_image_file=NULL');
      assert.equal(await bytes('', '2'), 'backup-pdf');
      await client.query('UPDATE pg_temp.def_top_backup SET background_image_file=NULL');
      assert.equal(await bytes('', '2'), '');
      await client.query('UPDATE pg_temp.rep_top SET background_image_file=NULL');
      await assert.rejects(getClientBackgroundPdf(db, '', '2'), /Missing PDF binary/);
      // Definition-only PDF does not read backups; missing report may use an explicit unrelated definition.
      await assert.rejects(getClientBackgroundPdf(db, '1', ''), /Missing PDF binary/);
      await client.query("UPDATE pg_temp.def_top SET background_image_file='definition-pdf'");
      assert.equal(await bytes('1', '99'), 'definition-pdf');
      await assert.rejects(getClientBackgroundPdf(db, 'invalid', '2'), /Invalid binary request integer/);
      await assert.rejects(getClientBackgroundPdf(db, '', ''), /Missing PDF binary/);
    }),
);

test(
  'sheet backgrounds use definition ID and sheet number, preserving raw binary/empty and rejecting missing/null',
  { skip: !process.env.DATABASE_URL },
  async () =>
    fixture(async (db, client) => {
      assert.equal((await getClientSheetBackground(db, '1', '0')).toString(), 'sheet-png');
      await assert.rejects(getClientSheetBackground(db, '1', '1'), /Missing sheet binary/);
      await assert.rejects(getClientSheetBackground(db, '2', '0'), /Missing sheet binary/);
      await client.query('UPDATE pg_temp.def_sheet SET background_image_file=$1', [Buffer.alloc(0)]);
      assert.equal((await getClientSheetBackground(db, '1', '0')).length, 0);
      await client.query('UPDATE pg_temp.def_sheet SET background_image_file=NULL');
      await assert.rejects(getClientSheetBackground(db, '1', '0'), /Missing sheet binary/);
    }),
);
