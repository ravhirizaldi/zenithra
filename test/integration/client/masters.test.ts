import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import express from 'express';
import session from 'express-session';
import { XMLParser } from 'fast-xml-parser';
import {
  getClientMasterList,
  getClientCustomMasterLabels,
  getClientMasterRecords,
} from '../../../src/models/client-masters.js';
import { registerClientRoutes } from '../../../src/routes/client.js';
import { registerApiRoutes } from '../../../src/routes/api.js';
import { clientSession } from '../../../src/middleware/client-session.js';
import { apiSession } from '../../../src/middleware/api-session.js';

const enabled = { skip: !process.env.DATABASE_URL },
  parser = new XMLParser({ parseTagValue: false }),
  now = new Date(2026, 10, 8, 12);
async function fixture(run: (db: pg.Pool) => Promise<void>) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }),
    client = await pool.connect();
  try {
    for (const table of [
      'mst_user',
      'mst_group_affiation',
      'mst_common',
      'mst_terminal',
      'mst_custom_table',
      'mst_custom_table_role',
      'custom_table_delete',
      'mst_custom_column',
      'mst_custom_record',
      'custom_record_delete',
      'custom_master_synching_terminal',
      'log_custom_table_download',
      'mst_custom_default_record',
      'mst_custom_default_record_role',
      'common_custom_table_label',
      'report_custom_table_label',
      'mst_label_common_custom_table',
      'common_custom_table_label_role',
      'def_report_custom_table',
      'rep_report_custom_table',
    ])
      await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    await client.query(`CREATE TEMP SEQUENCE fixture_master_download_id;
      ALTER TABLE pg_temp.log_custom_table_download ALTER COLUMN log_id SET DEFAULT nextval('pg_temp.fixture_master_download_id');
      ALTER TABLE pg_temp.log_custom_table_download ALTER COLUMN master_id DROP DEFAULT`);
    await client.query(`INSERT INTO pg_temp.mst_user (user_id,user_name) VALUES ('reader','Master reader'),('writer','Writer');
      INSERT INTO pg_temp.mst_group_affiation (user_id,group_id) VALUES ('reader',1),('writer',2);
      INSERT INTO pg_temp.mst_terminal (term_id,term_type,physical_id,approver,deleted) VALUES (10,'iPad','fixture-device','approved',0);
      INSERT INTO pg_temp.mst_custom_table (master_id,master_key,master_name,master_type,expire,display_number,mobile_save,download_type,life_time,sys_regist_time,sys_update_time,sys_regist_user,sys_update_user,record_version) VALUES
      (1,'one','Common <&',0,NULL,2,1,1,60,'2026-11-01 09:00:00','2026-11-08 10:00:00','reader','writer','v1'),
      (2,'two','Report',1,'2026-11-08',1,1,1,30,'2026-11-01','2026-11-07','reader','writer','v2'),
      (3,'three','Expired',0,'2026-11-07 23:59:59',3,0,0,NULL,'2026-11-01','2026-11-08','reader','reader','v3'),
      (4,'four','Deleted',0,NULL,4,0,0,NULL,'2026-11-01','2026-11-08','reader','reader','v4'),
      (5,'five','Private',0,NULL,5,0,0,NULL,'2026-11-01','2026-11-08','reader','reader','v5');
      INSERT INTO pg_temp.custom_table_delete (master_id,sys_update_time) VALUES (4,'2026-11-08'),(99,'2026-11-07');
      INSERT INTO pg_temp.mst_custom_table_role (master_id,group_id) VALUES (2,1),(5,2);
      INSERT INTO pg_temp.common_custom_table_label (master_id,mst_label_id) VALUES (1,10),(1,11);
      INSERT INTO pg_temp.report_custom_table_label (master_id,mst_label_id) VALUES (2,20);
      INSERT INTO pg_temp.def_report_custom_table (def_top_id,master_id) VALUES (30,1),(30,2);
      INSERT INTO pg_temp.rep_report_custom_table (rep_top_id,master_id) VALUES (40,2);
      INSERT INTO pg_temp.mst_custom_column (master_id,field_no,value,type) VALUES (1,1,'Text <&','text'),(1,2,'Empty','text'),(1,1001,'Picture','image'),(2,1,'Report field','text'),(3,1,'Expired field','text');
      INSERT INTO pg_temp.mst_custom_default_record (record_id,master_id,value,field0001,field0002,field1001,sys_update_time) VALUES
      (100,1,'Default <&',' text value ','   ','image','2026-11-08 10:30:00'),(200,2,'Restricted','report default',NULL,NULL,'2026-11-08'),(300,3,'Expired default','expired',NULL,NULL,'2026-11-08');
      INSERT INTO pg_temp.mst_custom_default_record_role (record_id,group_id) VALUES (200,2);
      INSERT INTO pg_temp.mst_label_common_custom_table (mst_label_id,upper_label_id,label_name,label_icon_id,diplay_number) VALUES (10,NULL,'Common <&',1,2),(11,10,'Child',2,1);
      INSERT INTO pg_temp.common_custom_table_label_role (mst_label_id,group_id) VALUES (11,2),(11,1);
      INSERT INTO pg_temp.mst_custom_record (master_id,record_id,record_key,value,display_number,group_id,group_array,field0001,field1001,sys_update_time,record_version) VALUES
      (1,101,'key_1','Value <&',1,'',NULL,'Text <&','image','2026-11-08 10:00:00','v1'),
      (1,102,'key%2','Second',2,'1;3',ARRAY[1,3],'other',NULL,'2026-11-08 11:00:00','v2'),
      (1,103,'key3','Private',3,'2',ARRAY[2],'other','','2026-11-08 12:00:00','v2'),
      (2,201,'report','Report value',0,NULL,NULL,'report text',NULL,'2026-11-08','v2'),
      (3,301,'expired','Expired value',0,NULL,NULL,'expired text',NULL,'2026-11-08','v2');
      INSERT INTO pg_temp.custom_record_delete (master_id,record_id,sys_update_time,record_version) VALUES (1,401,'2026-11-08','v1'),(1,402,'2026-11-08','v2'),(2,403,'2026-11-07','v1')`);
    await run({
      query: client.query.bind(client),
      connect: async () => ({ query: client.query.bind(client), release() {} }),
    } as unknown as pg.Pool);
  } finally {
    client.release(true);
    await pool.end();
  }
}
type MasterRecord = Record<string, unknown> & {
  fields: { field: { value: string }[] };
  imageFields: { field: { imageName: string } };
};
type Master = Record<string, unknown> & {
  fields: { field: { fieldNo: string }[] };
  imageFields: { field: { fieldNo: string; fieldName: string } };
  defaultRecord: { value: string; fields: { field: { value: string } }; imageFields: { field: { imageName: string } } };
};
const masters = (xml: string): Master[] => {
  const result = parser.parse(xml).conmas.masters.master;
  return result ? (Array.isArray(result) ? result : [result]) : [];
};
const records = (xml: string): MasterRecord[] => {
  const result = parser.parse(xml).conmas.records.record;
  return result ? (Array.isArray(result) ? result : [result]) : [];
};

test(
  'record downloads preserve fields, image references, row roles, source ordering and request quirks without changing masters',
  enabled,
  async () =>
    fixture(async (db) => {
      const list = (params: Record<string, string> = {}, userId = 'reader') =>
        getClientMasterRecords(db, { userId, termType: 'API', termId: 'fixture' }, params, now);
      const before = (await db.query('SELECT * FROM pg_temp.mst_custom_record ORDER BY record_id')).rows;
      const initial = records(await list());
      assert.deepEqual(
        initial.map((r) => r.recordId),
        ['201', '101', '102'],
      );
      assert.equal(initial[1]!.value, 'Value <&');
      assert.equal(initial[1]!.fields.field[0].value, 'Text <&');
      assert.equal(initial[1]!.fields.field[1].value, '');
      assert.equal(initial[1]!.imageFields.field.imageName, 'image_101_1001');
      assert.equal(initial[2]!.group, '1,3');
      assert.equal(initial[2]!.imageFields.field.imageName, 'image_102_1001');
      // CASE WHEN LENGTH(NULL)=0 falls through to 1 in the original image-presence query.
      assert.deepEqual(
        records(await list({ masterId: '1', recordId: '101' })).map((r) => r.recordId),
        ['101', '102'],
      );
      assert.equal(records(await list({ recordKey: 'key3' }, 'conmasadmin'))[0]!.imageFields, '');
      assert.deepEqual(
        records(await list({ repTopId: '999', masterId: '2' })).map((r) => r.recordId),
        ['201'],
      );
      assert.deepEqual(records(await list({ masterId: '1', defTopId: '999' })), []);
      assert.deepEqual(records(await list({ masterId: '3', ignoreExpire: 'true' })), []);
      assert.deepEqual(records(await list({ recordKey: '' })), []);
      assert.deepEqual(
        records(await list({ masterId: '1' }, 'no-groups')).map((r) => r.recordId),
        ['101', '102', '103'],
      );
      assert.deepEqual(
        records(await list({ masterId: '1' }, 'writer')).map((r) => r.recordId),
        ['101', '103'],
      );
      assert.deepEqual(
        records(await list({ masterId: '1' }, 'conmasadmin')).map((r) => r.recordId),
        ['101', '102', '103'],
      );
      assert.deepEqual(records(await list({ masterId: '5' })), []);
      assert.deepEqual(
        records(await list({ masterType: '0', masterId: '1', startNo: '1', max: '1' })).map((r) => r.recordId),
        ['102'],
      );
      assert.deepEqual(
        records(await list({ masterId: '1', startNo: 'bad', max: 'bad' })).map((r) => r.recordId),
        ['101', '102'],
      );
      assert.deepEqual(records(await list({ masterId: '1', max: '0' })), []);
      await assert.rejects(list({ startNo: '-1' }));
      await assert.rejects(list({ max: '-1' }));
      assert.deepEqual((await db.query('SELECT * FROM pg_temp.mst_custom_record ORDER BY record_id')).rows, before);
      assert.equal((await db.query('SELECT count(*) FROM pg_temp.log_custom_table_download')).rows[0].count, '0');
    }),
);

test(
  'record searches escape LIKE metacharacters, parse tab pairs and preserve date/version/key filters and tombstone pagination',
  enabled,
  async () =>
    fixture(async (db) => {
      const list = (params: Record<string, string>) =>
        getClientMasterRecords(db, { userId: 'reader', termType: 'API', termId: 'fixture' }, params, now);
      for (const [search, id] of [
        ['-1\tkey_', '101'],
        ['-1\tkey%', '102'],
        ['0\tＶａｌｕｅ', '101'],
        ['1\tText <&', '101'],
      ])
        assert.deepEqual(
          records(await list({ masterId: '1', fieldSearch: search! })).map((r) => r.recordId),
          [id],
        );
      assert.deepEqual(records(await list({ fieldSearch: "1\t' OR 1=1 --" })), []);
      assert.deepEqual(
        records(await list({ masterId: '1', fieldSearch: '-2\tignore\t-1\tkey_\tbad\tignored\t0\tnever' })).map(
          (r) => r.recordId,
        ),
        ['101'],
      );
      await assert.rejects(list({ fieldSearch: '1\tone\t1\ttwo' }));
      await assert.rejects(list({ fieldSearch: '1001\timage' }));
      assert.deepEqual(
        records(await list({ masterId: '1', recordVersion: 'v1' })).map((r) => r.recordId),
        ['102'],
      );
      assert.deepEqual(
        records(await list({ masterId: '1', lastDownloadTime: '2026/11/08 11:00:00' })).map((r) => r.recordId),
        ['102'],
      );
      assert.deepEqual(
        records(await list({ masterId: '1', recordKey: 'key_1' })).map((r) => r.recordId),
        ['101'],
      );
      assert.deepEqual(
        records(await list({ masterId: '1', isDeleteTran: 'true', max: '1' })).map((r) => r.action),
        ['M'],
      );
      assert.deepEqual(records(await list({ masterId: '1', isDeleteTran: 'true', startNo: '2', max: '1' })), [
        { action: 'D', masterId: '1', recordId: '401' },
      ]);
      assert.deepEqual(records(await list({ masterId: '1', isDeleteTran: 'true', startNo: '3', max: '1' })), [
        { action: 'D', masterId: '1', recordId: '402' },
      ]);
      assert.deepEqual(
        records(await list({ masterId: '1', isDeleteTran: 'true', recordVersion: 'v1', startNo: '1', max: '5' })),
        [{ action: 'D', masterId: '1', recordId: '402' }],
      );
      assert.deepEqual(
        records(
          await list({
            recordKey: 'missing',
            masterType: '1',
            defTopId: '999',
            isDeleteTran: 'true',
            lastDownloadTime: '2026/11/08',
          }),
        ),
        [
          { action: 'D', masterId: '1', recordId: '401' },
          { action: 'D', masterId: '1', recordId: '402' },
        ],
      );
    }),
);

test(
  'server-only masters preserve iPad caps/raw counts and source download-log timing without failing reads on audit errors',
  enabled,
  async () =>
    fixture(async (db) => {
      const actor = { userId: 'reader', termType: 'iPad', termId: '10' },
        list = (params: Record<string, string> = {}) => getClientMasterRecords(db, actor, params, now);
      await db.query(
        "INSERT INTO pg_temp.mst_common (com_key,com_name,com_value) VALUES ('CUSTOM_MASTER','SERVER_MAX_RECORDS','1');UPDATE pg_temp.mst_custom_table SET mobile_save=0 WHERE master_id=1",
      );
      const first = parser.parse(await list({ masterId: '1', max: '50' })).conmas;
      assert.equal(first.recordCount, '3');
      assert.equal(first.records.record.recordId, '101');
      const stop = parser.parse(await list({ masterId: '1', startNo: '1' })).conmas;
      assert.equal(stop.recordCount, '3');
      assert.equal(stop.records, '');
      let logs = (
        await db.query(
          'SELECT master_id,record_download_count,log_user,log_user_name,log_term,log_date FROM pg_temp.log_custom_table_download ORDER BY log_id',
        )
      ).rows;
      assert.equal(logs.length, 1);
      assert.equal(logs[0].record_download_count, 1);
      assert.equal(logs[0].log_user_name, 'Master reader');
      assert.equal(logs[0].log_term, '10');
      assert.equal(logs[0].log_date.getHours(), 0);
      await db.query(
        'DELETE FROM pg_temp.log_custom_table_download;UPDATE pg_temp.mst_custom_table SET mobile_save=1 WHERE master_id=1',
      );
      await list();
      logs = (
        await db.query('SELECT master_id,record_download_count FROM pg_temp.log_custom_table_download ORDER BY log_id')
      ).rows;
      assert.deepEqual(logs, [
        { master_id: 2, record_download_count: 1 },
        { master_id: 1, record_download_count: 1 },
      ]);
      await db.query('ALTER TABLE pg_temp.log_custom_table_download ADD CHECK (record_download_count<0) NOT VALID');
      assert.equal(records(await list({ masterId: '1' })).length, 2);
      await db.query(
        "UPDATE pg_temp.mst_custom_table SET mobile_save=0 WHERE master_id=1;UPDATE pg_temp.mst_common SET com_value='bad' WHERE com_key='CUSTOM_MASTER'",
      );
      await assert.rejects(list({ masterId: '1' }));
    }),
);

test(
  'negative built-in masters download records without requiring report-attachment rows; cloud limits are shared with images',
  enabled,
  async () =>
    fixture(async (db) => {
      await db.query(`INSERT INTO pg_temp.mst_custom_table (master_id,master_key,master_name,master_type,mobile_save) VALUES (-100,'BuiltInCustomMaster001','Built-in',0,1);
    INSERT INTO pg_temp.mst_custom_record (master_id,record_id,record_key) VALUES (-100,900,'built-in');
    INSERT INTO pg_temp.mst_common (com_key,com_name,com_value) VALUES ('CUSTOM_MASTER','SYNC_TERMINAL_LIMIT','1');
    INSERT INTO pg_temp.custom_master_synching_terminal (term_id,sys_update_time) VALUES (99,clock_timestamp())`);
      assert.equal(
        masters(await getClientMasterList(db, 'reader', 'device', { masterId: '-100' }, now))[0]!.key,
        'BuiltInCustomMaster001',
      );
      assert.equal(
        records(
          await getClientMasterRecords(
            db,
            { userId: 'reader', termType: 'API', termId: 'fixture' },
            { masterId: '-100' },
            now,
          ),
        )[0]!.recordId,
        '900',
      );
      const old = process.env.CONMAS_PLATFORM;
      process.env.CONMAS_PLATFORM = 'cloud';
      try {
        assert.equal(
          parser.parse(
            await getClientMasterRecords(
              db,
              { userId: 'reader', termType: 'iPad', termId: '10' },
              { masterId: '1' },
              now,
            ),
          ).conmas.error.code,
          '17009',
        );
        assert.equal(
          records(
            await getClientMasterRecords(
              db,
              { userId: 'reader', termType: 'iPad', termId: '10' },
              { masterId: '-100' },
              now,
            ),
          ).length,
          1,
        );
        assert.equal(
          records(
            await getClientMasterRecords(
              db,
              { userId: 'reader', termType: 'API', termId: '10' },
              { masterId: '1' },
              now,
            ),
          ).length,
          2,
        );
        await db.query('DELETE FROM pg_temp.custom_master_synching_terminal');
        assert.equal(
          records(
            await getClientMasterRecords(
              db,
              { userId: 'reader', termType: 'iPad', termId: '10' },
              { masterId: '1' },
              now,
            ),
          ).length,
          2,
        );
        assert.equal(
          (await db.query('SELECT term_id FROM pg_temp.custom_master_synching_terminal')).rows[0].term_id,
          10,
        );
      } finally {
        if (old === undefined) delete process.env.CONMAS_PLATFORM;
        else process.env.CONMAS_PLATFORM = old;
      }
    }),
);

test(
  'master lists preserve physical-session access, expiry, field metadata, defaults, labels and deletion deltas without writes',
  enabled,
  async () =>
    fixture(async (db) => {
      const list = (params: Record<string, string> = {}, user = 'reader', physical = 'device') =>
        getClientMasterList(db, user, physical, params, now);
      const before = (await db.query('SELECT * FROM pg_temp.mst_custom_table ORDER BY master_id')).rows;
      const initial = masters(await list());
      assert.deepEqual(
        initial.map((row) => row.masterId),
        ['2', '1'],
      );
      const report = initial[0]!,
        common = initial[1]!;
      assert.equal(report.expire, '2026/11/08 23:59:59');
      assert.equal(report.downloadType, '0');
      assert.equal(report.lifeTime, '');
      assert.equal(report.labelId, '20');
      assert.equal(report.group, '1');
      assert(!report.defaultRecord);
      assert.equal(common.masterName, 'Common <&');
      assert.equal(common.keyName, 'Record key');
      assert.equal(common.valueName, 'Record value');
      assert.equal(common.updateUser, 'Writer');
      assert.equal(common.registUser, 'Master reader');
      assert.equal(common.updateTime, '2026/11/08 10:00:00');
      assert.equal(common.fields, '');
      assert.equal(common.imageFields, '');
      assert.equal(common.labelId, '10,11');
      assert.equal(common.defaultRecord.value, 'Default <&');
      assert.equal(common.defaultRecord.fields.field.value, 'text value');
      assert.equal(common.defaultRecord.imageFields.field.imageName, 'image_100_1001');
      const columns = masters(await list({ masterId: '1', isColumn: ' True ' }))[0]!;
      assert.deepEqual(
        columns.fields.field.map((field: Record<string, string>) => field.fieldNo),
        ['1', '2'],
      );
      assert.deepEqual(columns.imageFields.field, { fieldNo: '1001', fieldName: 'Picture' });
      assert.deepEqual(masters(await list({}, 'no-groups')), []);
      assert.deepEqual(masters(await list({}, 'conmasadmin')), []);
      const api = masters(await list({}, 'reader', ''));
      assert.deepEqual(
        api.map((row) => row.masterId),
        ['2', '1', '5'],
      );
      assert(!api[0]!.defaultRecord);
      assert.equal(masters(await list({ masterId: '2' }, 'conmasadmin', ''))[0]!.defaultRecord.value, 'Restricted');
      assert.deepEqual(
        masters(await list({ masterType: '1' })).map((row) => row.masterId),
        ['2'],
      );
      assert.deepEqual(
        masters(await list({ repTopId: '40', defTopId: '30' })).map((row) => row.masterId),
        ['2'],
      );
      assert.deepEqual(masters(await list({ masterKey: "' OR 1=1 --" })), []);
      for (const value of ['invalid', '2147483648', '-1', '0'])
        assert.deepEqual(
          masters(await list({ masterId: value })).map((row) => row.masterId),
          ['2', '1'],
        );
      assert.deepEqual(
        masters(await list({ masterType: 'invalid', defTopId: 'invalid', repTopId: 'invalid' })).map(
          (row) => row.masterId,
        ),
        ['2', '1'],
      );
      const expired = masters(await list({ masterId: '3', ignoreExpire: 'true', isColumn: 'true' }))[0]!;
      assert.equal(expired.masterId, '3');
      assert.equal(expired.fields, '');
      assert.equal(expired.defaultRecord.fields, '');
      assert.deepEqual(
        masters(await list({ ignoreExpire: '1' })).map((row) => row.masterId),
        ['2', '1'],
      );
      assert.deepEqual(
        masters(await list({ lastDownloadTime: '2026/11/08 10:00:00' })).map((row) => row.masterId),
        ['1'],
      );
      assert.deepEqual(
        masters(await list({ lastDownloadTime: '11/8/2026 10:00:00 AM' })).map((row) => row.masterId),
        ['1'],
      );
      assert.deepEqual(
        masters(await list({ lastDownloadTime: '2026/02/30' })).map((row) => row.masterId),
        ['2', '1'],
      );
      const deleted = masters(
        await list({ masterKey: 'does not match', masterType: '1', repTopId: '999', isDeleteTran: 'true' }),
      );
      assert.deepEqual(deleted, [
        { action: 'D', masterId: '4' },
        { action: 'D', masterId: '99' },
      ]);
      assert.deepEqual(masters(await list({ masterId: '4', lastDownloadTime: '2026/11/08', isDeleteTran: 'true' })), [
        { action: 'D', masterId: '4' },
      ]);
      assert.deepEqual((await db.query('SELECT * FROM pg_temp.mst_custom_table ORDER BY master_id')).rows, before);
    }),
);

test(
  'custom master labels return common labels and group lists without inventing filtering or report-label substitution',
  enabled,
  async () =>
    fixture(async (db) => {
      const labels = parser.parse(await getClientCustomMasterLabels(db)).conmas.localLabels.localLabel;
      assert.equal(labels.length, 2);
      assert.equal(labels[0].name, 'Common <&');
      assert.equal(labels[0].upperLabelId, '');
      assert.equal(labels[1].group, '2,1');
      await db.query(
        'DELETE FROM pg_temp.common_custom_table_label_role;DELETE FROM pg_temp.mst_label_common_custom_table',
      );
      assert.equal(parser.parse(await getClientCustomMasterLabels(db)).conmas.localLabels, '');
    }),
);

test(
  'master commands and direct pages retain native terminal checks, independent API identity and XML failures',
  enabled,
  async () =>
    fixture(async (db) => {
      const app = express(),
        nativeStore = new session.MemoryStore(),
        apiStore = new session.MemoryStore();
      app.use(express.urlencoded({ extended: false }));
      app.use('/ConMasWeb/__seed', clientSession(db, nativeStore), (req, res) => {
        req.session.clientAccount = {
          userId: 'reader',
          userName: 'Reader',
          client: 'iPad',
          physicalId: 'fixture-device',
          version: '999.9',
          platform: 'Windows',
          address: 'fixture',
          sessionId: req.sessionID,
        };
        res.send('seeded');
      });
      app.use('/ConMasAPI/__seed', apiSession(db, apiStore), (req, res) => {
        req.session.apiAccount = {
          userId: 'reader',
          userName: 'Reader',
          address: 'fixture',
          sessionId: req.sessionID,
          freeDrawOnly: false,
        };
        res.send('seeded');
      });
      registerClientRoutes(app, db, nativeStore);
      registerApiRoutes(app, db, apiStore);
      const server = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', resolve));
      try {
        const address = server.address();
        assert(address && typeof address !== 'string');
        const origin = `http://127.0.0.1:${address.port}`;
        const cookies: Record<string, string> = {};
        for (const mode of ['ConMasWeb', 'ConMasAPI']) {
          const seed = await fetch(`${origin}/${mode}/__seed`);
          await seed.text();
          cookies[mode] = seed.headers.get('set-cookie')!.split(';')[0]!;
        }
        const call = async (
          mode: string,
          command: string,
          direct: boolean,
          cookie = cookies[mode],
          extra: Record<string, string> = {},
        ) => {
          const response = await fetch(
            `${origin}/${mode}/Rests/${direct ? command.toLowerCase() : mode === 'ConMasAPI' ? 'APIExecute' : 'ConMasIReporter'}.aspx`,
            { method: 'POST', headers: { cookie: cookie ?? '' }, body: new URLSearchParams({ command, ...extra }) },
          );
          assert.match(response.headers.get('content-type')!, /^text\/xml/);
          return { response, text: await response.text() };
        };
        for (const mode of ['ConMasWeb', 'ConMasAPI'])
          for (const direct of [false, true]) {
            const result = await call(mode, 'GetMasterList', direct);
            assert.equal(result.response.status, 200);
            assert.deepEqual(
              masters(result.text).map((row) => row.masterId),
              mode === 'ConMasWeb' ? ['2', '1'] : ['2', '1', '5'],
            );
            assert.equal(
              parser.parse((await call(mode, 'GetCustomMasterLabel', direct, undefined, { masterType: '1' })).text)
                .conmas.localLabels.localLabel.length,
              2,
            );
            assert.equal(parser.parse((await call(mode, 'GetMasterList', direct, '')).text).conmas.error.code, '5');
            const downloaded = await call(mode, 'GetMasterRecordList', direct, undefined, {
              masterId: '1',
              masterType: '0',
            });
            assert.equal(downloaded.response.status, 200);
            assert.deepEqual(
              records(downloaded.text).map((row) => row.recordId),
              ['101', '102'],
            );
            assert.equal(records(downloaded.text)[0]!.imageFields.field.imageName, 'image_101_1001');
            assert.equal(
              parser.parse((await call(mode, 'GetMasterRecordList', direct, '')).text).conmas.error.code,
              '5',
            );
            const invalid = await call(mode, 'GetMasterRecordList', direct, undefined, {
              fieldSearch: '1\tone\t1\ttwo',
            });
            assert.equal(invalid.response.status, 200);
            assert.equal(parser.parse(invalid.text).conmas.error.code, '-1');
            const image = await fetch(
              `${origin}/${mode}/Rests/${direct ? 'getmasterimage' : 'ConMasWeb' === mode ? 'ConMasIReporter' : 'APIExecute'}.aspx`,
              {
                method: 'POST',
                headers: { cookie: cookies[mode]! },
                body: new URLSearchParams({ command: 'GetMasterImage', recordId: '101', fieldNo: '1001' }),
              },
            );
            assert.equal(image.status, 200);
            assert.equal(image.headers.get('content-type'), 'image');
            assert.match(image.headers.get('content-disposition')!, /image_101_1001/);
            assert.equal(Buffer.from(await image.arrayBuffer()).toString(), 'image');
            assert.equal(
              parser.parse(
                (await call(mode, 'GetMasterImage', direct, undefined, { recordId: 'bad', fieldNo: '1001' })).text,
              ).conmas.error.code,
              '2',
            );
          }
        assert.equal(
          parser.parse((await call('ConMasAPI', 'GetMasterList', false, cookies.ConMasWeb)).text).conmas.error.code,
          '5',
        );
        assert.equal(
          parser.parse((await call('ConMasWeb', 'GetMasterList', false, cookies.ConMasAPI)).text).conmas.error.code,
          '5',
        );
        for (const direct of [false, true]) {
          assert.equal(
            parser.parse((await call('ConMasWeb', 'GetDocumentInfo', direct, '')).text).conmas.error.code,
            '5',
          );
          assert.equal(
            parser.parse((await call('ConMasWeb', 'GetDocumentInfo', direct)).text).conmas.error.remarks.remark,
            "'documentId' is required.",
          );
          assert.equal(
            parser.parse((await call('ConMasWeb', 'GetDocumentInfo', direct, undefined, { documentId: '1' })).text)
              .conmas.error.remarks.remark,
            "'iconType' is required.",
          );
        }
        assert.equal((await db.query('SELECT count(*) FROM pg_temp.log_custom_table_download')).rows[0].count, '2');
        await db.query('UPDATE pg_temp.mst_terminal SET approver=NULL');
        for (const command of [
          'GetMasterList',
          'GetCustomMasterLabel',
          'GetMasterRecordList',
          'GetMasterImage',
          'GetDocumentInfo',
        ])
          assert.equal(parser.parse((await call('ConMasWeb', command, false)).text).conmas.error.code, '3');
        assert.equal((await call('ConMasAPI', 'GetMasterList', false)).response.status, 200);
        assert.equal(
          records((await call('ConMasAPI', 'GetMasterRecordList', false, undefined, { masterId: '1' })).text).length,
          2,
        );
        const unresolved = await call('ConMasAPI', 'GetDocumentInfo', false);
        assert.equal(unresolved.response.status, 501);
        assert.equal(parser.parse(unresolved.text).conmas.error.code, '-1');
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }
    }),
);
