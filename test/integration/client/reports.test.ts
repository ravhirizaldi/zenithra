import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crc32 } from 'node:zlib';
import express from 'express';
import session from 'express-session';
import pg from 'pg';
import { XMLParser } from 'fast-xml-parser';
import { registerClientRoutes } from '../../../src/routes/client.js';
import { clientSession } from '../../../src/middleware/client-session.js';
import {
  getDefinitionDetail,
  getDefinitionList,
  getReportDetail,
  getReportList,
} from '../../../src/models/client-definitions.js';
import {
  defaultReportLayers,
  getReportDownload,
  getReportFreeDraw,
  reportDownloadSheet,
  reportDownloadTop,
  reportSheetBinaries,
  ReportUnsupported,
  type ReportDownload,
} from '../../../src/models/client-reports.js';
import { reportNameDate, setReportAuditFields, setReportName } from '../../../src/models/client-report-name.js';
import { reportTableValue, saveReportTables } from '../../../src/models/client-report-tables.js';
import { root, must, serialize, replace, children, field } from '../../../src/models/client-definition-xml.js';
import {
  beginReportUpload,
  cleanupReportUpload,
  finishReportUpload,
  checkReportSaveFeatures,
  stageReportSheet,
  stageReportFreeDrawInfo,
  stageReportFreeDraw,
  type ReportUpload,
  type ReportSheetDiagnostic,
} from '../../../src/models/client-report-upload.js';
import { mkdtemp, writeFile, rm, stat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { requestLog } from '../../../src/middleware/request-log.js';
import { reportApplicantLocked } from '../../../src/models/client-report-lock.js';
import { setTimeout } from 'node:timers/promises';

const enabled = { skip: !process.env.DATABASE_URL },
  parser = new XMLParser({ parseTagValue: false });
const actor = {
  userId: 'windows-fixture',
  terminalId: '7',
  client: 'iPad',
  platform: 'Windows',
  version: '999.9.9999',
};
const sheet = `<sheet><sheetNo>1</sheetNo><defSheetId>10</defSheetId><repSheetId>20</repSheetId><defSheetName>Sheet</defSheetName><repSheetName>Sheet</repSheetName><backgroundImage/><inputImage/><thumbnail/><references/><clusters>
  <cluster><sheetNo>1</sheetNo><clusterId>0</clusterId><name>Text</name><type>KeyboardText</type><value>saved text</value><readOnly>0</readOnly></cluster>
  <cluster><sheetNo>1</sheetNo><clusterId>1</clusterId><name>Drawing</name><type>FreeDraw</type><value/><readOnly>0</readOnly></cluster>
  <cluster><sheetNo>1</sheetNo><clusterId>2</clusterId><name>Sound</name><type>AudioRecording</type><value/><readOnly>0</readOnly></cluster>
  <cluster><sheetNo>1</sheetNo><clusterId>3</clusterId><name>Hidden</name><type>KeyboardText</type><value>original</value><readOnly>0</readOnly></cluster>
  </clusters></sheet>`;
const xml = `<conmas><top><defTopId>1</defTopId><defTopName>Windows form</defTopName><repTopId>2</repTopId><repTopName>Windows report</repTopName><reportType>1</reportType><publicStatus>2</publicStatus><sheetCount>1</sheetCount><editStatus>1</editStatus><thumbnail/><backgroundImage/><locked>0</locked><readOnly>0</readOnly><labels/><reportCopyType>0</reportCopyType><sheets>${sheet}</sheets></top></conmas>`;
async function fixture(run: (db: pg.Pool, connection: pg.PoolClient) => Promise<void>) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }),
    connection = await pool.connect();
  try {
    for (const table of [
      'mst_common',
      'mst_mail',
      'mst_direct',
      'mst_report_table',
      'mst_user',
      'mst_terminal',
      'mst_group',
      'mst_group_affiation',
      'def_top',
      'def_current',
      'def_role',
      'def_lock',
      'def_label',
      'def_rep_label',
      'mst_label_def',
      'def_label_role',
      'def_sheet',
      'def_cluster',
      'def_cluster_role',
      'def_cluster_refer',
      'def_reference',
      'rep_top',
      'rep_current',
      'rep_role',
      'rep_lock',
      'rep_label',
      'mst_label_rep',
      'rep_label_role',
      'rep_sheet',
      'rep_cluster',
      'rep_cluster_role',
      'rep_cluster_refer',
      'rep_reference',
      'rep_layer',
      'rep_fd_sheet',
      'rep_top_app',
      'rep_cluster_draw',
      'rep_layer_draw',
      'def_report_document',
      'rep_report_document',
      'def_report_custom_table',
      'rep_report_custom_table',
      'binder_rep_src',
    ]) {
      await connection.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    await connection.query(
      'CREATE TEMP SEQUENCE rep_top_rep_top_id_seq START 100;CREATE TEMP SEQUENCE rep_sheet_rep_sheet_id_seq START 200;CREATE TEMP SEQUENCE mst_label_def_mst_label_id_seq START 1000',
    );
    await connection.query(
      'ALTER TABLE pg_temp.rep_sheet ADD FOREIGN KEY (rep_top_id) REFERENCES pg_temp.rep_top(rep_top_id) ON DELETE CASCADE;ALTER TABLE pg_temp.rep_cluster ADD FOREIGN KEY (rep_sheet_id) REFERENCES pg_temp.rep_sheet(rep_sheet_id) ON DELETE CASCADE',
    );
    await connection.query(`INSERT INTO pg_temp.mst_user (user_id,user_name) VALUES ('windows-fixture','Windows fixture');
      INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (-101,'OUTPUT_SETTING','TMP_XML','false'),(-102,'OUTPUT_SETTING','FINISH','false'),(-103,'OUTPUT_SETTING','EDIT','false');
      INSERT INTO pg_temp.mst_group (group_id,group_name,deleted) VALUES (4,'Readers',0),(5,'Other',0);
      INSERT INTO pg_temp.mst_group_affiation (user_id,group_id) VALUES ('windows-fixture',4);
      INSERT INTO pg_temp.mst_terminal (term_id,term_type,physical_id,approver,deleted) VALUES (7,'iPad','windows-device','admin',0);`);
    await connection.query(
      "INSERT INTO pg_temp.def_top (def_top_id,def_top_org,def_top_name,report_type,deleted,public_status,xml_data,thumbnail_file,background_image_file,sys_regist_time,sys_update_time) VALUES (1,1,'Windows form',1,0,2,$1,$2,$3,now(),now())",
      [xml, Buffer.from('thumbnail'), Buffer.from('pdf')],
    );
    await connection.query(
      "INSERT INTO pg_temp.rep_top (rep_top_id,rep_top_org,def_top_id,rep_top_name,report_type,deleted,public_status,edit_refer_status,xml_data,thumbnail_file,background_image_file,sys_regist_user,sys_update_user,sys_regist_time,sys_update_time) VALUES (2,2,1,'Windows report',1,0,2,1,$1,$2,$3,'windows-fixture','windows-fixture',now(),now())",
      [xml, Buffer.from('thumbnail'), Buffer.from('pdf')],
    );
    await connection.query(`INSERT INTO pg_temp.def_current (def_top_id,def_top_org) VALUES (1,1);
      INSERT INTO pg_temp.rep_current (rep_top_id,rep_top_org) VALUES (2,2);
      INSERT INTO pg_temp.def_role (def_top_id,group_id,role_def_read,role_def_update,role_rep_create,role_rep_read) VALUES (1,4,1,0,1,1);
      INSERT INTO pg_temp.rep_role (rep_top_id,group_id,role_rep_read,role_rep_update) VALUES (2,4,1,1);
      INSERT INTO pg_temp.def_sheet (def_top_id,def_sheet_id,def_sheet_no) VALUES (1,10,1);
      INSERT INTO pg_temp.rep_sheet (rep_top_id,rep_sheet_id,rep_sheet_no,def_sheet_id) VALUES (2,20,1,10);
      INSERT INTO pg_temp.def_cluster (def_sheet_id,cluster_id,cluster_type,cluster_name) VALUES (10,0,'KeyboardText','Text'),(10,1,'FreeDraw','Drawing'),(10,2,'AudioRecording','Sound'),(10,3,'KeyboardText','Hidden');
      INSERT INTO pg_temp.rep_cluster (rep_sheet_id,cluster_id,cluster_type,cluster_name) SELECT 20,cluster_id,cluster_type,cluster_name FROM pg_temp.def_cluster;
      INSERT INTO pg_temp.def_cluster_role (def_sheet_id,cluster_id,group_id) VALUES (10,3,5);
      INSERT INTO pg_temp.def_cluster_refer (def_sheet_id,cluster_id,group_id) VALUES (10,3,5);
      INSERT INTO pg_temp.rep_cluster_role (rep_sheet_id,cluster_id,group_id) VALUES (20,3,5);
      INSERT INTO pg_temp.rep_cluster_refer (rep_sheet_id,cluster_id,group_id) VALUES (20,3,5);`);
    const db = {
      query: connection.query.bind(connection),
      connect: async () => ({ query: connection.query.bind(connection), release() {} }),
    } as unknown as pg.Pool;
    await run(db, connection);
  } finally {
    connection.release(true);
    await pool.end();
  }
}
function unzip(data: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (data.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(data.readUInt16LE(offset + 8), 0);
    const size = data.readUInt32LE(offset + 18),
      length = data.readUInt16LE(offset + 26),
      extra = data.readUInt16LE(offset + 28);
    const name = data.subarray(offset + 30, offset + 30 + length).toString(),
      body = data.subarray(offset + 30 + length + extra, offset + 30 + length + extra + size);
    assert.equal(data.readUInt32LE(offset + 14), crc32(body));
    assert(!entries.has(name));
    entries.set(name, body);
    offset += 30 + length + extra + size;
  }
  return entries;
}
const items = (text: string) => {
  const list = parser.parse(text).conmas.items.item;
  return !list ? [] : Array.isArray(list) ? list : [list];
};

test('staged sheet validation and exact legacy layer defaults preserve existing fields', () => {
  const node = root('<sheet><layers><layer><layerNo>8</layerNo><value>keep</value></layer></layers></sheet>');
  defaultReportLayers(node);
  defaultReportLayers(node);
  assert.deepEqual(parser.parse(serialize(node)).sheet.layers.layer, {
    layerNo: '8',
    value: 'keep',
    type: 'FreeDraw',
    inputParameters: 'Required=0;Width=8;Color=0,0,0',
  });
  assert.equal(parser.parse(reportDownloadSheet(undefined, '2', '1', false)).conmas.error.code, '2');
  const download = { xml, topId: 2, definition: false };
  assert.equal(parser.parse(reportDownloadSheet(download, '1', '1', false)).conmas.error.code, '2');
  assert.equal(parser.parse(reportDownloadSheet(download, '2', '9', false)).conmas.error.code, '8');
  assert.equal(parser.parse(reportDownloadTop(download)).conmas.top.sheets, '');
  assert.equal(parser.parse(download.xml).conmas.top.sheets.sheet.sheetNo, '1');
});

test('report naming follows source part order, creation/regeneration gates and numeric .NET date formats', () => {
  const now = new Date(2026, 10, 7, 13, 4, 9, 123);
  assert.equal(reportNameDate(now, 'yyyyMMddHHmm'), '202611071304');
  assert.equal(reportNameDate(now, "yyyy/MM/dd 'at' HH:mm:ss.fff"), '2026/11/07 at 13:04:09.123');
  assert.equal(reportNameDate(now, 'yy-M-d h:mm:ss'), '26-11-7 1:04:09');
  assert.equal(reportNameDate(now, 'yyyy\\y'), '2026y');
  for (const format of ['MMM dd', 'zzz', 'd', "yyyy 'broken", 'yyyy\\'])
    assert.throws(
      () => reportNameDate(now, format),
      (error) => error instanceof ReportUnsupported && error.code === 'report_name_date_format',
    );
  const parts =
    '<nameParts><part><partId>5</partId><type>report</type><value>defTopName</value></part><part><partId>1</partId><type>user</type><value>id</value></part><part><partId>2</partId><type>value</type><value>_</value></part><part><partId>3</partId><type>dateTime</type><value>yyyyMMddHHmm</value></part><part><partId>4</partId><type>value</type><value>_</value></part></nameParts>';
  const top = must(root(xml.replace('<defTopId>', '<registUser>creator</registUser>' + parts + '<defTopId>')), 'top');
  setReportName(top, now, false);
  assert.equal(parser.parse(serialize(top)).top.repTopName, 'Windows report');
  setReportName(top, now, true);
  assert.equal(parser.parse(serialize(top)).top.repTopName, 'creator_202611071304_Windows form');
  const fromClusters = must(
    root(
      xml.replace(
        '<defTopId>',
        '<nameRegenerate>1</nameRegenerate><nameParts><part><partId>1</partId><type>inputValue</type><value>1,0</value></part></nameParts><defTopId>',
      ),
    ),
    'top',
  );
  setReportName(fromClusters, now, false);
  assert.equal(parser.parse(serialize(fromClusters)).top.repTopName, 'saved text');
});

test('server audit clusters use original creator/current editor, source name modes and English/Japanese weekdays', () => {
  const top = root(
    '<top><registUser>creator</registUser><registUserName>Original</registUserName><registTime>2026/11/07 13:04:09</registTime><updateUser>editor</updateUser><updateUserName>Current</updateUserName><updateTime>2026/11/08 15:20:30</updateTime></top>',
  );
  const cluster = (type: string, parameters: string, id: number) =>
    `<cluster><clusterId>${id}</clusterId><type>${type}</type><inputParameters>${parameters}</inputParameters><value>untrusted</value></cluster>`;
  const sheet = root(
    '<sheet><clusters>' +
      cluster('Registration', 'DisplayUserName=UserIDandName', 1) +
      cluster('LatestUpdate', 'DisplayUserName=UserName', 2) +
      cluster('RegistrationDate', 'DateFormat=yyyy/MM/dd(ccc)', 3) +
      cluster('LatestUpdateDate', 'DateFormat=yyyy/MM/dd(ccc)', 4) +
      cluster('Registration', 'DisplayUserName=UserID', 5) +
      '</clusters></sheet>',
  );
  assert.deepEqual(setReportAuditFields(top, sheet), ['1', '2', '3', '4', '5']);
  let saved = parser.parse(serialize(sheet)).sheet.clusters.cluster;
  assert.deepEqual(
    saved.map((node: { value: string }) => node.value),
    ['creator:Original', 'Current', '2026/11/07', '2026/11/08', 'creator'],
  );
  assert.equal(saved[2].displayValue, '2026/11/07(Sat)');
  assert.equal(saved[3].displayValue, '2026/11/08(Sun)');
  setReportAuditFields(top, sheet, 'ja-JP');
  saved = parser.parse(serialize(sheet)).sheet.clusters.cluster;
  assert.equal(saved[2].displayValue, '2026/11/07(土)');
  assert.equal(saved[3].displayValue, '2026/11/08(日)');
  assert.throws(() => setReportAuditFields(top, sheet, 'de-DE'), ReportUnsupported);
  replace(top, 'updateTime', '2026/02/29 00:00:00');
  assert.throws(() => setReportAuditFields(top, sheet), /Invalid report audit date/);
});

test(
  'rich report saves approval identities/signatures, server audit fields, pictures and FreeDraw atomically; updates preserve omitted approvals',
  enabled,
  async () =>
    fixture(async (db, connection) => {
      const directory = await mkdtemp(join(tmpdir(), 'conmas-rich-report-'));
      let upload: ReportUpload | undefined;
      const file = async (name: string, data: string): Promise<Express.Multer.File> => {
        const path = join(directory, name);
        await writeFile(path, data);
        return { fieldname: name, path, size: Buffer.byteLength(data) } as Express.Multer.File;
      };
      const types = [
        'Create',
        'Inspect',
        'Approve',
        'Approve',
        'Registration',
        'RegistrationDate',
        'LatestUpdate',
        'LatestUpdateDate',
        'Image',
      ];
      const clusters = types
        .map(
          (type, index) =>
            `<cluster><sheetNo>1</sheetNo><clusterId>${index + 4}</clusterId><name>${type} ${index}</name><type>${type}</type><value/><displayValue/><readOnly>0</readOnly><inputParameters>${type.endsWith('Date') ? 'DateFormat=yyyy/MM/dd(ccc)' : ['Registration', 'LatestUpdate'].includes(type) ? 'DisplayUserName=UserIDandName' : 'Required=0;SignType=0'}</inputParameters><management><mail><apply/><approve/></mail><direct><apply/></direct><webhook><approve/></webhook></management></cluster>`,
        )
        .join('');
      const source = xml
        .replace('<defTopId>', '<cooperationTable>1</cooperationTable><defTopId>')
        .replace('</clusters>', clusters + '</clusters>');
      const top =
        '<conmas><top><defTopId>1</defTopId><repTopId/><repTopName>rich report</repTopName><editStatus>1</editStatus><thumbnail/><sheets/></top></conmas>';
      const incoming = (clusters: string) =>
        `<conmas><sheet><defSheetId>10</defSheetId><sheetNo>1</sheetNo><clusters>${clusters}</clusters></sheet></conmas>`;
      try {
        await connection.query('UPDATE pg_temp.def_top SET xml_data=$1', [source]);
        await connection.query('UPDATE pg_temp.def_role SET role_rep_update=1');
        await connection.query('UPDATE pg_temp.mst_user SET approval_sign=$1', ['AQID']);
        upload = (await beginReportUpload(db, actor, [await file('report', top)])) as ReportUpload;
        assert.equal(typeof upload, 'object');
        const approvals =
          '<cluster><clusterId>4</clusterId><value>3</value><approver/><approverName/><approvalDate>2026/11/07 13:04:09</approvalDate><approverComment>created</approverComment><approvalSignImage>BAUG</approvalSignImage></cluster><cluster><clusterId>5</clusterId><value>3</value><approver>reviewer</approver><approverName>Reviewer</approverName><approvalDate>2026/11/07 14:05:10</approvalDate><approverComment>inspected</approverComment></cluster><cluster><clusterId>6</clusterId><value>4</value><applicant/><applicantName/><applicationDate>2026/11/07 12:03:08</applicationDate><applicantComment>applied</applicantComment><approver/><approverName/><approvalDate>2026/11/07 15:06:11</approvalDate><approverComment>approved</approverComment><approvalSignImage> </approvalSignImage></cluster><cluster><clusterId>7</clusterId><value>2</value><applicant/><applicantName/><applicationDate>2026/11/07 16:07:12</applicationDate></cluster>';
        assert.equal(
          parser.parse(
            await stageReportSheet(db, actor, upload, [
              await file('cluster_1_value', 'rich ink'),
              await file('cluster_1_displayValue', 'rich preview'),
              await file('cluster_12_value', 'picture bytes'),
              await file(
                'report',
                incoming(
                  approvals +
                    '<cluster><clusterId>1</clusterId><value/><displayValue/></cluster><cluster><clusterId>12</clusterId><value/><displayValue/></cluster>',
                ),
              ),
            ]),
          ).conmas.error.code,
          '0',
        );
        await stageReportFreeDrawInfo(upload, [
          await file(
            'pageOrder',
            '<conmas><sheets><sheet><sheetIndex>1</sheetIndex><fdSheetNo>9</fdSheetNo></sheet></sheets></conmas>',
          ),
        ]);
        await stageReportFreeDraw(
          upload,
          [await file('pdfFile', 'rich PDF'), await file('irfdFile', 'rich IRFD')],
          '9',
          '0',
        );
        assert.equal(parser.parse(await finishReportUpload(db, actor, upload)).conmas.error.code, '0');
        const report = (await connection.query('SELECT * FROM pg_temp.rep_top WHERE rep_top_id=100')).rows[0],
          saved = parser.parse(report.xml_data).conmas.top.sheets.sheet.clusters.cluster;
        const rows = (
          await connection.query('SELECT * FROM pg_temp.rep_cluster WHERE rep_sheet_id=200 ORDER BY cluster_id')
        ).rows;
        assert.equal(rows[4].approver, actor.userId);
        assert.equal(rows[4].approver_name, 'Windows fixture');
        assert.equal(rows[4].approver_comment, 'created');
        assert.equal(rows[4].approval_sign, 'BAUG');
        assert.equal(rows[4].approver_date.getHours(), 13);
        assert.equal(rows[5].approver, 'reviewer');
        assert.equal(rows[6].applicant, actor.userId);
        assert.equal(rows[6].applicant_comment, 'applied');
        assert.equal(rows[6].approver, actor.userId);
        assert.equal(rows[6].approval_sign, 'AQID');
        assert.equal(rows[6].applicant_date.getHours(), 12);
        assert.equal(rows[7].applicant, actor.userId);
        assert.equal(rows[7].approver, '');
        assert.equal(saved[6].approvalSignImage, 'AQID');
        assert.equal(saved[4].approver, rows[4].approver);
        assert.equal(saved[8].value, 'windows-fixture:Windows fixture');
        assert.equal(saved[10].value, saved[8].value);
        assert.match(saved[9].value, /^\d{4}\/\d{2}\/\d{2}$/);
        assert.match(saved[11].displayValue, /^\d{4}\/\d{2}\/\d{2}\([A-Za-z]{3}\)$/);
        assert.equal(rows[8].input_value, saved[8].value);
        assert.equal(rows[9].display_value, saved[9].displayValue);
        assert.equal(rows[12].image_file.toString(), 'picture bytes');
        assert.equal(rows[1].binary_file_win.toString(), 'rich ink');
        assert.equal((await getReportFreeDraw(db, actor, '100', '9', 'irfd')).toString(), 'rich IRFD');
        const derived = (
          await connection.query('SELECT cluster_1_8_t,cluster_1_9_d::text FROM pg_temp.report_1 WHERE rep_top_id=100')
        ).rows[0];
        assert.equal(derived.cluster_1_8_t, saved[8].value);
        assert.equal(derived.cluster_1_9_d, saved[9].value.replaceAll('/', '-') + ' 00:00:00');
        await cleanupReportUpload(upload);
        upload = (await beginReportUpload(db, actor, [
          await file('report', top.replace('<repTopId/>', '<repTopId>100</repTopId>')),
        ])) as ReportUpload;
        await stageReportSheet(db, actor, upload, [
          await file(
            'report',
            incoming(
              '<cluster><clusterId>6</clusterId><value>4</value><approverComment>changed comment</approverComment></cluster>',
            ),
          ),
        ]);
        assert.equal(parser.parse(await finishReportUpload(db, actor, upload)).conmas.error.code, '0');
        const updated = (
          await connection.query('SELECT * FROM pg_temp.rep_cluster WHERE rep_sheet_id=200 AND cluster_id=6')
        ).rows[0];
        assert.equal(updated.approver_comment, 'changed comment');
        assert.equal(updated.applicant_comment, 'applied');
        assert.equal(updated.approval_sign, 'AQID');
        assert.deepEqual(updated.applicant_date, rows[6].applicant_date);
        assert.equal(
          (
            await connection.query('SELECT sys_regist_time FROM pg_temp.rep_top WHERE rep_top_id=100')
          ).rows[0].sys_regist_time.getTime(),
          report.sys_regist_time.getTime(),
        );
        await cleanupReportUpload(upload);
        upload = (await beginReportUpload(db, actor, [
          await file('report', top.replace('<repTopId/>', '<repTopId>100</repTopId>')),
        ])) as ReportUpload;
        await stageReportSheet(db, actor, upload, [
          await file('cluster_12_value', 'must roll back'),
          await file(
            'report',
            incoming(
              '<cluster><clusterId>6</clusterId><value>4</value><approvalDate>2026/02/29 00:00:00</approvalDate></cluster><cluster><clusterId>12</clusterId><value/></cluster>',
            ),
          ),
        ]);
        await assert.rejects(finishReportUpload(db, actor, upload), /Invalid report approval date/);
        assert.equal(upload.result, undefined);
        assert.equal(
          (
            await connection.query(
              'SELECT image_file FROM pg_temp.rep_cluster WHERE rep_sheet_id=200 AND cluster_id=12',
            )
          ).rows[0].image_file.toString(),
          'picture bytes',
        );
        await connection.query('UPDATE pg_temp.def_top SET xml_data=$1', [
          source.replace('<apply/>', '<apply>configured</apply>'),
        ]);
        await assert.rejects(
          beginReportUpload(db, actor, [await file('report', top)]),
          (error) => error instanceof ReportUnsupported && error.code === 'report_cluster_notifications',
        );
      } finally {
        await cleanupReportUpload(upload);
        await rm(directory, { recursive: true, force: true });
      }
    }),
);

test(
  'report finish rechecks output/default notifications and rolls back instead of acknowledging unimplemented side effects',
  enabled,
  async () =>
    fixture(async (db, connection) => {
      const directory = await mkdtemp(join(tmpdir(), 'conmas-report-output-'));
      let upload: ReportUpload | undefined;
      const file = async (data: string): Promise<Express.Multer.File> => {
        const path = join(directory, 'report');
        await writeFile(path, data);
        return { fieldname: 'report', path, size: Buffer.byteLength(data) } as Express.Multer.File;
      };
      const top =
        '<conmas><top><defTopId>1</defTopId><repTopId/><repTopName>guarded report</repTopName><editStatus>1</editStatus><thumbnail/><sheets/></top></conmas>';
      const fails = async (code: string, data = top) =>
        assert.rejects(
          beginReportUpload(db, actor, [await file(data)]),
          (error) => error instanceof ReportUnsupported && error.code === code,
        );
      try {
        await connection.query("UPDATE pg_temp.mst_common SET com_value='true' WHERE com_name='TMP_XML'");
        await fails('report_output_temporary');
        await connection.query(
          "UPDATE pg_temp.mst_common SET com_value='false' WHERE com_name='TMP_XML';UPDATE pg_temp.mst_common SET com_value='true' WHERE com_name='EDIT'",
        );
        await fails('report_output_edit');
        await connection.query(
          "UPDATE pg_temp.mst_common SET com_value='false' WHERE com_name='EDIT';UPDATE pg_temp.mst_common SET com_value='true' WHERE com_name='FINISH'",
        );
        await fails('report_output_complete', top.replace('<editStatus>1', '<editStatus>4'));
        await connection.query("UPDATE pg_temp.mst_common SET com_value='invalid' WHERE com_name='FINISH'");
        await fails('report_output_complete', top.replace('<editStatus>1', '<editStatus>4'));
        await connection.query(
          "UPDATE pg_temp.mst_common SET com_value='false' WHERE com_name='FINISH';INSERT INTO pg_temp.mst_mail (mail_file_name,xml_data) VALUES ('MailEdit.xml','<mail default=\"fixture-template\"/>')",
        );
        await fails('report_mail_default');
        await connection.query('DELETE FROM pg_temp.mst_mail');
        await connection.query('UPDATE pg_temp.def_top SET xml_data=$1', [
          xml.replace('<defTopId>', '<management><editWebhook>9</editWebhook></management><defTopId>'),
        ]);
        await fails('report_notifications');
        await connection.query('UPDATE pg_temp.def_top SET xml_data=$1', [xml]);
        upload = (await beginReportUpload(db, actor, [await file(top)])) as ReportUpload;
        await stageReportSheet(db, actor, upload, [
          await file('<conmas><sheet><defSheetId>10</defSheetId><sheetNo>1</sheetNo><clusters/></sheet></conmas>'),
        ]);
        await connection.query("UPDATE pg_temp.mst_common SET com_value='true' WHERE com_name='EDIT'");
        await assert.rejects(
          finishReportUpload(db, actor, upload),
          (error) => error instanceof ReportUnsupported && error.code === 'report_output_edit',
        );
        assert.equal(upload.result, undefined);
        assert.equal((await connection.query('SELECT COUNT(*)::int n FROM pg_temp.rep_top')).rows[0].n, 1);
        await connection.query("UPDATE pg_temp.mst_common SET com_value='false' WHERE com_name='EDIT'");
        assert.equal(parser.parse(await finishReportUpload(db, actor, upload)).conmas.error.code, '0');
      } finally {
        await cleanupReportUpload(upload);
        await rm(directory, { recursive: true, force: true });
      }
    }),
);

test(
  'five-sheet Windows save accepts seven-part image sheet previews without replacing picture values and retains rejection diagnostics',
  enabled,
  async () =>
    fixture(async (db, connection) => {
      const directory = await mkdtemp(join(tmpdir(), 'conmas-image-preview-'));
      let upload: ReportUpload | undefined;
      const file = async (name: string, data: string): Promise<Express.Multer.File> => {
        const path = join(directory, name);
        await writeFile(path, data);
        return { fieldname: name, path, size: Buffer.byteLength(data) } as Express.Multer.File;
      };
      const images = [10, 11, 12]
        .map(
          (id) =>
            `<cluster><sheetNo>3</sheetNo><clusterId>${id}</clusterId><name>Picture ${id}</name><type>Image</type><value/><displayValue/><readOnly>0</readOnly></cluster>`,
        )
        .join('');
      const sheets = [1, 2, 3, 4, 5]
        .map(
          (number) =>
            `<sheet><sheetNo>${number}</sheetNo><defSheetId>${number + 9}</defSheetId><defSheetName>Sheet ${number}</defSheetName><repSheetName>Sheet ${number}</repSheetName><clusters>${number === 2 ? '<cluster><sheetNo>2</sheetNo><clusterId>1</clusterId><name>Ink</name><type>FreeDraw</type><value/><displayValue/><readOnly>0</readOnly></cluster>' : number === 3 ? images : ''}</clusters></sheet>`,
        )
        .join('');
      const source = xml
        .replace('<sheetCount>1', '<sheetCount>5')
        .replace('<sheets>' + sheet + '</sheets>', '<sheets>' + sheets + '</sheets>');
      const incoming = (number: number, clusters = '') =>
        `<conmas><sheet><defSheetId>${number + 9}</defSheetId><sheetNo>${number}</sheetNo><clusters>${clusters}</clusters></sheet></conmas>`;
      try {
        await connection.query('UPDATE pg_temp.def_top SET xml_data=$1', [source]);
        await connection.query(
          'INSERT INTO pg_temp.def_sheet (def_top_id,def_sheet_id,def_sheet_no) VALUES (1,11,2),(1,12,3),(1,13,4),(1,14,5)',
        );
        upload = (await beginReportUpload(db, actor, [
          await file(
            'report',
            '<conmas><top><defTopId>1</defTopId><repTopId/><repTopName>five sheets</repTopName><editStatus>1</editStatus><sheets/></top></conmas>',
          ),
        ])) as ReportUpload;
        assert.equal(
          parser.parse(await stageReportSheet(db, actor, upload, [await file('report', incoming(1))])).conmas.error
            .code,
          '0',
        );
        assert.equal(
          parser.parse(
            await stageReportSheet(db, actor, upload, [
              await file('cluster_1_value', 'ink data'),
              await file('cluster_1_displayValue', 'ink preview'),
              await file('report', incoming(2, '<cluster><clusterId>1</clusterId><value/><displayValue/></cluster>')),
            ]),
          ).conmas.error.code,
          '0',
        );
        const parts: Express.Multer.File[] = [];
        for (const id of [10, 11, 12])
          parts.push(
            await file('cluster_' + id + '_value', 'picture ' + id),
            await file('cluster_' + id + '_displayValue', id === 12 ? '' : 'unused preview ' + id),
          );
        parts.push(
          await file(
            'report',
            incoming(
              3,
              [10, 11, 12]
                .map((id) => `<cluster><clusterId>${id}</clusterId><value/><displayValue/></cluster>`)
                .join(''),
            ),
          ),
        );
        assert.equal(parts.length, 7);
        const diagnostic: ReportSheetDiagnostic = {};
        assert.equal(parser.parse(await stageReportSheet(db, actor, upload, parts, diagnostic)).conmas.error.code, '0');
        assert.deepEqual(diagnostic, { sheetNo: 3, defSheetId: 12, clusters: 3 });
        for (const number of [4, 5])
          assert.equal(
            parser.parse(await stageReportSheet(db, actor, upload, [await file('report', incoming(number))])).conmas
              .error.code,
            '0',
          );
        const rejected: ReportSheetDiagnostic = {};
        assert.equal(
          parser.parse(
            await stageReportSheet(
              db,
              actor,
              upload,
              [
                await file('cluster_10_sound', 'bad attachment'),
                await file('report', incoming(3, '<cluster><clusterId>10</clusterId><value/></cluster>')),
              ],
              rejected,
            ),
          ).conmas.error.code,
          '2',
        );
        assert.deepEqual(rejected, {
          sheetNo: 3,
          defSheetId: 12,
          clusters: 1,
          reason: 'invalid_cluster_file',
          clusterId: 10,
          field: 'cluster_10_sound',
        });
        assert.equal(Object.keys(upload.sheets).length, 5);
        assert.equal(parser.parse(await finishReportUpload(db, actor, upload)).conmas.error.code, '0');
        assert.equal(
          (await connection.query('SELECT rep_sheet_count FROM pg_temp.rep_top WHERE rep_top_id=100')).rows[0]
            .rep_sheet_count,
          5,
        );
        const rows = (
          await connection.query(
            'SELECT cluster_id,image_file FROM pg_temp.rep_cluster WHERE rep_sheet_id=202 ORDER BY cluster_id',
          )
        ).rows;
        assert.deepEqual(
          rows.map((row) => row.image_file.toString()),
          ['picture 10', 'picture 11', 'picture 12'],
        );
        assert.equal(
          (
            await connection.query(
              'SELECT binary_file_win FROM pg_temp.rep_cluster WHERE rep_sheet_id=201 AND cluster_id=1',
            )
          ).rows[0].binary_file_win.toString(),
          'ink data',
        );
      } finally {
        await cleanupReportUpload(upload);
        await rm(directory, { recursive: true, force: true });
      }
    }),
);

test(
  'cooperation creates missing tables and commits report values/names, preserves existing rows and rejects pin/deferred work',
  enabled,
  async () =>
    fixture(async (db, connection) => {
      const directory = await mkdtemp(join(tmpdir(), 'conmas-cooperation-fixture-'));
      let upload: ReportUpload | undefined;
      const file = async (name: string, data: string): Promise<Express.Multer.File> => {
        const path = join(directory, name);
        await writeFile(path, data);
        return { fieldname: name, path, size: Buffer.byteLength(data) } as Express.Multer.File;
      };
      const parts =
        '<nameParts><part><partId>1</partId><type>user</type><value>name</value></part><part><partId>2</partId><type>value</type><value>_</value></part><part><partId>3</partId><type>dateTime</type><value>yyyyMMddHHmm</value></part><part><partId>4</partId><type>value</type><value>_</value></part><part><partId>5</partId><type>report</type><value>defTopName</value></part></nameParts>';
      const source = xml.replace('<defTopId>', '<cooperationTable>1</cooperationTable>' + parts + '<defTopId>');
      const top =
        '<conmas><top><defTopId>1</defTopId><repTopId/><repTopName>submitted name</repTopName><editStatus>1</editStatus><thumbnail/><sheets/></top></conmas>';
      const incoming =
        '<conmas><sheet><defSheetId>10</defSheetId><sheetNo>1</sheetNo><clusters><cluster><clusterId>0</clusterId><value>saved</value><displayValue>saved</displayValue></cluster></clusters></sheet></conmas>';
      try {
        await connection.query('UPDATE pg_temp.def_top SET xml_data=$1', [source]);
        await connection.query('UPDATE pg_temp.def_role SET role_rep_update=1');
        upload = (await beginReportUpload(db, actor, [await file('report', top)])) as ReportUpload;
        assert.equal(typeof upload, 'object');
        await stageReportSheet(db, actor, upload, [await file('report', incoming)]);
        assert.equal((await connection.query("SELECT to_regclass('pg_temp.report_1') AS object")).rows[0].object, null);
        assert.equal(parser.parse(await finishReportUpload(db, actor, upload)).conmas.error.code, '0');
        const saved = (await connection.query('SELECT xml_data,rep_top_name FROM pg_temp.rep_top WHERE rep_top_id=100'))
          .rows[0];
        assert.equal(parser.parse(saved.xml_data).conmas.top.cooperationTable, '1');
        assert.match(saved.rep_top_name, /^Windows fixture_\d{12}_Windows form$/);
        assert.equal(parser.parse(saved.xml_data).conmas.top.repTopName, saved.rep_top_name);
        const derived = (await connection.query('SELECT * FROM pg_temp.report_1 WHERE rep_top_id=100')).rows[0];
        assert.equal(derived.cluster_1_0_t, 'saved');
        assert.equal(derived.cluster_1_3_t, 'original');
        assert.equal(derived.rep_top_name, saved.rep_top_name);
        await connection.query(
          "INSERT INTO pg_temp.report_1 (rep_top_id,cluster_1_0_t) VALUES (987,'untouched other report')",
        );
        const mapping = (
          await connection.query("SELECT xml_data FROM pg_temp.mst_report_table WHERE report_file_name='1.xml'")
        ).rows[0].xml_data;
        await cleanupReportUpload(upload);
        const started = await beginReportUpload(db, actor, [
          await file('report', top.replace('<repTopId/>', '<repTopId>100</repTopId>')),
        ]);
        assert.notEqual(typeof started, 'string');
        upload = started as ReportUpload;
        await stageReportSheet(db, actor, upload, [
          await file('report', incoming.replace('<value>saved', '<value>updated')),
        ]);
        assert.equal(parser.parse(await finishReportUpload(db, actor, upload)).conmas.error.code, '0');
        assert.equal(
          (await connection.query('SELECT cluster_1_0_t FROM pg_temp.report_1 WHERE rep_top_id=100')).rows[0]
            .cluster_1_0_t,
          'updated',
        );
        assert.equal(
          (await connection.query('SELECT cluster_1_0_t FROM pg_temp.report_1 WHERE rep_top_id=987')).rows[0]
            .cluster_1_0_t,
          'untouched other report',
        );
        assert.equal(
          (await connection.query("SELECT xml_data FROM pg_temp.mst_report_table WHERE report_file_name='1.xml'"))
            .rows[0].xml_data,
          mapping,
        );
        await connection.query('UPDATE pg_temp.def_top SET xml_data=$1', [
          source.replace('<type>FreeDraw</type>', '<type>DrawingImage</type>'),
        ]);
        await assert.rejects(
          beginReportUpload(db, actor, [await file('report', top)]),
          (error) => error instanceof ReportUnsupported && error.code === 'report_table_pin',
        );
        await connection.query(
          "INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (1,'COOPERATION_TABLE_SETTING','REGIST_IMMEDIATELY','0')",
        );
        await connection.query('UPDATE pg_temp.def_top SET xml_data=$1', [
          source.replace('<defTopId>', '<tables><table/></tables><defTopId>'),
        ]);
        await assert.rejects(
          beginReportUpload(db, actor, [await file('report', top)]),
          (error) => error instanceof ReportUnsupported && error.code === 'report_table_deferred',
        );
      } finally {
        await cleanupReportUpload(upload);
        await rm(directory, { recursive: true, force: true });
      }
    }),
);

test(
  'native finish shares automatic-label creation/regeneration and cannot acknowledge failed label-role persistence',
  enabled,
  async () =>
    fixture(async (db, connection) => {
      const directory = await mkdtemp('/tmp/opencode/report-label-finish-');
      let upload: ReportUpload | undefined;
      const file = async (data: string): Promise<Express.Multer.File> => {
        const path = join(directory, 'report');
        await writeFile(path, data);
        return { fieldname: 'report', path, size: Buffer.byteLength(data) } as Express.Multer.File;
      };
      const top =
        '<conmas><top><defTopId>1</defTopId><repTopId/><repTopName>Initial</repTopName><editStatus>1</editStatus><thumbnail/><sheets/></top></conmas>';
      const incoming = (value: string) =>
        `<conmas><sheet><defSheetId>10</defSheetId><sheetNo>1</sheetNo><clusters><cluster><clusterId>0</clusterId><value>${value}</value><displayValue>${value}</displayValue></cluster></clusters></sheet></conmas>`;
      try {
        await connection.query(`UPDATE pg_temp.def_role SET role_rep_update=1;
      INSERT INTO pg_temp.mst_label_rep(mst_label_id,label_name,label_id_path,label_name_path,auto_creation,auto_label_name,report_update_type,auto_slash_hierarchy,bottom_layer,auto_delete)
      VALUES(101,'Template','101','Template',1,'Auto/{report:repTopName}/{clusterValue_1_0}',1,1,1,1);
      INSERT INTO pg_temp.def_rep_label(def_top_id,mst_label_id) VALUES(1,101);
      INSERT INTO pg_temp.rep_label_role(mst_label_id,group_id) VALUES(101,4);`);
        upload = (await beginReportUpload(db, actor, [await file(top)])) as ReportUpload;
        assert.equal(typeof upload, 'object');
        assert.equal(
          parser.parse(await stageReportSheet(db, actor, upload, [await file(incoming('saved'))])).conmas.error.code,
          '0',
        );
        assert.equal(parser.parse(await finishReportUpload(db, actor, upload)).conmas.error.code, '0');
        const labels = async () =>
          (
            await connection.query(
              'SELECT m.label_name_path FROM pg_temp.mst_label_rep m JOIN pg_temp.rep_label l USING(mst_label_id) WHERE l.rep_top_id=100 ORDER BY m.label_name_path',
            )
          ).rows.map((row) => row.label_name_path);
        assert.deepEqual(await labels(), ['Auto/Initial/saved']);
        await cleanupReportUpload(upload);
        upload = (await beginReportUpload(db, actor, [
          await file(top.replace('<repTopId/>', '<repTopId>100</repTopId>')),
        ])) as ReportUpload;
        assert.equal(typeof upload, 'object');
        assert.equal(
          parser.parse(await stageReportSheet(db, actor, upload, [await file(incoming('updated'))])).conmas.error.code,
          '0',
        );
        const before = (
          await connection.query(
            'SELECT xml_data,rep_top_name,sys_update_time FROM pg_temp.rep_top WHERE rep_top_id=100',
          )
        ).rows[0];
        const failing = {
          ...db,
          connect: async () => ({
            query: async (sql: string, values?: unknown[]) => {
              if (sql.startsWith('INSERT INTO rep_label_role')) throw new Error('Fixture label role failed.');
              return connection.query(sql, values);
            },
            release() {},
          }),
        } as unknown as pg.Pool;
        await assert.rejects(finishReportUpload(failing, actor, upload), /Fixture label role failed/);
        assert.equal(upload.result, undefined);
        assert.deepEqual(
          (
            await connection.query(
              'SELECT xml_data,rep_top_name,sys_update_time FROM pg_temp.rep_top WHERE rep_top_id=100',
            )
          ).rows[0],
          before,
        );
        assert.deepEqual(await labels(), ['Auto/Initial/saved']);
        assert.equal(parser.parse(await finishReportUpload(db, actor, upload)).conmas.error.code, '0');
        assert.deepEqual(await labels(), ['Auto/Initial/updated']);
        assert.equal(
          (
            await connection.query(
              'SELECT 1 FROM pg_temp.rep_label_role r JOIN pg_temp.mst_label_rep m USING(mst_label_id) WHERE m.label_name_path=$1 AND r.group_id=4',
              ['Auto/Initial/updated'],
            )
          ).rowCount,
          1,
        );
      } finally {
        await cleanupReportUpload(upload);
        await rm(directory, { recursive: true, force: true });
      }
    }),
);

test(
  'finish returns original registration/applicant remarks and releases a new applicant-locked report even with unlock=0',
  enabled,
  async () =>
    fixture(async (db, connection) => {
      const directory = await mkdtemp('/tmp/opencode/report-lock-finish-');
      let upload: ReportUpload | undefined;
      const file = async (xml: string): Promise<Express.Multer.File> => {
        const path = join(directory, 'report');
        await writeFile(path, xml);
        return { fieldname: 'report', path, size: Buffer.byteLength(xml) } as Express.Multer.File;
      };
      try {
        await connection.query('UPDATE pg_temp.def_top SET use_applicant_lock=1,xml_data=$1', [
          xml.replace(
            '<name>Text</name><type>KeyboardText</type><value>saved text</value>',
            '<name>Text</name><type>Approve</type><value>2</value><applicant>windows-fixture</applicant>',
          ),
        ]);
        await connection.query(
          "UPDATE pg_temp.def_cluster SET cluster_type='Approve' WHERE cluster_id=0; INSERT INTO pg_temp.def_cluster_role(def_sheet_id,cluster_id,group_id) VALUES(10,0,5)",
        );
        const top =
          '<conmas><top><defTopId>1</defTopId><repTopId/><repTopName>Applied &amp; saved</repTopName><editStatus>1</editStatus><sheets/></top></conmas>';
        upload = (await beginReportUpload(db, actor, [await file(top)])) as ReportUpload;
        assert.equal(typeof upload, 'object');
        await stageReportSheet(db, actor, upload, [
          await file('<conmas><sheet><defSheetId>10</defSheetId><sheetNo>1</sheetNo><clusters/></sheet></conmas>'),
        ]);
        const response = await finishReportUpload(db, actor, upload, false);
        const result = parser.parse(response).conmas.error;
        assert.equal(result.code, '0');
        const remarks = result.remarks.remark as string[];
        assert.equal(remarks.length, 9);
        assert(remarks.includes('repTopId=100'));
        assert(remarks.includes('applicantLock=1'));
        assert(remarks.includes('registUser=windows-fixture'));
        assert(remarks.includes('registUserName=Windows fixture'));
        assert(remarks.includes('repTopName=Applied & saved'));
        assert.match(
          remarks.find((text) => text.startsWith('registTime='))!,
          /^registTime=\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/,
        );
        assert.equal((await connection.query('SELECT 1 FROM pg_temp.rep_lock WHERE rep_top_id=100')).rowCount, 0);
        assert.equal(await finishReportUpload(db, actor, structuredClone(upload), false), response);
        assert.equal(
          parser.parse(
            (await beginReportUpload(db, actor, [
              await file(top.replace('<repTopId/>', '<repTopId>100</repTopId>')),
            ])) as string,
          ).conmas.error.code,
          '3',
        );
      } finally {
        await cleanupReportUpload(upload);
        await rm(directory, { recursive: true, force: true });
      }
    }),
);

test(
  'initial-input downloads preserve source text/binary/approval baselines and verified-empty replacement rules',
  enabled,
  async () =>
    fixture(async (db, connection) => {
      await connection.query('CREATE TEMP TABLE history_rep_cluster (LIKE public.history_rep_cluster INCLUDING ALL)');
      const types = [
        'KeyboardText',
        'MultipleChoiceNumber',
        'FixedText',
        'FreeDraw',
        'Image',
        'DrawingImage',
        'FreeText',
        'AudioRecording',
        'Action',
        'Approve',
        'Create',
        'Inspect',
        'KeyboardText',
        'KeyboardText',
        'KeyboardText',
        'KeyboardText',
      ];
      const clusters = types
        .map(
          (type, id) =>
            `<cluster><sheetNo>1</sheetNo><clusterId>${id}</clusterId><name>Initial ${id}</name><type>${type}</type><value/><displayValue/><readOnly>0</readOnly><initValue>stale</initValue></cluster>`,
        )
        .join('');
      await connection.query(
        'UPDATE pg_temp.rep_top SET xml_data=$1,use_input_history=2,use_init_input_judge=1,use_init_input_judge_parameters=$2',
        [
          xml.replace(/<clusters>[\s\S]*?<\/clusters>/, '<clusters>' + clusters + '</clusters>'),
          '<useInitInputJudgeParameters><color>fixture</color></useInitInputJudgeParameters>',
        ],
      );
      await connection.query(
        "INSERT INTO pg_temp.mst_common(com_id,com_key,com_name,com_value) VALUES(-201,'CONMAS_FUNCTION','INITIAL_VALUE_CHANGE_DISPLAY_TYPE','0'); DELETE FROM pg_temp.rep_cluster_role; DELETE FROM pg_temp.rep_cluster_refer",
      );
      for (const [id, type] of types.entries()) {
        if (id !== 14)
          await connection.query(
            `INSERT INTO pg_temp.history_rep_cluster(history_id,rep_sheet_id,cluster_id,cluster_type,init_history_input,verified,input_value,display_value,binary_file_type,history_regist_time,approver,approver_date)
          VALUES($1,20,$2,$3,1,$4,$5,'',$6,'2026-11-09 12:00:00',$7,'2026-11-09 13:00:00')`,
            [
              String(id) + '-initial',
              id,
              type,
              id === 15 ? null : id >= 9 && id <= 11 ? '0' : '1',
              id === 12 ? '0' : id === 9 ? '2' : id === 10 ? '3' : id === 11 ? '4' : '',
              id === 2 ? 'Windows' : '',
              id === 11 ? 'inspector' : null,
            ],
          );
        if (id !== 13)
          await connection.query(
            `INSERT INTO pg_temp.history_rep_cluster(history_id,rep_sheet_id,cluster_id,cluster_type,init_history_input,verified,input_value,display_value,binary_file_type,binary_file_win,binary_file,image_file,recording_file,history_regist_time,approver,approver_date)
          VALUES($1,20,$2,$3,0,'0',$4,'next choice',$5,$6,$7,$8,$9,'2026-11-10 12:00:00','reviewer','2026-11-10 13:04:09')`,
            [
              String(id) + '-next',
              id,
              type,
              id === 9 ? '4' : 'next input',
              id === 2 ? 'Windows' : '',
              Buffer.alloc(3),
              Buffer.alloc(4),
              Buffer.alloc(5),
              Buffer.alloc(6),
            ],
          );
      }
      await connection.query(
        "INSERT INTO pg_temp.history_rep_cluster(history_id,rep_sheet_id,cluster_id,cluster_type,init_history_input,verified,input_value,history_regist_time) VALUES('older-initial',20,0,'KeyboardText',1,'0','obsolete','2026-11-08 12:00:00')",
      );
      const download = async () =>
        parser.parse(((await getReportDownload(db, actor, { topId: '2' }, false, false)) as ReportDownload).xml).conmas
          .top;
      let top = await download();
      assert.equal(top.useInitInputJudgeParameters.color, 'fixture');
      let values = top.sheets.sheet.clusters.cluster.map((cluster: { initValue?: string }) => cluster.initValue);
      assert.deepEqual(values, [
        '',
        '',
        '0',
        '0',
        '0',
        '0',
        '0',
        '0',
        undefined,
        'reviewer20261110130409',
        undefined,
        'inspector20261109130000',
        '0',
        '',
        undefined,
        '',
      ]);
      await connection.query(
        "UPDATE pg_temp.mst_common SET com_value='1' WHERE com_name='INITIAL_VALUE_CHANGE_DISPLAY_TYPE'",
      );
      top = await download();
      values = top.sheets.sheet.clusters.cluster.map((cluster: { initValue?: string }) => cluster.initValue);
      assert.deepEqual(values, [
        'next input',
        'next choice',
        '3',
        '4',
        '5',
        '5',
        '5',
        '6',
        undefined,
        'reviewer20261110130409',
        undefined,
        'inspector20261109130000',
        '0',
        undefined,
        undefined,
        '',
      ]);
      await connection.query('UPDATE pg_temp.rep_top SET use_input_history=0');
      top = await download();
      assert.equal(top.useInitInputJudge, undefined);
      assert.equal(top.useInitInputJudgeParameters, undefined);
      assert(
        top.sheets.sheet.clusters.cluster.every((cluster: { initValue?: string }) => cluster.initValue === undefined),
      );
    }),
);

test('cooperation value conversion keeps decimal precision, nulls invalid dates and refuses unsupported formats', () => {
  const cluster = (type: string, value: string) =>
    root(`<cluster><type>${type}</type><value>${value}</value><inputParameters/></cluster>`);
  assert.equal(reportTableValue(cluster('InputNumeric', '1,234.1234567890'), 'N'), '1234.1234567890');
  assert.equal(reportTableValue(cluster('InputNumeric', '(42.25)'), 'N'), '-42.25');
  assert.equal(reportTableValue(cluster('InputNumeric', '42-'), 'N'), '-42');
  assert.equal(reportTableValue(cluster('InputNumeric', ''), 'N'), null);
  for (const invalid of ['NaN', '1e3', '+1-', '(1)-'])
    assert.throws(() => reportTableValue(cluster('InputNumeric', invalid), 'N'));
  assert.equal(reportTableValue(cluster('Calculate', 'not numeric'), 'N'), null);
  assert.equal(reportTableValue(cluster('Calculate', '+1-'), 'N'), null);
  assert.equal(reportTableValue(cluster('Date', '2026/11/07'), 'D'), '2026-11-07 00:00:00');
  assert.equal(reportTableValue(cluster('Date', '11/07/2026'), 'D'), '2026-11-07 00:00:00');
  assert.equal(reportTableValue(cluster('Date', '2026/02/29'), 'D'), null);
  assert.equal(reportTableValue(cluster('Calculate', '20261107'), 'D'), '2026-11-07 00:00:00');
  assert.equal(reportTableValue(cluster('Calculate', '130409'), 'I'), '13:4:9');
  assert.equal(reportTableValue(cluster('Calculate', '256199'), 'I'), null);
  const modern = (type: string, value: string, field: string) =>
    reportTableValue(cluster(type, value), field, 'en-US', true);
  for (const value of ['NaN', '1e3', '+1-', '(42)', '1000000000', '-1000000000', '999999999.99999999991'])
    assert.equal(modern('InputNumeric', value, 'N'), null);
  assert.equal(modern('InputNumeric', '-999999999.9999999999', 'N'), '-999999999.9999999999');
  assert.equal(modern('InputNumeric', '000999999999.99999999990', 'N'), '000999999999.99999999990');
  assert.equal(modern('Date', '20261107', 'D'), '2026-11-07 00:00:00');
  assert.equal(modern('Date', 'not a date', 'D'), null);
  assert.equal(reportTableValue(cluster('Calculate', 'not a date'), 'D'), null);
  assert.throws(() => reportTableValue(cluster('InputNumeric', '1'), 'N', 'de-DE'), ReportUnsupported);
});

test(
  'history saves use the original trigger once per cluster, including metadata/binaries, and roll back together',
  enabled,
  async () =>
    fixture(async (db, connection) => {
      const directory = await mkdtemp('/tmp/opencode/report-history-');
      let upload: ReportUpload | undefined;
      const file = async (name: string, data: string): Promise<Express.Multer.File> => {
        const path = join(directory, name);
        await writeFile(path, data);
        return { fieldname: name, path, size: Buffer.byteLength(data) } as Express.Multer.File;
      };
      const top =
        '<conmas><top><defTopId>1</defTopId><repTopId/><repTopName>History</repTopName><editStatus>1</editStatus><sheets/></top></conmas>';
      const incoming = (clusters: string) =>
        `<conmas><sheet><defSheetId>10</defSheetId><sheetNo>1</sheetNo><clusters>${clusters}</clusters></sheet></conmas>`;
      const text = (value: string, details = '') =>
        `<cluster><clusterId>0</clusterId><value>${value}</value><displayValue>${value}</displayValue>${details}</cluster>`;
      const history = async () =>
        (await connection.query('SELECT * FROM pg_temp.history_rep_cluster ORDER BY history_id')).rows;
      try {
        await connection.query(
          'UPDATE pg_temp.def_top SET use_input_history=2,use_change_reason=1,use_init_input_judge=1',
        );
        await assert.rejects(
          beginReportUpload(db, actor, [await file('report', top)]),
          (error) => error instanceof ReportUnsupported && error.code === 'report_history_trigger',
        );
        for (const table of ['history_rep_cluster', 'rep_cluster_store', 'rep_cluster_approval'])
          await connection.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
        await connection.query(`CREATE TEMP SEQUENCE history_rep_cluster_seq; CREATE TEMP SEQUENCE rep_cluster_store_seq;
        SET search_path=pg_temp,pg_catalog;
        CREATE TRIGGER fixture_report_history AFTER INSERT OR UPDATE OR DELETE ON pg_temp.rep_cluster FOR EACH ROW EXECUTE FUNCTION public.func_rep_cluster_trigger();
        INSERT INTO pg_temp.mst_common(com_id,com_key,com_name,com_value,com_index) VALUES
          (-201,'HISTORY_SETTING','ENABLE','0',0),(-202,'HISTORY_SETTING','SELECT_MODE','0',1),(-203,'IMAGE_SAVE_SETTING','IMAGE_STORE_MODE','1',1);
        UPDATE pg_temp.def_role SET role_rep_update=1;`);
        upload = (await beginReportUpload(db, actor, [await file('report', top)])) as ReportUpload;
        assert.equal(typeof upload, 'object');
        assert.equal(
          parser.parse(
            await stageReportSheet(db, actor, upload, [
              await file('cluster_1_value', 'first ink'),
              await file('cluster_1_displayValue', 'first preview'),
              await file('cluster_2_sound', 'first sound'),
              await file(
                'report',
                incoming(
                  text(
                    'first',
                    '<verified>0</verified><changeReasonValue>first reason</changeReasonValue><comment><value>first comment</value><inputParameters>Color=1</inputParameters></comment><gps><lat>1.2</lat><lon>3.4</lon><alt>5</alt></gps><editUser>editor</editUser><editUserName>Editor</editUserName><editTime>2026/11/10 12:00:00</editTime>',
                  ) +
                    '<cluster><clusterId>1</clusterId><value/><verified>0</verified><editUser>artist</editUser><editTime>2026/11/10 12:00:01</editTime></cluster><cluster><clusterId>2</clusterId><value/><fileExtension>wav</fileExtension><editUser>speaker</editUser></cluster>',
                ),
              ),
            ]),
          ).conmas.error.code,
          '0',
        );
        assert.equal(parser.parse(await finishReportUpload(db, actor, upload)).conmas.error.code, '0');
        const first = await history();
        for (const clusterId of [0, 1, 2]) {
          const rows = first.filter((row) => row.cluster_id === clusterId);
          assert.equal(rows.length, 1);
          assert.equal(Number(rows[0].init_history_input), 1);
          assert.equal(rows[0].history_type, 'I');
        }
        const initial = first.find((row) => row.cluster_id === 0)!;
        assert.equal(initial.comment_value, 'first comment');
        assert.equal(initial.comment_input_parameters, 'Color=1');
        assert.equal(initial.change_reason, 'first reason');
        assert.equal(initial.edit_user, 'editor');
        assert.equal(initial.gps_lat, '1.2');
        assert.equal(first.find((row) => row.cluster_id === 1)!.binary_file_win.toString(), 'first ink');
        assert.equal(first.find((row) => row.cluster_id === 1)!.image_file.toString(), 'first preview');
        assert.equal(first.find((row) => row.cluster_id === 2)!.recording_file.toString(), 'first sound');
        assert.equal(
          (await connection.query('SELECT count(*)::int AS count FROM pg_temp.rep_cluster_store')).rows[0].count,
          1,
        );
        await cleanupReportUpload(upload);
        upload = (await beginReportUpload(db, actor, [
          await file('report', top.replace('<repTopId/>', '<repTopId>100</repTopId>')),
        ])) as ReportUpload;
        const before = (await connection.query('SELECT xml_data FROM pg_temp.rep_top WHERE rep_top_id=100')).rows[0]
          .xml_data;
        await stageReportSheet(db, actor, upload, [
          await file('cluster_1_value', 'second ink'),
          await file('cluster_1_displayValue', 'second preview'),
          await file(
            'report',
            incoming(
              text('second', '<changeReasonValue>corrected</changeReasonValue>') +
                '<cluster><clusterId>1</clusterId><value/></cluster>',
            ),
          ),
        ]);
        const failing = {
          ...db,
          connect: async () => ({
            query: async (sql: string, values?: unknown[]) => {
              if (sql.startsWith('DELETE FROM rep_lock WHERE rep_top_id='))
                throw new Error('Fixture failure after history.');
              return connection.query(sql, values);
            },
            release() {},
          }),
        } as unknown as pg.Pool;
        await assert.rejects(finishReportUpload(failing, actor, upload), /Fixture failure after history/);
        assert.equal(upload.result, undefined);
        assert.deepEqual(await history(), first);
        assert.equal(
          (await connection.query('SELECT xml_data FROM pg_temp.rep_top WHERE rep_top_id=100')).rows[0].xml_data,
          before,
        );
        assert.equal(parser.parse(await finishReportUpload(db, actor, upload)).conmas.error.code, '0');
        const second = (await history()).filter((row) => row.history_type === 'U');
        assert.equal(second.length, 2);
        const updated = second.find((row) => row.cluster_id === 0)!;
        assert.equal(updated.old_input_value, 'first');
        assert.equal(updated.input_value, 'second');
        assert.equal(updated.change_reason, 'corrected');
        assert.equal(updated.comment_value, 'first comment');
        assert.equal(updated.edit_user, 'editor');
        assert.equal(updated.gps_lat, '1.2');
        assert.equal(Number(updated.init_history_input), 0);
        assert.equal(second.find((row) => row.cluster_id === 1)!.binary_file_win.toString(), 'second ink');
        assert.equal(second.find((row) => row.cluster_id === 1)!.old_binary_file_win.toString(), 'first ink');
        const downloaded = (await getReportDownload(db, actor, { topId: '100' }, false, false)) as ReportDownload;
        const saved = parser.parse(downloaded.xml).conmas.top.sheets.sheet.clusters.cluster[0];
        assert.equal(saved.verified, '0');
        assert.equal(saved.comment.value, 'first comment');
        assert.equal(saved.gps.lat, '1.2');
        assert.equal(saved.editUser, 'editor');
        assert.equal(saved.initValue, 'first');
        const count = (await history()).length;
        assert.equal(parser.parse(await finishReportUpload(db, actor, upload)).conmas.error.code, '0');
        assert.equal((await history()).length, count);
        await connection.query(
          "UPDATE pg_temp.mst_common SET com_value='2' WHERE com_name='ENABLE'; UPDATE pg_temp.rep_top SET use_input_history=0 WHERE rep_top_id=100",
        );
        const global = (await getReportDownload(db, actor, { topId: '100' }, false, false)) as ReportDownload;
        assert.equal(parser.parse(global.xml).conmas.top.useInputHistory, '2');
        for (const [mode, verified, expected] of [
          ['1', '0', 0],
          ['2', '0', 0],
          ['2', '1', 1],
          ['0', '1', 1],
        ]) {
          await cleanupReportUpload(upload);
          await connection.query("UPDATE pg_temp.mst_common SET com_value=$1 WHERE com_name='SELECT_MODE'", [mode]);
          upload = (await beginReportUpload(db, actor, [
            await file('report', top.replace('<repTopId/>', '<repTopId>100</repTopId>')),
          ])) as ReportUpload;
          const beforeCount = (await history()).length;
          await stageReportSheet(db, actor, upload, [
            await file(
              'report',
              incoming(
                text(
                  'second',
                  `<verified>${verified}</verified><editUser>editor</editUser><editTime>2026/11/10 12:00:00</editTime><changeReasonValue>stale resent reason</changeReasonValue>`,
                ),
              ),
            ),
          ]);
          assert.equal(parser.parse(await finishReportUpload(db, actor, upload)).conmas.error.code, '0');
          assert.equal((await history()).length - beforeCount, Number(expected));
          assert.equal(
            (
              await connection.query(
                'SELECT change_reason FROM pg_temp.rep_cluster WHERE rep_sheet_id=200 AND cluster_id=0',
              )
            ).rows[0].change_reason,
            'corrected',
          );
        }
        await cleanupReportUpload(upload);
        await connection.query("UPDATE pg_temp.mst_common SET com_value='1' WHERE com_name='ENABLE'");
        upload = (await beginReportUpload(db, actor, [
          await file('report', top.replace('<repTopId/>', '<repTopId>100</repTopId>')),
        ])) as ReportUpload;
        const beforeBinary = (await history()).length;
        assert.equal(
          parser.parse(
            await stageReportSheet(db, actor, upload, [
              await file('report', incoming(text('', '<verified>invalid</verified>'))),
            ]),
          ).conmas.error.code,
          '2',
        );
        await stageReportSheet(db, actor, upload, [
          await file('cluster_1_value', 'text-only-history ink'),
          await file('cluster_1_displayValue', 'text-only-history preview'),
          await file('report', incoming('<cluster><clusterId>1</clusterId><value/></cluster>')),
        ]);
        assert.equal(parser.parse(await finishReportUpload(db, actor, upload)).conmas.error.code, '0');
        assert.equal((await history()).length, beforeBinary);
        assert.equal(
          (
            await connection.query(
              'SELECT binary_file_win FROM pg_temp.rep_cluster WHERE rep_sheet_id=200 AND cluster_id=1',
            )
          ).rows[0].binary_file_win.toString(),
          'text-only-history ink',
        );
        await connection.query('ALTER TABLE pg_temp.rep_cluster DISABLE TRIGGER fixture_report_history');
        await assert.rejects(
          checkReportSaveFeatures(db, must(root(global.xml), 'top')),
          (error) => error instanceof ReportUnsupported && error.code === 'report_history_trigger',
        );
      } finally {
        await cleanupReportUpload(upload);
        await rm(directory, { recursive: true, force: true });
      }
    }),
);

test(
  'native applicant locks honor either enablement, role-free approvals, deregulation and finish-time rechecks',
  enabled,
  async () =>
    fixture(async (db, connection) => {
      const directory = await mkdtemp('/tmp/opencode/report-applicant-');
      let upload: ReportUpload | undefined;
      const file = async (xml: string): Promise<Express.Multer.File> => {
        const path = join(directory, 'report');
        await writeFile(path, xml);
        return { fieldname: 'report', path, size: Buffer.byteLength(xml) } as Express.Multer.File;
      };
      const top =
        '<conmas><top><defTopId>1</defTopId><repTopId>2</repTopId><repTopName>Locked</repTopName><editStatus>1</editStatus><sheets/></top></conmas>';
      const download = async () =>
        parser.parse(((await getReportDownload(db, actor, { topId: '2' }, false, false)) as ReportDownload).xml).conmas
          .top;
      try {
        await connection.query(`INSERT INTO pg_temp.rep_cluster(rep_sheet_id,cluster_id,cluster_type,input_value) VALUES (20,4,'Approve','2');
        INSERT INTO pg_temp.rep_cluster_role(rep_sheet_id,cluster_id,group_id) VALUES (20,4,5);
        INSERT INTO pg_temp.mst_common(com_id,com_key,com_name,com_value) VALUES (-201,'IPAD_SETTING','USE_APPLICANT_LOCK','0'),(-202,'IPAD_SETTING','APPLICANT_LOCK_TYPE','0');
        UPDATE pg_temp.rep_top SET use_applicant_lock=1;`);
        assert.equal(await reportApplicantLocked(db, 2, actor.userId), true);
        const locked = await download();
        assert.equal(locked.readOnly, '1');
        assert.equal(locked.sheets.sheet.clusters.cluster[0].applyLock, '1');
        assert.equal(locked.sheets.sheet.clusters.cluster[3].applyLock, '0');
        assert.equal(
          parser.parse((await beginReportUpload(db, actor, [await file(top)])) as string).conmas.error.code,
          '3',
        );
        await connection.query(
          "UPDATE pg_temp.rep_top SET use_applicant_lock=0; UPDATE pg_temp.mst_common SET com_value='1' WHERE com_name='USE_APPLICANT_LOCK'",
        );
        assert.equal(await reportApplicantLocked(db, 2, actor.userId), true);
        assert.equal((await download()).useApplicantLock, '1');
        await connection.query(
          "UPDATE pg_temp.mst_common SET com_value='1' WHERE com_name='APPLICANT_LOCK_TYPE'; INSERT INTO pg_temp.rep_cluster(rep_sheet_id,cluster_id,cluster_type,input_value,applicant) VALUES(20,5,'Approve','3','windows-fixture')",
        );
        assert.equal(await reportApplicantLocked(db, 2, actor.userId), false);
        await connection.query("UPDATE pg_temp.rep_cluster SET applicant='other' WHERE cluster_id=5");
        assert.equal(await reportApplicantLocked(db, 2, actor.userId), true);
        await connection.query("UPDATE pg_temp.rep_cluster SET input_value='2' WHERE cluster_id=5");
        assert.equal(await reportApplicantLocked(db, 2, actor.userId), false);
        assert.equal((await download()).readOnly, '0');
        upload = (await beginReportUpload(db, actor, [await file(top)])) as ReportUpload;
        assert.equal(typeof upload, 'object');
        await stageReportSheet(db, actor, upload, [
          await file('<conmas><sheet><defSheetId>10</defSheetId><sheetNo>1</sheetNo><clusters/></sheet></conmas>'),
        ]);
        const before = (await connection.query('SELECT xml_data FROM pg_temp.rep_top WHERE rep_top_id=2')).rows[0]
          .xml_data;
        await connection.query("UPDATE pg_temp.mst_common SET com_value='0' WHERE com_name='APPLICANT_LOCK_TYPE'");
        assert.equal(parser.parse(await finishReportUpload(db, actor, upload)).conmas.error.code, '3');
        assert.equal(upload.result, undefined);
        assert.equal(
          (await connection.query('SELECT xml_data FROM pg_temp.rep_top WHERE rep_top_id=2')).rows[0].xml_data,
          before,
        );
        await connection.query('UPDATE pg_temp.rep_top SET edit_refer_status=4');
        assert.equal(await reportApplicantLocked(db, 2, actor.userId), false);
        assert.equal((await download()).editStatus, '4');
        assert.equal(await reportApplicantLocked(db, 2, actor.userId, true), true);
        assert.equal(
          parser.parse(
            ((await getReportDownload(db, actor, { topId: '2', copy: '1' }, false, false)) as ReportDownload).xml,
          ).conmas.top.readOnly,
          '1',
        );
        assert.equal(parser.parse(await finishReportUpload(db, actor, upload)).conmas.error.code, '1110');
        assert.equal(
          parser.parse((await beginReportUpload(db, actor, [await file(top)])) as string).conmas.error.code,
          '1110',
        );
      } finally {
        await cleanupReportUpload(upload);
        await rm(directory, { recursive: true, force: true });
      }
    }),
);

test(
  'Calculate saves client numeric/date/time/text results and formulas, and preserves omitted values on update',
  enabled,
  async () =>
    fixture(async (db, connection) => {
      const directory = await mkdtemp(join(tmpdir(), 'conmas-calculate-fixture-'));
      let upload: ReportUpload | undefined;
      const file = async (data: string): Promise<Express.Multer.File> => {
        const path = join(directory, 'report');
        await writeFile(path, data);
        return { fieldname: 'report', path, size: Buffer.byteLength(data) } as Express.Multer.File;
      };
      const clusters = [
        'DataType=0;Maximum=999999999;Minimum=-999999999',
        'DataType=1;DateFormat=yyyyMMdd',
        'DataType=1;DateFormat=HHmmss',
        'DataType=2',
      ]
        .map(
          (parameters, id) =>
            `<cluster><sheetNo>1</sheetNo><clusterId>${id}</clusterId><name>Calculation ${id}</name><type>Calculate</type><inputParameters>${parameters}</inputParameters><function>original formula</function><value/><displayValue/><readOnly>0</readOnly></cluster>`,
        )
        .join('');
      const source = xml
        .replace('<defTopId>', '<cooperationTable>1</cooperationTable><defTopId>')
        .replace(/<clusters>[\s\S]*?<\/clusters>/, '<clusters>' + clusters + '</clusters>');
      const top =
        '<conmas><top><defTopId>1</defTopId><repTopId/><repTopName>Calculated report</repTopName><editStatus>1</editStatus><thumbnail/><sheets/></top></conmas>';
      const incoming = (clusters: string) =>
        `<conmas><sheet><defSheetId>10</defSheetId><sheetNo>1</sheetNo><clusters>${clusters}</clusters></sheet></conmas>`;
      try {
        await connection.query('UPDATE pg_temp.def_top SET xml_data=$1', [source]);
        await connection.query('UPDATE pg_temp.def_role SET role_rep_update=1');
        await connection.query('DELETE FROM pg_temp.def_cluster_role;DELETE FROM pg_temp.def_cluster_refer');
        await connection.query(
          "INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (1,'CONMAS_FUNCTION','CALCULATE_MAXMIN_VALID','2')",
        );
        upload = (await beginReportUpload(db, actor, [await file(top)])) as ReportUpload;
        assert.equal(typeof upload, 'object');
        const values = ['42.1234567890', '20261107', '130409', 'calculated text'];
        const submitted = values
          .map(
            (value, id) =>
              `<cluster><clusterId>${id}</clusterId><value>${value}</value><displayValue>shown ${id}</displayValue><function>client formula ${id}</function></cluster>`,
          )
          .join('');
        assert.equal(
          parser.parse(await stageReportSheet(db, actor, upload, [await file(incoming(submitted))])).conmas.error.code,
          '0',
        );
        assert.equal(parser.parse(await finishReportUpload(db, actor, upload)).conmas.error.code, '0');
        const saved = parser.parse(
          (await connection.query('SELECT xml_data FROM pg_temp.rep_top WHERE rep_top_id=100')).rows[0].xml_data,
        ).conmas.top.sheets.sheet.clusters.cluster;
        assert.deepEqual(
          saved.map((cluster: { value: string }) => cluster.value),
          values,
        );
        assert.deepEqual(
          saved.map((cluster: { function: string }) => cluster.function),
          values.map((_, id) => 'client formula ' + id),
        );
        assert.deepEqual(
          (
            await connection.query(
              'SELECT input_value,display_value FROM pg_temp.rep_cluster WHERE rep_sheet_id=200 ORDER BY cluster_id',
            )
          ).rows,
          values.map((value, id) => ({ input_value: value, display_value: 'shown ' + id })),
        );
        const derived = (
          await connection.query(
            'SELECT cluster_1_0_n,cluster_1_1_d::text,cluster_1_2_i::text,cluster_1_3_t FROM pg_temp.report_1 WHERE rep_top_id=100',
          )
        ).rows[0];
        assert.deepEqual(derived, {
          cluster_1_0_n: values[0],
          cluster_1_1_d: '2026-11-07 00:00:00',
          cluster_1_2_i: '13:04:09',
          cluster_1_3_t: values[3],
        });
        await cleanupReportUpload(upload);
        upload = (await beginReportUpload(db, actor, [
          await file(top.replace('<repTopId/>', '<repTopId>100</repTopId>')),
        ])) as ReportUpload;
        assert.equal(
          parser.parse(
            await stageReportSheet(db, actor, upload, [
              await file(incoming('<cluster><clusterId>0</clusterId><value>7</value><function/></cluster>')),
            ]),
          ).conmas.error.code,
          '0',
        );
        assert.equal(parser.parse(await finishReportUpload(db, actor, upload)).conmas.error.code, '0');
        const updated = parser.parse(
          (await connection.query('SELECT xml_data FROM pg_temp.rep_top WHERE rep_top_id=100')).rows[0].xml_data,
        ).conmas.top.sheets.sheet.clusters.cluster;
        assert.equal(updated[0].value, '7');
        assert.equal(updated[0].function, 'client formula 0');
        assert.equal(updated[3].value, 'calculated text');
        await connection.query('INSERT INTO pg_temp.binder_rep_src (rep_top_org,binder_rep_id) VALUES (100,1)');
        await assert.rejects(
          beginReportUpload(db, actor, [await file(top.replace('<repTopId/>', '<repTopId>100</repTopId>'))]),
          (error) => error instanceof ReportUnsupported && error.code === 'report_binder_mapping',
        );
      } finally {
        await cleanupReportUpload(upload);
        await rm(directory, { recursive: true, force: true });
      }
    }),
);

test(
  'Calculate max/min uses platform/selection/type gates, exact decimals and rechecks before commit',
  enabled,
  async () =>
    fixture(async (db, connection) => {
      const directory = await mkdtemp(join(tmpdir(), 'conmas-calculate-limits-'));
      let upload: ReportUpload | undefined;
      const file = async (data: string): Promise<Express.Multer.File> => {
        const path = join(directory, 'report');
        await writeFile(path, data);
        return { fieldname: 'report', path, size: Buffer.byteLength(data) } as Express.Multer.File;
      };
      const source = xml
        .replace('<defTopId>', '<cooperationTable>1</cooperationTable><defTopId>')
        .replace(
          '<type>KeyboardText</type><value>saved text',
          '<type>Calculate</type><inputParameters>DataType=0;Maximum=10.1234567890;Minimum=-10.1234567890</inputParameters><value>1',
        );
      const top =
        '<conmas><top><defTopId>1</defTopId><repTopId/><repTopName>Limits</repTopName><editStatus>1</editStatus><thumbnail/><sheets/></top></conmas>';
      const incoming = (value: string) =>
        `<conmas><sheet><defSheetId>10</defSheetId><sheetNo>1</sheetNo><clusters><cluster><clusterId>0</clusterId><value>${value}</value></cluster></clusters></sheet></conmas>`;
      try {
        await connection.query('UPDATE pg_temp.def_top SET xml_data=$1', [source]);
        await connection.query(
          "INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (1,'CONMAS_FUNCTION','CALCULATE_MAXMIN_VALID','2')",
        );
        upload = (await beginReportUpload(db, actor, [await file(top)])) as ReportUpload;
        for (const value of ['10.1234567891', '-10.1234567891', '1000000000', '-1000000000'])
          assert.equal(
            parser.parse(await stageReportSheet(db, actor, upload, [await file(incoming(value))])).conmas.error.code,
            '10',
          );
        assert.equal(Object.keys(upload.sheets).length, 0);
        for (const value of ['10.1234567890', '-10.1234567890', 'not numeric', '+1-'])
          assert.equal(
            parser.parse(await stageReportSheet(db, actor, upload, [await file(incoming(value))])).conmas.error.code,
            '0',
          );
        assert.equal(
          parser.parse(await stageReportSheet(db, { ...actor, platform: 'iPad' }, upload, [await file(incoming('11'))]))
            .conmas.error.code,
          '0',
        );
        await connection.query("UPDATE pg_temp.mst_common SET com_value='3' WHERE com_id=1");
        assert.equal(
          parser.parse(await stageReportSheet(db, { ...actor, platform: 'iPad' }, upload, [await file(incoming('11'))]))
            .conmas.error.code,
          '10',
        );
        const baseline = upload.baseline;
        upload.baseline = baseline.replace('<cooperationTable>1', '<cooperationTable>2');
        assert.equal(
          parser.parse(await stageReportSheet(db, actor, upload, [await file(incoming('11'))])).conmas.error.code,
          '0',
        );
        upload.baseline = upload.baseline.replace(
          '<type>Calculate',
          '<cooperationCluster>1</cooperationCluster><type>Calculate',
        );
        assert.equal(
          parser.parse(await stageReportSheet(db, actor, upload, [await file(incoming('11'))])).conmas.error.code,
          '10',
        );
        upload.baseline = baseline.replace('DataType=0', 'DataType=1');
        assert.equal(
          parser.parse(await stageReportSheet(db, actor, upload, [await file(incoming('11'))])).conmas.error.code,
          '0',
        );
        upload.baseline = baseline;
        await connection.query("UPDATE pg_temp.mst_common SET com_value='0' WHERE com_id=1");
        assert.equal(
          parser.parse(await stageReportSheet(db, actor, upload, [await file(incoming('11'))])).conmas.error.code,
          '0',
        );
        await connection.query("UPDATE pg_temp.mst_common SET com_value='2' WHERE com_id=1");
        assert.equal(parser.parse(await finishReportUpload(db, actor, upload)).conmas.error.code, '10');
        assert.equal(upload.result, undefined);
        assert.equal((await connection.query('SELECT COUNT(*)::int n FROM pg_temp.rep_top')).rows[0].n, 1);
        assert.equal((await connection.query("SELECT to_regclass('pg_temp.report_1') AS object")).rows[0].object, null);
        assert.equal(
          parser.parse(await stageReportSheet(db, actor, upload, [await file(incoming('7'))])).conmas.error.code,
          '0',
        );
        assert.equal(parser.parse(await finishReportUpload(db, actor, upload)).conmas.error.code, '0');
      } finally {
        await cleanupReportUpload(upload);
        await rm(directory, { recursive: true, force: true });
      }
    }),
);

test(
  'missing-only cooperation repair preserves existing table/view identities, rows and metadata, reconstructing missing views from saved unions',
  enabled,
  async () =>
    fixture(async (_db, connection) => {
      const source = xml.replace('<defTopId>', '<cooperationTable>1</cooperationTable><defTopId>'),
        top = must(root(source), 'top');
      await connection.query('UPDATE pg_temp.def_top SET xml_data=$1', [source]);
      await connection.query('BEGIN');
      await saveReportTables(connection, top, new Set());
      await connection.query('COMMIT');
      const objects = async () =>
        (
          await connection.query(
            "SELECT 'pg_temp.report_1'::regclass::oid AS table_oid,'pg_temp.view_report_1'::regclass::oid AS view_oid,pg_get_viewdef('pg_temp.view_report_1'::regclass) AS definition",
          )
        ).rows[0];
      const before = await objects();
      const tableMapping = (
        await connection.query("SELECT xml_data FROM pg_temp.mst_report_table WHERE report_file_name='1.xml'")
      ).rows[0].xml_data;
      const viewMapping = (
        await connection.query("SELECT xml_data FROM pg_temp.mst_report_table WHERE report_file_name='view1.xml'")
      ).rows[0].xml_data;
      await connection.query(
        "INSERT INTO pg_temp.report_1 (rep_top_id,cluster_1_0_t) VALUES (987,'keep');DELETE FROM pg_temp.mst_report_table WHERE report_file_name='1.xml'",
      );
      await connection.query('BEGIN');
      await saveReportTables(connection, top, new Set());
      await connection.query('COMMIT');
      assert.deepEqual(await objects(), before);
      assert.equal(
        (await connection.query('SELECT cluster_1_0_t FROM pg_temp.report_1 WHERE rep_top_id=987')).rows[0]
          .cluster_1_0_t,
        'keep',
      );
      assert.equal(
        (await connection.query("SELECT xml_data FROM pg_temp.mst_report_table WHERE report_file_name='1.xml'")).rows[0]
          .xml_data,
        tableMapping,
      );
      assert.equal(
        (await connection.query("SELECT xml_data FROM pg_temp.mst_report_table WHERE report_file_name='view1.xml'"))
          .rows[0].xml_data,
        viewMapping,
      );
      const union = viewMapping.replace(
        '</definitions>',
        '<definition defTopId="9"><field>cluster_1_0_T</field></definition></definitions>',
      );
      await connection.query('CREATE TEMP TABLE report_9 (LIKE pg_temp.report_1 INCLUDING ALL)');
      await connection.query(
        "INSERT INTO pg_temp.report_9 (rep_top_id,cluster_1_0_t) VALUES (9,'older revision');INSERT INTO pg_temp.rep_top (rep_top_id,deleted) VALUES (9,0);INSERT INTO pg_temp.rep_current (rep_top_id) VALUES (9)",
      );
      await connection.query("UPDATE pg_temp.mst_report_table SET xml_data=$1 WHERE report_file_name='view1.xml'", [
        union,
      ]);
      await connection.query('DROP VIEW pg_temp.view_report_1');
      await connection.query('BEGIN');
      await saveReportTables(connection, top, new Set());
      await connection.query('COMMIT');
      assert.equal((await objects()).table_oid, before.table_oid);
      assert.equal(
        (await connection.query("SELECT xml_data FROM pg_temp.mst_report_table WHERE report_file_name='view1.xml'"))
          .rows[0].xml_data,
        union,
      );
      assert.deepEqual(
        (await connection.query('SELECT rep_top_id,cluster_1_0_t FROM pg_temp.view_report_1 ORDER BY rep_top_id')).rows,
        [
          { rep_top_id: 2, cluster_1_0_t: 'saved text' },
          { rep_top_id: 9, cluster_1_0_t: 'older revision' },
        ],
      );
    }),
);

test(
  'cooperation conversion failure rolls back report, new tables and mappings; retry commits without resetting restored data',
  enabled,
  async () =>
    fixture(async (db, connection) => {
      const directory = await mkdtemp(join(tmpdir(), 'conmas-table-rollback-'));
      let upload: ReportUpload | undefined;
      const file = async (data: string): Promise<Express.Multer.File> => {
        const path = join(directory, 'report');
        await writeFile(path, data);
        return { fieldname: 'report', path, size: Buffer.byteLength(data) } as Express.Multer.File;
      };
      const source = xml
        .replace('<defTopId>', '<cooperationTable>1</cooperationTable><defTopId>')
        .replace('<type>KeyboardText</type><value>saved text', '<type>InputNumeric</type><value>1');
      const incoming = (value: string) =>
        `<conmas><sheet><defSheetId>10</defSheetId><sheetNo>1</sheetNo><clusters><cluster><clusterId>0</clusterId><value>${value}</value></cluster></clusters></sheet></conmas>`;
      try {
        await connection.query('UPDATE pg_temp.def_top SET xml_data=$1', [source]);
        upload = (await beginReportUpload(db, actor, [
          await file(
            '<conmas><top><defTopId>1</defTopId><repTopId/><repTopName>numeric report</repTopName><editStatus>1</editStatus><thumbnail/><sheets/></top></conmas>',
          ),
        ])) as ReportUpload;
        await stageReportSheet(db, actor, upload, [await file(incoming('1234567890123'))]);
        await assert.rejects(
          finishReportUpload(db, actor, upload),
          (error) => !!error && typeof error === 'object' && 'code' in error && error.code === '22003',
        );
        assert.equal(upload.result, undefined);
        assert.equal((await connection.query("SELECT to_regclass('pg_temp.report_1') AS object")).rows[0].object, null);
        assert.equal((await connection.query('SELECT COUNT(*)::int n FROM pg_temp.mst_report_table')).rows[0].n, 0);
        assert.equal((await connection.query('SELECT COUNT(*)::int n FROM pg_temp.rep_top')).rows[0].n, 1);
        await stageReportSheet(db, actor, upload, [await file(incoming('42.1234567890'))]);
        assert.equal(parser.parse(await finishReportUpload(db, actor, upload)).conmas.error.code, '0');
        assert.equal(
          (await connection.query('SELECT cluster_1_0_n FROM pg_temp.report_1')).rows[0].cluster_1_0_n,
          '42.1234567890',
        );
      } finally {
        await cleanupReportUpload(upload);
        await rm(directory, { recursive: true, force: true });
      }
    }),
);

test(
  'cooperation split creation/repair preserves first table rows and sticky mappings across retries',
  enabled,
  async () =>
    fixture(async (_db, connection) => {
      const clusters = Array.from(
        { length: 374 },
        (_, i) =>
          `<cluster><sheetNo>1</sheetNo><clusterId>${i}</clusterId><name>Field ${i}</name><type>KeyboardText</type><value>value ${i}</value></cluster>`,
      ).join('');
      const source = xml
        .replace('<defTopId>', '<cooperationTable>1</cooperationTable><defTopId>')
        .replace(/<clusters>[\s\S]*?<\/clusters>/, '<clusters>' + clusters + '</clusters>');
      await connection.query('UPDATE pg_temp.def_top SET xml_data=$1', [source]);
      await connection.query(
        "INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (1,'COOPERATION_TABLE_SETTING','DIVIDE_TABLE_MODE','1')",
      );
      const top = must(root(source), 'top');
      await connection.query('BEGIN');
      await saveReportTables(connection, top, new Set());
      await connection.query('COMMIT');
      assert.equal(
        (await connection.query('SELECT cluster_1_372_t FROM pg_temp.report_1_s_1 WHERE rep_top_id=2')).rows[0]
          .cluster_1_372_t,
        'value 372',
      );
      assert.equal(
        (await connection.query('SELECT cluster_1_373_t FROM pg_temp.report_1_s_2 WHERE rep_top_id=2')).rows[0]
          .cluster_1_373_t,
        'value 373',
      );
      const mapping = (
        await connection.query("SELECT xml_data FROM pg_temp.mst_report_table WHERE report_file_name='1.xml'")
      ).rows[0].xml_data;
      await connection.query("INSERT INTO pg_temp.report_1_s_1 (rep_top_id,cluster_1_0_t) VALUES (987,'keep')");
      await connection.query('DROP VIEW pg_temp.view_report_1');
      await connection.query('DROP TABLE pg_temp.report_1_s_2');
      await connection.query("UPDATE pg_temp.mst_common SET com_value='0' WHERE com_id=1");
      const cluster = children(must(children(must(top, 'sheets'), 'sheet')[0], 'clusters'), 'cluster')[373];
      replace(cluster, 'value', 'repaired');
      await connection.query('BEGIN');
      await saveReportTables(connection, top, new Set(['1,373']));
      await connection.query('COMMIT');
      assert.equal(
        (await connection.query('SELECT cluster_1_0_t FROM pg_temp.report_1_s_1 WHERE rep_top_id=987')).rows[0]
          .cluster_1_0_t,
        'keep',
      );
      assert.equal(
        (await connection.query('SELECT cluster_1_373_t FROM pg_temp.report_1_s_2 WHERE rep_top_id=2')).rows[0]
          .cluster_1_373_t,
        'repaired',
      );
      assert.equal(
        (await connection.query("SELECT xml_data FROM pg_temp.mst_report_table WHERE report_file_name='1.xml'")).rows[0]
          .xml_data,
        mapping,
      );
    }),
);

test(
  'legacy detail cooperation persists headers, numeric detail and check-group labels with omitted-value preservation',
  enabled,
  async () =>
    fixture(async (_db, connection) => {
      const header =
        '<cluster><sheetNo>1</sheetNo><clusterId>0</clusterId><name>Header</name><type>KeyboardText</type><value>title</value><remarksValue1>{ir_header}</remarksValue1><remarksValue3>2</remarksValue3></cluster>';
      const details = [1, 2]
        .flatMap((row) => [
          `<cluster><sheetNo>1</sheetNo><clusterId>${row * 2}</clusterId><name>Number</name><type>InputNumeric</type><value>${row}.25</value><remarksValue1>{ir_detail}</remarksValue1><remarksValue2>1</remarksValue2><remarksValue3>3</remarksValue3><remarksValue4>${row}</remarksValue4></cluster>`,
          `<cluster><sheetNo>1</sheetNo><clusterId>${row * 2 + 1}</clusterId><name>Selected ${row}</name><type>Check</type><value>TRUE</value><inputParameters>Group=7</inputParameters><remarksValue1>{ir_detail}</remarksValue1><remarksValue2>1</remarksValue2><remarksValue3>4</remarksValue3><remarksValue4>${row}</remarksValue4></cluster>`,
        ])
        .join('');
      const source = xml
        .replace('<defTopId>', '<cooperationTable>1</cooperationTable><defTopId>')
        .replace(/<clusters>[\s\S]*?<\/clusters>/, '<clusters>' + header + details + '</clusters>');
      await connection.query('UPDATE pg_temp.def_top SET xml_data=$1', [source]);
      const top = must(root(source), 'top');
      await connection.query('BEGIN');
      await saveReportTables(connection, top, new Set());
      await connection.query('COMMIT');
      const rows = (await connection.query('SELECT * FROM pg_temp.report_1_1 ORDER BY rep_row_no')).rows;
      assert.equal(rows.length, 2);
      assert.equal(rows[0].header_2_t, 'title');
      assert.equal(rows[0].detail_3_n, '1.2500000000');
      assert.equal(rows[1].group_7_t, 'Selected 2');
      const nodes = children(must(children(must(top, 'sheets'), 'sheet')[0], 'clusters'), 'cluster');
      replace(
        nodes.find((node) => field(node, 'clusterId') === '2')!,
        'value',
        '9.5',
      );
      await connection.query('UPDATE pg_temp.report_1_1 SET detail_3_n=88 WHERE rep_row_no=2');
      await connection.query('BEGIN');
      await saveReportTables(connection, top, new Set(['1,2']));
      await connection.query('COMMIT');
      assert.equal(
        (await connection.query('SELECT detail_3_n FROM pg_temp.report_1_1 WHERE rep_row_no=1')).rows[0].detail_3_n,
        '9.5000000000',
      );
      assert.equal(
        (await connection.query('SELECT detail_3_n FROM pg_temp.report_1_1 WHERE rep_row_no=2')).rows[0].detail_3_n,
        '88.0000000000',
      );
    }),
);

test(
  'modern selected cooperation rows resolve column keys from fixed sheets, retain row names and preserve other reports',
  enabled,
  async () =>
    fixture(async (_db, connection) => {
      const table =
        '<table><no>1</no><cooperationTable>1</cooperationTable><columns><column><no>1</no><key>item</key><type>text</type></column></columns><rows><row><no>1</no><name>First</name><clusters><cluster><sheetNo>1</sheetNo><clusterId>0</clusterId><columnKey>item</columnKey></cluster></clusters></row><row><no>2</no><name>Second</name><clusters><cluster><sheetNo>1</sheetNo><clusterId>3</clusterId><columnKey>item</columnKey></cluster></clusters></row></rows></table>';
      const source = xml
        .replace('<defTopId>', '<cooperationTable>2</cooperationTable><tables>' + table + '</tables><defTopId>')
        .replaceAll('<type>', '<cooperationCluster>1</cooperationCluster><type>');
      await connection.query('UPDATE pg_temp.def_top SET xml_data=$1', [source]);
      const top = must(root(source), 'top');
      await connection.query('BEGIN');
      await saveReportTables(connection, top, new Set());
      await connection.query('COMMIT');
      assert.deepEqual(
        (
          await connection.query(
            'SELECT rep_row_no,rep_row_name,cluster_item_t FROM pg_temp.report_1_1 ORDER BY rep_row_no',
          )
        ).rows,
        [
          { rep_row_no: 1, rep_row_name: 'First', cluster_item_t: 'saved text' },
          { rep_row_no: 2, rep_row_name: 'Second', cluster_item_t: 'original' },
        ],
      );
      await connection.query(
        "INSERT INTO pg_temp.report_1_1 (rep_top_id,rep_row_no,cluster_item_t) VALUES (987,1,'keep')",
      );
      replace(children(must(children(must(top, 'sheets'), 'sheet')[0], 'clusters'), 'cluster')[0], 'value', 'updated');
      await connection.query('BEGIN');
      await saveReportTables(connection, top, new Set(['1,0']));
      await connection.query('COMMIT');
      assert.equal(
        (await connection.query('SELECT cluster_item_t FROM pg_temp.report_1_1 WHERE rep_top_id=2 AND rep_row_no=1'))
          .rows[0].cluster_item_t,
        'updated',
      );
      assert.equal(
        (await connection.query('SELECT cluster_item_t FROM pg_temp.report_1_1 WHERE rep_top_id=987')).rows[0]
          .cluster_item_t,
        'keep',
      );
    }),
);

test(
  'modern cooperation numeric/date columns null invalid values and persist exact boundaries and compact dates',
  enabled,
  async () =>
    fixture(async (_db, connection) => {
      const table =
        '<table><no>1</no><cooperationTable>1</cooperationTable><columns><column><no>1</no><key>amount</key><type>numeric</type></column><column><no>2</no><key>day</key><type>date</type></column></columns><rows><row><no>1</no><clusters><cluster><sheetNo>1</sheetNo><clusterId>0</clusterId><columnKey>amount</columnKey></cluster><cluster><sheetNo>1</sheetNo><clusterId>3</clusterId><columnKey>day</columnKey></cluster></clusters></row></rows></table>';
      const source = xml
        .replace('<defTopId>', '<cooperationTable>2</cooperationTable><tables>' + table + '</tables><defTopId>')
        .replaceAll('<type>', '<cooperationCluster>1</cooperationCluster><type>');
      await connection.query('UPDATE pg_temp.def_top SET xml_data=$1', [source]);
      const top = must(root(source), 'top'),
        clusters = children(must(children(must(top, 'sheets'), 'sheet')[0], 'clusters'), 'cluster');
      const save = async (changed: Set<string>) => {
        await connection.query('BEGIN');
        await saveReportTables(connection, top, changed);
        await connection.query('COMMIT');
      };
      await save(new Set());
      assert.deepEqual(
        (await connection.query('SELECT cluster_amount_n,cluster_day_d FROM pg_temp.report_1_1')).rows[0],
        { cluster_amount_n: null, cluster_day_d: null },
      );
      replace(clusters[0], 'value', '999999999.9999999999');
      replace(clusters[3], 'value', '20261107');
      await save(new Set(['1,0', '1,3']));
      assert.deepEqual(
        (await connection.query('SELECT cluster_amount_n,cluster_day_d::text FROM pg_temp.report_1_1')).rows[0],
        { cluster_amount_n: '999999999.9999999999', cluster_day_d: '2026-11-07 00:00:00' },
      );
      replace(clusters[0], 'value', '1000000000');
      await save(new Set(['1,0']));
      assert.deepEqual(
        (await connection.query('SELECT cluster_amount_n,cluster_day_d::text FROM pg_temp.report_1_1')).rows[0],
        { cluster_amount_n: null, cluster_day_d: '2026-11-07 00:00:00' },
      );
    }),
);

test(
  'layer XML comments/parameters persist with unchanged omitted binaries and invalid/duplicate layer IDs reject',
  enabled,
  async () =>
    fixture(async (db, connection) => {
      const directory = await mkdtemp(join(tmpdir(), 'conmas-layer-fixture-'));
      let upload: ReportUpload | undefined;
      const file = async (data: string): Promise<Express.Multer.File> => {
        const path = join(directory, 'report');
        await writeFile(path, data);
        return { fieldname: 'report', path, size: Buffer.byteLength(data) } as Express.Multer.File;
      };
      const top =
        '<conmas><top><defTopId>1</defTopId><repTopId>2</repTopId><repTopName>layer update</repTopName><editStatus>1</editStatus><thumbnail/><sheets/></top></conmas>';
      const incoming = (layers: string) =>
        '<conmas><sheet><defSheetId>10</defSheetId><sheetNo>1</sheetNo><clusters/><layers>' +
        layers +
        '</layers></sheet></conmas>';
      const layer =
        '<layer><layerNo>1</layerNo><value>new &amp; kept</value><inputParameters>Required=0;Width=4;Color=1,2,3</inputParameters></layer>';
      try {
        await connection.query(
          'INSERT INTO pg_temp.rep_layer (rep_top_id,rep_sheet_id,rep_sheet_no,layer_id,input_value,input_parameters,binary_file,image_file) VALUES (2,20,1,1,$1,$2,$3,$4)',
          ['old', 'old params', Buffer.from('preserved ink'), Buffer.from('preserved preview')],
        );
        upload = (await beginReportUpload(db, actor, [await file(top)])) as ReportUpload;
        assert.equal(
          parser.parse(
            await stageReportSheet(db, actor, upload, [
              await file(incoming(layer.replace('<layerNo>1', '<layerNo>9'))),
            ]),
          ).conmas.error.code,
          '2',
        );
        assert.equal(
          parser.parse(await stageReportSheet(db, actor, upload, [await file(incoming(layer + layer))])).conmas.error
            .code,
          '2',
        );
        assert.equal(
          parser.parse(await stageReportSheet(db, actor, upload, [await file(incoming(layer))])).conmas.error.code,
          '0',
        );
        assert.equal(parser.parse(await finishReportUpload(db, actor, upload)).conmas.error.code, '0');
        const row = (await connection.query('SELECT * FROM pg_temp.rep_layer WHERE rep_sheet_id=20')).rows[0];
        assert.equal(row.input_value, 'new & kept');
        assert.equal(row.input_parameters, 'Required=0;Width=4;Color=1,2,3');
        assert.equal(row.binary_file.toString(), 'preserved ink');
        assert.equal(row.image_file.toString(), 'preserved preview');
        const saved = parser.parse(
          (await connection.query('SELECT xml_data FROM pg_temp.rep_top WHERE rep_top_id=2')).rows[0].xml_data,
        ).conmas.top.sheets.sheet.layers.layer;
        assert.equal(saved.value, row.input_value);
        assert.equal(saved.inputParameters, row.input_parameters);
      } finally {
        await cleanupReportUpload(upload);
        await rm(directory, { recursive: true, force: true });
      }
    }),
);

test('Windows lists/detail use tablet creation permission, report filters and read denial', enabled, async () =>
  fixture(async (db, connection) => {
    const request = { labelId: '-9', itemTargetLabel: 'false', itemTargetBook: 'false', sortId: '2', sortType: 'desc' };
    assert.deepEqual(
      items(await getDefinitionList(db, actor, request)).map((item) => item.itemId),
      ['1'],
    );
    assert.equal(items(await getDefinitionList(db, actor, request))[0].designerVersion, undefined);
    assert.equal(parser.parse(await getDefinitionDetail(db, actor, 1)).conmas.detailInfo.readOnly, '0');
    assert.equal(
      parser.parse(await getDefinitionDetail(db, { ...actor, client: 'Designer' }, 1)).conmas.detailInfo.readOnly,
      '1',
    );
    assert.deepEqual(
      items(await getReportList(db, actor, request)).map((item) => item.itemId),
      ['2'],
    );
    assert.deepEqual(items(await getReportList(db, actor, { ...request, definition: '999' })), []);
    assert.deepEqual(items(await getReportList(db, actor, { ...request, registTimeFrom: '2999/01/01' })), []);
    assert.deepEqual(
      items(await getReportList(db, actor, { ...request, word: "' OR 1=1 --", wordTargetName: 'true' })),
      [],
    );
    assert.equal(parser.parse(await getReportDetail(db, actor, 2)).conmas.detailInfo.hide, '1');
    await connection.query(
      'UPDATE pg_temp.def_role SET role_rep_create=0;UPDATE pg_temp.rep_role SET role_rep_read=0,role_rep_update=0;',
    );
    assert.equal(parser.parse(await getDefinitionDetail(db, actor, 1)).conmas.detailInfo.readOnly, '1');
    assert.deepEqual(
      items(await getDefinitionList(db, actor, request)).map((item) => item.itemId),
      ['1'],
    );
    await connection.query('UPDATE pg_temp.def_role SET role_def_read=0');
    assert.deepEqual(items(await getDefinitionList(db, actor, request)), []);
    assert.deepEqual(items(await getReportList(db, actor, request)), []);
    assert.equal(parser.parse(await getReportDetail(db, actor, 2)).conmas.error.code, '3');
  }),
);

test(
  'Windows named upload persists report/XML/binaries before finish success and repeat finish is idempotent',
  enabled,
  async () =>
    fixture(async (db, connection) => {
      const directory = await mkdtemp(join(tmpdir(), 'conmas-upload-fixture-'));
      let upload: ReportUpload | undefined;
      const file = async (name: string, data: string | Buffer): Promise<Express.Multer.File> => {
        const path = join(directory, name);
        await writeFile(path, data);
        return { fieldname: name, path, size: Buffer.byteLength(data) } as Express.Multer.File;
      };
      try {
        const started = await beginReportUpload(db, actor, [
          await file(
            'report',
            '<conmas><top><defTopId>1</defTopId><repTopId/><repTopName>filled report</repTopName><editStatus>1</editStatus><thumbnail/><repTopAppId>private-app-id</repTopAppId><sheets/></top></conmas>',
          ),
        ]);
        assert.notEqual(typeof started, 'string');
        upload = started as ReportUpload;
        assert.equal(parser.parse(await finishReportUpload(db, actor, upload)).conmas.error.code, '2');
        const bytes = Array.from({ length: 12 }, (_, i) => Buffer.from('embedded image ' + i));
        const files: Express.Multer.File[] = [
          await file('cluster_1_value', Buffer.from('Windows drawing')),
          await file('cluster_1_displayValue', Buffer.from('drawing preview')),
          await file('cluster_2_sound', Buffer.from('recorded audio')),
        ];
        for (let i = 0; i < bytes.length; i++) files.push(await file('cluster_1_image_' + (i + 1), bytes[i]));
        files.push(
          await file(
            'report',
            '<conmas><sheet><defSheetId>10</defSheetId><repSheetId/><sheetNo>1</sheetNo><clusters><cluster><clusterId>0</clusterId><value>entered &amp; kept</value><displayValue>entered &amp; kept</displayValue></cluster><cluster><clusterId>1</clusterId><value/><displayValue/></cluster><cluster><clusterId>2</clusterId><value/><displayValue/><fileExtension>wav</fileExtension></cluster></clusters></sheet></conmas>',
          ),
        );
        assert.equal(parser.parse(await stageReportSheet(db, actor, upload, files)).conmas.error.code, '0');
        assert.equal((await connection.query('SELECT COUNT(*)::int n FROM pg_temp.rep_top')).rows[0].n, 1);
        assert.equal(
          parser.parse(
            await stageReportFreeDrawInfo(upload, [
              await file(
                'pageOrder',
                '<conmas><sheets><sheet><sheetIndex>1</sheetIndex><fdSheetNo>9</fdSheetNo></sheet></sheets></conmas>',
              ),
            ]),
          ).conmas.error.code,
          '0',
        );
        assert.equal(
          parser.parse(
            await stageReportFreeDraw(
              upload,
              [await file('pdfFile', Buffer.from('free pdf')), await file('irfdFile', Buffer.from('free irfd'))],
              '9',
              '0',
            ),
          ).conmas.error.code,
          '0',
        );
        const results = await Promise.all([
          finishReportUpload(db, actor, upload),
          finishReportUpload(db, actor, structuredClone(upload)),
        ]);
        for (const result of results) assert.equal(parser.parse(result).conmas.error.code, '0');
        const report = (await connection.query('SELECT * FROM pg_temp.rep_top WHERE rep_top_id=100')).rows[0];
        assert.equal(report.rep_top_name, 'filled report');
        assert.equal(Number(report.edit_refer_status), 1);
        assert.equal(report.sys_regist_user, actor.userId);
        const saved = parser.parse(report.xml_data).conmas.top;
        assert.equal(saved.repTopId, '100');
        assert.equal(saved.sheets.sheet.repSheetId, '200');
        assert.equal(saved.sheets.sheet.clusters.cluster[0].value, 'entered & kept');
        assert.equal(saved.sheets.sheet.clusters.cluster[3].value, 'original');
        const clusters = (
          await connection.query('SELECT * FROM pg_temp.rep_cluster WHERE rep_sheet_id=200 ORDER BY cluster_id')
        ).rows;
        assert.equal(clusters[0].input_value, 'entered & kept');
        assert.equal(clusters[1].binary_file_win.toString(), 'Windows drawing');
        assert.equal(clusters[1].image_file.toString(), 'drawing preview');
        assert.equal(clusters[2].recording_file.toString(), 'recorded audio');
        assert.equal(
          (await connection.query('SELECT COUNT(*)::int n FROM pg_temp.rep_cluster_draw WHERE rep_sheet_id=200'))
            .rows[0].n,
          12,
        );
        assert.equal((await getReportFreeDraw(db, actor, '100', '9', 'pdf')).toString(), 'free pdf');
        assert.equal(parser.parse(await finishReportUpload(db, actor, upload)).conmas.error.code, '0');
        assert.equal((await connection.query('SELECT COUNT(*)::int n FROM pg_temp.rep_top')).rows[0].n, 2);
        const download = await getReportDownload(db, actor, { topId: '100' }, false);
        assert.notEqual(typeof download, 'string');
        const binary = await reportSheetBinaries(db, actor, download as ReportDownload, '100', '1');
        assert(Buffer.isBuffer(binary));
        assert.equal(unzip(binary).get('cluster_1_value')?.toString(), 'Windows drawing');
        await cleanupReportUpload(upload);
        assert.equal(await stat(upload.directory).catch(() => undefined), undefined);
      } finally {
        await cleanupReportUpload(upload);
        await rm(directory, { recursive: true, force: true });
      }
    }),
);

test(
  'upload rejects unauthorized clusters/revoked roles, rolls back missing binaries and preserves existing unsent data',
  enabled,
  async () =>
    fixture(async (db, connection) => {
      const directory = await mkdtemp(join(tmpdir(), 'conmas-upload-failure-'));
      let upload: ReportUpload | undefined;
      const file = async (name: string, data: string | Buffer): Promise<Express.Multer.File> => {
        const path = join(directory, name);
        await writeFile(path, data);
        return { fieldname: name, path, size: Buffer.byteLength(data) } as Express.Multer.File;
      };
      const top =
        '<conmas><top><defTopId>1</defTopId><repTopId>2</repTopId><repTopName>updated report</repTopName><editStatus>1</editStatus><thumbnail/><sheets/></top></conmas>';
      const uploadedSheet = (id: number) =>
        `<conmas><sheet><defSheetId>10</defSheetId><repSheetId>20</repSheetId><sheetNo>1</sheetNo><clusters><cluster><clusterId>${id}</clusterId><value>changed</value><displayValue>changed</displayValue></cluster></clusters></sheet></conmas>`;
      try {
        await connection.query(
          'UPDATE pg_temp.rep_cluster SET binary_file_win=$1,binary_file_type=$2 WHERE cluster_id=1',
          [Buffer.from('untouched drawing'), 'Windows'],
        );
        upload = (await beginReportUpload(db, actor, [await file('report', top)])) as ReportUpload;
        assert.equal(
          parser.parse(await stageReportSheet(db, actor, upload, [await file('report', uploadedSheet(3))])).conmas.error
            .code,
          '3',
        );
        assert.equal(
          parser.parse(
            await stageReportSheet(db, actor, upload, [
              await file('report', uploadedSheet(0)),
              await file('cluster_0_value', 'wrong binary for text'),
            ]),
          ).conmas.error.code,
          '2',
        );
        assert.equal(
          parser.parse(
            await stageReportSheet(db, actor, upload, [
              await file('report', uploadedSheet(1)),
              await file('cluster_1_value', 'new ink'),
            ]),
          ).conmas.error.code,
          '0',
        );
        const path = upload.sheets['1'].files.cluster_1_value;
        await rm(path);
        await assert.rejects(finishReportUpload(db, actor, upload), /ENOENT/);
        assert.equal(
          (await connection.query('SELECT xml_data FROM pg_temp.rep_top WHERE rep_top_id=2')).rows[0].xml_data,
          xml,
        );
        assert.equal(
          (
            await connection.query('SELECT binary_file_win FROM pg_temp.rep_cluster WHERE cluster_id=1')
          ).rows[0].binary_file_win.toString(),
          'untouched drawing',
        );
        assert.equal(upload.result, undefined);
        assert.equal(
          parser.parse(await stageReportSheet(db, actor, upload, [await file('report', uploadedSheet(0))])).conmas.error
            .code,
          '0',
        );
        await connection.query('UPDATE pg_temp.rep_role SET role_rep_update=0');
        assert.equal(parser.parse(await finishReportUpload(db, actor, upload)).conmas.error.code, '3');
        await connection.query('UPDATE pg_temp.rep_role SET role_rep_update=1');
        assert.equal(parser.parse(await finishReportUpload(db, actor, upload, false)).conmas.error.code, '0');
        assert.equal(
          (await connection.query('SELECT input_value FROM pg_temp.rep_cluster WHERE cluster_id=0')).rows[0]
            .input_value,
          'changed',
        );
        assert.equal(
          (
            await connection.query('SELECT binary_file_win FROM pg_temp.rep_cluster WHERE cluster_id=1')
          ).rows[0].binary_file_win.toString(),
          'untouched drawing',
        );
        assert.equal(
          (await connection.query('SELECT COUNT(*)::int n FROM pg_temp.rep_lock WHERE rep_top_id=2')).rows[0].n,
          1,
        );
        await cleanupReportUpload(upload);
        upload = (await beginReportUpload(db, actor, [await file('report', top)])) as ReportUpload;
        await stageReportSheet(db, actor, upload, [await file('report', uploadedSheet(0))]);
        await connection.query(
          "UPDATE pg_temp.rep_top SET xml_data=replace(xml_data,'updated report','concurrent update') WHERE rep_top_id=2",
        );
        assert.equal(parser.parse(await finishReportUpload(db, actor, upload)).conmas.error.code, '1010');
        await cleanupReportUpload(upload);
        const completeTop = top.replace('<editStatus>1</editStatus>', '<editStatus>4</editStatus>');
        upload = (await beginReportUpload(db, actor, [await file('report', completeTop)])) as ReportUpload;
        await stageReportSheet(db, actor, upload, [await file('report', uploadedSheet(0))]);
        assert.equal(parser.parse(await finishReportUpload(db, actor, upload)).conmas.error.code, '0');
        assert.equal(
          Number(
            (await connection.query('SELECT edit_refer_status FROM pg_temp.rep_top WHERE rep_top_id=2')).rows[0]
              .edit_refer_status,
          ),
          4,
        );
        const completed = await getReportDownload(db, actor, { topId: '2' }, false);
        assert.equal(parser.parse((completed as ReportDownload).xml).conmas.top.readOnly, '1');
      } finally {
        await cleanupReportUpload(upload);
        await rm(directory, { recursive: true, force: true });
      }
    }),
);

test(
  'tablet definition and report top/sheet transfers preserve permissions, binaries and lock ownership',
  enabled,
  async () =>
    fixture(async (db, connection) => {
      const definition = await getReportDownload(db, actor, { topId: '1' }, true);
      assert.notEqual(typeof definition, 'string');
      const top = parser.parse(reportDownloadTop(definition as ReportDownload)).conmas.top;
      assert.equal(top.repTopName, 'Windows form');
      assert.equal(top.sheets, '');
      assert.equal(top.defTopOrg, '1');
      const received = parser.parse(reportDownloadSheet(definition as ReportDownload, '1', '1', true)).conmas.sheet;
      assert.equal(received.layers.layer.inputParameters, 'Required=0;Width=8;Color=0,0,0');
      assert.equal(received.clusters.cluster[3].hide, '1');
      assert.equal(received.clusters.cluster[3].readOnly, '1');
      assert.equal((await connection.query('SELECT COUNT(*)::int AS n FROM pg_temp.def_lock')).rows[0].n, 0);
      await connection.query(
        'UPDATE pg_temp.rep_cluster SET binary_file_type=$1,binary_file_win=$2,binary_file=$3,image_file=$4 WHERE cluster_id=1',
        ['Windows', Buffer.from('win ink'), Buffer.from('ios ink'), Buffer.from('display')],
      );
      await connection.query('UPDATE pg_temp.rep_cluster SET recording_file=$1 WHERE cluster_id=2', [
        Buffer.from('audio'),
      ]);
      await connection.query(
        'INSERT INTO pg_temp.rep_layer (rep_top_id,rep_sheet_id,rep_sheet_no,layer_id,binary_file,image_file) VALUES (2,20,1,1,$1,$2)',
        [Buffer.from('layer ink'), Buffer.from('layer display')],
      );
      const download = await getReportDownload(db, actor, { topId: '2' }, false);
      assert.notEqual(typeof download, 'string');
      assert.equal((await connection.query('SELECT user_id FROM pg_temp.rep_lock')).rows[0].user_id, actor.userId);
      const binary = await reportSheetBinaries(db, actor, download as ReportDownload, '2', '1');
      assert(Buffer.isBuffer(binary));
      const entries = unzip(binary);
      assert.deepEqual(
        [...entries.keys()],
        ['cluster_1_value', 'cluster_1_displayValue', 'cluster_2_sound', 'layer_1_value', 'layer_1_displayValue'],
      );
      assert.equal(entries.get('cluster_1_value')?.toString(), 'win ink');
      assert.equal(entries.get('cluster_2_sound')?.toString(), 'audio');
      assert.equal(
        parser.parse((await reportSheetBinaries(db, actor, download as ReportDownload, '1', '1')) as string).conmas
          .error.code,
        '2',
      );
      assert.notEqual(typeof (await getReportDownload(db, actor, { topId: '2' }, false)), 'string');
      await connection.query("UPDATE pg_temp.rep_lock SET user_id='other',sys_regist_term='other-terminal'");
      assert.equal(
        parser.parse((await getReportDownload(db, actor, { topId: '2' }, false)) as string).conmas.error.code,
        '1010',
      );
      assert.equal((await connection.query('SELECT user_id FROM pg_temp.rep_lock')).rows[0].user_id, 'other');
      await connection.query('UPDATE pg_temp.rep_top SET edit_refer_status=4');
      const completed = await getReportDownload(db, actor, { topId: '2' }, false);
      assert.equal(parser.parse((completed as ReportDownload).xml).conmas.top.readOnly, '1');
      assert.equal((await connection.query('SELECT xml_data FROM pg_temp.rep_top')).rows[0].xml_data, xml);
    }),
);

test(
  'saved-report copy preserves source locks/data, snapshots binaries and keeps permissions and workflow gates',
  enabled,
  async () =>
    fixture(async (db, connection) => {
      const savedXml = xml.replace('<editStatus>1</editStatus>', '<editStatus>4</editStatus>');
      await connection.query('UPDATE pg_temp.rep_top SET edit_refer_status=4,xml_data=$1', [savedXml]);
      await connection.query(
        "INSERT INTO pg_temp.rep_lock (rep_top_id,user_id,sys_regist_term) VALUES (2,'other','other-terminal'); INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (1,'LOCK_SETTING','REPORT_STRICT_LOCK','1')",
      );
      await connection.query(
        'UPDATE pg_temp.rep_cluster SET binary_file_type=$1,binary_file_win=$2,image_file=$3 WHERE cluster_id=1',
        ['Windows', Buffer.from('copy ink'), Buffer.from('copy preview')],
      );
      await connection.query('UPDATE pg_temp.rep_cluster SET recording_file=$1 WHERE cluster_id=2', [
        Buffer.from('copy audio'),
      ]);
      await connection.query(
        'INSERT INTO pg_temp.rep_layer (rep_top_id,rep_sheet_id,rep_sheet_no,layer_id,binary_file,image_file) VALUES (2,20,1,1,$1,$2)',
        [Buffer.from('copy layer'), Buffer.from('copy layer preview')],
      );
      const source = await connection.query('SELECT * FROM pg_temp.rep_top WHERE rep_top_id=2'),
        locks = await connection.query('SELECT * FROM pg_temp.rep_lock');
      const normal = (await getReportDownload(db, actor, { topId: '2' }, false)) as ReportDownload;
      assert.equal(parser.parse(normal.xml).conmas.top.readOnly, '1');
      assert.equal(
        parser.parse(reportDownloadSheet(normal, '2', '1', false)).conmas.sheet.clusters.cluster[0].readOnly,
        '1',
      );
      const copy = (await getReportDownload(db, actor, { topId: '2', copy: '1' }, false)) as ReportDownload;
      const top = parser.parse(reportDownloadTop(copy)).conmas.top;
      assert.equal(top.repTopId, '2');
      assert.equal(top.editStatus, '4');
      assert.equal(top.readOnly, '0');
      assert.equal(top.locked, '0');
      const copiedSheet = parser.parse(reportDownloadSheet(copy, '2', '1', false)).conmas.sheet;
      assert.equal(copiedSheet.clusters.cluster[0].value, 'saved text');
      assert.equal(copiedSheet.clusters.cluster[0].readOnly, '0');
      assert.equal(copiedSheet.clusters.cluster[3].hide, '1');
      assert.equal(copiedSheet.clusters.cluster[3].readOnly, '1');
      assert.deepEqual((await connection.query('SELECT * FROM pg_temp.rep_top WHERE rep_top_id=2')).rows, source.rows);
      assert.deepEqual((await connection.query('SELECT * FROM pg_temp.rep_lock')).rows, locks.rows);
      assert.deepEqual(
        (await connection.query('SELECT last_value,is_called FROM pg_temp.rep_top_rep_top_id_seq')).rows,
        [{ last_value: '100', is_called: false }],
      );
      const serializedCopy = JSON.parse(JSON.stringify(copy)) as ReportDownload;
      await connection.query('UPDATE pg_temp.rep_cluster SET binary_file_win=$1,recording_file=$1,image_file=$1', [
        Buffer.from('concurrent edit'),
      ]);
      await connection.query('UPDATE pg_temp.rep_layer SET binary_file=$1,image_file=$1', [
        Buffer.from('concurrent edit'),
      ]);
      const noDatabase = {
        connect() {
          throw new Error('Copy binaries must use the staged snapshot.');
        },
      } as unknown as pg.Pool;
      const bytes = await reportSheetBinaries(noDatabase, actor, serializedCopy, '2', '1');
      assert(Buffer.isBuffer(bytes));
      const entries = unzip(bytes);
      assert.equal(entries.get('cluster_1_value')?.toString(), 'copy ink');
      assert.equal(entries.get('cluster_1_displayValue')?.toString(), 'copy preview');
      assert.equal(entries.get('cluster_2_sound')?.toString(), 'copy audio');
      assert.equal(entries.get('layer_1_value')?.toString(), 'copy layer');
      assert.equal(
        parser.parse((await reportSheetBinaries(noDatabase, actor, serializedCopy, '999', '1')) as string).conmas.error
          .code,
        '2',
      );
      assert.equal(
        parser.parse((await reportSheetBinaries(noDatabase, actor, serializedCopy, '2', '999')) as string).conmas.error
          .code,
        '8',
      );
      assert.equal(
        parser.parse(
          (await getReportDownload(db, { ...actor, userId: '' }, { topId: '2', copy: '1' }, false)) as string,
        ).conmas.error.code,
        '5',
      );
      assert.equal(
        parser.parse((await getReportDownload(db, actor, { topId: '999', copy: '1' }, false)) as string).conmas.error
          .code,
        '8',
      );
      await connection.query('UPDATE pg_temp.rep_role SET role_rep_update=0');
      assert.equal(
        parser.parse(((await getReportDownload(db, actor, { topId: '2', copy: '1' }, false)) as ReportDownload).xml)
          .conmas.top.readOnly,
        '1',
      );
      await connection.query('UPDATE pg_temp.rep_role SET role_rep_read=0');
      assert.equal(
        parser.parse((await getReportDownload(db, actor, { topId: '2', copy: '1' }, false)) as string).conmas.error
          .code,
        '1003',
      );
      await connection.query(
        'UPDATE pg_temp.rep_role SET role_rep_update=1,role_rep_read=1; UPDATE pg_temp.rep_top SET workflow_lock=1',
      );
      const workflow = (await getReportDownload(db, actor, { topId: '2', copy: '1' }, false)) as ReportDownload;
      assert.equal(parser.parse(workflow.xml).conmas.top.readOnly, '1');
      assert.equal(
        parser.parse(reportDownloadSheet(workflow, '2', '1', false)).conmas.sheet.clusters.cluster[0].readOnly,
        '1',
      );
      await connection.query('UPDATE pg_temp.rep_top SET workflow_lock=0,use_applicant_lock=1');
      assert.equal(
        parser.parse(((await getReportDownload(db, actor, { topId: '2', copy: '1' }, false)) as ReportDownload).xml)
          .conmas.top.readOnly,
        '0',
      );
      await connection.query('UPDATE pg_temp.rep_top SET use_applicant_lock=0,deleted=1');
      assert.equal(
        parser.parse((await getReportDownload(db, actor, { topId: '2', copy: '1' }, false)) as string).conmas.error
          .code,
        '8',
      );
    }),
);

test(
  'retrieval rejects missing/deleted/unauthorized data, incompatible versions and unported newest-revision copy',
  enabled,
  async () =>
    fixture(async (db, connection) => {
      assert.equal(
        parser.parse((await getReportDownload(db, actor, { topId: 'bad' }, true)) as string).conmas.error.code,
        '2',
      );
      assert.equal(
        parser.parse((await getReportDownload(db, actor, { topId: '999' }, true)) as string).conmas.error.code,
        '8',
      );
      await assert.rejects(
        getReportDownload(db, actor, { topId: '2', copyReportMode: '1' }, false),
        (error) => error instanceof ReportUnsupported && error.code === 'report_copy_current_revision',
      );
      await connection.query('UPDATE pg_temp.def_role SET role_rep_create=0');
      assert.equal(
        parser.parse((await getReportDownload(db, actor, { topId: '1' }, true)) as string).conmas.error.code,
        '3',
      );
      await connection.query('UPDATE pg_temp.def_role SET role_rep_create=1');
      await connection.query('UPDATE pg_temp.def_top SET xml_data=$1', [
        xml.replace('<publicStatus>2</publicStatus>', '<publicStatus>0</publicStatus>'),
      ]);
      assert.equal(
        parser.parse((await getReportDownload(db, actor, { topId: '1' }, true)) as string).conmas.error.code,
        '2001',
      );
      await connection.query(
        "INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (1,'CONSTRAINEDFUNCTION_WIN','NEW_FUNCTION','8.0.0')",
      );
      await connection.query('UPDATE pg_temp.def_top SET xml_data=$1', [
        xml.replace('<defTopId>', '<constrainedFunction>new_function</constrainedFunction><defTopId>'),
      ]);
      assert.equal(
        parser.parse((await getReportDownload(db, { ...actor, version: '6.2.0' }, { topId: '1' }, true)) as string)
          .conmas.error.code,
        '2002',
      );
      await connection.query('UPDATE pg_temp.def_top SET deleted=1');
      assert.equal(
        parser.parse((await getReportDownload(db, actor, { topId: '1' }, true)) as string).conmas.error.code,
        '8',
      );
    }),
);

test(
  'FreeDraw reads return an empty-index error or exact PDF/IRFD bytes without exposing other reports',
  enabled,
  async () =>
    fixture(async (db, connection) => {
      assert.equal(parser.parse((await getReportFreeDraw(db, actor, '2')) as string).conmas.error.code, '8');
      await connection.query('UPDATE pg_temp.rep_top SET fd_sheet_info=$1', [
        '<conmas><sheets><sheet><sheetIndex>1</sheetIndex><fdSheetNo>9</fdSheetNo></sheet></sheets></conmas>',
      ]);
      await connection.query(
        'INSERT INTO pg_temp.rep_fd_sheet (top_id,fd_sheet_no,sheet_index,pdf_file,irfd_file) VALUES (2,9,1,$1,$2)',
        [Buffer.from('fd pdf'), Buffer.from('fd irfd')],
      );
      assert.equal(
        parser.parse((await getReportFreeDraw(db, actor, '2')) as string).conmas.sheets.sheet.fdSheetNo,
        '9',
      );
      assert.equal((await getReportFreeDraw(db, actor, '2', '9', 'pdf')).toString(), 'fd pdf');
      assert.equal((await getReportFreeDraw(db, actor, '2', '9', 'irfd')).toString(), 'fd irfd');
      assert.equal(
        parser.parse((await getReportFreeDraw(db, actor, '2', '9', 'invalid')) as string).conmas.error.code,
        '2',
      );
      assert.equal(
        parser.parse((await getReportFreeDraw(db, { ...actor, userId: 'other' }, '2', '9', 'pdf')) as string).conmas
          .error.code,
        '3',
      );
    }),
);

test(
  'Windows Copy This Report downloads five saved sheets and saves a distinct rich report with safe diagnostics',
  enabled,
  async () =>
    fixture(async (db, connection) => {
      const picture =
        '<cluster><sheetNo>1</sheetNo><clusterId>4</clusterId><name>Picture</name><type>Image</type><value/><readOnly>0</readOnly></cluster>';
      const sheets = [1, 2, 3, 4, 5]
        .map((number) =>
          sheet
            .replace('</clusters>', picture + '</clusters>')
            .replaceAll('<sheetNo>1</sheetNo>', `<sheetNo>${number}</sheetNo>`)
            .replace('<defSheetId>10</defSheetId>', `<defSheetId>${number + 9}</defSheetId>`)
            .replace('<repSheetId>20</repSheetId>', `<repSheetId>${number + 19}</repSheetId>`),
        )
        .join('');
      const sourceXml = xml
        .replace('<sheetCount>1</sheetCount>', '<sheetCount>5</sheetCount>')
        .replace('<sheets>' + sheet + '</sheets>', '<sheets>' + sheets + '</sheets>');
      const fdInfo =
        '<conmas><sheets><sheet><sheetIndex>1</sheetIndex><fdSheetNo>9</fdSheetNo></sheet></sheets></conmas>';
      await connection.query('UPDATE pg_temp.def_top SET xml_data=$1,def_file=$2,def_file_type=$3', [
        sourceXml,
        Buffer.from('copy Excel'),
        'xlsx',
      ]);
      await connection.query('UPDATE pg_temp.rep_top SET xml_data=$1,edit_refer_status=4,fd_sheet_info=$2', [
        sourceXml.replace('<editStatus>1</editStatus>', '<editStatus>4</editStatus>'),
        fdInfo,
      ]);
      for (const number of [2, 3, 4, 5]) {
        await connection.query(
          'INSERT INTO pg_temp.def_sheet (def_top_id,def_sheet_id,def_sheet_no) VALUES (1,$1,$2)',
          [number + 9, number],
        );
        await connection.query(
          'INSERT INTO pg_temp.rep_sheet (rep_top_id,rep_sheet_id,rep_sheet_no,def_sheet_id) VALUES (2,$1,$2,$3)',
          [number + 19, number, number + 9],
        );
        await connection.query(
          'INSERT INTO pg_temp.def_cluster (def_sheet_id,cluster_id,cluster_type,cluster_name) SELECT $1,cluster_id,cluster_type,cluster_name FROM pg_temp.def_cluster WHERE def_sheet_id=10',
          [number + 9],
        );
        await connection.query(
          'INSERT INTO pg_temp.rep_cluster (rep_sheet_id,cluster_id,cluster_type,cluster_name) SELECT $1,cluster_id,cluster_type,cluster_name FROM pg_temp.rep_cluster WHERE rep_sheet_id=20',
          [number + 19],
        );
      }
      await connection.query(
        "INSERT INTO pg_temp.def_cluster (def_sheet_id,cluster_id,cluster_type,cluster_name) SELECT def_sheet_id,4,'Image','Picture' FROM pg_temp.def_sheet; INSERT INTO pg_temp.rep_cluster (rep_sheet_id,cluster_id,cluster_type,cluster_name) SELECT rep_sheet_id,4,'Image','Picture' FROM pg_temp.rep_sheet; INSERT INTO pg_temp.rep_lock (rep_top_id,user_id,sys_regist_term) VALUES (2,'other','other-terminal')",
      );
      await connection.query(
        'UPDATE pg_temp.rep_cluster SET binary_file_type=$1,binary_file_win=$2,image_file=$3 WHERE rep_sheet_id=20 AND cluster_id=1',
        ['Windows', Buffer.from('saved ink'), Buffer.from('saved preview')],
      );
      await connection.query(
        'UPDATE pg_temp.rep_cluster SET recording_file=$1 WHERE rep_sheet_id=20 AND cluster_id=2',
        [Buffer.from('saved audio')],
      );
      await connection.query('UPDATE pg_temp.rep_cluster SET image_file=$1 WHERE rep_sheet_id=20 AND cluster_id=4', [
        Buffer.from('saved picture'),
      ]);
      await connection.query(
        'INSERT INTO pg_temp.rep_layer (rep_top_id,rep_sheet_id,rep_sheet_no,layer_id,binary_file,image_file) VALUES (2,20,1,1,$1,$2)',
        [Buffer.from('saved layer'), Buffer.from('saved layer preview')],
      );
      await connection.query(
        'INSERT INTO pg_temp.rep_fd_sheet (top_id,fd_sheet_no,sheet_index,pdf_file,irfd_file) VALUES (2,9,1,$1,$2)',
        [Buffer.from('saved PDF'), Buffer.from('saved IRFD')],
      );
      const sourceTables = ['rep_top', 'rep_sheet', 'rep_cluster', 'rep_layer', 'rep_fd_sheet', 'rep_lock'];
      const original = async () => {
        const rows = [];
        for (const table of sourceTables) {
          const condition =
            table === 'rep_cluster'
              ? 'rep_sheet_id IN (SELECT rep_sheet_id FROM pg_temp.rep_sheet WHERE rep_top_id=2)'
              : `${table === 'rep_fd_sheet' ? 'top_id' : 'rep_top_id'}=2`;
          rows.push((await connection.query(`SELECT * FROM pg_temp.${table} WHERE ${condition} ORDER BY 1,2`)).rows);
        }
        return rows;
      };
      const before = await original();
      const directory = await mkdtemp('/tmp/opencode/conmas-report-copy-');
      const app = express(),
        store = new session.MemoryStore();
      app.use(requestLog(directory));
      app.use(express.urlencoded({ extended: false }));
      app.use(clientSession(db, store));
      app.post('/ConMasWeb/__fixture', (req, res) => {
        req.session.clientAccount = {
          ...actor,
          userName: 'Windows fixture',
          physicalId: 'windows-device',
          address: '127.0.0.1',
          sessionId: req.sessionID,
        };
        res.send('seeded');
      });
      registerClientRoutes(app, db, store);
      const server = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', resolve));
      try {
        const address = server.address();
        assert(address && typeof address !== 'string');
        const origin = `http://127.0.0.1:${address.port}`;
        const seed = await fetch(origin + '/ConMasWeb/__fixture', { method: 'POST' }),
          cookie = seed.headers.get('set-cookie')!.split(';')[0];
        await seed.text();
        const request = (command: string, fields: Record<string, string> = {}, sessionCookie = cookie) =>
          fetch(origin + '/ConMasWeb/Rests/ConMasIReporter.aspx', {
            method: 'POST',
            headers: { cookie: sessionCookie },
            body: new URLSearchParams({ command, ...fields }),
          });
        const anonymous = await request('GetReportDataTop', { topId: '2', copy: '1' }, '');
        assert.equal(parser.parse(await anonymous.text()).conmas.error.code, '5');
        const response = await request('GetReportDataTop', { topId: '2', copy: '1' }),
          topText = await response.text();
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type')!, /^text\/xml/);
        const receivedTop = parser.parse(topText).conmas.top;
        assert.equal(receivedTop.repTopId, '2');
        assert.equal(receivedTop.sheetCount, '5');
        assert.equal(receivedTop.readOnly, '0');
        assert.equal((await connection.query('SELECT count(*)::int n FROM pg_temp.rep_top')).rows[0].n, 1);
        const pdf = await request('GetBackgroundImage', { topId: '1', repTopId: '2' });
        assert.match(pdf.headers.get('content-type')!, /^application\/pdf/);
        assert.equal(await pdf.text(), 'pdf');
        const excel = await request('GetDefinitionExcel', { topId: '1', repTopId: '2' });
        assert.match(excel.headers.get('content-type')!, /^application\/vnd.ms-excel/);
        assert.equal(await excel.text(), 'copy Excel');
        for (const number of [1, 2, 3, 4, 5]) {
          const data = parser.parse(
            await (await request('GetReportDataSheet', { topId: '2', sheetNo: String(number) })).text(),
          ).conmas.sheet;
          assert.equal(data.sheetNo, String(number));
          assert.equal(data.clusters.cluster[0].value, 'saved text');
          assert.equal(data.clusters.cluster[0].readOnly, '0');
        }
        const binaries: Map<string, Buffer>[] = [];
        for (const number of [1, 2, 3, 4, 5]) {
          const bytes = await request('GetSheetBinaries', { topId: '2', sheetNo: String(number) });
          assert.match(bytes.headers.get('content-type')!, /^application\/zip/);
          binaries.push(unzip(Buffer.from(await bytes.arrayBuffer())));
        }
        assert.equal(binaries[0].get('cluster_4_value')?.toString(), 'saved picture');
        assert.equal(
          parser.parse(await (await request('GetFreeDrawSheetInfo', { repTopId: '2' })).text()).conmas.sheets.sheet
            .fdSheetNo,
          '9',
        );
        const fd: Record<string, string> = {};
        for (const fileType of ['pdf', 'irfd'])
          fd[fileType] = await (
            await request('GetReportFreeDrawSheet', { repTopId: '2', fdSheetNo: '9', fileType })
          ).text();
        assert.deepEqual(await original(), before);
        const multipart = async (
          command: string,
          parts: [string, string | Buffer][],
          fields: Record<string, string> = {},
        ) => {
          const body = new FormData();
          body.set('command', command);
          for (const [name, value] of Object.entries(fields)) body.set(name, value);
          for (const [name, data] of parts)
            body.append(name, new Blob([typeof data === 'string' ? data : new Uint8Array(data)]), name);
          const result = await fetch(origin + '/ConMasWeb/Rests/ConMasIReporter.aspx', {
            method: 'POST',
            headers: { cookie },
            body,
          });
          assert.equal(parser.parse(await result.text()).conmas.error.code, '0');
        };
        // ExecuteReportCopy in the unchanged Windows client resets repTopId to 0 and editStatus to 1.
        const copied = root(topText),
          top = must(copied, 'top');
        replace(top, 'repTopId', '0');
        replace(top, 'editStatus', '1');
        replace(top, 'repTopName', 'Saved report copy');
        await multipart('RegistReportTop', [['report', serialize(copied)]]);
        for (const number of [1, 2, 3, 4, 5]) {
          const parts: [string, string | Buffer][] = [...binaries[number - 1]].filter(([name]) => name !== 'empty');
          parts.push([
            'report',
            `<conmas><sheet><sheetNo>${number}</sheetNo><defSheetId>${number + 9}</defSheetId><repSheetId>${number + 19}</repSheetId><clusters><cluster><clusterId>0</clusterId><value>copied text</value></cluster><cluster><clusterId>1</clusterId><value/><displayValue/></cluster><cluster><clusterId>2</clusterId><value/></cluster><cluster><clusterId>4</clusterId><value/></cluster></clusters><layers><layer><layerNo>1</layerNo><value/></layer></layers></sheet></conmas>`,
          ]);
          await multipart('RegistReportSheet', parts);
        }
        await multipart('RegistFreeDrawSheetInfo', [['pageOrder', fdInfo]]);
        await multipart(
          'RegistReportFreeDrawSheet',
          [
            ['pdfFile', fd.pdf],
            ['irfdFile', fd.irfd],
          ],
          { fdSheetNo: '9', isDelete: '0' },
        );
        const finish = await request('RegistReportFinish');
        assert.equal(parser.parse(await finish.text()).conmas.error.code, '0');
        assert.deepEqual(await original(), before);
        const saved = (
          await connection.query(
            'SELECT rep_top_id,rep_top_name,rep_sheet_count,edit_refer_status FROM pg_temp.rep_top WHERE rep_top_id=100',
          )
        ).rows[0];
        assert.equal(saved.rep_top_name, 'Saved report copy');
        assert.equal(Number(saved.rep_sheet_count), 5);
        assert.equal(Number(saved.edit_refer_status), 1);
        const values = (
          await connection.query(
            'SELECT cluster_id,input_value,binary_file_win,image_file,recording_file FROM pg_temp.rep_cluster WHERE rep_sheet_id=200 ORDER BY cluster_id',
          )
        ).rows;
        assert.equal(values[0].input_value, 'copied text');
        assert.equal(values[1].binary_file_win.toString(), 'saved ink');
        assert.equal(values[1].image_file.toString(), 'saved preview');
        assert.equal(values[2].recording_file.toString(), 'saved audio');
        assert.equal(values[4].image_file.toString(), 'saved picture');
        assert.equal(
          (
            await connection.query(
              'SELECT binary_file FROM pg_temp.rep_layer WHERE rep_top_id=100 AND rep_sheet_id=200',
            )
          ).rows[0].binary_file.toString(),
          'saved layer',
        );
        assert.equal((await getReportFreeDraw(db, actor, '100', '9', 'irfd')).toString(), 'saved IRFD');
        const received = await request('GetReportDataTop', { topId: '100' });
        assert.equal(parser.parse(await received.text()).conmas.top.repTopId, '100');
        let entries: {
          requestId: string;
          parameters: Record<string, string>;
          status: number;
          failure?: unknown;
          transfer: { committed: boolean };
          resultCode?: number;
        }[] = [];
        for (let attempt = 0; attempt < 50; attempt++) {
          entries = (
            await Promise.all(
              (await readdir(directory))
                .filter((name) => name.endsWith('.jsonl'))
                .map((name) => readFile(join(directory, name), 'utf8')),
            )
          )
            .join('')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line));
          if (entries.some((entry) => entry.requestId === finish.headers.get('x-request-id'))) break;
          await setTimeout(10);
        }
        const copyLog = entries.find((entry) => entry.requestId === response.headers.get('x-request-id'));
        assert.equal(copyLog?.parameters.copy, '1');
        assert.equal(copyLog?.parameters.topId, '2');
        assert.equal(copyLog?.status, 200);
        assert.equal(copyLog?.failure, undefined);
        const finishLog = entries.find((entry) => entry.requestId === finish.headers.get('x-request-id'));
        assert.equal(finishLog?.transfer.committed, true);
        assert.equal(finishLog?.resultCode, 0);
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        const sessions = await new Promise<session.SessionData[]>((resolve, reject) =>
          store.all((error, data) => (error ? reject(error) : resolve(Object.values(data ?? {})))),
        );
        for (const data of sessions) await cleanupReportUpload(data.clientReportUpload);
        await rm(directory, { recursive: true, force: true });
      }
    }),
);

test(
  'unchanged Windows command sequence reaches native dispatcher with separate session and MIME boundaries',
  enabled,
  async () =>
    fixture(async (db, connection) => {
      const rich =
        '<cluster><sheetNo>1</sheetNo><clusterId>4</clusterId><name>Create</name><type>Create</type><inputParameters>Required=0;SignType=1</inputParameters><value/><readOnly>0</readOnly></cluster><cluster><sheetNo>1</sheetNo><clusterId>5</clusterId><name>Registration</name><type>Registration</type><inputParameters>DisplayUserName=UserName</inputParameters><value/><readOnly>0</readOnly></cluster><cluster><sheetNo>1</sheetNo><clusterId>6</clusterId><name>Picture</name><type>Image</type><value/><readOnly>0</readOnly></cluster>';
      await connection.query('UPDATE pg_temp.def_top SET xml_data=$1', [
        xml
          .replace('<defTopId>', '<cooperationTable>1</cooperationTable><defTopId>')
          .replace(
            '<type>KeyboardText</type><value>saved text',
            '<type>Calculate</type><inputParameters>DataType=0;Maximum=999999999;Minimum=-999999999</inputParameters><value>1',
          )
          .replace('</clusters>', rich + '</clusters>'),
      ]);
      await connection.query(
        "INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (1,'CONMAS_FUNCTION','CALCULATE_MAXMIN_VALID','2')",
      );
      const app = express(),
        store = new session.MemoryStore();
      app.use(express.urlencoded({ extended: false }));
      app.use(clientSession(db, store));
      app.post('/ConMasWeb/__fixture', (req, res) => {
        req.session.clientAccount = {
          ...actor,
          userName: 'Windows fixture',
          physicalId: 'windows-device',
          address: '127.0.0.1',
          sessionId: req.sessionID,
        };
        res.send('seeded');
      });
      registerClientRoutes(app, db, store);
      const server = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', resolve));
      try {
        const address = server.address();
        assert(address && typeof address !== 'string');
        const origin = `http://127.0.0.1:${address.port}`;
        const seed = await fetch(origin + '/ConMasWeb/__fixture', { method: 'POST' }),
          cookie = seed.headers.get('set-cookie')!.split(';')[0];
        await seed.text();
        const request = (command: string, fields: Record<string, string> = {}, withSession = true) =>
          fetch(origin + '/ConMasWeb/Rests/ConMasIReporter.aspx', {
            method: 'POST',
            headers: withSession ? { cookie } : {},
            body: new URLSearchParams({ command, ...fields }),
          });
        for (const command of ['GetDefinitionList', 'GetReportList', 'GetReportDataTop', 'MakeReportFromDefinitionTop'])
          assert.equal(parser.parse(await (await request(command, {}, false)).text()).conmas.error.code, '5');
        const list = await request('GetDefinitionList', {
          itemTargetLabel: 'false',
          itemTargetSheet: 'true',
          itemTargetSet: 'true',
          itemTargetBook: 'false',
          sortId: '2',
          sortType: 'desc',
          publicStatus: '2',
        });
        assert.equal(list.status, 200);
        assert.match(list.headers.get('content-type')!, /^text\/xml/);
        assert.equal(parser.parse(await list.text()).conmas.items.item.itemId, '1');
        const top = await request('MakeReportFromDefinitionTop', { topId: '1' });
        assert.equal(parser.parse(await top.text()).conmas.top.sheets, '');
        const received = await request('MakeReportFromDefinitionSheet', { topId: '1', sheetNo: '1' });
        assert.equal(parser.parse(await received.text()).conmas.sheet.sheetNo, '1');
        const wrong = await request('GetReportDataSheet', { topId: '2', sheetNo: '1' });
        assert.equal(parser.parse(await wrong.text()).conmas.error.code, '2');
        const report = await request('GetReportDataTop', { topId: '2' });
        assert.equal(parser.parse(await report.text()).conmas.top.repTopId, '2');
        const bytes = await request('GetSheetBinaries', { topId: '2', sheetNo: '1' });
        assert.match(bytes.headers.get('content-type')!, /^application\/zip/);
        assert.deepEqual([...unzip(Buffer.from(await bytes.arrayBuffer())).keys()], ['empty']);
        const other = await request('GetSheetBinaries', { topId: '1', sheetNo: '1' });
        assert.match(other.headers.get('content-type')!, /^text\/xml/);
        assert.equal(parser.parse(await other.text()).conmas.error.code, '2');
        const copied = await request('GetReportDataTop', { topId: '2', copyReportMode: '1' });
        assert.equal(copied.status, 501);
        assert.equal(parser.parse(await copied.text()).conmas.error.code, '-1');
        const multipart = async (command: string, parts: [string, string | Buffer][]) => {
          const body = new FormData();
          body.set('command', command);
          for (const [name, data] of parts)
            body.append(name, new Blob([typeof data === 'string' ? data : new Uint8Array(data)]), name);
          return fetch(origin + '/ConMasWeb/Rests/ConMasIReporter.aspx', { method: 'POST', headers: { cookie }, body });
        };
        const staged = await multipart('RegistReportTop', [
          [
            'report',
            '<conmas><top><defTopId>1</defTopId><repTopId/><repTopName>HTTP Windows report</repTopName><editStatus>1</editStatus><thumbnail/><sheets/></top></conmas>',
          ],
        ]);
        assert.equal(parser.parse(await staged.text()).conmas.error.code, '0');
        const parts: [string, string | Buffer][] = [
          ['cluster_1_value', Buffer.from('HTTP ink')],
          ['cluster_1_displayValue', Buffer.from('HTTP preview')],
          ['cluster_6_value', Buffer.from('HTTP picture')],
          ['cluster_6_displayValue', Buffer.from('HTTP unused picture preview')],
        ];
        for (let i = 1; i <= 12; i++) parts.push(['cluster_1_image_' + i, Buffer.from('image ' + i)]);
        parts.push([
          'report',
          '<conmas><sheet><defSheetId>10</defSheetId><repSheetId/><sheetNo>1</sheetNo><clusters><cluster><clusterId>0</clusterId><value>7.25</value><function>client formula</function></cluster><cluster><clusterId>1</clusterId><value/><displayValue/></cluster><cluster><clusterId>4</clusterId><value>3</value><approver/><approverName/><approverComment>HTTP created</approverComment><approvalSignImage>AQID</approvalSignImage></cluster><cluster><clusterId>6</clusterId><value/></cluster></clusters></sheet></conmas>',
        ]);
        const stagedSheet = await multipart('RegistReportSheet', parts);
        assert.equal(stagedSheet.status, 200);
        assert.equal(parser.parse(await stagedSheet.text()).conmas.error.code, '0');
        assert.equal(
          parser.parse(
            await (
              await multipart('RegistFreeDrawSheetInfo', [
                [
                  'pageOrder',
                  '<conmas><sheets><sheet><sheetIndex>1</sheetIndex><fdSheetNo>9</fdSheetNo></sheet></sheets></conmas>',
                ],
              ])
            ).text(),
          ).conmas.error.code,
          '0',
        );
        const free = new FormData();
        free.set('command', 'RegistReportFreeDrawSheet');
        free.set('fdSheetNo', '9');
        free.set('isDelete', '0');
        free.append('pdfFile', new Blob(['HTTP PDF']), 'pdfFile');
        free.append('irfdFile', new Blob(['HTTP IRFD']), 'irfdFile');
        assert.equal(
          parser.parse(
            await (
              await fetch(origin + '/ConMasWeb/Rests/ConMasIReporter.aspx', {
                method: 'POST',
                headers: { cookie },
                body: free,
              })
            ).text(),
          ).conmas.error.code,
          '0',
        );
        assert.equal(parser.parse(await (await request('RegistReportFinish')).text()).conmas.error.code, '0');
        assert.equal(
          (
            await connection.query(
              "SELECT COUNT(*)::int n FROM pg_temp.rep_top WHERE rep_top_name='HTTP Windows report'",
            )
          ).rows[0].n,
          1,
        );
        assert.equal(parser.parse(await (await request('RegistReportFinish')).text()).conmas.error.code, '0');
        assert.equal(
          (
            await connection.query(
              'SELECT binary_file_win FROM pg_temp.rep_cluster WHERE rep_sheet_id=200 AND cluster_id=1',
            )
          ).rows[0].binary_file_win.toString(),
          'HTTP ink',
        );
        const approvals = (
          await connection.query(
            'SELECT approver,approver_comment,approval_sign FROM pg_temp.rep_cluster WHERE rep_sheet_id=200 AND cluster_id=4',
          )
        ).rows[0];
        assert.deepEqual(approvals, {
          approver: actor.userId,
          approver_comment: 'HTTP created',
          approval_sign: 'AQID',
        });
        assert.equal(
          (
            await connection.query(
              'SELECT input_value FROM pg_temp.rep_cluster WHERE rep_sheet_id=200 AND cluster_id=5',
            )
          ).rows[0].input_value,
          'Windows fixture',
        );
        assert.equal(
          (
            await connection.query('SELECT image_file FROM pg_temp.rep_cluster WHERE rep_sheet_id=200 AND cluster_id=6')
          ).rows[0].image_file.toString(),
          'HTTP picture',
        );
        assert.equal((await getReportFreeDraw(db, actor, '100', '9', 'pdf')).toString(), 'HTTP PDF');
        const table = (
          await connection.query('SELECT rep_top_name,cluster_1_0_n FROM pg_temp.report_1 WHERE rep_top_id=100')
        ).rows[0];
        assert.equal(table.rep_top_name, 'HTTP Windows report');
        assert.equal(table.cluster_1_0_n, '7.2500000000');
        await connection.query('UPDATE pg_temp.mst_terminal SET approver=NULL');
        const pending = await request('GetReportList');
        assert.equal(parser.parse(await pending.text()).conmas.error.code, '3');
        const upload = await request('RegistReportFinish');
        assert.notEqual(parser.parse(await upload.text()).conmas.error.code, '0');
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }
    }),
);
