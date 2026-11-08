import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { XMLParser } from 'fast-xml-parser';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  getClientLocalReferenceList,
  getClientLocalReference,
  getClientDocumentInfo,
  hasClientFreeDrawLicense,
  unlockClientDocuments,
  editClientLibraryDocument,
} from '../../../src/models/client-library.js';
import { readLicenseFields } from '../../../src/shared/license-counts.js';

const enabled = { skip: !process.env.DATABASE_URL };
const parser = new XMLParser({ parseTagValue: false });
async function fixture(run: (db: pg.Pool) => Promise<void>) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const connection = await pool.connect();
  try {
    const tables = [
      'mst_common',
      'mst_user',
      'mst_terminal',
      'mst_group_affiation',
      'mst_common_document',
      'mst_report_document',
      'mst_image_document',
      'mst_common_document_role',
      'mst_report_document_role',
      'mst_image_document_role',
      'common_document_irfd',
      'common_document_irfd_role',
      'document_lock',
      'log_library_download',
      'mst_label_common_document',
      'mst_label_image_document',
      'common_document_label_role',
      'image_document_label_role',
      'common_document_label',
      'image_document_label',
    ];
    for (const table of tables)
      await connection.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    await connection.query(
      "CREATE TEMP SEQUENCE library_test_log_seq; ALTER TABLE pg_temp.log_library_download ALTER COLUMN log_id SET DEFAULT nextval('pg_temp.library_test_log_seq')",
    );
    assert.equal(
      (
        await connection.query(
          "SELECT pg_get_expr(d.adbin,d.adrelid) AS expression FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum WHERE d.adrelid='pg_temp.log_library_download'::regclass AND a.attname='log_id'",
        )
      ).rows[0].expression,
      "nextval('library_test_log_seq'::regclass)",
    );
    await connection.query(`INSERT INTO pg_temp.mst_user (user_id,user_name,irfd_enable) VALUES ('fixture','Library fixture',1),('other','Other fixture',0);
      INSERT INTO pg_temp.mst_terminal (term_id,term_name) VALUES (10,'Library terminal');
      INSERT INTO pg_temp.mst_group_affiation (user_id,group_id) VALUES ('fixture',1),('other',2);
      INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (1,'LIBRARY','FILE_LOCATION','1')`);
    await run({
      query: connection.query.bind(connection),
      connect: async () => ({ query: connection.query.bind(connection), release() {} }),
    } as unknown as pg.Pool);
  } finally {
    connection.release(true);
    await pool.end();
  }
}

test(
  'document unlocking validates ten-ID limit, handles repeated/missing IDs and preserves independent owner-unfiltered deletes',
  enabled,
  async () =>
    fixture(async (db) => {
      await db.query(
        "INSERT INTO pg_temp.document_lock (document_id,user_id,sys_regist_term) VALUES (1,'other','99'),(2,'other','99'),(3,'fixture','10')",
      );
      assert.match(await unlockClientDocuments(db, ''), /&apos;documentId&apos; is required/);
      assert.match(await unlockClientDocuments(db, '1,,2'), /<code>2<\/code>/);
      assert.match(await unlockClientDocuments(db, '1;DROP'), /<code>2<\/code>/);
      assert.match(await unlockClientDocuments(db, '1,2,3,4,5,6,7,8,9,10,11,bad'), /number of documentId is over 10/);
      assert.equal((await db.query('SELECT * FROM pg_temp.document_lock')).rowCount, 3);
      const result = parser.parse(await unlockClientDocuments(db, ' +1 ,1,99,2')).conmas;
      assert.equal(result.error.code, '0');
      assert.deepEqual(
        result.results.result.map((row: Record<string, string>) => row.documentId),
        ['1', '2'],
      );
      assert.equal((await db.query('SELECT * FROM pg_temp.document_lock')).rowCount, 1);
      await db.query(`CREATE FUNCTION pg_temp.reject_library_lock() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''fixture delete error''; END';
    CREATE TRIGGER reject_library_lock BEFORE DELETE ON pg_temp.document_lock FOR EACH ROW WHEN (OLD.document_id=3) EXECUTE FUNCTION pg_temp.reject_library_lock();
    INSERT INTO pg_temp.document_lock (document_id) VALUES (4)`);
      await assert.rejects(unlockClientDocuments(db, '4,3'), /fixture delete error/);
      assert.equal((await db.query('SELECT * FROM pg_temp.document_lock WHERE document_id=4')).rowCount, 0);
      assert.equal((await db.query('SELECT * FROM pg_temp.document_lock WHERE document_id=3')).rowCount, 1);
    }),
);

test(
  'local library lists retain source permissions, expiry, ordering, label inheritance and image-library selection',
  enabled,
  async () =>
    fixture(async (db) => {
      await db.query(`INSERT INTO pg_temp.mst_common_document (document_id,document_name,document_name_org,document_save_kbn,document_type,document_update_time,use_end_time,document_mobile_save,document_path,document_life_time,document_manual_download,is_other_app_open) VALUES
    (1,'Unlabelled & name','one.pdf',0,'PDF','2026-01-01',NULL,1,NULL,30,0,NULL),(2,'Hidden child','two.pdf',0,'PDF','2026-01-02',NULL,1,NULL,NULL,NULL,0),
    (3,'Visible and hidden','three.pdf',1,'URL','2026-01-03','2026-11-07',1,'https://example.invalid',30,1,0),(4,'Expired','expired.pdf',0,'PDF','2026-01-04','2026-11-06',1,NULL,NULL,0,1),
    (5,'Role denied','denied.pdf',0,'PDF','2026-01-05',NULL,1,NULL,NULL,0,1),(6,'FreeDraw read','read.irfd',2,'PDF','2026-01-06',NULL,1,NULL,60,1,1),(7,'FreeDraw no role','denied.irfd',2,'PDF','2026-01-07',NULL,1,NULL,NULL,0,1);
    INSERT INTO pg_temp.mst_common_document_role (document_id,group_id) VALUES (5,2);
    INSERT INTO pg_temp.common_document_irfd_role (document_id,group_id,role_irfd_read,role_irfd_update) VALUES (6,1,1,0);
    INSERT INTO pg_temp.mst_label_common_document (mst_label_id,upper_label_id,label_name,label_icon_id,diplay_number) VALUES (10,0,'Private',1,1),(11,10,'Child',2,2),(12,0,'Public',3,3);
    INSERT INTO pg_temp.common_document_label_role (mst_label_id,group_id) VALUES (10,2);
    INSERT INTO pg_temp.common_document_label (document_id,mst_label_id) VALUES (2,11),(3,11),(3,12);
    INSERT INTO pg_temp.mst_image_document (document_id,document_name,document_save_kbn,document_update_time) VALUES (9,'Image',0,'2026-01-01');
    INSERT INTO pg_temp.mst_image_document_role (document_id,group_id) VALUES (9,1)`);
      const today = new Date(2026, 10, 7, 14);
      const list = async (user = 'fixture', type = '') =>
        parser.parse(await getClientLocalReferenceList(db, user, type, today)).conmas;
      const initial = await list();
      assert.deepEqual(
        initial.localFiles.localFile.map((file: Record<string, string>) => file.localFileId),
        ['6', '3', '2', '1'],
      );
      assert.equal(initial.localFiles.localFile[1].url, 'https://example.invalid');
      assert.equal(initial.localFiles.localFile[1].mobilesave, '0');
      assert.equal(initial.localFiles.localFile[1].expire, '2026/11/07 23:59:59');
      assert.equal(initial.localFiles.localFile[1].lifeTime, '30');
      assert.equal(initial.localFiles.localFile.at(-1).lifeTime, '0');
      assert.equal(initial.localFiles.localFile.at(-1).isOtherAppOpen, '1');
      assert.equal(initial.localLabels.localLabel[0].group, '2');
      for (const mode of ['1', '2']) {
        await db.query(
          "INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (2,'LIBRARY','IREPORTER_LABEL_ROLE_MODE',$1) ON CONFLICT (com_id) DO UPDATE SET com_value=$1",
          [mode],
        );
        const restricted = await list();
        assert.deepEqual(
          restricted.localFiles.localFile.map((file: Record<string, string>) => file.localFileId),
          ['6', '3', '1'],
        );
        assert.equal(restricted.localFiles.localFile[2].displayNumber, '4');
        assert.equal(restricted.localLabels.localLabel.length, 3);
      }
      assert.equal((await list('fixture', '1')).localFiles.localFile.localFileId, '9');
      assert.equal((await list('other', '1')).localFiles, '');
      assert.equal((await list('fixture', '01')).localFiles.localFile.length, 3);
      assert.equal(
        (await list('conmasadmin')).localFiles.localFile.some(
          (file: Record<string, string>) => file.localFileId === '7',
        ),
        true,
      );
      await db.query('UPDATE pg_temp.mst_label_common_document SET upper_label_id=11 WHERE mst_label_id=10');
      await assert.rejects(list('other'), /Cyclic library label hierarchy/);
    }),
);

test(
  'native document info validates in source order and preserves metadata, expiry, roles, lock state and label/search filters without writes',
  enabled,
  async () =>
    fixture(async (db) => {
      await db.query(`INSERT INTO pg_temp.mst_common_document (document_id,document_name,document_name_org,document_save_kbn,document_type,document_update_time,sys_regist_time,sys_update_time,sys_regist_user,sys_update_user,sys_regist_user_name,sys_update_user_name,document_mobile_save,document_manual_download,document_life_time,is_other_app_open,edit_status,remarks,lock_mode,use_end_time) VALUES
    (1,'Name <&','one.pdf',0,'PDF','2026-11-01','2026-11-01 09:00:00','2026-11-02 10:00:00','creator','editor','Creator name','Editor name',1,1,30,0,4,'Remark <&',0,'2026-11-08'),
    (2,'FreeDraw','preview.pdf',2,'FD','2026-11-02','2026-11-01','2026-11-02','creator','editor',NULL,NULL,1,NULL,NULL,NULL,1,'FD remark',1,NULL);
    INSERT INTO pg_temp.common_document_irfd (document_id,rev_no,irfd_file_name) VALUES (2,1,'old.irfd'),(2,2,'latest.irfd');
    INSERT INTO pg_temp.common_document_irfd_role (document_id,group_id,role_irfd_read,role_irfd_update) VALUES (2,1,1,0);
    INSERT INTO pg_temp.common_document_label (document_id,mst_label_id) VALUES (1,11);
    INSERT INTO pg_temp.mst_label_common_document (mst_label_id,upper_label_id,label_id_path) VALUES (10,NULL,'10'),(11,10,'10/11');
    INSERT INTO pg_temp.document_lock (document_id,user_id,sys_regist_term) VALUES (1,'fixture','10');
    INSERT INTO pg_temp.mst_image_document (document_id,document_name,document_name_org,document_type,document_save_kbn,sys_regist_time,sys_update_time,sys_regist_user,sys_update_user) VALUES (3,'Picture','picture.png','PHOTO',0,'2026-11-01','2026-11-02','creator','editor')`);
      const now = new Date(2026, 10, 8, 12),
        info = (params: Record<string, string> = {}, user = 'fixture') =>
          getClientDocumentInfo(db, user, { documentId: '1', iconType: 'PDF', ...params }, now);
      const file = (xml: string) => parser.parse(xml).conmas.localFiles.localFile;
      const before = (await db.query('SELECT * FROM pg_temp.document_lock')).rows;
      assert.equal(
        parser.parse(await info({ documentId: '', iconType: '' })).conmas.error.remarks.remark,
        "'documentId' is required.",
      );
      const invalid = parser.parse(await info({ documentId: '1;DROP', iconType: '' })).conmas.error;
      assert.equal(invalid.code, '2');
      assert.equal(invalid.remarks.remark.length, 2);
      assert.equal(parser.parse(await info({ iconType: '' })).conmas.error.remarks.remark, "'iconType' is required.");
      const metadata = file(await info());
      assert.equal(metadata.localFileId, '1');
      assert.equal(metadata.displayName, 'Name <&');
      assert.equal(metadata.registUser, 'Creator name');
      assert.equal(metadata.updateUser, 'Editor name');
      assert.equal(metadata.registTime, '2026/11/01 09:00:00');
      assert.equal(metadata.expire, '2026/11/08 23:59:59');
      assert.equal(metadata.labelId, '11');
      assert.equal(metadata.lifeTime, '30');
      assert.equal(metadata.isOtherAppOpen, '0');
      assert.equal(metadata.remarks, 'Remark <&');
      assert.equal(metadata.editStatus, '4');
      assert.equal(metadata.lockMode, '');
      assert.equal(metadata.locked, '0');
      assert.equal(parser.parse(await info({ documentId: '999' })).conmas.localFiles, '');
      assert.equal(parser.parse(await info({ iconType: 'pdf' })).conmas.localFiles, '');
      assert.equal(file(await info({ labelId: '10' })).localFileId, '1');
      assert.equal(parser.parse(await info({ labelId: '999' })).conmas.localFiles, '');
      assert.equal(file(await info({ word: 'Ｎａｍｅ', wordTargetName: 'true' })).localFileId, '1');
      assert.equal(file(await info({ word: '%', wordTargetName: 'true' })).localFileId, '1');
      assert.equal(file(await info({ word: 'Remark', wordTargetRemarks: 'true' })).localFileId, '1');
      assert.equal(parser.parse(await info({ word: 'ignored' })).conmas.localFiles, '');
      assert.equal(parser.parse(await info({ editStatus: '1' })).conmas.localFiles, '');
      await assert.rejects(info({ labelId: 'bad' }));
      await db.query(
        "INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (2,'LOCK_SETTING','REPORT_STRICT_LOCK','1')",
      );
      assert.equal(file(await info()).locked, '1');
      assert.equal(file(await info()).lockUserName, 'Library fixture');
      await db.query(
        "UPDATE pg_temp.document_lock SET user_id='other';UPDATE pg_temp.mst_common SET com_value='0' WHERE com_id=2",
      );
      assert.equal(file(await info()).lockUserName, 'Other fixture');
      const fd = file(await info({ documentId: '2', iconType: 'FD' }));
      assert.equal(fd.fileName, 'latest.irfd');
      assert.equal(fd.locked, '1');
      assert.equal(fd.lockUserName, '');
      assert.equal(fd.lockMode, '1');
      assert.equal(fd.lifeTime, '0');
      assert.equal(fd.isOtherAppOpen, '1');
      await db.query('UPDATE pg_temp.common_document_irfd_role SET role_irfd_update=1');
      assert.equal(file(await info({ documentId: '2', iconType: 'FD' })).locked, '0');
      assert.equal(parser.parse(await info({ documentId: '2', iconType: 'FD' }, 'other')).conmas.localFiles, '');
      assert.equal(file(await info({ documentId: '2', iconType: 'FD' }, 'conmasadmin')).locked, '0');
      const image = file(await info({ documentId: '3', iconType: 'PHOTO', libraryType: '1', editStatus: 'invalid' }));
      assert.equal(image.fileName, 'picture.png');
      assert.equal(image.editStatus, '');
      assert.equal(image.registUser, 'creator');
      await db.query('INSERT INTO pg_temp.mst_common_document_role (document_id,group_id) VALUES (1,2)');
      assert.equal(parser.parse(await info()).conmas.localFiles, '');
      assert.equal(file(await info({}, 'conmasadmin')).localFileId, '1');
      await db.query(
        "DELETE FROM pg_temp.mst_common_document_role;INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (3,'LIBRARY','IREPORTER_LABEL_ROLE_MODE','1');INSERT INTO pg_temp.common_document_label_role (mst_label_id,group_id) VALUES (10,2)",
      );
      assert.equal(parser.parse(await info({ labelId: '10' })).conmas.localFiles, '');
      assert.equal(file(await info()).localFileId, '1');
      assert.equal(file(await info({ labelId: '10' }, 'conmasadmin')).localFileId, '1');
      await db.query("UPDATE pg_temp.mst_common_document SET use_end_time='2026-11-07 23:59:59' WHERE document_id=1");
      assert.equal(parser.parse(await info()).conmas.localFiles, '');
      await db.query("UPDATE pg_temp.document_lock SET user_id='fixture'");
      assert.deepEqual((await db.query('SELECT * FROM pg_temp.document_lock')).rows, before);
      assert.equal((await db.query('SELECT count(*) FROM pg_temp.log_library_download')).rows[0].count, '0');
    }),
);

test(
  'local downloads preserve metadata/binary precedence, raw/null bytes, role filtering and exact download log context',
  enabled,
  async () =>
    fixture(async (db) => {
      await db.query(`INSERT INTO pg_temp.mst_common_document (document_id,document_name,document_name_org,content_type,document_file) VALUES (1,'Common','common.pdf','application/pdf','common'),(2,'Null',NULL,NULL,NULL),(3,'Denied','denied.pdf','application/pdf','private'),(4,'Expired','expired.pdf','application/pdf','expired');
    INSERT INTO pg_temp.mst_report_document (document_id,document_name,document_name_org,content_type,document_file) VALUES (1,'Report','report.pdf','application/report','report');
    INSERT INTO pg_temp.mst_image_document (document_id,document_name,document_name_org,content_type,document_file) VALUES (5,'Image','image.png','image/png','image');
    INSERT INTO pg_temp.mst_common_document_role (document_id,group_id) VALUES (3,2);
    UPDATE pg_temp.mst_common_document SET use_end_time=now()-interval '2 days' WHERE document_id=4`);
      const download = (id: string, user = 'fixture') => getClientLocalReference(db, user, 10, id, '', '');
      assert.deepEqual(await download(' +1 '), {
        data: Buffer.from('common'),
        filename: 'report.pdf',
        contentType: 'application/report',
      });
      assert.deepEqual(await download('2'), { data: Buffer.alloc(0), filename: 'unknown', contentType: 'application' });
      assert.deepEqual(await download('5'), {
        data: Buffer.from('image'),
        filename: 'image.png',
        contentType: 'image/png',
      });
      const count = (await db.query('SELECT * FROM pg_temp.log_library_download')).rowCount;
      for (const id of ['', '1;DROP', '2147483648', '3', '4', '99'])
        assert.deepEqual(await download(id), { data: Buffer.alloc(0), filename: 'empty', contentType: 'application' });
      assert.equal((await db.query('SELECT * FROM pg_temp.log_library_download')).rowCount, count);
      const log = (await db.query('SELECT * FROM pg_temp.log_library_download ORDER BY log_id')).rows[0];
      assert.equal(log.document_name, 'Report');
      assert.equal(log.document_kbn, 1);
      assert.equal(log.document_top_id, null);
      assert.equal(log.log_user_name, 'Library fixture');
      assert.equal(log.log_term_name, 'Library terminal');
      assert.equal(log.sys_regist_term, '10');
      assert.equal(log.log_gps_lat, '');
      assert.equal(log.sys_regist_time.getHours(), 0);
      assert.equal(log.sys_regist_time.getMinutes(), 0);
      assert.equal(typeof (await download('3', 'conmasadmin')), 'object');
      await db.query('ALTER TABLE pg_temp.log_library_download ADD CONSTRAINT reject_log CHECK (false) NOT VALID');
      assert.equal(typeof (await download('1')), 'object');
      assert.equal((await db.query('SELECT 1 AS usable')).rows[0].usable, 1);
    }),
);

test(
  'library file storage uses existing configured folder, numeric filenames and source missing-file behavior',
  enabled,
  async () =>
    fixture(async (db) => {
      const directory = await mkdtemp('/tmp/opencode/client-library-');
      try {
        await writeFile(join(directory, '1'), Buffer.from('disk-document'));
        await db.query("UPDATE pg_temp.mst_common SET com_value='0'");
        await db.query(
          "INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (2,'LIBRARY','BASE_FOLDER',$1)",
          [directory],
        );
        await db.query(
          "INSERT INTO pg_temp.mst_common_document (document_id,document_name,document_name_org,content_type,document_file) VALUES (1,'Disk','disk.pdf','application/pdf','ignored-db'),(2,'Missing','missing.pdf','application/pdf','ignored-db')",
        );
        assert.deepEqual(await getClientLocalReference(db, 'fixture', 10, '01', '', ''), {
          data: Buffer.from('disk-document'),
          filename: 'disk.pdf',
          contentType: 'application/pdf',
        });
        assert.deepEqual(await getClientLocalReference(db, 'fixture', 10, '2', '', ''), {
          data: Buffer.alloc(0),
          filename: 'missing.pdf',
          contentType: 'application/pdf',
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }),
);

test(
  'FreeDraw licensing follows user enablement, admin bypass, exact expiry day and independent FreeDrawOnly entitlement',
  enabled,
  async () =>
    fixture(async (db) => {
      const today = new Date(2026, 10, 7);
      const check = (user: string, fields: Record<string, string>) =>
        hasClientFreeDrawLicense(db, user, new Map(Object.entries(fields)), today);
      assert.equal(await check('fixture', {}), false);
      assert.equal(await check('fixture', { FreeDraw: '1' }), true);
      assert.equal(await check('other', { FreeDraw: '1' }), false);
      assert.equal(await check('conmasadmin', { FreeDraw: '1' }), true);
      assert.equal(await check('fixture', { FreeDraw: '1', FreeDrawExprie: '20261107' }), true);
      assert.equal(await check('fixture', { FreeDraw: '1', FreeDrawExprie: '20261106' }), false);
      assert.equal(await check('other', { FreeDrawOnly: '1', FreeDrawOnlyExpire: '20261107' }), true);
      assert.equal(await check('fixture', { FreeDrawOnly: '1', FreeDrawOnlyExpire: '20261106' }), false);
    }),
);

test(
  'FreeDraw edit/strict-lock paths run independently of installed licensing, preserving audit, admin/non-lock modes and rollback',
  enabled,
  async () =>
    fixture(async (db) => {
      await db.query(
        'INSERT INTO pg_temp.common_document_irfd_role (document_id,group_id,role_irfd_update) VALUES (1,1,1),(2,1,0)',
      );
      const now = new Date(2026, 10, 7, 12, 34, 56),
        edit = (user = 'fixture', mode = '0', id = 1) => editClientLibraryDocument(db, user, 10, id, mode, now);
      assert.match((await edit('other')) ?? '', /<code>3<\/code>/);
      assert.match((await edit('fixture', '0', 2)) ?? '', /<code>3<\/code>/);
      assert.equal(await edit('fixture', '1'), undefined);
      assert.equal((await db.query('SELECT * FROM pg_temp.document_lock')).rowCount, 0);
      assert.equal(await edit(), undefined);
      const row = (await db.query('SELECT * FROM pg_temp.document_lock')).rows[0];
      assert.equal(row.user_id, 'fixture');
      assert.equal(row.sys_regist_term, '10');
      assert.equal(row.sys_regist_user, 'fixture');
      assert.equal(row.sys_regist_time.getTime(), now.getTime());
      assert.equal(await edit(), undefined);
      await db.query(
        "INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (2,'LOCK_SETTING','REPORT_STRICT_LOCK','1')",
      );
      assert.match((await edit()) ?? '', /Exclusive Error/);
      await db.query(
        "UPDATE pg_temp.mst_common SET com_value='0' WHERE com_id=2; UPDATE pg_temp.document_lock SET user_id='other'",
      );
      assert.match((await edit()) ?? '', /Exclusive Error/);
      assert.match((await edit('conmasadmin')) ?? '', /Exclusive Error/);
      await db.query('DELETE FROM pg_temp.document_lock');
      assert.equal(await edit('conmasadmin'), undefined);
      await db.query(`UPDATE pg_temp.document_lock SET user_id='fixture';
    CREATE FUNCTION pg_temp.reject_document_lock() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''fixture lock error''; END';
    CREATE TRIGGER reject_document_lock BEFORE INSERT ON pg_temp.document_lock FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_document_lock()`);
      await assert.rejects(edit(), /fixture lock error/);
      assert.equal((await db.query('SELECT * FROM pg_temp.document_lock')).rows[0].user_id, 'fixture');
    }),
);

test(
  'FreeDraw retrieval selects latest IRFD, logs rejected downloads, and protects edit/strict locks without touching restored data',
  enabled,
  async () =>
    fixture(async (db) => {
      await db.query(`INSERT INTO pg_temp.mst_common_document (document_id,document_name,document_name_org,content_type,document_file,document_save_kbn,lock_mode) VALUES (1,'FreeDraw','preview.pdf','application/pdf','preview',2,0);
    INSERT INTO pg_temp.common_document_irfd (document_id,rev_no,irfd_file,irfd_file_name) VALUES (1,1,'old','old.irfd'),(1,2,'latest','latest.irfd');
    INSERT INTO pg_temp.common_document_irfd_role (document_id,group_id,role_irfd_update) VALUES (1,1,1)`);
      const download = (user = 'fixture', preview = '') => getClientLocalReference(db, user, 10, '1', '1', preview);
      const current = readLicenseFields();
      const licensed = await hasClientFreeDrawLicense(db, 'fixture', current);
      if (!licensed) {
        assert.match((await download()) as string, /<code>11050<\/code>/);
        assert.equal((await db.query('SELECT * FROM pg_temp.document_lock')).rowCount, 0);
        assert.equal((await db.query('SELECT * FROM pg_temp.log_library_download')).rowCount, 1);
      } else {
        assert.deepEqual(await download('fixture', '1'), {
          data: Buffer.from('latest'),
          filename: 'latest.irfd',
          contentType: 'application/octet-stream',
        });
        assert.equal((await db.query('SELECT * FROM pg_temp.document_lock')).rowCount, 0);
        assert.equal(typeof (await download()), 'object');
        assert.equal((await db.query('SELECT user_id FROM pg_temp.document_lock')).rows[0].user_id, 'fixture');
        assert.equal(typeof (await download()), 'object');
        await db.query(
          "INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (2,'LOCK_SETTING','REPORT_STRICT_LOCK','1')",
        );
        assert.match((await download()) as string, /Exclusive Error/);
        await db.query(
          "UPDATE pg_temp.mst_common SET com_value='0' WHERE com_id=2; UPDATE pg_temp.document_lock SET user_id='other'",
        );
        assert.match((await download()) as string, /Exclusive Error/);
        await db.query('DELETE FROM pg_temp.common_document_irfd_role');
        assert.match((await download()) as string, /<code>3<\/code>/);
      }
      assert.deepEqual(await getClientLocalReference(db, 'fixture', 10, '1', '', ''), {
        data: Buffer.from('preview'),
        filename: 'preview.pdf',
        contentType: 'application/pdf',
      });
    }),
);
