import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { XMLParser } from 'fast-xml-parser';
import { getClientDownloadReportList } from '../../../src/models/client-schedule.js';

const enabled = { skip: !process.env.DATABASE_URL },
  parser = new XMLParser({ parseTagValue: false });
async function fixture(run: (db: pg.Pool) => Promise<void>) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }),
    connection = await pool.connect();
  try {
    for (const table of [
      'mst_common',
      'rep_top',
      'rep_schedule',
      'rep_schedule_user',
      'rep_role',
      'mst_group_affiation',
    ])
      await connection.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    await connection.query(`INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value,com_index) VALUES (1,'SCHEDULE_SETTING','AUTO_DOWNLOAD','1',1);
      INSERT INTO pg_temp.mst_group_affiation (user_id,group_id) VALUES ('reader',1),('updater',2)`);
    await run({ query: connection.query.bind(connection) } as unknown as pg.Pool);
  } finally {
    connection.release(true);
    await pool.end();
  }
}
const now = new Date(2026, 10, 7, 12, 34, 59, 999);
function ids(xml: string): string[] {
  const reports = parser.parse(xml).conmas.reports.report;
  return reports ? (Array.isArray(reports) ? reports : [reports]).map((report) => report.repTopId) : [];
}
async function setting(db: pg.Pool, name: string, text: string) {
  await db.query('DELETE FROM pg_temp.mst_common WHERE com_name=$1', [name]);
  await db.query(
    "INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES ((SELECT COALESCE(MAX(com_id),0)+1 FROM pg_temp.mst_common),'SCHEDULE_SETTING',$1,$2)",
    [name, text],
  );
}

test(
  'scheduled download enablement is exact, settings select first com_index regardless of locale, and malformed numeric ranges default to zero',
  enabled,
  async () =>
    fixture(async (db) => {
      for (const text of ['0', 'true', ' 1', '01', '', '2']) {
        await setting(db, 'AUTO_DOWNLOAD', text);
        assert.match(
          await getClientDownloadReportList(db, 'reader', now),
          /Auto-Download has been disabled in Common-Master/,
        );
      }
      await db.query('DELETE FROM pg_temp.mst_common');
      assert.match(await getClientDownloadReportList(db, 'conmasadmin', now), /<code>-1<\/code>/);
      await db.query(`INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value,com_index,com_locale) VALUES
    (1,'SCHEDULE_SETTING','AUTO_DOWNLOAD','1',1,'ja-JP'),(2,'SCHEDULE_SETTING','AUTO_DOWNLOAD','0',2,'en-US');
    INSERT INTO pg_temp.rep_top (rep_top_id,public_status,edit_refer_status,deleted,xml_data) VALUES (1,2,0,0,'<conmas><top/></conmas>');
    INSERT INTO pg_temp.rep_schedule (schedule_id,rep_top_id,auto_download,start_date,start_time,end_date,end_time) VALUES (1,1,1,'2026-11-07','12:34','2026-11-07','12:34');
    INSERT INTO pg_temp.rep_schedule_user (schedule_id,user_id) VALUES (1,'reader');
    INSERT INTO pg_temp.rep_role (rep_top_id,group_id,role_rep_read) VALUES (1,1,1)`);
      for (const name of [
        'AUTO_DOWNLOAD_RANGE_PAST_HOUR',
        'AUTO_DOWNLOAD_RANGE_PAST_MINUTE',
        'AUTO_DOWNLOAD_RANGE_FUTURE_HOUR',
        'AUTO_DOWNLOAD_RANGE_FUTURE_MINUTE',
      ]) {
        for (const text of ['bad', '-1', '2147483648', '1.5', '']) {
          await setting(db, name, text);
          assert.deepEqual(ids(await getClientDownloadReportList(db, 'reader', now)), ['1']);
        }
      }
    }),
);

test(
  'scheduled downloads filter assigned users/read-or-update roles, public/edit/deleted/auto state and XML lock/mobile flags without current/admin bypass',
  enabled,
  async () =>
    fixture(async (db) => {
      await setting(db, 'AUTO_DOWNLOAD_RANGE_TYPE', 'All');
      const xml = [
        '<conmas><top/></conmas>',
        '<conmas><top><lockMode>0</lockMode><mobileReportSave>1</mobileReportSave></top></conmas>',
        '<conmas><top><lockMode>1</lockMode></top></conmas>',
        '<conmas><top><lockMode> 0 </lockMode></top></conmas>',
        '<conmas><top><mobileReportSave>0</mobileReportSave></top></conmas>',
        '<conmas><top><mobileReportSave/></top></conmas>',
        '<conmas/>',
      ];
      for (let id = 1; id <= 16; id++) {
        await db.query(
          'INSERT INTO pg_temp.rep_top (rep_top_id,public_status,edit_refer_status,deleted,xml_data) VALUES ($1,$2,$3,$4,$5)',
          [id, id === 8 ? 1 : 2, id === 9 ? 2 : id === 2 ? 1 : 0, id === 10 ? 1 : 0, xml[(id - 1) % 7]],
        );
        await db.query(
          "INSERT INTO pg_temp.rep_schedule (schedule_id,rep_top_id,auto_download,start_date,start_time) VALUES ($1,$1,$2,'2026-11-07','12:00')",
          [id, id === 11 ? 0 : 1],
        );
        await db.query('INSERT INTO pg_temp.rep_schedule_user (schedule_id,user_id) VALUES ($1,$2)', [
          id,
          id === 12 ? 'other' : 'reader',
        ]);
        if (id !== 13)
          await db.query(
            'INSERT INTO pg_temp.rep_role (rep_top_id,group_id,role_rep_read,role_rep_update) VALUES ($1,$2,$3,$4)',
            [id, id === 14 ? 3 : id === 16 ? 2 : 1, id === 16 ? 0 : 1, id === 16 ? 1 : 0],
          );
      }
      await db.query(
        "INSERT INTO pg_temp.rep_schedule (schedule_id,rep_top_id,auto_download,start_date,start_time) VALUES (100,2,1,'2026-11-06','12:00'); INSERT INTO pg_temp.rep_schedule_user (schedule_id,user_id) VALUES (100,'reader')",
      );
      assert.deepEqual(ids(await getClientDownloadReportList(db, 'reader', now)), ['2', '1', '15']);
      assert.deepEqual(ids(await getClientDownloadReportList(db, 'updater', now)), []);
      await db.query(
        "INSERT INTO pg_temp.rep_schedule_user (schedule_id,user_id) VALUES (16,'updater'),(16,'conmasadmin')",
      );
      assert.deepEqual(ids(await getClientDownloadReportList(db, 'updater', now)), ['16']);
      assert.deepEqual(ids(await getClientDownloadReportList(db, 'conmasadmin', now)), []);
    }),
);

test(
  'scheduled download windows use inclusive interval overlap, midnight/23:59 open-ended defaults and source numeric/named All versus Limited',
  enabled,
  async () =>
    fixture(async (db) => {
      const bounds = [
        [null, null, null, null],
        ['2026-11-07', null, '2026-11-07', null],
        ['2026-11-07', '13:39', '2026-11-07', '13:39'],
        ['2026-11-07', '13:40', null, null],
        ['2026-11-06', null, '2026-11-07', '10:31'],
        ['2026-11-06', null, '2026-11-07', '10:30'],
        ['2026-01-01', '00:00', '2027-01-01', '23:59'],
        ['2026-11-08', null, '2026-11-08', null],
        ['2026-11-06', null, '2026-11-06', null],
        ['2026-11-07', '12:34', '2026-11-07', '12:34'],
      ];
      for (let index = 0; index < bounds.length; index++) {
        const id = index + 1;
        await db.query(
          "INSERT INTO pg_temp.rep_top (rep_top_id,public_status,edit_refer_status,deleted,xml_data) VALUES ($1,2,0,0,'<conmas><top/></conmas>')",
          [id],
        );
        await db.query(
          'INSERT INTO pg_temp.rep_schedule (schedule_id,rep_top_id,auto_download,start_date,start_time,end_date,end_time) VALUES ($1,$1,1,$2,$3,$4,$5)',
          [id, ...bounds[index]!],
        );
        await db.query("INSERT INTO pg_temp.rep_schedule_user (schedule_id,user_id) VALUES ($1,'reader')", [id]);
        await db.query('INSERT INTO pg_temp.rep_role (rep_top_id,group_id,role_rep_read) VALUES ($1,1,1)', [id]);
      }
      for (const [name, text] of [
        ['PAST_HOUR', '2'],
        ['PAST_MINUTE', '3'],
        ['FUTURE_HOUR', '1'],
        ['FUTURE_MINUTE', '5'],
      ])
        await setting(db, 'AUTO_DOWNLOAD_RANGE_' + name, text!);
      for (const type of ['Limited', '1', 'invalid', 'all', '2', 'All,Limited', '']) {
        await setting(db, 'AUTO_DOWNLOAD_RANGE_TYPE', type);
        assert.deepEqual(ids(await getClientDownloadReportList(db, 'reader', now)), ['7', '5', '10', '3', '2', '1']);
      }
      for (const type of ['All', '0', ' +0 ', 'All, All']) {
        await setting(db, 'AUTO_DOWNLOAD_RANGE_TYPE', type);
        assert.deepEqual(ids(await getClientDownloadReportList(db, 'reader', now)), [
          '7',
          '5',
          '6',
          '9',
          '10',
          '3',
          '4',
          '2',
          '8',
          '1',
        ]);
      }
      await setting(db, 'AUTO_DOWNLOAD_RANGE_TYPE', 'Limited');
      await setting(db, 'AUTO_DOWNLOAD_RANGE_FUTURE_HOUR', '2147483647');
      await assert.rejects(getClientDownloadReportList(db, 'reader', now), /DateTime bounds/);
      await setting(db, 'AUTO_DOWNLOAD_RANGE_TYPE', 'All');
      assert.equal(ids(await getClientDownloadReportList(db, 'reader', now)).length, 10);
    }),
);

test(
  'scheduled downloads reject selected corrupt/null XML rather than returning partial success but ignore XML in filtered-out rows',
  enabled,
  async () =>
    fixture(async (db) => {
      await setting(db, 'AUTO_DOWNLOAD_RANGE_TYPE', 'All');
      await db.query(`INSERT INTO pg_temp.rep_top (rep_top_id,public_status,edit_refer_status,deleted,xml_data) VALUES (1,2,0,0,'<conmas><top/></conmas>'),(2,2,0,0,'broken');
    INSERT INTO pg_temp.rep_schedule (schedule_id,rep_top_id,auto_download) VALUES (1,1,1),(2,2,0);
    INSERT INTO pg_temp.rep_schedule_user (schedule_id,user_id) VALUES (1,'reader'),(2,'reader');
    INSERT INTO pg_temp.rep_role (rep_top_id,group_id,role_rep_read) VALUES (1,1,1),(2,1,1)`);
      assert.deepEqual(ids(await getClientDownloadReportList(db, 'reader', now)), ['1']);
      await db.query('UPDATE pg_temp.rep_schedule SET auto_download=1');
      await assert.rejects(getClientDownloadReportList(db, 'reader', now), /Invalid definition XML/);
      await db.query('UPDATE pg_temp.rep_top SET xml_data=NULL WHERE rep_top_id=2');
      await assert.rejects(getClientDownloadReportList(db, 'reader', now), /Invalid definition XML/);
      await db.query("UPDATE pg_temp.rep_top SET xml_data='<!DOCTYPE x><conmas/>' WHERE rep_top_id=2");
      await assert.rejects(getClientDownloadReportList(db, 'reader', now), /Invalid definition XML/);
    }),
);
