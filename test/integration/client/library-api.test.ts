import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import express from 'express';
import session from 'express-session';
import { XMLParser } from 'fast-xml-parser';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  getClientApiDocumentList,
  getClientApiDocumentDownload,
  deleteClientApiDocument,
  registerClientApiDocument,
} from '../../../src/models/client-library-api.js';
import { registerClientRoutes } from '../../../src/routes/client.js';

const enabled = { skip: !process.env.DATABASE_URL },
  parser = new XMLParser({ parseTagValue: false });
async function fixture(run: (db: pg.Pool) => Promise<void>) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }),
    client = await pool.connect();
  try {
    for (const table of [
      'mst_common',
      'mst_group',
      'mst_group_affiation',
      'def_top',
      'rep_top',
      'def_role',
      'rep_role',
      'common_document_irfd',
      'common_document_irfd_role',
      'def_report_document',
      'rep_report_document',
      'document_lock',
      'document_size',
      ...['common', 'report', 'image'].flatMap((mode) => [
        `mst_${mode}_document`,
        `mst_${mode}_document_role`,
        `mst_label_${mode}_document`,
        `${mode}_document_label`,
        `${mode}_document_label_role`,
      ]),
    ])
      await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    for (const sequence of [
      'mst_document_document_id_seq',
      'mst_label_common_document_mst_label_id_seq',
      'mst_label_report_document_mst_label_id_seq',
      'mst_label_def_mst_label_id_seq',
    ]) {
      await client.query(`CREATE TEMP SEQUENCE ${sequence} START 100`);
      assert.equal(
        (await client.query(`SELECT '${sequence}'::regclass::oid='pg_temp.${sequence}'::regclass::oid AS private`))
          .rows[0].private,
        true,
      );
    }
    for (const table of ['common_document_irfd_role', 'document_lock', 'document_size'])
      await client.query(
        `ALTER TABLE pg_temp.${table} ADD FOREIGN KEY (document_id) REFERENCES pg_temp.mst_common_document(document_id) ON DELETE CASCADE`,
      );
    await client.query(`INSERT INTO pg_temp.mst_group (group_id,role_library_read) VALUES (1,1),(2,0);
      INSERT INTO pg_temp.mst_group_affiation (user_id,group_id) VALUES ('reader',1),('denied',2);
      INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (1,'LIBRARY','FILE_LOCATION','1');
      INSERT INTO pg_temp.mst_label_common_document (mst_label_id,label_name_path,upper_label_id) VALUES (10,'Parent',0),(11,'Parent/Child',10),(12,'Other',0);
      INSERT INTO pg_temp.common_document_label_role (mst_label_id,group_id) VALUES (10,2),(12,2)`);
    await run({
      query: client.query.bind(client),
      connect: async () => ({ query: client.query.bind(client), release() {} }),
    } as unknown as pg.Pool);
  } finally {
    client.release(true);
    await pool.end();
  }
}
const documents = (xml: string): Record<string, unknown>[] => {
  const result = parser.parse(xml).conmas.documents.document;
  return result ? (Array.isArray(result) ? result : [result]) : [];
};

test(
  'GeneralProcess Library list validation preserves exact enum/date/int messages, defaults and existence-before-privilege',
  enabled,
  async () =>
    fixture(async (db) => {
      const list = (params: Record<string, string>, user = 'reader') =>
        getClientApiDocumentList(db, user, params, new Date(2026, 10, 7, 12));
      const invalid = parser.parse(
        await list({
          documentType: '00',
          scopeOfLabel: '2',
          scopeOfExpiration: '3',
          mobileSave: '2',
          dateFirstCreatedFrom: '2026/02/30',
          limitOfList: '0',
          skipOver: '0',
          documentId: '1;DROP',
        }),
      ).conmas.error;
      assert.equal(invalid.code, '2');
      assert.equal(invalid.remarks.remark.length, 9);
      assert.equal(
        invalid.remarks.remark[0],
        "Invalid value '00' specified for 'documentType'. It must be one of the following: '0', '1', '2'.",
      );
      assert(invalid.remarks.remark.includes("'labelPath' is required."));
      assert(invalid.remarks.remark.includes("'documentId' must be an integer."));
      assert.match(await list({ labelPath: 'Missing' }, 'denied'), /<code>8<\/code>/);
      assert.match(await list({}, 'denied'), /<code>3<\/code>/);
      assert.match(await list({ labelPath: 'Parent/Child' }, 'reader'), /<documents/);
      await assert.rejects(list({ documentType: '' }), /Invalid API integer/);
      await assert.rejects(list({ dateFirstCreatedTo: '' }), /Invalid API date/);
      assert.match(await list({ limitOfList: ' +1 ', skipOver: '1' }), /<documents/);
    }),
);

test(
  'Library registration validates type, duplicate target, parameters, references, closest label, privilege and IRFD in source order',
  enabled,
  async () =>
    fixture(async (db) => {
      const register = (params: Record<string, string>, user = 'denied', file?: Express.Multer.File) =>
        registerClientApiDocument(db, user, params, file);
      assert.match(await register({ documentType: '00' }), /<code>2<\/code>/);
      assert.match(await register({}), /&apos;documentType&apos; is required/);
      await db.query(`INSERT INTO pg_temp.mst_common_document (document_id,document_name,document_save_kbn) VALUES (1,'Duplicate',0),(2,'Duplicate',0);
    INSERT INTO pg_temp.mst_label_common_document (mst_label_id,label_name_path) VALUES (20,'Ambiguous'),(21,'Ambiguous')`);
      assert.match(
        await register({ documentType: '0', documentName: 'Duplicate', storageMode: 'invalid', expire: 'invalid' }),
        /Document must be unique/,
      );
      const parameters = {
        documentType: '0',
        storageMode: '1',
        documentUrl: 'https://example.invalid',
        labelPath: 'Ambiguous',
        groupId: '99',
      };
      assert.match(await register(parameters), /&apos;99&apos; does not exist as group id/);
      assert.match(await register({ ...parameters, groupId: '1' }), /Label must be unique/);
      assert.match(
        await register({ ...parameters, labelPath: 'Parent/Child', groupId: '1' }),
        /Unauthorized to create documents in library/,
      );
      assert.match(await register({ documentType: '0', storageMode: '1' }), /&apos;documentUrl&apos; is required/);
      assert.match(await register({ documentType: '0' }), /File upload is required/);
      const invalid = parser.parse(
        await register({
          documentType: '1',
          storageMode: '1',
          documentUrl: 'url',
          definitionId: '1,,  ,x,2147483648',
          groupId: 'bad,bad',
          expire: '2026/02/30 12:00:00',
        }),
      ).conmas.error;
      assert.equal(invalid.code, '2');
      assert.equal(invalid.remarks.remark.length, 6);
      const irfd = {
        originalname: 'file.IRFD',
        size: 1,
        path: '/unused',
        mimetype: 'application/octet-stream',
      } as Express.Multer.File;
      assert.match(await register({ documentType: '0' }, 'denied', irfd), /<code>3<\/code>/);
      assert.match(await register({ documentType: '0' }, 'conmasadmin', irfd), /irfd file is not allowed/);
      assert.match(
        await register({ documentType: '0', storageMode: '1', documentUrl: 'url', iconType: 'PATH' }, 'denied'),
        /<code>3<\/code>/,
      );
      assert.match(
        await register({ documentType: '0', storageMode: '1', documentUrl: 'url', iconType: 'PATH' }, 'conmasadmin'),
        /<code>2<\/code>/,
      );
      await assert.rejects(register({ documentType: '0', storageMode: 'invalid' }), /Invalid API integer/);
      assert.match(
        await register({ documentType: '0', documentName: 'Explicit name', storageMode: 'invalid' }),
        /<code>2<\/code>/,
      );
      assert.equal((await db.query('SELECT count(*) FROM pg_temp.mst_common_document')).rows[0].count, '2');
    }),
);

test(
  'Library registration persists file/URL categories, default names/icons and audit metadata with private source sequences',
  enabled,
  async () =>
    fixture(async (db) => {
      const directory = await mkdtemp('/tmp/opencode/client-library-register-');
      try {
        await writeFile(join(directory, 'upload'), 'binary <&>');
        await db.query(
          `INSERT INTO pg_temp.def_top (def_top_id) VALUES (20); INSERT INTO pg_temp.rep_top (rep_top_id) VALUES (30)`,
        );
        const now = new Date(2026, 10, 7, 12),
          file = { path: join(directory, 'upload'), originalname: '日本 &.pdf', mimetype: 'application/pdf', size: 10 };
        for (const [type, mode] of ['common', 'report', 'image'].entries()) {
          const params = {
            documentType: String(type),
            definitionId: '20',
            reportId: '30',
            mobileSave: '1',
            labelPath: 'Created/Child',
            labelIcon: '7',
          };
          assert.match(
            await registerClientApiDocument(db, 'conmasadmin', params, file, 'fixture-host', now),
            /<code>0<\/code>/,
          );
          const stored = (await db.query(`SELECT * FROM pg_temp.mst_${mode}_document`)).rows[0];
          assert.equal(stored.document_id, 100 + type * 2);
          assert.equal(stored.document_name, file.originalname);
          assert.equal(stored.document_type, 'PDF');
          assert.equal(stored.document_save_kbn, '0');
          assert.equal(stored.document_mobile_save, '1');
          assert.equal(stored.document_life_time, 0);
          assert.equal(stored.document_manual_download, '0');
          assert.equal(stored.is_other_app_open, '0');
          assert.deepEqual(stored.document_file, Buffer.from('binary <&>'));
          assert.equal(stored.sys_regist_term, 'fixture-host');
          assert.equal(stored.sys_regist_user, 'conmasadmin');
          assert.deepEqual(stored.document_update_time, now);
          const labels = (
            await db.query(
              `SELECT * FROM pg_temp.mst_label_${mode}_document WHERE label_name_path LIKE 'Created%' ORDER BY label_name_path`,
            )
          ).rows;
          assert.equal(labels.length, 2);
          assert.equal(labels[0].upper_label_id, null);
          assert.equal(labels[1].upper_label_id, labels[0].mst_label_id);
          assert.equal(labels[1].label_id_path, `${labels[0].mst_label_id}/${labels[1].mst_label_id}`);
          assert.equal(labels[1].label_icon_id, 7);
          assert.equal(
            (await db.query(`SELECT * FROM pg_temp.${mode}_document_label WHERE document_id=$1`, [stored.document_id]))
              .rows[0].mst_label_id,
            labels[1].mst_label_id,
          );
          assert.match(
            await registerClientApiDocument(
              db,
              'conmasadmin',
              {
                documentType: String(type),
                storageMode: '1',
                documentUrl: 'https://example.invalid/' + mode,
                definitionId: '20',
                mobileSave: 'bad',
              },
              undefined,
              'host',
              now,
            ),
            /<code>0<\/code>/,
          );
          const url = (await db.query(`SELECT * FROM pg_temp.mst_${mode}_document WHERE document_save_kbn=1`)).rows[0];
          assert.equal(url.document_name, url.document_path);
          assert.equal(url.document_type, 'URL');
          assert.equal(url.document_mobile_save, '0');
          assert.equal(url.document_file, null);
          assert.equal(url.content_type, null);
        }
        assert.equal(
          (await db.query('SELECT last_value FROM pg_temp.mst_label_def_mst_label_id_seq')).rows[0].last_value,
          '101',
        );
        assert.equal((await db.query('SELECT add_rep FROM pg_temp.def_report_document LIMIT 1')).rows[0].add_rep, null);
        assert.equal((await db.query('SELECT add_rep FROM pg_temp.rep_report_document LIMIT 1')).rows[0].add_rep, 1);
        assert.match(
          await registerClientApiDocument(
            db,
            'conmasadmin',
            { documentType: '1', definitionId: '20' },
            { ...file, originalname: 'recognize.mlmodel' },
          ),
          /<code>0<\/code>/,
        );
        assert.equal(
          (
            await db.query(
              "SELECT document_type FROM pg_temp.mst_report_document WHERE document_name='recognize.mlmodel'",
            )
          ).rows[0].document_type,
          'AIModel',
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }),
);

test(
  'Library registration updates by name/path, preserves omitted options and source file/URL lifetime transition quirks',
  enabled,
  async () =>
    fixture(async (db) => {
      const directory = await mkdtemp('/tmp/opencode/client-library-register-');
      try {
        const file = {
          path: join(directory, 'upload'),
          originalname: 'replacement.jpg',
          mimetype: 'image/jpeg',
          size: 3,
        };
        await writeFile(file.path, 'new');
        await db.query(`INSERT INTO pg_temp.mst_common_document (document_id,document_name,document_name_org,document_save_kbn,document_type,document_file,document_mobile_save,document_manual_download,document_life_time,use_end_time,sys_regist_user,sys_regist_time,document_update_time,is_other_app_open,remarks)
      VALUES (1,'Existing','original.pdf',0,'PDF','old',1,1,20,'2030-01-01','creator','2000-01-01','2000-01-01',1,'keep');
      INSERT INTO pg_temp.common_document_label (document_id,mst_label_id) VALUES (1,11)`);
        const register = (params: Record<string, string>, upload?: typeof file) =>
          registerClientApiDocument(
            db,
            'conmasadmin',
            { documentType: '0', documentName: 'Existing', labelPath: 'Parent/Child', ...params },
            upload,
          );
        assert.match(await register({ lifeTime: '30', expire: '', documentId: '999' }), /<code>0<\/code>/);
        let stored = (await db.query('SELECT * FROM pg_temp.mst_common_document WHERE document_id=1')).rows[0];
        assert.equal(stored.document_life_time, 20);
        assert.equal(stored.sys_regist_user, 'creator');
        assert.equal(stored.remarks, 'keep');
        assert.match(await register({ manualDownload: '1', lifeTime: '30' }), /<code>0<\/code>/);
        assert.match(
          await register({ storageMode: '1', documentUrl: 'changed', mobileSave: 'bad' }, file),
          /<code>0<\/code>/,
        );
        stored = (await db.query('SELECT * FROM pg_temp.mst_common_document WHERE document_id=1')).rows[0];
        assert.equal(stored.document_path, 'changed');
        assert.equal(stored.document_name_org, 'original.pdf');
        assert.equal(stored.document_type, 'PDF');
        assert.deepEqual(stored.document_file, Buffer.from('old'));
        assert.equal(stored.document_mobile_save, '1');
        assert.equal(stored.document_update_time.getFullYear(), 2000);
        assert.match(await register({ lifeTime: '40' }), /<code>0<\/code>/);
        assert.match(await register({ storageMode: '0', mobileSave: '0' }, file), /<code>0<\/code>/);
        stored = (await db.query('SELECT * FROM pg_temp.mst_common_document WHERE document_id=1')).rows[0];
        assert.equal(stored.document_life_time, 40);
        assert.equal(stored.document_path, 'changed');
        assert.equal(stored.document_type, 'PDF');
        assert.equal(stored.document_name_org, 'replacement.jpg');
        assert.equal(stored.content_type, 'image/jpeg');
        assert.deepEqual(stored.document_file, Buffer.from('new'));
        assert.equal((await db.query('SELECT * FROM pg_temp.common_document_label WHERE document_id=1')).rowCount, 1);
        await writeFile(file.path, '');
        assert.match(await register({ manualDownload: '0', lifeTime: '99' }, { ...file, size: 0 }), /<code>0<\/code>/);
        stored = (await db.query('SELECT * FROM pg_temp.mst_common_document WHERE document_id=1')).rows[0];
        assert.equal(stored.document_file.length, 0);
        assert.equal(stored.document_life_time, 40);
        await db.query(
          'UPDATE pg_temp.mst_common_document SET document_mobile_save=NULL,document_manual_download=NULL,is_other_app_open=NULL',
        );
        assert.match(await register({}), /<code>0<\/code>/);
        stored = (await db.query('SELECT * FROM pg_temp.mst_common_document WHERE document_id=1')).rows[0];
        for (const key of ['document_mobile_save', 'document_manual_download', 'is_other_app_open'])
          assert.equal(stored[key], null);
        assert.match(
          await registerClientApiDocument(db, 'conmasadmin', {
            documentType: '0',
            documentName: 'Existing',
            storageMode: '1',
            documentUrl: 'unlabelled',
          }),
          /<code>0<\/code>/,
        );
        assert.equal(
          (await db.query("SELECT * FROM pg_temp.mst_common_document WHERE document_name='Existing'")).rowCount,
          2,
        );
        assert.match(
          await registerClientApiDocument(db, 'conmasadmin', {
            documentType: '0',
            storageMode: '1',
            documentUrl: 'other',
            definitionId: 'ignored-invalid',
            reportId: 'ignored-invalid',
            iconType: '',
          }),
          /<code>0<\/code>/,
        );
        assert.equal(
          (await db.query("SELECT document_type FROM pg_temp.mst_common_document WHERE document_name='other'")).rows[0]
            .document_type,
          '',
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }),
);

test(
  'Library registration enforces ancestor/document/definition/report roles while label creation shifts siblings without requiring label-update',
  enabled,
  async () =>
    fixture(async (db) => {
      await db.query(`UPDATE pg_temp.mst_group SET role_library_create=1,role_library_update=1,role_label_create_manager=1,role_label_update_manager=0 WHERE group_id=1;
    UPDATE pg_temp.mst_label_common_document SET label_id_path='10',label_name='Parent' WHERE mst_label_id=10;
    UPDATE pg_temp.mst_label_common_document SET label_id_path='10/11',label_name='Child',diplay_number=4,sys_update_user='keep' WHERE mst_label_id=11;
    INSERT INTO pg_temp.def_top (def_top_id) VALUES (20); INSERT INTO pg_temp.rep_top (rep_top_id) VALUES (30)`);
      const parameters = { documentType: '0', storageMode: '1', documentUrl: 'url', labelPath: 'Parent/New/Leaf' };
      assert.match(await registerClientApiDocument(db, 'reader', parameters), /Unauthorized to refer the label/);
      await db.query('DELETE FROM pg_temp.common_document_label_role WHERE mst_label_id=10');
      assert.match(await registerClientApiDocument(db, 'reader', parameters), /<code>0<\/code>/);
      const sibling = (
        await db.query(
          'SELECT diplay_number,sys_update_user FROM pg_temp.mst_label_common_document WHERE mst_label_id=11',
        )
      ).rows[0];
      assert.equal(sibling.diplay_number, 5);
      assert.equal(sibling.sys_update_user, 'keep');
      assert.equal(
        (
          await db.query(
            "SELECT label_icon_id FROM pg_temp.mst_label_common_document WHERE label_name_path='Parent/New/Leaf'",
          )
        ).rows[0].label_icon_id,
        6,
      );
      const document = (await db.query('SELECT document_id FROM pg_temp.mst_common_document')).rows[0];
      await db.query('INSERT INTO pg_temp.mst_common_document_role (document_id,group_id) VALUES ($1,2)', [
        document.document_id,
      ]);
      assert.match(await registerClientApiDocument(db, 'reader', parameters), /Unauthorized to refer the document/);
      const report = { documentType: '1', storageMode: '1', documentUrl: 'report', definitionId: '20', reportId: '30' };
      const denied = await registerClientApiDocument(db, 'reader', report);
      assert.match(denied, /Unauthorized to refer the definition/);
      assert.match(denied, /Unauthorized to refer the report/);
      await db.query(`INSERT INTO pg_temp.def_role (def_top_id,group_id,role_def_read) VALUES (20,1,1);
    INSERT INTO pg_temp.rep_role (rep_top_id,group_id,role_rep_read) VALUES (30,1,1)`);
      assert.match(await registerClientApiDocument(db, 'reader', report), /<code>0<\/code>/);
      assert.match(
        await registerClientApiDocument(db, 'reader', {
          documentType: '0',
          storageMode: '1',
          documentUrl: 'another',
          labelPath: 'Parent/Child',
          labelIcon: 'invalid',
        }),
        /<code>0<\/code>/,
      );
    }),
);

test(
  'Library registration reconciles attachment/access differences, preserves unchanged audits and does not clear empty lists',
  enabled,
  async () =>
    fixture(async (db) => {
      await db.query(
        `INSERT INTO pg_temp.def_top (def_top_id) VALUES (20),(21); INSERT INTO pg_temp.rep_top (rep_top_id) VALUES (30),(31)`,
      );
      const register = (params: Record<string, string>) =>
        registerClientApiDocument(db, 'conmasadmin', {
          documentType: '1',
          documentName: 'Attachments',
          storageMode: '1',
          documentUrl: 'url',
          ...params,
        });
      assert.match(await register({ definitionId: '20', reportId: '30', groupId: '1' }), /<code>0<\/code>/);
      await db.query(
        "UPDATE pg_temp.def_report_document SET sys_update_user='keep'; UPDATE pg_temp.mst_report_document_role SET sys_update_user='keep'",
      );
      assert.match(await register({ definitionId: '20,21,20', reportId: '31', groupId: '1,2' }), /<code>0<\/code>/);
      const definitions = (await db.query('SELECT * FROM pg_temp.def_report_document ORDER BY def_top_id')).rows;
      assert.deepEqual(
        definitions.map((row) => row.def_top_id),
        [20, 21],
      );
      assert.equal(definitions[0].sys_update_user, 'keep');
      assert.equal(definitions[1].add_rep, null);
      const reports = (await db.query('SELECT * FROM pg_temp.rep_report_document')).rows;
      assert.equal(reports[0].rep_top_id, 31);
      assert.equal(reports[0].add_rep, 1);
      assert.equal(
        (await db.query('SELECT sys_update_user FROM pg_temp.mst_report_document_role WHERE group_id=1')).rows[0]
          .sys_update_user,
        'keep',
      );
      assert.match(await register({ definitionId: '', reportId: '', groupId: '' }), /<code>0<\/code>/);
      assert.equal((await db.query('SELECT * FROM pg_temp.def_report_document')).rowCount, 2);
      assert.equal((await db.query('SELECT * FROM pg_temp.mst_report_document_role')).rowCount, 2);
      assert.match(await register({ definitionId: '21', reportId: '30', groupId: '2' }), /<code>0<\/code>/);
      assert.equal((await db.query('SELECT * FROM pg_temp.def_report_document')).rows[0].def_top_id, 21);
      assert.equal((await db.query('SELECT * FROM pg_temp.mst_report_document_role')).rows[0].group_id, 2);
    }),
);

test(
  'Library registration rolls back relations/labels/database writes and restores disk files on save errors; late commit keeps legacy file limit',
  enabled,
  async () =>
    fixture(async (db) => {
      const directory = await mkdtemp('/tmp/opencode/client-library-register-');
      try {
        const file = {
          path: join(directory, 'upload'),
          originalname: 'file.pdf',
          mimetype: 'application/pdf',
          size: 3,
        };
        await writeFile(file.path, 'old');
        await db.query("UPDATE pg_temp.mst_common SET com_value='0'");
        await db.query(
          "INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (2,'LIBRARY','BASE_FOLDER',$1)",
          [directory],
        );
        const params = { documentType: '0', documentName: 'Disk', groupId: '1', labelPath: 'Private/Child' };
        await db.query(`CREATE FUNCTION pg_temp.reject_document_role() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''fixture role error''; END';
      CREATE TRIGGER reject_document_role BEFORE INSERT ON pg_temp.mst_common_document_role FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_document_role()`);
        await assert.rejects(registerClientApiDocument(db, 'conmasadmin', params, file), /fixture role error/);
        assert.equal((await db.query('SELECT * FROM pg_temp.mst_common_document')).rowCount, 0);
        assert.equal(
          (await db.query("SELECT * FROM pg_temp.mst_label_common_document WHERE label_name_path LIKE 'Private%'"))
            .rowCount,
          0,
        );
        await db.query('DROP TRIGGER reject_document_role ON pg_temp.mst_common_document_role');
        assert.match(await registerClientApiDocument(db, 'conmasadmin', params, file), /<code>0<\/code>/);
        const id = (await db.query('SELECT document_id FROM pg_temp.mst_common_document')).rows[0].document_id;
        assert.equal(await readFile(join(directory, String(id)), 'utf8'), 'old');
        assert.equal(
          (await db.query('SELECT document_file FROM pg_temp.mst_common_document')).rows[0].document_file,
          null,
        );
        await assert.rejects(
          registerClientApiDocument(db, 'conmasadmin', params, {
            ...file,
            path: join(directory, 'missing'),
            originalname: 'missing.pdf',
          }),
          { code: 'ENOENT' },
        );
        assert.equal(await readFile(join(directory, String(id)), 'utf8'), 'old');
        await assert.rejects(readFile(join(directory, '_' + id)), { code: 'ENOENT' });
        assert.equal(
          (await db.query('SELECT document_name_org FROM pg_temp.mst_common_document')).rows[0].document_name_org,
          'file.pdf',
        );
        const failingDb = {
          connect: async () => {
            const client = await db.connect();
            return {
              release: client.release,
              query: async (sql: string, values?: unknown[]) => {
                if (sql === 'COMMIT') throw new Error('fixture commit error');
                return client.query(sql, values);
              },
            };
          },
        } as unknown as pg.Pool;
        await writeFile(file.path, 'new');
        await writeFile(join(directory, 'unrelated'), 'keep');
        await assert.rejects(
          registerClientApiDocument(failingDb, 'conmasadmin', params, { ...file, originalname: 'new.pdf' }),
          /fixture commit error/,
        );
        assert.equal(
          (await db.query('SELECT document_name_org FROM pg_temp.mst_common_document')).rows[0].document_name_org,
          'file.pdf',
        );
        assert.equal(await readFile(join(directory, String(id)), 'utf8'), 'new');
        assert.equal(await readFile(join(directory, 'unrelated'), 'utf8'), 'keep');
        await assert.rejects(readFile(join(directory, '_' + id)), { code: 'ENOENT' });
        await assert.rejects(
          registerClientApiDocument(
            db,
            'conmasadmin',
            { documentType: '0', documentName: 'Failed create' },
            { ...file, path: join(directory, 'missing') },
          ),
          { code: 'ENOENT' },
        );
        assert.equal((await db.query('SELECT * FROM pg_temp.mst_common_document')).rowCount, 1);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }),
);

test(
  'GeneralProcess registration HTTP accepts arbitrary first-file multipart, keeps session-only auth and XML MIME, and cleans every staged file',
  enabled,
  async () =>
    fixture(async (db) => {
      const app = express(),
        store = new session.MemoryStore(),
        uploads: string[] = [];
      app.use(express.urlencoded({ extended: false }));
      app.use((req, res, next) => {
        res.once('finish', () => {
          if (Array.isArray(req.files)) uploads.push(...req.files.map((file) => file.path));
        });
        next();
      });
      registerClientRoutes(app, db, store);
      const server = app.listen(0, '127.0.0.1');
      try {
        await new Promise<void>((resolve) => server.once('listening', resolve));
        const address = server.address();
        assert(address && typeof address !== 'string');
        const base = `http://127.0.0.1:${address.port}/ConMasWeb/Rests`,
          endpoint = `${base}/generalprocess.ASPX?target=Library&process=DocumentRegistration`;
        const anonymous = await fetch(endpoint, { method: 'POST', body: new URLSearchParams({ documentType: '0' }) });
        assert.equal(anonymous.status, 200);
        assert.equal(parser.parse(await anonymous.text()).conmas.error.code, '5');
        const seed = await fetch(`${base}/Test/GetTest.aspx?value=session`);
        await seed.text();
        const cookie = seed.headers.get('set-cookie')!.split(';')[0]!,
          sid = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1))
            .slice(2)
            .split('.')[0]!;
        const state = await new Promise<session.SessionData>((resolve, reject) =>
          store.get(sid, (error, data) => (error ? reject(error) : resolve(data!))),
        );
        state.clientAccount = {
          userId: 'reader',
          userName: 'Reader',
          physicalId: 'unregistered-fixture',
          client: 'iPad',
          version: '999.9.9999',
          platform: 'Windows',
          address: '127.0.0.1',
          sessionId: sid,
        };
        await new Promise<void>((resolve, reject) =>
          store.set(sid, state, (error) => (error ? reject(error) : resolve())),
        );
        const body = () => {
          const form = new FormData();
          form.append('documentType', '0');
          form.append('documentName', 'HTTP upload');
          form.append('arbitrary', new Blob(['first file'], { type: 'application/pdf' }), 'first.pdf');
          form.append('ignored', new Blob(['ignored']), 'second.irfd');
          return form;
        };
        const denied = await fetch(endpoint, { method: 'POST', headers: { cookie }, body: body() });
        assert.equal(denied.status, 200);
        assert.equal(parser.parse(await denied.text()).conmas.error.code, '3');
        assert.equal((await db.query('SELECT * FROM pg_temp.mst_common_document')).rowCount, 0);
        await db.query('UPDATE pg_temp.mst_group SET role_library_create=1,role_library_update=1 WHERE group_id=1');
        const response = await fetch(endpoint, { method: 'POST', headers: { cookie }, body: body() });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'text/xml; charset=utf-8');
        assert.equal(parser.parse(await response.text()).conmas.error.code, '0');
        const stored = (await db.query('SELECT * FROM pg_temp.mst_common_document')).rows[0];
        assert.equal(stored.document_name_org, 'first.pdf');
        assert.deepEqual(stored.document_file, Buffer.from('first file'));
        assert.equal(stored.sys_update_user, 'reader');
        const download = await fetch(
          `${base}/GeneralProcess.aspx?target=Library&process=DocumentDownload&documentType=0&documentId=${stored.document_id}`,
          { headers: { cookie } },
        );
        assert.equal(download.headers.get('content-type'), 'application/pdf');
        assert.equal(await download.text(), 'first file');
        const update = await fetch(endpoint, {
          method: 'POST',
          headers: { cookie },
          body: new URLSearchParams({
            documentType: '0',
            documentName: 'HTTP upload',
            manualDownload: '1',
            lifeTime: '60',
          }),
        });
        assert.equal(parser.parse(await update.text()).conmas.error.code, '0');
        assert.equal(
          (await db.query('SELECT document_life_time FROM pg_temp.mst_common_document')).rows[0].document_life_time,
          60,
        );
        const invalid = new FormData();
        invalid.append('documentType', '0');
        invalid.append('file', new Blob(['irfd']), 'invalid.IRFD');
        assert.equal(
          parser.parse(await (await fetch(endpoint, { method: 'POST', headers: { cookie }, body: invalid })).text())
            .conmas.error.code,
          '2',
        );
        const get = await fetch(endpoint, { headers: { cookie } });
        assert.equal(parser.parse(await get.text()).conmas.error.code, '4');
        const crossSite = await fetch(endpoint, {
          method: 'POST',
          headers: { cookie, origin: 'https://other.invalid' },
          body: body(),
        });
        assert.equal(crossSite.status, 403);
        await crossSite.text();
        const mapped = await fetch(`${base}/ConMasIReporter.aspx`, {
          method: 'POST',
          headers: { cookie },
          body: new URLSearchParams({ command: 'DocumentRegistration' }),
        });
        assert.equal(mapped.status, 501);
        await mapped.text();
        assert.equal(uploads.length, 5);
        for (const path of uploads) await assert.rejects(readFile(path), { code: 'ENOENT' });
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }
    }),
);

test(
  'Library deletion shares source resolution/permissions, detaches report links and cascades common locks/roles without deleting IRFD history',
  enabled,
  async () =>
    fixture(async (db) => {
      const directory = await mkdtemp('/tmp/opencode/client-library-delete-');
      try {
        await db.query(
          "INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (2,'LIBRARY','BASE_FOLDER',$1)",
          [directory],
        );
        await db.query(`INSERT INTO pg_temp.mst_common_document (document_id,document_name,document_save_kbn) VALUES (1,'Denied',0),(2,'Child',2),(3,'Duplicate',0),(4,'Duplicate',0);
      INSERT INTO pg_temp.mst_common_document_role (document_id,group_id) VALUES (1,2);
      INSERT INTO pg_temp.common_document_label (document_id,mst_label_id) VALUES (2,11);
      INSERT INTO pg_temp.document_lock (document_id,user_id) VALUES (2,'other');
      INSERT INTO pg_temp.common_document_irfd_role (document_id,group_id,role_irfd_read) VALUES (2,1,1);
      INSERT INTO pg_temp.common_document_irfd (document_id,rev_no,irfd_file,irfd_file_name) VALUES (2,1,'history','history.irfd');
      INSERT INTO pg_temp.mst_report_document (document_id,document_name,document_save_kbn) VALUES (2,'Report',1);
      INSERT INTO pg_temp.def_report_document (def_top_id,document_id) VALUES (10,2),(11,2);
      INSERT INTO pg_temp.rep_report_document (rep_top_id,document_id) VALUES (12,2);
      INSERT INTO pg_temp.report_document_label (document_id,mst_label_id) VALUES (2,11);
      INSERT INTO pg_temp.mst_report_document_role (document_id,group_id) VALUES (2,1);
      INSERT INTO pg_temp.mst_image_document (document_id,document_name,document_save_kbn) VALUES (2,'Image',0)`);
        const remove = (params: Record<string, string>, user = 'reader') => deleteClientApiDocument(db, user, params);
        assert.match(await remove({}), /<code>2<\/code>/);
        assert.match(await remove({ documentType: '0', documentId: '99' }, 'denied'), /<code>8<\/code>/);
        assert.match(await remove({ documentType: '0', documentName: 'Duplicate' }, 'denied'), /<code>9<\/code>/);
        assert.match(
          await remove({ documentType: '0', documentId: '2' }),
          /Unauthorized to delete documents in library/,
        );
        await db.query('UPDATE pg_temp.mst_group SET role_library_delete=1 WHERE group_id=1');
        assert.match(await remove({ documentType: '0', documentId: '1' }), /Unauthorized to refer the document/);
        assert.match(
          await remove({ documentType: '0', documentName: 'Child', labelPath: 'Parent/Child' }),
          /Unauthorized to refer the label/,
        );
        await writeFile(join(directory, '2'), 'target');
        await writeFile(join(directory, '_2'), 'backup');
        await writeFile(join(directory, 'unrelated'), 'keep');
        assert.match(await remove({ documentType: '0', documentId: '2', downloadType: 'invalid' }), /<code>0<\/code>/);
        for (const table of [
          'mst_common_document',
          'common_document_label',
          'common_document_irfd_role',
          'document_lock',
        ])
          assert.equal((await db.query(`SELECT * FROM pg_temp.${table} WHERE document_id=2`)).rowCount, 0);
        assert.equal((await db.query('SELECT * FROM pg_temp.common_document_irfd WHERE document_id=2')).rowCount, 1);
        await assert.rejects(readFile(join(directory, '2')), { code: 'ENOENT' });
        await assert.rejects(readFile(join(directory, '_2')), { code: 'ENOENT' });
        assert.equal(await readFile(join(directory, 'unrelated'), 'utf8'), 'keep');
        assert.equal((await db.query('SELECT * FROM pg_temp.mst_report_document WHERE document_id=2')).rowCount, 1);
        assert.match(await remove({ documentType: '1', documentId: '2' }), /<code>0<\/code>/);
        for (const table of [
          'mst_report_document',
          'report_document_label',
          'mst_report_document_role',
          'def_report_document',
          'rep_report_document',
        ])
          assert.equal((await db.query(`SELECT * FROM pg_temp.${table} WHERE document_id=2`)).rowCount, 0);
        assert.match(await remove({ documentType: '2', documentName: 'Image' }, 'conmasadmin'), /<code>0<\/code>/);
        assert.match(await remove({ documentType: '0', documentId: '1' }, 'conmasadmin'), /<code>0<\/code>/);
        assert.equal((await db.query('SELECT * FROM pg_temp.mst_common_document')).rowCount, 2);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }),
);

test(
  'Library deletion rolls back database mutations on delete/file errors and preserves an orphan backup when the target file is absent',
  enabled,
  async () =>
    fixture(async (db) => {
      const directory = await mkdtemp('/tmp/opencode/client-library-delete-');
      try {
        await db.query(
          "INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (2,'LIBRARY','BASE_FOLDER',$1)",
          [directory],
        );
        await db.query(`INSERT INTO pg_temp.mst_common_document (document_id,document_name,document_save_kbn) VALUES (1,'One',0);
      INSERT INTO pg_temp.common_document_label (document_id,mst_label_id) VALUES (1,11);
      INSERT INTO pg_temp.mst_common_document_role (document_id,group_id) VALUES (1,2);
      CREATE FUNCTION pg_temp.reject_document_delete() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''fixture delete error''; END';
      CREATE TRIGGER reject_document_delete BEFORE DELETE ON pg_temp.mst_common_document FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_document_delete()`);
        const remove = () => deleteClientApiDocument(db, 'conmasadmin', { documentType: '0', documentId: '1' });
        await writeFile(join(directory, '1'), 'target');
        await assert.rejects(remove(), /fixture delete error/);
        for (const table of ['mst_common_document', 'common_document_label', 'mst_common_document_role'])
          assert.equal((await db.query(`SELECT * FROM pg_temp.${table} WHERE document_id=1`)).rowCount, 1);
        assert.equal(await readFile(join(directory, '1'), 'utf8'), 'target');
        await db.query('DROP TRIGGER reject_document_delete ON pg_temp.mst_common_document');
        await rm(join(directory, '1'));
        const failingDb = {
          connect: async () => {
            const client = await db.connect();
            return {
              release: client.release,
              query: async (sql: string, values?: unknown[]) => {
                if (sql.startsWith('SELECT com_value')) throw new Error('fixture file setting error');
                return client.query(sql, values);
              },
            };
          },
        } as unknown as pg.Pool;
        await assert.rejects(
          deleteClientApiDocument(failingDb, 'conmasadmin', { documentType: '0', documentId: '1' }),
          /fixture file setting error/,
        );
        assert.equal((await db.query('SELECT * FROM pg_temp.common_document_label')).rowCount, 1);
        await writeFile(join(directory, '_1'), 'orphan');
        assert.match(await remove(), /<code>0<\/code>/);
        assert.equal(await readFile(join(directory, '_1'), 'utf8'), 'orphan');
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }),
);

test(
  'GeneralProcess Library list filters all categories, scopes, literal ILIKE, date boundaries, pagination and direct-only label roles',
  enabled,
  async () =>
    fixture(async (db) => {
      await db.query(`INSERT INTO pg_temp.mst_common_document (document_id,document_name,document_type,document_save_kbn,document_mobile_save,document_path,document_manual_download,document_life_time,use_end_time,is_other_app_open,sys_regist_user,sys_regist_time,sys_update_user,sys_update_time) VALUES
    (1,'Name %_\\ &','PDF',0,1,NULL,0,60,NULL,NULL,'creator','2026-01-01 23:59:59','editor','2026-11-07 23:59:59'),
    (2,'Child','URL',1,0,'https://example.invalid',1,NULL,'2026-11-07 13:00',0,'creator','2026-01-02','editor','2026-11-07 11:00'),
    (3,'Expired','PDF',0,1,NULL,0,0,'2026-11-07 00:00',1,'creator','2026-01-01','editor','2026-11-07 10:00'),
    (4,'Denied','PDF',0,1,NULL,0,0,NULL,1,'creator','2026-01-01','editor','2026-11-07 09:00'),
    (5,'FreeDraw','PDF',2,1,NULL,1,10,NULL,1,'creator','2026-01-01','editor','2026-11-07 08:00');
    INSERT INTO pg_temp.mst_common_document_role (document_id,group_id) VALUES (4,2);
    INSERT INTO pg_temp.common_document_irfd_role (document_id,group_id,role_irfd_read) VALUES (5,1,1);
    INSERT INTO pg_temp.common_document_label (document_id,mst_label_id) VALUES (2,11),(2,12);
    INSERT INTO pg_temp.mst_report_document (document_id,document_name,document_save_kbn) VALUES (6,'Report category',0);
    INSERT INTO pg_temp.mst_image_document (document_id,document_name,document_save_kbn) VALUES (7,'Image category',0)`);
      const list = async (params: Record<string, string> = {}, user = 'reader') =>
        documents(await getClientApiDocumentList(db, user, params, new Date(2026, 10, 7, 12)));
      assert.deepEqual(
        (await list()).map((row) => row.documentId),
        ['1', '2', '5'],
      );
      const child = (await list())[1]!;
      assert.equal(child.documentType, '0');
      assert.equal(child.url, 'https://example.invalid');
      assert.equal(child.expire, '2026/11/07 13:00:00');
      assert.deepEqual(child.labels, { label: { labelId: '11', labelPath: 'Parent/Child' } });
      const first = (await list())[0]!;
      assert.equal(first.lifeTime, '60');
      assert.equal(first.useInOtherApp, '');
      assert.equal(first.datetimeFirstCreated, '2026/01/01 23:59:59');
      assert.deepEqual(
        (await list({ scopeOfLabel: '1' })).map((row) => row.documentId),
        ['1', '5'],
      );
      assert.deepEqual(
        (await list({ scopeOfLabel: '2', labelPath: 'Parent/Child' })).map((row) => row.documentId),
        ['2'],
      );
      assert.deepEqual(await list({ scopeOfLabel: '2', labelPath: 'Other' }), []);
      assert.equal((await list({ scopeOfLabel: '2', labelPath: 'Other' }, 'conmasadmin')).length, 1);
      assert.deepEqual(
        (await list({ scopeOfExpiration: '1' })).map((row) => row.documentId),
        ['1', '2', '3', '5'],
      );
      assert.deepEqual(
        (await list({ scopeOfExpiration: '2' })).map((row) => row.documentId),
        ['3'],
      );
      assert.deepEqual(
        (await list({ scopeOfExpiration: '1' }, 'conmasadmin')).map((row) => row.documentId),
        ['1', '2', '3', '4', '5'],
      );
      assert.equal((await list({ documentName: '%_\\' }))[0]?.documentId, '1');
      assert.deepEqual(await list({ documentName: "' OR 1=1--" }), []);
      assert.equal((await list({ storageMode: '1', mobileSave: '0' }))[0]?.documentId, '2');
      assert.deepEqual(
        (
          await list({
            userFirstCreated: 'CREAT',
            userLastModified: 'EDIT',
            dateFirstCreatedFrom: '2026/01/01',
            dateFirstCreatedTo: '2026/01/01',
            dateLastModifiedFrom: '2026/11/07',
            dateLastModifiedTo: '2026/11/07',
          })
        ).map((row) => row.documentId),
        ['1', '5'],
      );
      assert.equal((await list({ limitOfList: '1', skipOver: '1' }))[0]?.documentId, '2');
      assert.equal((await list({ documentType: '1' }))[0]?.documentId, '6');
      assert.equal((await list({ documentType: '2' }))[0]?.documentId, '7');
      assert.deepEqual(await list({ documentId: '-1' }), []);
      await db.query('INSERT INTO pg_temp.common_document_label_role (mst_label_id,group_id) VALUES (11,2)');
      assert.equal((await list())[1]?.documentId, '2');
      assert.deepEqual((await list())[1]?.labels, '');
      assert.deepEqual(await list({ scopeOfLabel: '2', labelPath: 'Parent/Child' }), []);
    }),
);

test(
  'GeneralProcess Library download preserves ID/name resolution, no-expiry behavior, validation/duplication/privilege/storage precedence',
  enabled,
  async () =>
    fixture(async (db) => {
      await db.query(`INSERT INTO pg_temp.mst_common_document (document_id,document_name,document_name_org,document_save_kbn,content_type,document_file,use_end_time) VALUES
    (1,'Plain','日本 !.pdf',0,'application/pdf','expired','2000-01-01'),(2,'Child','child.pdf',0,'application/pdf','child',NULL),
    (3,'Duplicated','three.pdf',0,'application/pdf','three',NULL),(4,'Duplicated','four.pdf',0,'application/pdf','four',NULL),
    (5,'URL','url.pdf',1,'application/pdf','url',NULL),(6,'Null','null.pdf',0,'application/pdf',NULL,NULL);
    INSERT INTO pg_temp.common_document_label (document_id,mst_label_id) VALUES (2,11);
    INSERT INTO pg_temp.mst_report_document (document_id,document_name,document_name_org,document_save_kbn,content_type,document_file) VALUES (1,'Report','report.pdf',0,'application/pdf','report');
    INSERT INTO pg_temp.mst_image_document (document_id,document_name,document_name_org,document_save_kbn,content_type,document_file) VALUES (1,'Image','image.png',0,'image/png','image')`);
      const download = (params: Record<string, string>, user = 'reader') =>
        getClientApiDocumentDownload(db, user, params);
      assert.deepEqual(await download({ documentType: '0', documentId: ' +1 ' }), {
        data: Buffer.from('expired'),
        filename: '日本 !.pdf',
        contentType: 'application/pdf',
      });
      assert.deepEqual(await download({ documentType: '1', documentId: '1' }), {
        data: Buffer.from('report'),
        filename: 'report.pdf',
        contentType: 'application/pdf',
      });
      assert.deepEqual(await download({ documentType: '2', documentId: '1' }), {
        data: Buffer.from('image'),
        filename: 'image.png',
        contentType: 'image/png',
      });
      assert.match((await download({})) as string, /<code>2<\/code>/);
      assert.match(
        (await download({ documentType: '1', documentId: '1', downloadType: '1' })) as string,
        /It must be &apos;0&apos;/,
      );
      assert.match((await download({ documentType: '0', documentId: '99' }, 'denied')) as string, /<code>8<\/code>/);
      assert.match(
        (await download({ documentType: '0', documentName: 'Duplicated' }, 'denied')) as string,
        /<code>9<\/code>/,
      );
      assert.match((await download({ documentType: '0', documentId: '5' }, 'denied')) as string, /<code>3<\/code>/);
      assert.match((await download({ documentType: '0', documentId: '5' })) as string, /<code>1000<\/code>/);
      assert.match((await download({ documentType: '0', documentName: 'Child' })) as string, /<code>8<\/code>/);
      assert.match(
        (await download({ documentType: '0', documentName: 'Child', labelPath: 'Parent/Child' })) as string,
        /Unauthorized to refer the label &apos;id: 10&apos;/,
      );
      assert.deepEqual(
        await download({ documentType: '0', documentName: 'Child', labelPath: 'Parent/Child' }, 'conmasadmin'),
        { data: Buffer.from('child'), filename: 'child.pdf', contentType: 'application/pdf' },
      );
      assert.equal(typeof (await download({ documentType: '0', documentId: '2' })), 'object');
      await assert.rejects(download({ documentType: '0', documentId: '2', labelPath: '' }), /Missing label path/);
      await assert.rejects(download({ documentType: '0', documentId: '2147483648' }), /Invalid API integer/);
      await assert.rejects(download({ documentType: '0', documentId: '6' }), /Invalid library file response/);
      await db.query('INSERT INTO pg_temp.mst_common_document_role (document_id,group_id) VALUES (1,2)');
      assert.match(
        (await download({ documentType: '0', documentId: '1' })) as string,
        /Unauthorized to refer the document/,
      );
      assert.equal(typeof (await download({ documentType: '0', documentId: '1' }, 'conmasadmin')), 'object');
    }),
);

test(
  'GeneralProcess Library download uses file storage and unsorted IRFD without inventing license/lock/log side effects',
  enabled,
  async () =>
    fixture(async (db) => {
      const directory = await mkdtemp('/tmp/opencode/client-library-api-');
      try {
        await db.query(
          "UPDATE pg_temp.mst_common SET com_value='0'; INSERT INTO pg_temp.mst_common_document (document_id,document_name,document_name_org,document_save_kbn,content_type,document_file) VALUES (1,'FD','one.pdf',2,'application/pdf','db'),(2,'Missing','missing.pdf',0,'application/pdf','db')",
        );
        await db.query(
          "INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (2,'LIBRARY','BASE_FOLDER',$1)",
          [directory],
        );
        await db.query(`INSERT INTO pg_temp.common_document_irfd_role (document_id,group_id,role_irfd_read) VALUES (1,1,1);
      INSERT INTO pg_temp.common_document_irfd (document_id,rev_no,irfd_file,irfd_file_name) VALUES (1,1,'first','first.irfd'),(1,2,'latest','latest.irfd')`);
        const download = (params: Record<string, string>) =>
          getClientApiDocumentDownload(db, 'reader', { documentType: '0', documentId: '1', ...params });
        assert.match((await download({ downloadType: '1' })) as string, /document file does not exist/);
        await writeFile(join(directory, '1'), Buffer.from('disk'));
        assert.deepEqual(await download({}), {
          data: Buffer.from('disk'),
          filename: 'one.pdf',
          contentType: 'application/pdf',
        });
        assert.deepEqual(await download({ downloadType: '1' }), {
          data: Buffer.from('first'),
          filename: 'first.irfd',
          contentType: 'application/octet-stream',
        });
        await db.query('DELETE FROM pg_temp.common_document_irfd');
        assert.match((await download({ downloadType: '1' })) as string, /No data found/);
        await db.query(
          "INSERT INTO pg_temp.common_document_irfd (document_id,rev_no,irfd_file,irfd_file_name) VALUES (1,1,''::bytea,'first.irfd')",
        );
        assert.match((await download({ downloadType: '1' })) as string, /byte array is null or empty/);
        await db.query("UPDATE pg_temp.common_document_irfd SET irfd_file='bytes',irfd_file_name=''");
        assert.match((await download({ downloadType: '1' })) as string, /irfdFileName is null or empty/);
        await db.query('UPDATE pg_temp.common_document_irfd SET irfd_file=NULL');
        await assert.rejects(download({ downloadType: '1' }), /Null IRFD database field/);
        await db.query("UPDATE pg_temp.mst_common SET com_value='2' WHERE com_id=1");
        await assert.rejects(download({}), /Unknown library file location/);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }),
);
