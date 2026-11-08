import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { XMLParser } from 'fast-xml-parser';
import { getClientCalendar, getClientUsers, identifyClientApprover } from '../../../src/models/client-catalog.js';
import { legacyPassword } from '../../../src/shared/legacy-auth.js';

const enabled = { skip: !process.env.DATABASE_URL };
const parser = new XMLParser({ parseTagValue: false });
async function fixture(run: (db: pg.Pool) => Promise<void>) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    for (const name of [
      'mst_user',
      'mst_common',
      'rep_schedule',
      'rep_schedule_user',
      'rep_top',
      'rep_current',
      'rep_role',
      'mst_task',
      'mst_holiday',
      'mst_group',
      'mst_group_affiation',
    ])
      await client.query(`CREATE TEMP TABLE ${name} (LIKE public.${name} INCLUDING ALL)`);
    await run({ query: client.query.bind(client) } as unknown as pg.Pool);
  } finally {
    client.release();
    await pool.end();
  }
}

test(
  'IdentifyApprover uses the session user, exact plaintext/encrypted code and source errors without exposing code data',
  enabled,
  async () =>
    fixture(async (db) => {
      await db.query(
        "INSERT INTO pg_temp.mst_user (user_id,identification_code) VALUES ('fixture',' 1234 '),('other','1234'),('unset',NULL)",
      );
      const code = async (id: string, input: string) =>
        parser.parse(await identifyClientApprover(db, id, input)).conmas.error.code;
      assert.equal(await code('fixture', ' 1234 '), '0');
      for (const [id, input] of [
        ['fixture', '1234'],
        ['fixture', ''],
        ['unset', '1234'],
        ['missing', '1234'],
        ["' OR 1=1--", '1234'],
      ])
        assert.equal(await code(id, input), '2');
      if (!process.env.CONMAS_LEGACY_KEY) throw new Error('Encryption fixture key is unavailable.');
      await db.query('UPDATE pg_temp.mst_user SET identification_code=$1 WHERE user_id=$2', [
        legacyPassword('fixture', 'secret-code', process.env.CONMAS_LEGACY_KEY),
        'fixture',
      ]);
      await db.query(
        "INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (1,'PASSWORD_ENCRYPTION','PASSWORD_ENCRYPTION','1')",
      );
      assert.equal(await code('fixture', 'secret-code'), '0');
      assert.equal(await code('fixture', 'wrong'), '2');
      await db.query("UPDATE pg_temp.mst_user SET identification_code='broken' WHERE user_id='fixture'");
      await assert.rejects(identifyClientApprover(db, 'fixture', 'secret-code'));
    }),
);

test(
  'GetCalendarList preserves report permissions/current/deletion, task overrides, endpoint overlap and holiday boundaries',
  enabled,
  async () =>
    fixture(async (db) => {
      await db.query(`INSERT INTO pg_temp.mst_group (group_id,deleted) VALUES (1,0),(2,1);
    INSERT INTO pg_temp.mst_group_affiation (group_id,user_id) VALUES (1,'fixture'),(2,'fixture'),(1,'other');
    INSERT INTO pg_temp.rep_top (rep_top_id,rep_top_name,public_status,deleted,report_type,edit_refer_status,sys_regist_time,sys_update_time,top_remarks1,mobile_save) VALUES
      (1,'Visible & current',1,0,2,0,'2026-02-01','2026-02-02','remark',0),(2,'Deleted',1,1,2,0,now(),now(),'',0),
      (3,'No role',1,0,2,0,now(),now(),'',0),(4,'Historic',1,0,2,0,now(),now(),'',0),
      (5,'Wrong user',1,0,2,0,now(),now(),'',0),(6,'Deleted group',1,0,2,0,now(),now(),'',0),(7,'Published',2,0,2,0,now(),now(),'',0);
    INSERT INTO pg_temp.rep_current (rep_top_id,rep_top_org) VALUES (1,1),(2,2),(3,3),(5,5),(6,6),(7,7);
    INSERT INTO pg_temp.rep_role (rep_top_id,group_id,role_rep_read) VALUES (1,1,1),(2,1,1),(4,1,1),(5,1,1),(6,2,1),(7,1,1);
    INSERT INTO pg_temp.mst_task (task_id,task_name,task_remark,display_number) VALUES (10,'Master task','Master remark',1);
    INSERT INTO pg_temp.rep_schedule (schedule_id,rep_top_id,task_id,task_name,task_remark,start_date,end_date,start_time,end_time,order_comment,work_comment,finish_status) VALUES
      (1,1,10,'Original','Original remark','2026-02-01','2026-02-03','09:30','10:45','Order & comment','Work',0),
      (2,2,NULL,'Deleted','', '2026-02-03',NULL,NULL,NULL,'','',0),(3,3,NULL,'No role','','2026-02-03',NULL,NULL,NULL,'','',0),
      (4,4,NULL,'Historic','','2026-02-03',NULL,NULL,NULL,'','',0),(5,5,NULL,'Wrong user','','2026-02-03',NULL,NULL,NULL,'','',0),
      (6,6,NULL,'Deleted group','','2026-02-03',NULL,NULL,NULL,'','',0),(7,7,NULL,'Published','','2026-02-28',NULL,NULL,NULL,'','',0),
      (8,1,NULL,'Spanning month','','2026-01-01','2026-03-01',NULL,NULL,'','',0),
      (9,1,NULL,'Ends in month','','2026-01-01','2026-02-15',NULL,NULL,'','',0),
      (10,1,NULL,'Last second','','2026-02-28 23:59:59',NULL,NULL,NULL,'','',0),
      (11,1,NULL,'Next month','','2026-03-01',NULL,NULL,NULL,'','',0);
    INSERT INTO pg_temp.rep_schedule_user (schedule_id,user_id) VALUES (1,'fixture'),(2,'fixture'),(3,'fixture'),(4,'fixture'),(5,'other'),(6,'fixture'),(7,'fixture'),(8,'fixture'),(9,'fixture'),(10,'fixture'),(11,'fixture');
    INSERT INTO pg_temp.mst_holiday (holiday_id,holiday_name,holiday_from,holiday_to) VALUES
      (1,'Holiday & name','2026-02-01',NULL),(2,'Ends in month','2026-01-01','2026-02-10'),(3,'Spans month','2026-01-01','2026-03-01'),(4,'Next month','2026-03-01',NULL);`);
      const all = parser.parse(await getClientCalendar(db, 'fixture', '2026', '2', '-1')).conmas;
      assert.equal(all.tasks.task.length, 4);
      const first = all.tasks.task.find((task: Record<string, string>) => task.taskName === 'Master task');
      assert.equal(first.taskRemark, 'Master remark');
      assert.equal(first.orderComment, 'Order & comment');
      assert.equal(first.startDate, '2026/02/01 09:30:00');
      assert.equal(first.finishDate, '2026/02/03 10:45:00');
      assert.equal(first.registTime, '2026/02/01 00:00:00');
      assert.equal(first.mobileReportSave, '1');
      assert.equal(first.dispRemarks, 'remark,2026/02/02 00:00:00');
      assert.deepEqual(
        all.holidays.holiday.map((row: Record<string, string>) => row.holidayName),
        ['Ends in month', 'Holiday & name'],
      );
      assert.equal(
        parser.parse(await getClientCalendar(db, 'fixture', '2026', '2', '2')).conmas.tasks.task.taskName,
        'Published',
      );
      assert.equal(
        parser.parse(await getClientCalendar(db, 'other', '2026', '2', '-1')).conmas.tasks.task.taskName,
        'Wrong user',
      );
      assert.equal(parser.parse(await getClientCalendar(db, 'none', '2026', '2', '-1')).conmas.tasks, '');
      for (const args of [
        ['', '2', '1'],
        ['2026', '1.5', '1'],
        ['2147483648', '2', '1'],
        ['2026', '2', '1 OR 1=1'],
      ])
        assert.equal(
          parser.parse(await getClientCalendar(db, 'fixture', ...(args as [string, string, string]))).conmas.error.code,
          '2',
        );
      await assert.rejects(getClientCalendar(db, 'fixture', '2026', '0', '-1'), /Invalid calendar month/);
      await assert.rejects(getClientCalendar(db, 'fixture', '-1', '-1', '-1'), /Invalid calendar month/);
    }),
);

test(
  'GetCalendarList leap-year last-day and midnight/open-ended formatting use the installed SQL contract',
  enabled,
  async () =>
    fixture(async (db) => {
      await db.query(`INSERT INTO pg_temp.mst_group (group_id,deleted) VALUES (1,0);
    INSERT INTO pg_temp.mst_group_affiation (group_id,user_id) VALUES (1,'fixture');
    INSERT INTO pg_temp.rep_top (rep_top_id,public_status,deleted) VALUES (1,1,0);
    INSERT INTO pg_temp.rep_current (rep_top_id,rep_top_org) VALUES (1,1);
    INSERT INTO pg_temp.rep_role (rep_top_id,group_id,role_rep_read) VALUES (1,1,1);
    INSERT INTO pg_temp.rep_schedule (schedule_id,rep_top_id,start_date,task_name) VALUES (1,1,'2028-02-29','Leap day');
    INSERT INTO pg_temp.rep_schedule_user (schedule_id,user_id) VALUES (1,'fixture');`);
      const result = parser.parse(await getClientCalendar(db, 'fixture', '2028', '2', '1')).conmas.tasks.task;
      assert.equal(result.taskName, 'Leap day');
      assert.equal(result.startDate, '2028/02/29 00:00:00');
      assert.equal(result.finishDate, '');
    }),
);

test(
  'GetUser reuses source XML/CSV, optional signature/admin filters and encoding fallback without exposing passwords',
  enabled,
  async () =>
    fixture(async (db) => {
      await db.query(`INSERT INTO pg_temp.mst_user (user_id,user_name,password,approval_sign,e_mail,use_start_time,sys_regist_time,sys_update_time) VALUES
    ('fixture','名前 "<&','never-export','SIGN','mail@example.invalid',NULL,'2026-11-01','2026-11-02'),('conmasadmin','Private fixture admin','never-export',NULL,NULL,NULL,now(),now());
    INSERT INTO pg_temp.mst_common (com_id,com_key,com_locale,com_value) VALUES (1,'ENCODING','en-US','65001'),(2,'ENCODING','ja-JP','932');`);
      const options = { type: 'xml', withAdmin: '', withImprint: '', userId: '', encoding: '', cultureName: 'en-US' };
      const xml = (await getClientUsers(db, options)).data as string;
      assert.doesNotMatch(xml, /<password[\s/>]/);
      assert(!xml.includes('never-export'));
      const users = parser.parse(xml).conmas.user;
      assert.equal(users.length, 2);
      assert.equal(users[0].userName, '名前 "<&');
      assert.equal(users[0].approvalSign, 'SIGN');
      assert(!Object.hasOwn(users[0], 'useStartTime'));
      assert.equal(users[0].passwordChangeTime, '');
      const filtered = parser.parse(
        (await getClientUsers(db, { ...options, withAdmin: ' False ', withImprint: 'FALSE' })).data as string,
      ).conmas.user;
      assert.equal(filtered.userId, 'fixture');
      assert(!Object.hasOwn(filtered, 'approvalSign'));
      assert.equal(
        parser.parse((await getClientUsers(db, { ...options, userId: "' OR 1=1--" })).data as string).conmas,
        '',
      );
      for (const type of ['', 'XML', 'csvZip'])
        assert.equal(
          parser.parse((await getClientUsers(db, { ...options, type })).data as string).conmas.error.code,
          '2',
        );
      const csv = await getClientUsers(db, { ...options, type: 'csv', userId: 'fixture', withImprint: 'false' });
      assert.equal(csv.encoding, 'utf-8');
      assert(Buffer.isBuffer(csv.data));
      assert(csv.data.toString().startsWith('"fixture","名前 ""<&"'));
      assert(csv.data.toString().endsWith('\r\n'));
      assert(!csv.data.toString().includes('SIGN'));
      const japanese = await getClientUsers(db, { ...options, type: 'csv', userId: 'fixture', encoding: '932' });
      assert.equal(japanese.encoding, 'shift_jis');
      assert(Buffer.isBuffer(japanese.data));
      assert(japanese.data.includes(Buffer.from([0x96, 0xbc, 0x91, 0x4f])));
      for (const encoding of ['invalid', 'utf-8', '2147483648', '-1'])
        assert.equal(
          (await getClientUsers(db, { ...options, type: 'csv', encoding, cultureName: 'ja-JP' })).encoding,
          'shift_jis',
        );
      assert.equal((await getClientUsers(db, { ...options, type: 'csv', encoding: '1200' })).encoding, 'utf-16le');
      await assert.rejects(
        getClientUsers(db, { ...options, type: 'csv', cultureName: 'missing' }),
        /Invalid client CSV encoding setting/,
      );
    }),
);
