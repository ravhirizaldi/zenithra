import 'dotenv/config';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { Script } from 'node:vm';
import { runInNewContext } from 'node:vm';
import { createCipheriv } from 'node:crypto';
import ejs from 'ejs';
import sharp from 'sharp';
import { PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { test } from 'node:test';
import express from 'express';
import session from 'express-session';
import pg from 'pg';
import { registerSystemMiddleware } from '../../../../src/middleware/manager/system.js';
import { registerDocumentController } from '../../../../src/controllers/manager/documents/index.js';
import { createPageRenderer } from '../../../../src/services/manager/page.js';
import { documentDetailScript, documentViewSource } from '../../../../src/services/manager/documents.js';
import { documentTop, documentSaveTop, documentEditLock } from '../../../../src/models/manager/documents/top.js';
import { documentSheet, documentSaveSheetMetadata } from '../../../../src/models/manager/documents/sheet.js';
import {
  documentHistoryHeaders,
  documentHistorySort,
  documentReportHistory,
} from '../../../../src/models/manager/documents/history.js';
import {
  documentApplicantLocked,
  documentClusters,
  documentClusterHistory,
} from '../../../../src/models/manager/documents/clusters.js';
import { must, optionalField, root } from '../../../../src/models/client-definition-xml.js';
import {
  reportNotificationOptions,
  reportNotificationValues,
} from '../../../../src/models/manager/common/notifications.js';
import { validPrintPages } from '../../../../src/shared/print-pages.js';
import { documentUnlock } from '../../../../src/models/manager/documents/lifecycle.js';
import { documentPdfData } from '../../../../src/models/manager/documents/pdf.js';
import { documentInnerExcel } from '../../../../src/models/manager/documents/excel.js';
import { documentManualNumber } from '../../../../src/models/manager/documents/numbering.js';
import { documentApprove } from '../../../../src/models/manager/documents/approval.js';
import { documentCopy } from '../../../../src/models/manager/documents/copy.js';

test('Basic, sheet and history use project-owned EJS scripts, resources and escaped values', async () => {
  const source = await documentViewSource();
  for (const view of ['DetailsTop', 'EditTop', 'DetailsSheet', 'EditSheet', 'DetailsClusterHistory'] as const) {
    const script = await documentDetailScript(view, 123);
    assert.doesNotMatch(script, /@(?:Model|IR|Html)|__REP_ID__/);
    assert.doesNotThrow(() => new Script(script));
  }
  for (const view of [
    'top',
    'sheet',
    'sheet-preview',
    'cluster-history',
    'report-history',
    'cluster-value',
    'cluster-gps',
    'cluster-input',
    'output-options',
    'ajax-failure',
    'pdf-view',
  ]) {
    const template = await readFile(`src/views/manager/documents/${view}.ejs`, 'utf8');
    for (const match of template.matchAll(/\b([rv])\.(\w+)/g))
      assert(Object.hasOwn(source[match[1] as 'r' | 'v'], match[2]), `${view}: ${match[0]}`);
  }
});

test('print-page validation preserves source signed-single, whitespace and descending-range rules without expansion', () => {
  for (const value of ['', '1,3-5', '0,+2', ' 1 ,\t2\t', '5-1', '0-2147483647', '2147483647'])
    assert.equal(validPrintPages(value), true, value);
  for (const value of ['-1', '1 - 3', ' 1-3', '1-3 ', '1,,2', '1,', '2147483648', '1-2147483648', 'a', '1.5'])
    assert.equal(validPrintPages(value), false, value);
  assert.deepEqual(reportNotificationValues(['first', 'second', ''], true), ['first', 'second']);
  assert.throws(() => reportNotificationValues({ id: 'first' }, true));
  assert.throws(() => reportNotificationValues(['first', 'second'], false));
});

test('report history preserves all source sort tie-breakers and rejects arbitrary SQL columns or directions', () => {
  assert.equal(documentHistorySort(undefined, undefined).order, 'h.sys_update_time ASC,s.rep_sheet_id,h.cluster_id');
  assert.equal(
    documentHistorySort('GPS', 'DESC').order,
    'h.gps_lat DESC,h.gps_lon DESC,h.sys_update_time,s.rep_sheet_id,h.cluster_id',
  );
  for (const [column] of documentHistoryHeaders)
    for (const direction of ['ASC', 'DESC']) {
      const sort = documentHistorySort(column, direction);
      assert.equal(sort.sortColumn, column);
      assert.equal(sort.sortDirection, direction);
      assert.match(sort.order, /s\.rep_sheet_id,h\.cluster_id$/);
    }
  for (const [column, direction] of [
    ['input_value; SELECT 1', 'ASC'],
    ['sys_update_time', 'DESC NULLS FIRST'],
    ['SYS_UPDATE_TIME', 'ASC'],
  ])
    assert.throws(() => documentHistorySort(column, direction), /Invalid history sort/);
});

test('shared detail AJAX failures display retry forms and render plain errors as text without browser automation', async () => {
  const html = await ejs.renderFile('src/views/manager/documents/ajax-failure.ejs', await documentViewSource());
  const written: Array<[string, string, string]> = [];
  const $ = Object.assign(
    (selector: string) => ({
      html: (text: string) => written.push([selector, 'html', text]),
      text: (text: string) => written.push([selector, 'text', text]),
    }),
    { unblockUI() {} },
  );
  const context = { $ };
  runInNewContext(
    html.match(/<script[^>]*>([\s\S]*?)<\/script>/)![1] +
      `
    fConMasDocumentFailure({responseText:'<div id="DetailTop">Retry</div>'});
    fConMasDocumentFailure({responseText:'<img src=x onerror=alert(1)>'});`,
    context,
  );
  assert.deepEqual(
    written.map((row) => row.slice(0, 2)),
    [
      ['#content', 'html'],
      ['#MessageWrap', 'text'],
    ],
  );
});

test(
  'Basic and normal-sheet reads/saves use private fixtures, never customer reports',
  { skip: !process.env.DATABASE_URL },
  async (t) => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }),
      client = await pool.connect();
    let server: Server | undefined;
    try {
      for (const table of [
        'mst_common',
        'mst_user',
        'mst_terminal',
        'mst_group',
        'mst_group_affiation',
        'rep_top',
        'rep_role',
        'def_role',
        'rep_current',
        'rep_sheet',
        'rep_fd_sheet',
        'rep_lock',
        'document_lock',
        'mst_label_rep',
        'def_rep_label',
        'rep_label_role',
        'rep_label',
        'def_top',
        'def_top_backup',
        'rep_top_option',
        'rep_cluster',
        'rep_cluster_role',
        'rep_cluster_refer',
        'history_rep_cluster',
        'rep_reference',
        'rep_report_document',
        'rep_layer',
        'rep_layer_draw',
        'rep_cluster_draw',
        'mst_common_document',
        'mst_common_document_role',
        'mst_report_document',
        'mst_report_document_role',
        'binder_rep_src',
        'mst_mail',
        'mst_direct',
        'mst_webhook',
        'data_output_layout',
        'def_external_output',
        'mst_report_table',
        'def_auto_numbering_reset_setting',
        'log_auto_numbering',
      ])
        await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
      await client.query('SET search_path TO pg_temp');
      await client.query('CREATE TEMP SEQUENCE mst_label_def_mst_label_id_seq START 1000');
      const xml =
        '<conmas><top><repTopId>1</repTopId><defTopId>100</defTopId><repTopName>&lt;Fixture report&gt;</repTopName><editStatus>1</editStatus><voiceInputEndTime>30</voiceInputEndTime><noNeedToFillOutString>retained</noNeedToFillOutString><management><editDirect>retained-template</editDirect></management><sheets><sheet><repSheetId>11</repSheetId><repSheetNo>1</repSheetNo><repSheetName>First</repSheetName><remarksValue1>original-sheet</remarksValue1><clusters><cluster><id>1</id><type>Text</type><value>secret-preserved</value><displayValue>secret-preserved</displayValue></cluster></clusters></sheet><sheet><repSheetId>12</repSheetId><repSheetNo>3</repSheetNo><clusters/></sheet></sheets></top></conmas>';
      await client.query(`INSERT INTO mst_common(com_key,com_name,com_value,com_index) VALUES
      ('OUTPUT_SETTING','TMP_XML','false',1),('OUTPUT_SETTING','EDIT','false',2),('OUTPUT_SETTING','FINISH','false',3),
      ('HISTORY_SETTING','ENABLE','2',4),('CONMAS_FUNCTION','CALCULATE_MODE_FUNCTION','1',5);
      INSERT INTO mst_group(group_id,group_name_path,role_rep_read_manager,role_rep_update_manager) VALUES (10,'Editor',1,1),(20,'Reader',1,0),(30,'Other',1,1);
      INSERT INTO mst_group_affiation(group_id,user_id) VALUES (10,'fixture'),(20,'reader'),(30,'other');
      INSERT INTO mst_user(user_id,user_name) VALUES ('fixture','Fixture editor'),('reader','Reader'),('other','Other');
      INSERT INTO def_top(def_top_id,def_top_name) VALUES (100,'Fixture form');
      INSERT INTO def_role(def_top_id,group_id,role_def_update) VALUES (100,10,1);
      INSERT INTO rep_current(rep_top_org,rep_top_id) VALUES (1,1),(3,3);
      INSERT INTO rep_role(rep_top_id,group_id,role_rep_read,role_rep_update) VALUES (1,10,1,1),(1,20,1,0),(2,10,1,1),(3,30,1,1);
      INSERT INTO rep_sheet(rep_sheet_id,rep_top_id,rep_sheet_no,rep_sheet_name,sheet_remarks1) VALUES (11,1,1,'First','original-sheet'),(12,1,3,'Second','second-sheet');
      INSERT INTO rep_cluster(rep_sheet_id,cluster_id,cluster_name,cluster_type,input_value,display_value) VALUES
        (11,1,'Restricted text','Text','secret-preserved','secret-preserved'),(11,2,'Visible text','Text','visible','visible'),
        (11,3,'Approval','Approve','2',''),(11,4,'Remand','Approve','3','');
      INSERT INTO rep_cluster_refer(rep_sheet_id,cluster_id,group_id) VALUES (11,1,30);
      INSERT INTO rep_cluster_role(rep_sheet_id,cluster_id,group_id) VALUES (11,3,30);
      INSERT INTO rep_reference(rep_sheet_id,reference_id,diplay_number,reference_name,reference_type,reference_value,document_id) VALUES (11,1,1,'private-reference','PDF','private-filename',101);
      INSERT INTO mst_common_document(document_id,document_name) VALUES (101,'Private library fixture');
      INSERT INTO mst_common_document_role(document_id,group_id) VALUES (101,30);
      INSERT INTO history_rep_cluster(history_id,rep_sheet_id,cluster_id,cluster_name,cluster_type,input_value,display_value,history_regist_time) VALUES
        ('fixture-first',11,2,'Visible text','Text','old','old','2026-01-01'),('fixture-second',11,2,'Visible text','Text','new','new','2026-01-02'),
        ('fixture-hidden',11,1,'Restricted text','Text','history-secret','history-secret','2026-01-01');`);
      await client.query(
        `INSERT INTO rep_top(rep_top_id,rep_top_org,rev_no,rep_top_name,def_top_id,deleted,edit_refer_status,public_status,edit_output,finish_output,top_remarks1,top_remarks_name1,system_key1,xml_data,sys_regist_time,sys_update_time) VALUES
      (1,1,2,'<Fixture report>',100,0,1,2,0,0,'original-top','Remark','retained-key',$1,'2026-01-01','2026-01-02'),
      (2,1,1,'History',100,0,1,2,0,0,'','','',$1,'2026-01-01','2026-01-02'),
      (3,3,1,'Private report',100,0,1,2,0,0,'','','',$1,'2026-01-01','2026-01-02')`,
        [xml],
      );
      const db = {
        query: client.query.bind(client),
        connect: async () => ({ query: client.query.bind(client), release() {} }),
      } as unknown as pg.Pool;
      const background = await PDFDocument.create();
      background.addPage([300, 600]);
      background.addPage([400, 600]);
      await client.query(
        'UPDATE rep_top SET background_image_file=$1,rep_sheet_count=2,display_sheet_number=$2 WHERE rep_top_id=1',
        [Buffer.from(await background.save()), '1,3'],
      );
      await client.query(
        'UPDATE rep_cluster SET left_position=.1,top_position=.1,right_position=.9,bottom_position=.2',
      );
      let actor: string | undefined = 'fixture';
      const app = express();
      app.set('views', 'src/views');
      app.set('view engine', 'ejs');
      app.use(express.urlencoded({ extended: false }));
      app.use(session({ secret: 'documents-content-fixture', resave: false, saveUninitialized: true }));
      app.use((req, _res, next) => {
        req.session.userId = actor;
        next();
      });
      const requireAuth: express.RequestHandler = (req, res, next) =>
        req.session.userId ? next() : res.redirect('/ConMasManager/Account/LogOn');
      registerSystemMiddleware(app, db, true, requireAuth);
      registerDocumentController(app, db, true, createPageRenderer(true, true), requireAuth);
      app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
        res.status(500).send('Fixture handler failed.'),
      );
      server = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server!.once('listening', resolve));
      const address = server.address();
      assert(address && typeof address !== 'string');
      const origin = `http://127.0.0.1:${address.port}/ConMasManager`;
      let cookie = '',
        token = '';
      const get = async (path: string, ajax = true) => {
        const response = await fetch(origin + path, {
          headers: { cookie, ...(ajax ? { 'X-Requested-With': 'XMLHttpRequest' } : {}) },
          redirect: 'manual',
        });
        if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie')!.split(';')[0];
        return response;
      };
      const post = (path: string, body: Record<string, string | string[]>, csrf = token) => {
        const data = new URLSearchParams(
          Object.hasOwn(body, '__RequestVerificationToken') ? {} : { __RequestVerificationToken: csrf },
        );
        for (const [name, value] of Object.entries(body))
          for (const item of Array.isArray(value) ? value : [value]) data.append(name, item);
        return fetch(origin + path, {
          method: 'POST',
          headers: { cookie, 'X-Requested-With': 'XMLHttpRequest' },
          body: data,
          redirect: 'manual',
        });
      };
      const multipart = (
        body: Record<string, string>,
        files: Array<[string, Buffer, string]>,
        csrf = token,
        path = '/InputReport/EditSheet',
      ) => {
        const data = new FormData();
        data.append('__RequestVerificationToken', csrf);
        for (const [name, value] of Object.entries(body)) data.append(name, value);
        for (const [field, bytes, type] of files)
          data.append(field, new Blob([new Uint8Array(bytes)], { type }), 'fixture-image');
        return fetch(origin + path, {
          method: 'POST',
          headers: { cookie, 'X-Requested-With': 'XMLHttpRequest' },
          body: data,
          redirect: 'manual',
        });
      };
      const saved = async () =>
        (
          await client.query(
            'SELECT xml_data,rep_top_name,top_remarks1,sys_update_time FROM rep_top WHERE rep_top_id=1',
          )
        ).rows[0];

      await t.test('Basic reads, history and editable DOM contracts render without exposing raw XML', async () => {
        const response = await get('/InputReport/DetailsTop?repTopId=1');
        assert.equal(response.status, 200);
        const html = await response.text();
        token = html.match(/name="__RequestVerificationToken" value="([^"]+)"/)![1];
        assert.match(html, /&lt;Fixture report&gt;/);
        assert.match(html, /id="histroryList"/);
        assert.doesNotMatch(html, /secret-preserved|<conmas>/);
        const edit = await get('/InputReport/EditTop?repTopId=1');
        assert.equal(edit.status, 200);
        const form = await edit.text();
        assert.match(form, /id="rep_top_PdfAutoOutputSheetSelect"/);
        assert.match(form, /name="rep_top.output_files.Csv"/);
        assert.match(form, /id="outputFilesSetting"/);
        assert.equal((await get('/InputReport/DetailsTop?repTopId=1', false)).status, 200);
        assert.equal(await (await get('/InputReport/DetailsTop?repTopId=1', false)).text(), '');
        assert.equal((await get('/InputReport/DetailsTop?repTopId=3')).status, 403);
        assert.equal((await get('/InputReport/GetPdf?repTopId=1&defTopId=100')).status, 200);
        assert.equal((await get('/InputReport/GetPdf?repTopId=3&defTopId=100')).status, 403);
        const model = await documentTop(db, 1, 'fixture');
        assert.equal(model.fields.find((field) => field.name === 'UseVoiceInputEndTime')!.value, '1');
      });
      await t.test(
        'Basic preview flags and shared PDF viewer retain protected original URLs and close behavior',
        async () => {
          const response = await get(
            '/InputReport/DetailsTop?repTopId=1&isLayer=true&isInitJudgeDisplay=true&isForciblyFontSize=true',
          );
          assert.equal(response.status, 200);
          const html = await response.text();
          const pdf = new URL(html.match(/<embed src="([^"]+)"/)![1].replaceAll('&amp;', '&'), origin);
          assert.equal(pdf.searchParams.get('isLayer'), 'true');
          assert.equal(pdf.searchParams.get('isInitJudgeDisplay'), 'true');
          assert.equal(pdf.searchParams.get('isForciblyFontSize'), 'true');
          const layer = new URL(
            html.match(/href="([^"]+)" class="layer_change_On"/)![1].replaceAll('&amp;', '&'),
            origin,
          );
          assert.equal(layer.searchParams.get('isLayer'), 'false');
          assert.equal(layer.searchParams.get('isInitJudgeDisplay'), 'true');
          assert.equal(layer.searchParams.get('isForciblyFontSize'), 'true');
          const query = '?repTopId=1&defTopId=100&sheetNo=3&isLayer=true';
          const viewer = await get('/Common/PdfViewReport' + query, false);
          assert.equal(viewer.status, 200);
          assert.equal(viewer.headers.get('cache-control'), 'no-store');
          const view = await viewer.text();
          assert.match(view, /id="conmasPdfView"/);
          assert.match(view, /aria-label="Close"/);
          const embedded = new URL(view.match(/<embed src="([^"]+)"/)![1].replaceAll('&amp;', '&'), origin);
          assert.equal(embedded.pathname, '/ConMasManager/InputReport/GetPdf');
          assert.equal(embedded.searchParams.get('sheetNo'), null);
          assert.equal(embedded.searchParams.get('isClusterLine'), null);
          assert.equal(embedded.searchParams.get('isLayer'), 'true');
          const close: string[] = [];
          runInNewContext(view.match(/<script[^>]*>([\s\S]*?)<\/script>/)![1] + '\nfConMasPdfViewClose();', {
            $: (selector: unknown) =>
              typeof selector === 'function'
                ? undefined
                : {
                    length: 1,
                    hide: () => close.push('hide'),
                    remove: () => close.push('remove'),
                  },
          });
          assert.deepEqual(close, ['hide', 'remove']);
          assert.equal((await post('/Common/PdfViewReport', { repTopId: '1', defTopId: '100' })).status, 200);
          assert.equal((await post('/Common/PdfViewReport', { repTopId: '1', defTopId: '100' }, 'bad')).status, 403);
          assert.equal((await get('/Common/PdfViewReportExtra' + query)).status, 503);
          assert.equal((await get('/Common/PdfView?topId=100')).status, 503);
          for (const path of ['/Common/PdfViewReport', '/InputReport/GetPdf']) {
            assert.equal((await get(path + '?repTopId=3&defTopId=100')).status, 403);
            assert.equal((await get(path + '?repTopId=1&defTopId=101')).status, 403);
            assert.equal((await get(path + '?repTopId=1&defTopId=100&sheetNo=2')).status, 400);
            assert.equal((await get(path + '?repTopId=1&defTopId=100&isLayer=1')).status, 400);
            actor = 'no-permissions';
            assert.equal((await get(path + query)).status, 403);
            actor = undefined;
            assert.equal((await get(path + query)).headers.get('location'), '/ConMasManager/Account/LogOn');
            actor = 'fixture';
          }
          const unchanged = await saved();
          const output = await get('/InputReport/GetPdf' + query);
          assert.equal(output.status, 200);
          assert.match(output.headers.get('content-type') ?? '', /application\/pdf/);
          assert.equal(output.headers.get('cache-control'), 'no-store');
          const generated = await PDFDocument.load(await output.arrayBuffer());
          assert.equal(generated.getPageCount(), 1);
          assert.equal(generated.getPage(0).getWidth(), 400);
          assert.deepEqual(await saved(), unchanged);
          const calls: string[] = [];
          let released = false;
          const failedDb = {
            connect: async () => ({
              query: async (sql: string, values?: unknown[]) => {
                calls.push(sql);
                if (sql.includes('FROM rep_cluster c')) throw new Error('private-fixture-PDF-query-failure');
                return client.query(sql, values);
              },
              release() {
                released = true;
              },
            }),
          } as unknown as pg.Pool;
          await assert.rejects(
            documentPdfData(failedDb, { repTopId: '1', defTopId: '100' }, 'fixture', 'en-US'),
            /private-fixture-PDF-query-failure/,
          );
          assert.equal(calls[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          assert.equal(calls.at(-1), 'ROLLBACK');
          assert(released);
          assert(calls.every((sql) => !/^\s*(UPDATE|INSERT|DELETE|CREATE|ALTER|DROP)\b/i.test(sql)));
          assert.deepEqual(await saved(), unchanged);
        },
      );
      await t.test(
        'PDF routes render populated protected streams, use definition/backup fallbacks and return safe failures without writes',
        async () => {
          const unchanged = await saved();
          const data = (await client.query('SELECT background_image_file FROM rep_top WHERE rep_top_id=1')).rows[0];
          const output = await get('/InputReport/GetPdf?repTopId=1&defTopId=100&sheetNo=1');
          assert.equal(output.status, 200);
          const pdf = await PDFDocument.load(await output.arrayBuffer());
          const streams = pdf.context
            .enumerateIndirectObjects()
            .filter(([, object]) => object instanceof PDFRawStream)
            .map(([, object]) => Buffer.from(decodePDFRawStream(object as PDFRawStream).decode()).toString('latin1'))
            .join('\n');
          assert.match(streams, new RegExp(Buffer.from('visible').toString('hex').toUpperCase()));
          for (const hidden of ['secret-preserved', 'history-secret'])
            assert(!streams.includes(Buffer.from(hidden).toString('hex').toUpperCase()));
          try {
            await client.query('UPDATE rep_top SET background_image_file=NULL WHERE rep_top_id=1');
            await client.query('UPDATE def_top SET background_image_file=$1 WHERE def_top_id=100', [
              data.background_image_file,
            ]);
            assert.equal((await get('/InputReport/GetPdf?repTopId=1&defTopId=100')).status, 200);
            await client.query('UPDATE def_top SET background_image_file=NULL WHERE def_top_id=100');
            await client.query('INSERT INTO def_top_backup(def_top_id,background_image_file) VALUES (100,$1)', [
              data.background_image_file,
            ]);
            assert.equal((await get('/InputReport/GetPdf?repTopId=1&defTopId=100')).status, 200);
            await client.query('UPDATE rep_top SET xml_data=$1 WHERE rep_top_id=1', [
              xml.replace('</top>', '<trailOutput>1</trailOutput></top>'),
            ]);
            const unsupported = await get('/InputReport/GetPdf?repTopId=1&defTopId=100');
            assert.equal(unsupported.status, 501);
            assert.match(unsupported.headers.get('content-type') ?? '', /text\/plain/);
            assert.match(await unsupported.text(), /requires PDF output/);
            assert.equal((await get('/InputReport/GetPdf?repTopId=1&defTopId=100&sheetNo=1')).status, 200);
            await client.query('UPDATE rep_top SET xml_data=$1,background_image_file=$2 WHERE rep_top_id=1', [
              xml,
              Buffer.from('invalid-private-fixture-PDF'),
            ]);
            const corrupt = await get('/InputReport/GetPdf?repTopId=1&defTopId=100');
            assert.equal(corrupt.status, 500);
            assert.equal(await corrupt.text(), 'Server error has occurred.');
          } finally {
            await client.query('UPDATE rep_top SET xml_data=$1,background_image_file=$2 WHERE rep_top_id=1', [
              xml,
              data.background_image_file,
            ]);
            await client.query('UPDATE def_top SET background_image_file=NULL WHERE def_top_id=100');
            await client.query('DELETE FROM def_top_backup WHERE def_top_id=100');
          }
          assert.deepEqual(await saved(), unchanged);
        },
      );
      await t.test(
        'normal sheets and input history preserve sparse page indexes and hide inaccessible values',
        async () => {
          const sheet = await get('/InputReport/DetailsSheet?repTopId=1&pageIndex=0');
          assert.equal(sheet.status, 200);
          const html = await sheet.text();
          assert.match(html, /visible/);
          assert.doesNotMatch(html, /secret-preserved|private-reference|private-filename/);
          assert.match(html, /pageIndex=1/);
          assert.match(html, /clusterId=2/);
          const second = await documentSheet(db, 1, 1, 'fixture');
          assert.equal(Number(second.sheet.rep_sheet_no), 3);
          assert.equal(second.references.length, 10);
          const history = await get('/InputReport/DetailsClusterHistory?repTopId=1&pageIndex=0&clusterId=2');
          assert.equal(history.status, 200);
          assert.match(await history.text(), /new[\s\S]*old/);
          assert.equal(
            (await get('/InputReport/DetailsClusterHistory?repTopId=1&pageIndex=0&clusterId=1')).status,
            403,
          );
          assert.equal((await get('/InputReport/DetailsSheet?repTopId=1&pageIndex=2')).status, 400);
          assert.equal(
            (await documentClusters(db, 1, 'fixture', 11)).find((row) => row.cluster_id === 1)!.cluster_role,
            '2',
          );
          await assert.rejects(documentClusterHistory(db, 1, 'fixture', 11, 1), /Role authority/);
        },
      );
      await t.test(
        'report-wide history shares protected values/media, all twelve sorts, paging and CSV/ZIP downloads',
        async () => {
          const before = await saved();
          await client.query(
            "UPDATE history_rep_cluster SET sys_update_time=history_regist_time,sys_update_user='fixture',edit_user='fixture',edit_user_name='Fixture editor' WHERE history_id IN ('fixture-first','fixture-second','fixture-hidden')",
          );
          const first = await get('/InputReport/DetailsClusterHistoryTop?repTopId=1');
          assert.equal(first.status, 200);
          const html = await first.text();
          assert.match(html, /id="conmasPageForm"/);
          assert.match(html, /class="sorting"[\s\S]*class="sort asc"/);
          assert.match(html, /old[\s\S]*new/);
          assert.match(
            html,
            /GetClusterHistoryTopCsv\?repTopId=1&amp;sortColumn=sys_update_time&amp;sortDirection=ASC/,
          );
          assert.doesNotMatch(html, /history-secret|secret-preserved/);
          const page = await post('/InputReport/DetailsClusterHistoryTop', {
            'rep_top.rep_top_id': '1',
            'PageData.PageSize': '1',
            'PageData.PageIndex': '99',
            'PageData.SortColumn': 'input_value',
            'PageData.SortDirection': 'DESC',
          });
          assert.equal(page.status, 200);
          const pageHtml = await page.text();
          assert.match(pageHtml, /id="PageData_PageIndex" value="1"/);
          assert.match(pageHtml, /2&nbsp;\/&nbsp;2/);
          assert.match(pageHtml, /<td>new\s*<\/td>/);
          assert.doesNotMatch(pageHtml, /<td>old\s*<\/td>/);
          assert.equal(
            (await post('/InputReport/DetailsClusterHistoryTop', { 'rep_top.rep_top_id': '1' }, 'wrong-token')).status,
            403,
          );
          for (const [column] of documentHistoryHeaders)
            for (const direction of ['ASC', 'DESC'])
              assert.equal(
                (
                  await documentReportHistory(db, 1, 'fixture', {
                    'PageData.SortColumn': column,
                    'PageData.SortDirection': direction,
                  })
                ).total,
                2,
              );
          const bad = await get(
            '/InputReport/GetClusterHistoryTopCsv?repTopId=1&sortColumn=input_value%3BDROP%20TABLE%20rep_top',
          );
          assert.equal(bad.status, 400);
          const csv = await get(
            '/InputReport/GetClusterHistoryTopCsv?repTopId=1&sortColumn=input_value&sortDirection=ASC',
          );
          assert.equal(csv.status, 200);
          assert.match(csv.headers.get('content-type') ?? '', /text\/csv/);
          const csvBytes = Buffer.from(await csv.arrayBuffer());
          assert.deepEqual(csvBytes.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
          assert.match(csvBytes.toString('utf8'), /"Cluster ID"/);
          assert.match(csvBytes.toString('utf8'), /"new"[\s\S]*"old"/);
          assert.doesNotMatch(csvBytes.toString('utf8'), /history-secret/);
          actor = 'reader';
          assert.equal((await get('/InputReport/DetailsClusterHistoryTop?repTopId=1')).status, 200);
          assert.equal((await get('/InputReport/GetClusterHistoryTopCsv?repTopId=3')).status, 403);
          actor = 'other';
          assert.equal((await get('/InputReport/DetailsClusterHistoryTop?repTopId=1')).status, 403);
          assert.equal((await get('/InputReport/GetClusterHistoryTopCsv?repTopId=1')).status, 403);
          actor = 'fixture';
          const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } })
            .png()
            .toBuffer();
          try {
            await client.query(
              `INSERT INTO history_rep_cluster(history_id,rep_sheet_id,cluster_id,cluster_name,cluster_type,input_value,display_value,verified,image_file,recording_file,recording_file_extension,sys_update_time,gps_lat,gps_lon,gps_alt,comment_value,change_reason) VALUES
            ('archive-image',11,2,'picture/path','Image','1','',1,$1,NULL,NULL,'2026-01-03','35.100000','139.100000','2','"quoted",\nline','reason'),
            ('archive-audio',12,7,'音声','AudioRecording','1','',0,NULL,$2,'wav','2026-01-04',NULL,NULL,NULL,'',''),
            ('archive-verified',12,8,'No input','Text','','',1,NULL,NULL,NULL,'2026-01-05',NULL,NULL,NULL,'','')`,
              [png, Buffer.from('fixture recording')],
            );
            const render = await get('/InputReport/DetailsClusterHistoryTop?repTopId=1');
            assert.equal(render.status, 200);
            const mediaHtml = await render.text();
            assert.match(mediaHtml, /historyId=archive-image/);
            assert.match(mediaHtml, /historyId=archive-audio/);
            assert.match(mediaHtml, /linkGMapl\(35\.1,139\.1\)/);
            const zip = await get('/InputReport/GetClusterHistoryTopCsv?repTopId=1');
            assert.equal(zip.status, 200);
            assert.match(zip.headers.get('content-type') ?? '', /application\/zip/);
            const bytes = Buffer.from(await zip.arrayBuffer()),
              entries = new Map<string, Buffer>();
            let offset = 0;
            while (bytes.readUInt32LE(offset) === 0x04034b50) {
              assert.equal(bytes.readUInt16LE(offset + 8), 0);
              const length = bytes.readUInt32LE(offset + 18),
                nameLength = bytes.readUInt16LE(offset + 26),
                extra = bytes.readUInt16LE(offset + 28);
              const start = offset + 30 + nameLength + extra,
                name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
              entries.set(name, bytes.subarray(start, start + length));
              offset = start + length;
            }
            assert.deepEqual(
              [...entries.keys()],
              ['download.csv', 'archive-image_2_picture_path.png', 'archive-audio_7_音声.wav'],
            );
            assert.deepEqual(entries.get('archive-image_2_picture_path.png'), png);
            assert.equal(entries.get('archive-audio_7_音声.wav')!.toString(), 'fixture recording');
            assert.match(entries.get('download.csv')!.toString(), /""quoted"",\nline/);
            assert.doesNotMatch(entries.get('download.csv')!.toString(), /history-secret/);
            await client.query(
              "INSERT INTO mst_common(com_key,com_name,com_locale,com_value,com_index) VALUES ('ENCODING','fixture','en-US','932',1)",
            );
            const sjis = await get('/InputReport/GetClusterHistoryTopCsv?repTopId=1');
            assert.equal(sjis.status, 200);
            await client.query(
              "UPDATE mst_common SET com_value='invalid' WHERE com_key='ENCODING' AND com_name='fixture'",
            );
            assert.equal((await get('/InputReport/GetClusterHistoryTopCsv?repTopId=1')).status, 501);
            await client.query('DELETE FROM rep_role WHERE rep_top_id=1 AND group_id=10');
            assert.equal((await get('/InputReport/GetClusterHistoryTopCsv?repTopId=1')).status, 403);
            await client.query(
              'INSERT INTO rep_role(rep_top_id,group_id,role_rep_read,role_rep_update) VALUES (1,10,1,1)',
            );
            assert.deepEqual(await saved(), before);
          } finally {
            actor = 'fixture';
            await client.query(
              "DELETE FROM history_rep_cluster WHERE history_id IN ('archive-image','archive-audio','archive-verified'); DELETE FROM mst_common WHERE com_key='ENCODING' AND com_name='fixture'",
            );
          }
        },
      );
      await t.test(
        'Basic PDF downloads use configured safe filenames and protected whole-report rendering without server files',
        async () => {
          await client.query(`INSERT INTO mst_common(com_key,com_name,com_value,com_index) VALUES
          ('OUTPUT_SETTING','BASE_FOLDER','unused-server-folder',91),('OUTPUT_SETTING','BASE_FILE','report_{repTopId}_{repTopName}',91),
          ('OUTPUT_SETTING','DATE_FORMAT','yyyyMMdd',91),('OUTPUT_SETTING','DATETIME_FORMAT','yyyyMMddHHmmss',91),('OUTPUT_SETTING','TIME_FORMAT','HHmmss',91);`);
          const before = await saved();
          try {
            const form = await (await get('/InputReport/DetailsTop?repTopId=1')).text();
            assert.match(form, /class="pdf_link"[^>]*DownLoadAction/);
            const result = await get(
              '/InputReport/DownLoadAction?downloadMode=pdf&repTopId=1&isLayer=true&isInitJudgeDisplay=true&isForciblyFontSize=not-bound&sheetNo=999',
            );
            assert.equal(result.status, 200);
            assert.match(result.headers.get('content-type') ?? '', /application\/pdf/);
            assert.match(result.headers.get('content-disposition') ?? '', /report_1__Fixture report_\.pdf/);
            const pdf = await PDFDocument.load(await result.arrayBuffer());
            assert.equal(pdf.getPageCount(), 2);
            assert.equal((await get('/InputReport/DownLoadAction?downloadMode=pdf&repTopId=3')).status, 403);
            assert.equal((await get('/InputReport/DownLoadAction?downloadMode=csv&repTopId=3')).status, 403);
            assert.equal(
              (await get('/InputReport/DownLoadAction?downloadMode=pdf&repTopId=1&isLayer=bad')).status,
              400,
            );
            assert.equal((await get('/InputReport/DownLoadAction?downloadMode=unknown&repTopId=1')).status, 400);
            for (const mode of ['csv2', 'excel'])
              assert.equal((await get('/InputReport/DownLoadAction?downloadMode=' + mode + '&repTopId=1')).status, 501);
            await client.query(
              "INSERT INTO mst_common(com_key,com_name,com_value,com_index) VALUES('OUTPUT_SETTING','PDF_MANUAL_OUTPUT','false',91)",
            );
            assert.doesNotMatch(await (await get('/InputReport/DetailsTop?repTopId=1')).text(), /class="pdf_link"/);
            assert.deepEqual(await saved(), before);
          } finally {
            await client.query("DELETE FROM mst_common WHERE com_key='OUTPUT_SETTING' AND com_index=91");
          }
        },
      );
      await t.test(
        'settings-only Basic saves merge output selections and preserve omitted fields and source XML quirks',
        async () => {
          await documentSaveTop(
            db,
            1,
            {
              'rep_top.rep_top_name': 'Updated name',
              'rep_top.top_remarks1': 'updated-top',
              'rep_top.output_setting': '2',
              'rep_top.output_files.Csv': 'true',
              'rep_top.output_files.Pdf': 'true',
              'rep_top.no_need_to_fill_string': '',
            },
            'fixture',
          );
          await documentSaveTop(db, 1, { 'rep_top.output_files.Csv': 'false' }, 'fixture');
          const row = await saved(),
            top = must(root(row.xml_data), 'top');
          assert.equal(row.rep_top_name, 'Updated name');
          assert.equal(optionalField(top, 'repTopName'), 'Updated name');
          assert.equal(optionalField(top, 'noNeedToFillOutString'), 'retained');
          assert.equal(optionalField(top, 'editStatus'), '1');
          assert.equal(optionalField(must(top, 'finishOutputFiles'), 'csv'), '0');
          assert.equal(optionalField(must(top, 'finishOutputFiles'), 'pdf'), '1');
          assert.equal(optionalField(must(top, 'management'), 'editDirect'), 'retained-template');
          assert.equal(
            (await client.query('SELECT system_key1 FROM rep_top WHERE rep_top_id=1')).rows[0].system_key1,
            'retained-key',
          );
        },
      );
      await t.test(
        'notification selections use localized names, persist together, preserve omitted settings and never send',
        async () => {
          const previousKey = process.env.CONMAS_DIRECT_KEY;
          const fixtureKey = 'fixture-direct-key';
          process.env.CONMAS_DIRECT_KEY = fixtureKey;
          try {
            const key = Buffer.alloc(8);
            for (const [index, byte] of Buffer.from(fixtureKey).entries()) key[index % 8] ^= byte;
            const cipher = createCipheriv('des-ede3-cbc', Buffer.concat([key, key, key]), key);
            const encrypted = Buffer.concat([
              cipher.update('<direct><refreshToken>fixture</refreshToken></direct>'),
              cipher.final(),
            ]).toString('base64');
            await client.query(
              "INSERT INTO mst_direct(key,xml_data) VALUES ('Setting',$1),('Edit',$2),('Complete',$2)",
              [
                encrypted,
                '<direct><templates><template><templateId>one</templateId><templateName>First direct</templateName></template><template><templateId>two</templateId><templateName>Second direct</templateName></template></templates></direct>',
              ],
            );
            await client.query(
              "INSERT INTO mst_mail(mail_file_name,xml_data) VALUES ('MailEdit.xml',$1),('MailComplete.xml',$1)",
              [
                '<mail><template id="mail-one"><name locale="en-US">English</name><name locale="ja-JP">日本語</name><form><body>never expose body</body></form></template><template id="mail-fallback"><name locale="ja-JP"></name><name locale="fr-FR">Fallback</name></template></mail>',
              ],
            );
            await client.query(
              "INSERT INTO mst_common(com_key,com_name,com_value,com_index) VALUES ('WEBHOOK','WEBHOOK_VALID_ENABLE','1',30); INSERT INTO mst_webhook(webhook_id,webhook_to,webhook_name,webhook_url,webhook_request,retry_cnt,edit,complete) VALUES (101,'Other','Edit webhook','https://fixture.invalid','POST',1,true,false),(102,'Other','Complete webhook','https://fixture.invalid','POST',1,false,true)",
            );
            const options = await reportNotificationOptions(db, 'ja-JP');
            assert.equal(options.get('edit_mail')![1].text, '日本語');
            assert.equal(options.get('edit_mail')![2].text, 'Fallback');
            const model = await documentTop(db, 1, 'fixture');
            assert.equal(model.attachment, true);
            assert.equal(model.audioFormat, 'm4a');
            await documentSaveTop(
              db,
              1,
              {
                'rep_top.edit_mail': 'mail-one',
                'rep_top.complete_mail': 'mail-fallback',
                'rep_top.edit_direct': ['one', 'two', ''],
                'rep_top.complete_webhook': '102',
              },
              'fixture',
            );
            let top = must(root((await saved()).xml_data), 'top');
            assert.equal(optionalField(top, 'completeMail'), 'mail-fallback');
            assert.equal(optionalField(must(top, 'management'), 'editDirect'), 'one,two');
            assert.equal(optionalField(must(top, 'management'), 'completeWebhook'), '102');
            assert.equal(
              (await client.query('SELECT edit_mail,complete_mail FROM rep_top WHERE rep_top_id=1')).rows[0].edit_mail,
              'mail-one',
            );
            assert.equal(optionalField(top, 'editMail'), '');
            const before = await saved();
            await assert.rejects(
              documentSaveTop(
                db,
                1,
                { 'rep_top.complete_webhook': '101', 'rep_top.rep_top_name': 'rollback' },
                'fixture',
              ),
              /available notification/,
            );
            assert.deepEqual(await saved(), before);
            const retry = await post('/InputReport/EditTop', {
              'rep_top.rep_top_id': '1',
              'rep_top.edit_mail': 'mail-fallback',
              'rep_top_option.PdfFontSizeDeductionAmount': 'invalid',
            });
            assert.equal(retry.status, 400);
            assert.match(await retry.text(), /value="mail-fallback" selected/);
            await documentSaveTop(db, 1, { 'rep_top.top_remarks1': 'omission-preserved' }, 'fixture');
            top = must(root((await saved()).xml_data), 'top');
            assert.equal(optionalField(must(top, 'management'), 'editDirect'), 'one,two');
            await documentSaveTop(
              db,
              1,
              {
                'rep_top.edit_direct': [''],
                'rep_top.edit_mail': '',
                'rep_top.complete_mail': '',
                'rep_top.complete_webhook': '',
              },
              'fixture',
            );
            top = must(root((await saved()).xml_data), 'top');
            assert.equal(optionalField(must(top, 'management'), 'editDirect'), '');
          } finally {
            await client.query(
              "DELETE FROM mst_direct; DELETE FROM mst_mail; DELETE FROM mst_webhook; DELETE FROM mst_common WHERE com_key='WEBHOOK'",
            );
            if (previousKey === undefined) delete process.env.CONMAS_DIRECT_KEY;
            else process.env.CONMAS_DIRECT_KEY = previousKey;
          }
        },
      );
      await t.test(
        'Basic validation, permission and unsupported effects roll back and HTTP errors preserve drafts for retry',
        async () => {
          const before = await saved();
          for (const input of [
            { 'rep_top.rep_top_name': '' },
            { 'rep_top.UseVoiceInputEndTime': '1', 'rep_top.VoiceInputEndTime': '9' },
            { 'rep_top.InitInputJudgeThickness': '6' },
            { 'rep_top_option.PdfFontSizeDeductionAmount': '10.1' },
            { 'rep_top.output_files.Csv': 'invalid' },
            { 'rep_top.unsupported_field': 'yes' },
            { IsCompleteSuperManager: 'true' },
            { IsComplete: 'invalid' },
            { 'rep_top.edit_direct': 'changed' },
          ])
            await assert.rejects(documentSaveTop(db, 1, input, 'fixture'));
          assert.deepEqual(await saved(), before);
          const response = await post('/InputReport/EditTop', {
            'rep_top.rep_top_id': '1',
            'rep_top.rep_top_name': 'Retry name',
            'rep_top_option.PdfFontSizeDeductionAmount': 'invalid',
          });
          assert.equal(response.status, 400);
          const html = await response.text();
          assert.match(html, /value="Retry name"/);
          assert.match(html, /value="invalid"/);
          assert.doesNotMatch(html, /SELECT|UPDATE rep_top|password/);
          assert.equal((await post('/InputReport/EditTop', { 'rep_top.rep_top_id': '1' }, 'invalid')).status, 403);
          actor = 'reader';
          assert.equal((await get('/InputReport/EditTop?repTopId=1')).status, 403);
          assert.equal((await post('/InputReport/EditTop', { 'rep_top.rep_top_id': '1' })).status, 403);
          actor = 'fixture';
          await client.query('DELETE FROM def_role');
          await assert.rejects(
            documentSaveTop(db, 1, { 'rep_top.use_input_history': '2' }, 'fixture'),
            /form-controlled/,
          );
          await client.query('INSERT INTO def_role(def_top_id,group_id,role_def_update) VALUES (100,10,1)');
          assert.deepEqual(await saved(), before);
        },
      );
      await t.test(
        'Basic automatic labels use form-linked templates and roll back with report/cooperation failures',
        async () => {
          await client.query(`INSERT INTO mst_label_rep(mst_label_id,label_name,label_id_path,label_name_path,auto_creation,auto_label_name,report_update_type)
          VALUES(101,'Template','101','Template',1,'{report:repTopName}/{report:remarksValue1}',1),
          (102,'Unrelated','102','Unrelated',1,'unrelated/{report:repTopName}',1);
          INSERT INTO def_rep_label(def_top_id,mst_label_id) VALUES(100,101);
          INSERT INTO rep_label_role(mst_label_id,group_id) VALUES(101,20);`);
          const name = (await saved()).rep_top_name;
          await documentSaveTop(db, 1, { 'rep_top.top_remarks1': 'label fixture' }, 'fixture');
          const labels = (
            await client.query(
              'SELECT m.*,l.sys_regist_time AS linked FROM mst_label_rep m JOIN rep_label l USING(mst_label_id) WHERE l.rep_top_id=1 ORDER BY m.label_id_path',
            )
          ).rows;
          assert.deepEqual(
            labels.map((row) => row.label_name),
            [name, 'label fixture'],
          );
          assert.equal(
            (await client.query('SELECT 1 FROM mst_label_rep WHERE label_name_path LIKE $1', ['unrelated/%'])).rowCount,
            0,
          );
          assert.equal(
            (
              await client.query('SELECT 1 FROM rep_label_role WHERE mst_label_id=$1 AND group_id=20', [
                labels[1].mst_label_id,
              ])
            ).rowCount,
            1,
          );
          const before = await saved();
          const failing = {
            ...db,
            connect: async () => ({
              query: async (sql: string, values?: unknown[]) => {
                if (sql.startsWith('INSERT INTO rep_label_role')) throw new Error('Fixture role persistence failure.');
                return client.query(sql, values);
              },
              release() {},
            }),
          } as unknown as pg.Pool;
          await assert.rejects(
            documentSaveTop(failing, 1, { 'rep_top.rep_top_name': 'roll back automatic path' }, 'fixture'),
            /Fixture role persistence/,
          );
          assert.deepEqual(await saved(), before);
          assert.equal(
            (await client.query('SELECT 1 FROM mst_label_rep WHERE label_name=$1', ['roll back automatic path']))
              .rowCount,
            0,
          );
          assert.equal((await client.query('SELECT 1 FROM rep_label WHERE rep_top_id=1')).rowCount, labels.length);
          const response = await post('/InputReport/EditTop', {
            'rep_top.rep_top_id': '1',
            'rep_top.top_remarks1': 'label retry',
          });
          assert.equal(response.status, 302);
          assert.equal(
            (
              await client.query(
                'SELECT 1 FROM mst_label_rep m JOIN rep_label l USING(mst_label_id) WHERE l.rep_top_id=1 AND m.label_name=$1',
                ['label retry'],
              )
            ).rowCount,
            1,
          );
        },
      );
      await t.test(
        'locks reject other users, cancellation releases only source-owned locks and successful retry redirects',
        async () => {
          await client.query(
            "INSERT INTO rep_lock(rep_top_id,user_id,sys_regist_user,sys_regist_term) VALUES (1,'other','other','other-host') ON CONFLICT(rep_top_id) DO UPDATE SET user_id='other'",
          );
          assert.equal(await documentEditLock(db, 1, 'fixture'), false);
          await assert.rejects(documentSaveTop(db, 1, { 'rep_top.rep_top_name': 'locked' }, 'fixture'), /locked/);
          await client.query('DELETE FROM rep_lock');
          assert.equal(await documentEditLock(db, 1, 'fixture'), true);
          const cancel = await post('/InputReport/EditTop', {
            'rep_top.rep_top_id': '1',
            isCanceled: '1',
            'rep_top.rep_top_name': 'cancelled',
          });
          assert.equal(cancel.status, 302);
          assert.equal((await client.query('SELECT 1 FROM rep_lock')).rowCount, 0);
          const result = await post('/InputReport/EditTop', {
            'rep_top.rep_top_id': '1',
            'rep_top.rep_top_name': 'Successful retry',
          });
          assert.equal(result.status, 302);
          assert.match(result.headers.get('location')!, /DetailsTop\?repTopId=1/);
        },
      );
      await t.test(
        'applicant lock follows report/system enablement and deregulation without a retrieval administrator bypass',
        async () => {
          await client.query(
            "UPDATE rep_top SET use_applicant_lock=1 WHERE rep_top_id=1; INSERT INTO mst_common(com_key,com_name,com_value,com_index) VALUES ('IPAD_SETTING','USE_APPLICANT_LOCK','1',20),('IPAD_SETTING','APPLICANT_LOCK_TYPE','0',21)",
          );
          assert.equal(await documentApplicantLocked(db, 1, 'fixture'), true);
          assert.equal(await documentApplicantLocked(db, 1, 'other'), false);
          await client.query("UPDATE mst_common SET com_value='0' WHERE com_name='USE_APPLICANT_LOCK'");
          assert.equal(await documentApplicantLocked(db, 1, 'fixture'), true);
          await client.query(
            "UPDATE rep_top SET use_applicant_lock=0 WHERE rep_top_id=1; UPDATE mst_common SET com_value='1' WHERE com_name='USE_APPLICANT_LOCK'",
          );
          assert.equal(await documentApplicantLocked(db, 1, 'fixture'), true);
          await client.query(
            "UPDATE mst_common SET com_value='1' WHERE com_name='APPLICANT_LOCK_TYPE'; UPDATE rep_cluster SET applicant='fixture' WHERE cluster_id=4",
          );
          assert.equal(await documentApplicantLocked(db, 1, 'fixture'), false);
          await client.query("UPDATE rep_cluster SET applicant='other' WHERE cluster_id=4");
          assert.equal(await documentApplicantLocked(db, 1, 'fixture'), true);
          await client.query('UPDATE rep_top SET edit_refer_status=4 WHERE rep_top_id=1');
          assert.equal(await documentApplicantLocked(db, 1, 'fixture'), false);
          await client.query('UPDATE rep_top SET edit_refer_status=1,use_applicant_lock=0 WHERE rep_top_id=1');
          await client.query("UPDATE mst_common SET com_value='0' WHERE com_name='USE_APPLICANT_LOCK'");
        },
      );
      await t.test(
        'sheet metadata commits relational/XML values together only when all required effects are supported',
        async () => {
          for (const table of ['rep_cluster_store', 'rep_cluster_approval'])
            await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
          await client.query(`CREATE TEMP SEQUENCE history_rep_cluster_seq; CREATE TEMP SEQUENCE rep_cluster_store_seq;
            CREATE TRIGGER fixture_manager_history AFTER INSERT OR UPDATE OR DELETE ON pg_temp.rep_cluster
            FOR EACH ROW EXECUTE FUNCTION public.func_rep_cluster_trigger()`);
          await client.query(
            "UPDATE rep_top SET xml_data=replace(xml_data,'<editDirect>retained-template</editDirect>','<editDirect/>') WHERE rep_top_id=1",
          );
          const input = {
            'rep_sheets[0].rep_sheet_id': '11',
            'rep_sheets[0].rep_sheet_name': 'Updated sheet',
            'rep_sheets[0].sheet_remarks1': 'updated-sheet',
          };
          await documentSaveSheetMetadata(db, 1, 0, input, 'fixture');
          assert.equal(
            (await client.query('SELECT rep_sheet_name,sheet_remarks1 FROM rep_sheet WHERE rep_sheet_id=11')).rows[0]
              .sheet_remarks1,
            'updated-sheet',
          );
          assert.match((await saved()).xml_data, /<repSheetName>Updated sheet<\/repSheetName>/);
          assert.match((await saved()).xml_data, /secret-preserved/);
          const before = await saved();
          await assert.rejects(
            documentSaveSheetMetadata(db, 1, 0, { ...input, 'rep_clusters[0].input_value': 'changed' }, 'fixture'),
            /Cluster editing/,
          );
          await assert.rejects(
            documentSaveSheetMetadata(db, 1, 0, { ...input, 'rep_sheets[0].rep_sheet_id': '12' }, 'fixture'),
            /selected sheet/,
          );
          await client.query("UPDATE mst_common SET com_value='true' WHERE com_name='EDIT'");
          await assert.rejects(documentSaveSheetMetadata(db, 1, 0, input, 'fixture'), /output/);
          await client.query("UPDATE mst_common SET com_value='false' WHERE com_name='EDIT'");
          await client.query(
            'ALTER TABLE pg_temp.rep_cluster DISABLE TRIGGER fixture_manager_history; UPDATE rep_top SET use_input_history=1 WHERE rep_top_id=1',
          );
          await assert.rejects(documentSaveSheetMetadata(db, 1, 0, input, 'fixture'), /history/);
          await client.query(
            'ALTER TABLE pg_temp.rep_cluster ENABLE TRIGGER fixture_manager_history; UPDATE rep_top SET use_input_history=0 WHERE rep_top_id=1',
          );
          assert.deepEqual(await saved(), before);
          const response = await post('/InputReport/EditSheet', {
            'rep_sheets[0].rep_top_id': '1',
            'rep_sheets.PageIndex': '0',
            ...input,
            'rep_clusters[0].input_value': 'changed',
            'rep_clusters[1].input_value': '<retry-value>',
          });
          assert.equal(response.status, 501);
          const html = await response.text();
          assert.match(html, /No changes were saved/);
          assert.match(html, /value="&lt;retry-value&gt;"/);
          assert.doesNotMatch(html, /secret-preserved|value="changed"/);
        },
      );
      await t.test(
        'sheet editor applies source exclusive/re-edit/keypad locks and removes server-owned/OCR/pin fields only in edit mode',
        async () => {
          await client.query(`INSERT INTO rep_cluster(rep_sheet_id,cluster_id,cluster_name,cluster_type,input_parameter,input_value,display_value,edit_user) VALUES
          (11,10,'Other editor','KeyboardText','','saved','saved','other'),
          (11,11,'Calculator','InputNumeric','KeypadMode=2','1','1','fixture'),
          (11,12,'Automatic number','KeyboardText','AutoNumber=1','1','1','fixture'),
          (11,13,'Scanner','Scandit','','saved','saved','fixture'),
          (11,14,'OCR','EdgeOCR','','saved','saved','fixture'),
          (11,15,'Pin number','DrawingPinNo','','1','1','fixture'),
          (11,16,'Pin table','PinItemTableNo','','1','1','fixture'),
          (11,17,'PinImage','Image','','1','1','fixture');
          UPDATE rep_top SET use_exclusive_mode_manager=1 WHERE rep_top_id=1;
          UPDATE rep_cluster SET input_parameter='Items=secret-option' WHERE cluster_id=1;`);
          let model = await documentSheet(db, 1, 0, 'fixture', true);
          assert.equal(model.clusters.find((row) => row.cluster_id === 10)!.cluster_role, '0');
          assert.equal(model.clusters.find((row) => row.cluster_id === 11)!.cluster_role, '0');
          assert(!model.clusters.some((row) => row.cluster_id >= 12));
          assert((await documentSheet(db, 1, 0, 'fixture')).clusters.some((row) => row.cluster_id === 12));
          const response = await get('/InputReport/EditSheet?repTopId=1&pageIndex=0'),
            html = await response.text();
          assert.equal(response.status, 200);
          assert.doesNotMatch(html, /secret-option|Automatic number|OCR|Scanner|PinImage/);
          await client.query(
            "UPDATE rep_top SET xml_data=replace(xml_data,'<editStatus>1</editStatus>','<editStatus>1</editStatus><reEditDisable>1</reEditDisable>') WHERE rep_top_id=1",
          );
          model = await documentSheet(db, 1, 0, 'fixture', true);
          assert.equal(model.clusters.find((row) => row.cluster_id === 2)!.cluster_role, '0');
          assert.equal(model.clusters.find((row) => row.cluster_id === 1)!.cluster_role, '2');
          await client.query(
            "UPDATE rep_top SET xml_data=replace(xml_data,'<reEditDisable>1</reEditDisable>',''),use_exclusive_mode_manager=0 WHERE rep_top_id=1; DELETE FROM rep_cluster WHERE cluster_id>=10; UPDATE rep_cluster SET input_parameter='' WHERE cluster_id=1",
          );
        },
      );
      await t.test(
        'the real sheet metadata form accepts unchanged cluster fields but rejects hidden edits, stale identities and unsupported fields atomically',
        async () => {
          const response = await get('/InputReport/EditSheet?repTopId=1&pageIndex=0');
          assert.equal(response.status, 200);
          const html = await response.text(),
            data: Record<string, string | string[]> = {};
          for (const match of html.matchAll(/<input\b[^>]*>/g)) {
            const tag = match[0],
              name = /name="([^"]+)"/.exec(tag)?.[1];
            if (!name || /\bdisabled\b/.test(tag) || (/type="checkbox"/.test(tag) && !/\bchecked\b/.test(tag)))
              continue;
            const value = /value="([^"]*)"/.exec(tag)?.[1] ?? '';
            data[name] = data[name] === undefined ? value : [...[data[name]].flat(), value];
          }
          assert.equal(data['rep_clusters[0].cluster_role'], '2');
          assert.equal(data['rep_clusters[1].input_value'], 'visible');
          data['rep_sheets[0].sheet_remarks1'] = 'metadata from rendered form';
          assert.equal((await post('/InputReport/EditSheet', data)).status, 302);
          const sheet = (await client.query('SELECT * FROM rep_sheet WHERE rep_sheet_id=11')).rows[0],
            before = await saved();
          assert.equal(sheet.sheet_remarks1, 'metadata from rendered form');
          const invalidInputs: Record<string, string | string[]>[] = [
            { 'rep_clusters[0].input_value': 'hidden edit' },
            { 'rep_clusters[1].cluster_id': '3' },
            { 'rep_clusters[1].cluster_role': '0' },
            { 'rep_clusters[1].input_value': 'stale value' },
            { 'rep_clusters[1].Verified': ['false', 'invalid'] },
            { 'rep_clusters[1].unsupported_field': 'yes' },
            { 'rep_clusters[99].cluster_id': '99' },
          ];
          for (const invalid of invalidInputs) {
            assert.equal(
              (
                await post('/InputReport/EditSheet', {
                  ...data,
                  ...invalid,
                  'rep_sheets[0].sheet_remarks1': 'must roll back',
                })
              ).status,
              Object.hasOwn(invalid, 'rep_clusters[1].Verified') ? 400 : 501,
            );
            assert.deepEqual(await saved(), before);
            assert.deepEqual((await client.query('SELECT * FROM rep_sheet WHERE rep_sheet_id=11')).rows[0], sheet);
          }
        },
      );
      await t.test(
        'sheet value saves commit XML, history, names, labels, thumbnails and sparse sheets together or roll everything back',
        async () => {
          const clusterXml = (id: number, type: string, value: string, extra = '') =>
            `<cluster><clusterId>${id}</clusterId><type>${type}</type><name>Fixture ${id}</name><value>${value}</value><displayValue>${value}</displayValue>${extra}</cluster>`;
          const xml = `<conmas><top><repTopId>701</repTopId><defTopId>100</defTopId><repTopName>Values</repTopName><editStatus>1</editStatus><useInputHistory>2</useInputHistory><nameRegenerate>1</nameRegenerate><nameParts><part><partId>1</partId><type>inputValue</type><value>1,1</value></part></nameParts><sheets>
            <sheet><repSheetId>7011</repSheetId><sheetNo>1</sheetNo><repSheetName>First</repSheetName><clusters>${clusterXml(1, 'KeyboardText', 'before')}${clusterXml(2, 'Check', 'false')}${clusterXml(3, 'Select', 'A')}${clusterXml(4, 'MultiSelect', 'A,B')}${clusterXml(5, 'MultipleChoiceNumber', '1')}</clusters></sheet>
            <sheet><repSheetId>7013</repSheetId><sheetNo>3</sheetNo><repSheetName>Third</repSheetName><clusters>${clusterXml(1, 'KeyboardText', 'third')}</clusters></sheet>
            </sheets></top></conmas>`;
          await client.query(
            `INSERT INTO rep_top(rep_top_id,rep_top_org,rev_no,rep_top_name,def_top_id,deleted,edit_refer_status,public_status,edit_output,finish_output,use_input_history,use_change_reason,rep_sheet_count,display_sheet_number,background_image_file,xml_data)
            VALUES(701,701,1,'Values',100,0,1,2,0,0,2,1,2,'1,3',$1,$2)`,
            [Buffer.from(await background.save()), xml],
          );
          await client.query(`INSERT INTO rep_current(rep_top_org,rep_top_id) VALUES(701,701);
            INSERT INTO rep_role(rep_top_id,group_id,role_rep_read,role_rep_update) VALUES(701,10,1,1);
            INSERT INTO rep_sheet(rep_sheet_id,rep_top_id,rep_sheet_no,rep_sheet_name) VALUES(7011,701,1,'First'),(7013,701,3,'Third');
            INSERT INTO rep_cluster(rep_sheet_id,cluster_id,cluster_name,cluster_type,input_value,display_value,input_parameter,edit_user,edit_user_name,edit_time) VALUES
              (7011,1,'Text','KeyboardText','before','before','MaxLength=20','other','Original editor','2026-01-01'),
              (7011,2,'Check','Check','false','false','','','','2026-01-01'),
              (7011,3,'Select','Select','A','Alpha','Items=A,B;Labels=Alpha,Beta;Display=Labels','','','2026-01-01'),
              (7011,4,'Multi','MultiSelect','A,B','Alpha,Beta','Items=A,B;Labels=Alpha,Beta;Display=Labels','','','2026-01-01'),
              (7011,5,'Toggle','MultipleChoiceNumber','1','One','Items=1,2;Labels=One,Two','','','2026-01-01'),
              (7013,1,'Third text','KeyboardText','third','third','','','','2026-01-01');
            UPDATE rep_cluster SET left_position=.1,right_position=.9,top_position=.1*cluster_id,bottom_position=.1*cluster_id+.08 WHERE rep_sheet_id IN(7011,7013);`);
          const snapshot = async () => ({
            top: (await client.query('SELECT * FROM rep_top WHERE rep_top_id=701')).rows,
            sheets: (await client.query('SELECT * FROM rep_sheet WHERE rep_top_id=701 ORDER BY rep_sheet_id')).rows,
            clusters: (
              await client.query(
                'SELECT * FROM rep_cluster WHERE rep_sheet_id IN(7011,7013) ORDER BY rep_sheet_id,cluster_id',
              )
            ).rows,
            history: (
              await client.query(
                'SELECT * FROM history_rep_cluster WHERE rep_sheet_id IN(7011,7013) ORDER BY history_id',
              )
            ).rows,
            labels: (await client.query('SELECT * FROM rep_label WHERE rep_top_id=701 ORDER BY mst_label_id')).rows,
          });
          const data: Record<string, string | string[]> = {
            'rep_sheets[0].rep_sheet_id': '7011',
            'rep_sheets[0].rep_sheet_name': 'First saved',
          };
          for (let index = 0; index < 5; index++)
            Object.assign(data, {
              [`rep_clusters[${index}].rep_sheet_id`]: '7011',
              [`rep_clusters[${index}].cluster_id`]: String(index + 1),
              [`rep_clusters[${index}].cluster_role`]: '1',
              [`rep_clusters[${index}].ChangeReason`]: 'Correction',
            });
          Object.assign(data, {
            'rep_clusters[0].input_value': 'after',
            'rep_clusters[1].input_check_value': ['true', 'false'],
            'rep_clusters[1].comment_value': 'Checked',
            'rep_clusters[2].input_value': 'B',
            'rep_clusters[3].multi_input_value': ['B'],
            'rep_clusters[4].input_value': 'Two',
          });
          const before = await snapshot();
          await assert.rejects(
            documentSaveSheetMetadata(db, 701, 0, { ...data, 'rep_clusters[0].ChangeReason': '' }, 'fixture'),
            /reason/,
          );
          assert.deepEqual(await snapshot(), before);
          const response = await post('/InputReport/EditSheet', {
            ...data,
            'rep_sheets[0].rep_top_id': '701',
            'rep_sheets.PageIndex': '0',
          });
          assert.equal(response.status, 302);
          assert.equal(response.headers.get('location'), '/ConMasManager/InputReport/Details?repTopId=701&pageIndex=0');
          const saved = await snapshot();
          assert.equal(saved.top[0].rep_top_name, 'after');
          const image = await sharp(saved.top[0].thumbnail_file).metadata();
          assert.equal(Math.max(image.width!, image.height!), 350);
          assert.match(saved.top[0].xml_data, /<value>after<\/value>/);
          assert.match(saved.sheets[0].xml_data, /<value>after<\/value>/);
          assert.deepEqual(
            saved.clusters.slice(0, 5).map((row) => [row.input_value, row.display_value, row.change_reason]),
            [
              ['after', 'after', 'Correction'],
              ['true', 'true', 'Correction'],
              ['B', 'Beta', 'Correction'],
              ['B', 'Beta', 'Correction'],
              ['2', 'Two', 'Correction'],
            ],
          );
          assert.equal(saved.clusters[0].edit_user, 'other');
          assert.equal(saved.clusters[0].edit_user_name, 'Original editor');
          assert.equal(saved.clusters[1].edit_user, 'fixture');
          assert.equal(saved.clusters[1].comment_value, 'Checked');
          assert(
            saved.history.some(
              (row) =>
                row.cluster_id === 2 &&
                row.input_value === 'true' &&
                row.comment_value === 'Checked' &&
                row.change_reason === 'Correction',
            ),
          );
          assert(saved.labels.length > 0);
          const failing = {
            ...db,
            connect: async () => ({
              release() {},
              query: async (sql: string, values?: unknown[]) => {
                if (sql.startsWith('UPDATE rep_top SET thumbnail_file'))
                  throw new Error('Fixture thumbnail write failure');
                return client.query(sql, values);
              },
            }),
          } as unknown as pg.Pool;
          await assert.rejects(
            documentSaveSheetMetadata(failing, 701, 0, { ...data, 'rep_clusters[0].input_value': 'retry' }, 'fixture'),
            /Fixture thumbnail write failure/,
          );
          assert.deepEqual(await snapshot(), saved);
          const sparse = {
            'rep_sheets[0].rep_sheet_id': '7013',
            'rep_clusters[0].rep_sheet_id': '7013',
            'rep_clusters[0].cluster_id': '1',
            'rep_clusters[0].cluster_role': '1',
            'rep_clusters[0].input_value': 'third changed',
            'rep_clusters[0].ChangeReason': 'Correction',
          };
          await documentSaveSheetMetadata(db, 701, 1, sparse, 'fixture');
          const third = await snapshot();
          assert.equal(third.clusters.at(-1)!.input_value, 'third changed');
          assert.deepEqual(third.top[0].thumbnail_file, saved.top[0].thumbnail_file);
          for (const state of ['edit_refer_status=4', 'workflow_lock=1', 'deleted=1']) {
            await client.query(`UPDATE rep_top SET ${state} WHERE rep_top_id=701`);
            const locked = await snapshot();
            await assert.rejects(
              documentSaveSheetMetadata(
                db,
                701,
                1,
                { ...sparse, 'rep_clusters[0].input_value': 'rejected' },
                'fixture',
              ),
              /report state/,
            );
            assert.deepEqual(await snapshot(), locked);
            await client.query('UPDATE rep_top SET edit_refer_status=1,workflow_lock=0,deleted=0 WHERE rep_top_id=701');
          }
          await client.query(
            "UPDATE rep_cluster SET change_mail='configured' WHERE rep_sheet_id=7013 AND cluster_id=1",
          );
          const notified = await snapshot();
          await assert.rejects(
            documentSaveSheetMetadata(db, 701, 1, { ...sparse, 'rep_clusters[0].input_value': 'rejected' }, 'fixture'),
            /mail delivery/,
          );
          assert.deepEqual(await snapshot(), notified);
        },
      );
      await t.test(
        'numeric/date/time sheet saves persist normalized values, displays and history atomically with omission and validation rollback',
        async () => {
          const values = [
            ['InputNumeric', '1.00', 'Decimal=2;Comma=1;Maximum=2000'],
            ['CalendarDate', '2026/11/09 13:14:00', 'UseTime=1;DateFormat=yyyy/MM/dd HH:mm'],
            ['Time', '13:14:59', 'DateFormat=HH:mm'],
            ['NumberHours', '60', 'TimeFormat=colon;InputType=Formatted;TimeUnit=Hour;Maximum=2'],
            ['Calculate', '1', 'Decimal=2;Comma=1'],
            ['TimeCalculate', '3600000', 'TimeCalculateType=1;InputType=Formatted;DateFormat=HH:mm'],
          ];
          const clusters = values
            .map(
              ([type, value, parameter], index) =>
                `<cluster><clusterId>${index + 1}</clusterId><type>${type}</type><value>${value}</value><displayValue>${value}</displayValue><inputParameters>${parameter}</inputParameters>${type === 'Calculate' ? '<function>SUM(1,2)</function>' : ''}</cluster>`,
            )
            .join('');
          const xml = `<conmas><top><repTopId>702</repTopId><defTopId>100</defTopId><repTopName>Scalar fixture</repTopName><editStatus>1</editStatus><useInputHistory>2</useInputHistory><sheets><sheet><repSheetId>7023</repSheetId><sheetNo>3</sheetNo><repSheetName>Scalar sheet</repSheetName><clusters>${clusters}</clusters></sheet></sheets></top></conmas>`;
          await client.query(
            `INSERT INTO rep_top(rep_top_id,rep_top_org,rev_no,rep_top_name,def_top_id,deleted,edit_refer_status,public_status,edit_output,finish_output,use_input_history,xml_data)
            VALUES(702,702,1,'Scalar fixture',100,0,1,2,0,0,2,$1)`,
            [xml],
          );
          await client.query(`INSERT INTO rep_current(rep_top_org,rep_top_id) VALUES(702,702);
            INSERT INTO rep_role(rep_top_id,group_id,role_rep_read,role_rep_update) VALUES(702,10,1,1);
            INSERT INTO rep_sheet(rep_sheet_id,rep_top_id,rep_sheet_no,rep_sheet_name) VALUES(7023,702,3,'Scalar sheet');`);
          for (const [index, [type, value, parameter]] of values.entries())
            await client.query(
              `INSERT INTO rep_cluster(rep_sheet_id,cluster_id,cluster_type,input_value,display_value,input_parameter)
              VALUES(7023,$1,$2,$3,$3,$4)`,
              [index + 1, type, value, parameter],
            );
          const snapshot = async () => ({
            top: (await client.query('SELECT * FROM rep_top WHERE rep_top_id=702')).rows,
            sheet: (await client.query('SELECT * FROM rep_sheet WHERE rep_sheet_id=7023')).rows,
            clusters: (await client.query('SELECT * FROM rep_cluster WHERE rep_sheet_id=7023 ORDER BY cluster_id'))
              .rows,
            history: (
              await client.query('SELECT * FROM history_rep_cluster WHERE rep_sheet_id=7023 ORDER BY history_id')
            ).rows,
          });
          const data: Record<string, string> = {
            'rep_sheets[0].rep_top_id': '702',
            'rep_sheets[0].rep_sheet_id': '7023',
            'rep_sheets.PageIndex': '0',
          };
          for (let index = 0; index < values.length; index++)
            Object.assign(data, {
              [`rep_clusters[${index}].rep_sheet_id`]: '7023',
              [`rep_clusters[${index}].cluster_id`]: String(index + 1),
              [`rep_clusters[${index}].cluster_role`]: '1',
            });
          Object.assign(data, {
            'rep_clusters[0].input_value': '1234.565',
            'rep_clusters[1].input_value_date': '2026/11/10',
            'rep_clusters[1].input_value_time': '15:16:59',
            'rep_clusters[2].input_value': '14:15:59',
            'rep_clusters[3].input_value': '90',
            'rep_clusters[4].input_value': '1234.565',
            'rep_clusters[5].input_value': '5400000',
          });
          const before = await snapshot();
          const invalidInputs: Record<string, string>[] = [
            { 'rep_clusters[0].input_value': '2001' },
            { 'rep_clusters[1].input_value_date': '2026/11/31' },
            { 'rep_clusters[1].input_value_time': '' },
            { 'rep_clusters[2].input_value': '24:00' },
            { 'rep_clusters[3].input_value': '121' },
          ];
          for (const invalid of invalidInputs) {
            assert.equal((await post('/InputReport/EditSheet', { ...data, ...invalid })).status, 400);
            assert.deepEqual(await snapshot(), before);
          }
          assert.equal((await post('/InputReport/EditSheet', data)).status, 302);
          const saved = await snapshot();
          const expected = [
            ['1234.565', '1,234.57'],
            ['2026/11/10 15:16:00', '2026/11/10 15:16'],
            ['14:15:00', '14:15'],
            ['90', '1:30'],
            ['1234.565', '1,234.57'],
            ['5400000', '01:30'],
          ];
          assert.deepEqual(
            saved.clusters.map((row) => [row.input_value, row.display_value]),
            expected,
          );
          assert.equal(saved.history.length - before.history.length, values.length);
          for (const value of expected)
            assert(saved.history.some((row) => row.input_value === value[0] && row.display_value === value[1]));
          for (const stored of [saved.top[0].xml_data, saved.sheet[0].xml_data]) {
            assert(stored.includes('<function>SUM(1,2)</function>'));
            for (const [value, display] of expected) {
              assert(stored.includes(`<value>${value}</value>`));
              assert(stored.includes(`<displayValue>${display}</displayValue>`));
            }
          }
          await documentSaveSheetMetadata(db, 702, 0, { 'rep_sheets[0].rep_sheet_id': '7023' }, 'fixture');
          const omitted = await snapshot();
          assert.deepEqual(omitted.clusters, saved.clusters);
          assert.deepEqual(omitted.history, saved.history);
          assert.deepEqual(omitted.top[0].thumbnail_file, before.top[0].thumbnail_file);
        },
      );
      await t.test(
        'sheet images upload/clear original bytes with protected previews, history and transactional rollback',
        async () => {
          const directory = await mkdtemp('/tmp/opencode/document-image-');
          try {
            const photo = await sharp({ create: { width: 5, height: 7, channels: 3, background: '#a03040' } })
              .png()
              .toBuffer();
            const replacement = await sharp({ create: { width: 7, height: 5, channels: 3, background: '#30a040' } })
              .png()
              .toBuffer();
            const path = join(directory, 'image');
            await writeFile(path, replacement);
            const imageBackground = await PDFDocument.create();
            imageBackground.addPage([300, 600]);
            const clusters = ['Image', 'FreeText', 'DrawingImage', 'Image', 'FixedText']
              .map(
                (type, index) =>
                  `<cluster><clusterId>${index + 1}</clusterId><type>${type}</type><value/><displayValue/><inputParameters/></cluster>`,
              )
              .join('');
            const xml = `<conmas><top><repTopId>703</repTopId><defTopId>100</defTopId><repTopName>Images</repTopName><editStatus>1</editStatus><sheets><sheet><repSheetId>7031</repSheetId><sheetNo>1</sheetNo><repSheetName>Images</repSheetName><clusters>${clusters}</clusters></sheet></sheets></top></conmas>`;
            await client.query(
              `INSERT INTO rep_top(rep_top_id,rep_top_org,rev_no,def_top_id,rep_top_name,deleted,edit_refer_status,edit_output,finish_output,use_input_history,rep_sheet_count,xml_data,background_image_file)
            VALUES(703,703,1,100,'Images',0,1,0,0,2,1,$1,$2)`,
              [xml, Buffer.from(await imageBackground.save())],
            );
            await client.query(`INSERT INTO rep_current(rep_top_id,rep_top_org) VALUES(703,703);
            INSERT INTO rep_role(rep_top_id,group_id,role_rep_read,role_rep_update) VALUES(703,10,1,1),(703,20,1,0);
            INSERT INTO rep_sheet(rep_sheet_id,rep_top_id,rep_sheet_no,rep_sheet_name) VALUES(7031,703,1,'Images');
            INSERT INTO rep_cluster(rep_sheet_id,cluster_id,cluster_type,input_value,display_value,left_position,top_position,right_position,bottom_position) VALUES
              (7031,1,'Image','','',.1,.1,.3,.3),(7031,2,'FreeText','','',.3,.1,.5,.3),(7031,3,'DrawingImage','','',.5,.1,.7,.3),(7031,4,'Image','','',.7,.1,.9,.3),(7031,5,'FixedText','','',.1,.4,.3,.6);
            INSERT INTO rep_cluster_role(rep_sheet_id,cluster_id,group_id) VALUES(7031,4,30);
            INSERT INTO rep_cluster_refer(rep_sheet_id,cluster_id,group_id) VALUES(7031,4,30);`);
            const data: Record<string, string> = {
              'rep_sheets[0].rep_top_id': '703',
              'rep_sheets[0].rep_sheet_id': '7031',
              'rep_sheets.PageIndex': '0',
            };
            for (let index = 0; index < 5; index++)
              Object.assign(data, {
                [`rep_clusters[${index}].rep_sheet_id`]: '7031',
                [`rep_clusters[${index}].cluster_id`]: String(index + 1),
                [`rep_clusters[${index}].cluster_role`]: index === 3 ? '2' : '1',
              });
            const snapshot = async () => ({
              top: (await client.query('SELECT * FROM rep_top WHERE rep_top_id=703')).rows,
              sheet: (await client.query('SELECT * FROM rep_sheet WHERE rep_sheet_id=7031')).rows,
              clusters: (await client.query('SELECT * FROM rep_cluster WHERE rep_sheet_id=7031 ORDER BY cluster_id'))
                .rows,
              history: (
                await client.query('SELECT * FROM history_rep_cluster WHERE rep_sheet_id=7031 ORDER BY history_id')
              ).rows,
            });
            const before = await snapshot();
            const form = await (await get('/InputReport/EditSheet?repTopId=703&pageIndex=0')).text();
            assert.match(form, /enctype="multipart\/form-data"/);
            assert.match(form, /type="file" id="1" name="1"/);
            assert.doesNotMatch(form, /type="file" id="(?:4|5)"/);
            for (const files of [
              [
                ['1', photo, 'image/png'],
                ['1', replacement, 'image/png'],
              ],
              [['4', photo, 'image/png']],
              [['5', photo, 'image/png']],
              [['99', photo, 'image/png']],
              [['unknown', photo, 'image/png']],
              [['1', photo, 'text/plain']],
              [['1', Buffer.from('not an image'), 'image/png']],
            ] as Array<Array<[string, Buffer, string]>>) {
              assert.equal((await multipart(data, files)).status, 400);
              assert.deepEqual(await snapshot(), before);
            }
            assert.equal((await multipart(data, [['1', photo, 'image/png']], 'bad-token')).status, 403);
            actor = 'reader';
            assert.equal((await multipart(data, [['1', photo, 'image/png']])).status, 403);
            actor = 'fixture';
            const upload = await multipart(data, [
              ['1', photo, 'image/png'],
              ['2', photo, 'image/png'],
              ['3', photo, 'image/png'],
            ]);
            const uploadText = await upload.text();
            assert.equal(
              upload.status,
              302,
              uploadText.includes('<') ? uploadText.match(/<li>([^<]+)<\/li>/)?.[1] : uploadText,
            );
            const saved = await snapshot();
            for (const row of saved.clusters.slice(0, 3)) {
              assert.deepEqual(row.image_file, photo);
              assert.equal(row.input_value, '');
              assert.equal(row.edit_user, 'fixture');
              assert.equal(row.sys_update_user, 'fixture');
            }
            assert(
              saved.history.filter((row) => Buffer.isBuffer(row.image_file) && row.image_file.equals(photo)).length >=
                3,
            );
            assert(Buffer.isBuffer(saved.top[0].thumbnail_file) && saved.top[0].thumbnail_file.length > 0);
            const detail = await (await get('/InputReport/DetailsSheet?repTopId=703&pageIndex=0')).text();
            assert.match(detail, /GetInputValueImage\?repSheetId=7031/);
            assert.doesNotMatch(detail, new RegExp(photo.toString('base64')));
            const media = await get('/InputReport/GetInputValueImage?repSheetId=7031&clusterId=1');
            assert.equal(media.status, 200);
            assert.deepEqual(Buffer.from(await media.arrayBuffer()), photo);
            await documentSaveSheetMetadata(db, 703, 0, { 'rep_sheets[0].rep_sheet_id': '7031' }, 'fixture');
            assert.deepEqual((await snapshot()).clusters, saved.clusters);
            assert.deepEqual((await snapshot()).history, saved.history);
            const baseline = await snapshot();
            const file = { path, fieldname: '1', mimetype: 'image/png' } as Express.Multer.File;
            const failing = {
              ...db,
              connect: async () => ({
                query: async (sql: string, values?: unknown[]) => {
                  if (sql.startsWith('UPDATE rep_top SET thumbnail_file'))
                    throw new Error('Private image thumbnail failure');
                  return client.query(sql, values);
                },
                release() {},
              }),
            } as unknown as pg.Pool;
            await assert.rejects(
              documentSaveSheetMetadata(failing, 703, 0, data, 'fixture', 'en-US', [file]),
              /Private image thumbnail failure/,
            );
            assert.deepEqual(await snapshot(), baseline);
            await client.query('UPDATE rep_top SET use_change_reason=1 WHERE rep_top_id=703');
            const reasonBaseline = await snapshot();
            assert.equal((await multipart(data, [['1', replacement, 'image/png']])).status, 400);
            assert.deepEqual(await snapshot(), reasonBaseline);
            const clear = {
              ...data,
              'rep_clusters[0].IsImageClear': 'true',
              'rep_clusters[0].Verified': 'true',
              'rep_clusters[0].ChangeReason': 'remove image',
            };
            assert.equal((await multipart(clear, [['1', replacement, 'image/png']])).status, 302);
            const cleared = await snapshot();
            assert.equal(cleared.clusters[0].image_file, null);
            assert.equal(cleared.clusters[0].verified, '1');
            assert.equal(cleared.clusters[0].change_reason, 'remove image');
            assert.deepEqual(cleared.clusters[1], reasonBaseline.clusters[1]);
            assert.notDeepEqual(cleared.top[0].thumbnail_file, saved.top[0].thumbnail_file);
            assert.equal((await get('/InputReport/GetInputValueImage?repSheetId=7031&clusterId=1')).status, 404);
          } finally {
            actor = 'fixture';
            await rm(directory, { recursive: true, force: true });
          }
        },
      );
      await t.test(
        'sheet metadata regenerates report names using the native helper and commits labels/audits together, or rolls all of them back',
        async () => {
          const names =
            '<nameRegenerate>1</nameRegenerate><nameParts><part><partId>2</partId><type>report</type><value>remarksValue1</value></part><part><partId>1</partId><type>value</type><value>Sheet regenerated - </value></part></nameParts>';
          await client.query(
            "UPDATE rep_top SET xml_data=replace(xml_data,'<sheets>',$1 || '<sheets>') WHERE rep_top_id=1",
            [names],
          );
          const input = {
            'rep_sheets[0].rep_sheet_id': '11',
            'rep_sheets[0].rep_sheet_name': 'Regenerated fixture',
            'rep_sheets[0].sheet_remarks1': 'regeneration-sheet',
          };
          await documentSaveSheetMetadata(db, 1, 0, input, 'fixture');
          const report = await saved(),
            top = must(root(report.xml_data), 'top');
          assert.equal(report.rep_top_name, 'Sheet regenerated - label retry');
          assert.equal(optionalField(top, 'repTopName'), report.rep_top_name);
          assert.equal(optionalField(top, 'updateUser'), 'fixture');
          const sheet = (await client.query('SELECT * FROM rep_sheet WHERE rep_sheet_id=11')).rows[0];
          assert.equal(sheet.sys_update_time.getTime(), report.sys_update_time.getTime());
          const labels = (
            await client.query(
              'SELECT m.label_name_path FROM mst_label_rep m JOIN rep_label l USING(mst_label_id) WHERE l.rep_top_id=1 ORDER BY m.label_name_path',
            )
          ).rows;
          assert(labels.some((row) => row.label_name_path === report.rep_top_name + '/label retry'));

          const failing = {
            ...db,
            connect: async () => ({
              query: async (sql: string, values?: unknown[]) => {
                if (sql.startsWith('INSERT INTO rep_label_role')) throw new Error('Fixture sheet label failure.');
                return client.query(sql, values);
              },
              release() {},
            }),
          } as unknown as pg.Pool;
          await client.query(
            "UPDATE rep_top SET xml_data=replace(xml_data,'<value>Sheet regenerated - </value>','<value>Rollback regenerated - </value>') WHERE rep_top_id=1",
          );
          const before = await saved();
          await assert.rejects(
            documentSaveSheetMetadata(
              failing,
              1,
              0,
              { ...input, 'rep_sheets[0].sheet_remarks1': 'must roll back' },
              'fixture',
            ),
            /Fixture sheet label failure/,
          );
          assert.deepEqual(await saved(), before);
          assert.deepEqual((await client.query('SELECT * FROM rep_sheet WHERE rep_sheet_id=11')).rows[0], sheet);
          assert.deepEqual(
            (
              await client.query(
                'SELECT m.label_name_path FROM mst_label_rep m JOIN rep_label l USING(mst_label_id) WHERE l.rep_top_id=1 ORDER BY m.label_name_path',
              )
            ).rows,
            labels,
          );
          assert.equal(
            (await client.query("SELECT 1 FROM mst_label_rep WHERE label_name_path LIKE 'Rollback regenerated - %'"))
              .rowCount,
            0,
          );
          await client.query(
            "UPDATE rep_top SET xml_data=replace(replace(xml_data,'<type>value</type>','<type>date</type>'),'<value>Rollback regenerated - </value>','<value>MMM</value>') WHERE rep_top_id=1",
          );
          const unsupported = await saved();
          await assert.rejects(documentSaveSheetMetadata(db, 1, 0, input, 'fixture'), /date format/);
          assert.deepEqual(await saved(), unsupported);
          assert.deepEqual((await client.query('SELECT * FROM rep_sheet WHERE rep_sheet_id=11')).rows[0], sheet);
        },
      );
      await t.test(
        'completion checks every sheet, protects stale states and commits status, XML, audit, naming, labels and cooperation atomically',
        async () => {
          const completionXml =
            '<conmas><top><repTopId>801</repTopId><defTopId>801</defTopId><repTopName>Before completion</repTopName><editStatus>1</editStatus><publicStatus>0</publicStatus><cooperationTable>1</cooperationTable><nameRegenerate>1</nameRegenerate><remarksValue1>done</remarksValue1><nameParts><part><partId>1</partId><type>value</type><value>Completed - </value></part><part><partId>2</partId><type>report</type><value>remarksValue1</value></part></nameParts><sheets><sheet><repSheetId>8011</repSheetId><sheetNo>1</sheetNo><clusters><cluster><clusterId>1</clusterId><type>Text</type><value>kept</value></cluster></clusters></sheet><sheet><repSheetId>8012</repSheetId><sheetNo>2</sheetNo><clusters/></sheet></sheets></top></conmas>';
          await client.query(
            `INSERT INTO def_top(def_top_id,def_top_org,def_top_name,xml_data) VALUES (801,801,'Completion form',$1);
        `,
            [completionXml],
          );
          await client.query(
            `INSERT INTO rep_top(rep_top_id,rep_top_org,rev_no,rep_top_name,def_top_id,deleted,edit_refer_status,finish_output,top_remarks1,use_applicant_lock,workflow_lock,xml_data) VALUES (801,801,1,'Before completion',801,0,1,0,'done',0,0,$1)`,
            [completionXml],
          );
          await client.query(`INSERT INTO rep_current(rep_top_org,rep_top_id) VALUES (801,801);
        INSERT INTO rep_role(rep_top_id,group_id,role_rep_read,role_rep_update) VALUES (801,10,1,1),(801,20,1,0);
        INSERT INTO rep_sheet(rep_sheet_id,rep_top_id,rep_sheet_no,rep_sheet_name) VALUES (8011,801,1,'First'),(8012,801,2,'Second');
        INSERT INTO rep_cluster(rep_sheet_id,cluster_id,cluster_type,input_parameter,input_value) VALUES (8011,1,'Text','Required=true','kept'),(8012,1,'Text','Required=true','');
        INSERT INTO rep_cluster_refer(rep_sheet_id,cluster_id,group_id) VALUES (8012,1,30);
        CREATE TEMP TABLE report_801(rep_top_id int PRIMARY KEY,rep_top_name text,edit_refer_status int,sys_update_user text,sys_update_time timestamp,cluster_1_1_t text);
        INSERT INTO report_801 VALUES (801,'Before completion',1,'previous','2026-01-01','retained cooperation input');
        INSERT INTO mst_report_table(report_file_name,xml_data) VALUES ('801.xml','<report/>');
        INSERT INTO def_rep_label(def_top_id,mst_label_id) VALUES (801,101);`);
          const snapshot = async () => (await client.query('SELECT * FROM rep_top WHERE rep_top_id=801')).rows[0];
          const before = await snapshot();
          const request = {
            'rep_top.rep_top_id': '801',
            'rep_top.rep_top_name': 'Draft completion',
            IsComplete: ['true', 'false'],
          };
          const missing = await post('/InputReport/EditTop', request);
          assert.equal(missing.status, 400);
          const retry = await missing.text();
          assert.match(retry, /Required inputs are missing/);
          assert.match(retry, /id="IsComplete"[^>]*checked/);
          assert.match(retry, /value="Draft completion"/);
          assert.doesNotMatch(retry, /IsCompleteSuperManager|secret|SELECT|UPDATE rep_top/);
          assert.deepEqual(await snapshot(), before);
          await client.query("UPDATE rep_cluster SET verified='1' WHERE rep_sheet_id=8012");
          for (const state of ['deleted=1', 'workflow_lock=1', 'edit_refer_status=4']) {
            await client.query('UPDATE rep_top SET ' + state + ' WHERE rep_top_id=801');
            const locked = await snapshot();
            await assert.rejects(documentSaveTop(db, 801, { IsComplete: 'true' }, 'fixture'), /current state/);
            assert.deepEqual(await snapshot(), locked);
            await client.query('UPDATE rep_top SET deleted=0,workflow_lock=0,edit_refer_status=1 WHERE rep_top_id=801');
          }
          await client.query("INSERT INTO rep_lock(rep_top_id,user_id) VALUES (801,'other')");
          await assert.rejects(documentSaveTop(db, 801, { IsComplete: 'true' }, 'fixture'), /locked/);
          await client.query('DELETE FROM rep_lock WHERE rep_top_id=801');
          await client.query('DELETE FROM rep_current WHERE rep_top_id=801');
          await assert.rejects(documentSaveTop(db, 801, { IsComplete: 'true' }, 'fixture'), /current state/);
          await client.query('INSERT INTO rep_current(rep_top_org,rep_top_id) VALUES (801,801)');
          assert.equal((await post('/InputReport/EditTop', request, 'invalid')).status, 403);
          actor = 'reader';
          assert.equal((await post('/InputReport/EditTop', request)).status, 403);
          actor = 'fixture';
          await client.query(
            "UPDATE rep_top SET xml_data=replace(xml_data,'<defTopId>801</defTopId>','<defTopId>100</defTopId>') WHERE rep_top_id=801",
          );
          await assert.rejects(documentSaveTop(db, 801, request, 'fixture'), /Report XML identity differs/);
          await client.query('UPDATE rep_top SET xml_data=$1 WHERE rep_top_id=801', [before.xml_data]);
          assert.deepEqual(await snapshot(), before);
          await client.query(
            "UPDATE mst_common SET com_value='true' WHERE com_key='OUTPUT_SETTING' AND com_name='FINISH'",
          );
          try {
            const output = await post('/InputReport/EditTop', { ...request, 'rep_top.output_setting': '1' });
            assert.equal(output.status, 501);
            assert.match(await output.text(), /unmigrated output pipeline/);
            assert.deepEqual(await snapshot(), before);
          } finally {
            await client.query(
              "UPDATE mst_common SET com_value='false' WHERE com_key='OUTPUT_SETTING' AND com_name='FINISH'",
            );
          }
          await client.query(
            "INSERT INTO mst_mail(mail_file_name,xml_data) VALUES ('MailComplete.xml','<mail default=\"configured\"/>')",
          );
          try {
            const mail = await post('/InputReport/EditTop', request);
            assert.equal(mail.status, 501);
            assert.match(await mail.text(), /unmigrated mail pipeline/);
            assert.deepEqual(await snapshot(), before);
          } finally {
            await client.query("DELETE FROM mst_mail WHERE mail_file_name='MailComplete.xml'");
          }
          const cooperative = (await client.query('SELECT * FROM report_801')).rows;
          const failing = {
            ...db,
            connect: async () => ({
              query: async (sql: string, values?: unknown[]) => {
                if (sql.startsWith('INSERT INTO pg_temp.report_801'))
                  throw new Error('Private completion cooperation failure');
                return client.query(sql, values);
              },
              release() {},
            }),
          } as unknown as pg.Pool;
          await assert.rejects(
            documentSaveTop(failing, 801, request, 'fixture'),
            /Private completion cooperation failure/,
          );
          assert.deepEqual(await snapshot(), before);
          assert.deepEqual((await client.query('SELECT * FROM report_801')).rows, cooperative);
          assert.equal((await client.query('SELECT 1 FROM rep_label WHERE rep_top_id=801')).rowCount, 0);
          const labelFailure = {
            ...db,
            connect: async () => ({
              query: async (sql: string, values?: unknown[]) => {
                if (sql.startsWith('INSERT INTO rep_label_role')) throw new Error('Private completion label failure');
                return client.query(sql, values);
              },
              release() {},
            }),
          } as unknown as pg.Pool;
          await assert.rejects(
            documentSaveTop(labelFailure, 801, request, 'fixture'),
            /Private completion label failure/,
          );
          assert.deepEqual(await snapshot(), before);
          assert.deepEqual((await client.query('SELECT * FROM report_801')).rows, cooperative);
          assert.equal((await client.query('SELECT 1 FROM rep_label WHERE rep_top_id=801')).rowCount, 0);
          assert.equal((await post('/InputReport/EditTop', request)).status, 302);
          const after = await snapshot(),
            top = must(root(after.xml_data), 'top');
          assert.equal(Number(after.edit_refer_status), 4);
          assert.equal(optionalField(top, 'editStatus'), '4');
          assert.equal(after.rep_top_name, 'Completed - done');
          assert.equal(optionalField(top, 'repTopName'), after.rep_top_name);
          assert.equal(after.sys_update_user, 'fixture');
          assert.equal(after.sys_update_user_name, 'Fixture editor');
          assert.equal(optionalField(top, 'updateUser'), 'fixture');
          assert(after.sys_update_time instanceof Date);
          const persisted = (await client.query('SELECT * FROM report_801')).rows[0];
          assert.equal(persisted.rep_top_name, after.rep_top_name);
          assert.equal(persisted.edit_refer_status, 4);
          assert.equal(persisted.cluster_1_1_t, 'retained cooperation input');
          assert.equal(persisted.sys_update_time.getTime(), after.sys_update_time.getTime());
          assert((await client.query('SELECT 1 FROM rep_label WHERE rep_top_id=801')).rowCount! > 0);
          await assert.rejects(documentSaveTop(db, 801, request, 'fixture'), /current state/);
          assert.deepEqual(await snapshot(), after);
          const staleEditor = await get('/InputReport/EditTop?repTopId=801');
          assert.equal(staleEditor.status, 302);
          assert.equal(staleEditor.headers.get('location'), '/ConMasManager/InputReport/DetailsTop?repTopId=801');
          assert.equal((await client.query('SELECT 1 FROM rep_lock WHERE rep_top_id=801')).rowCount, 0);
        },
      );
      await t.test(
        'forced completion is server-authorized, preserves an escaped reason and bypasses only required checks',
        async () => {
          await client.query(`UPDATE rep_top SET edit_refer_status=1,xml_data=replace(xml_data,'<editStatus>4</editStatus>','<editStatus>1</editStatus>') WHERE rep_top_id=801;
        UPDATE rep_cluster SET verified='0',input_value='' WHERE rep_sheet_id=8012;`);
          const before = (await client.query('SELECT * FROM rep_top WHERE rep_top_id=801')).rows[0];
          const input = {
            'rep_top.rep_top_id': '801',
            IsCompleteSuperManager: ['true', 'false'],
            'rep_top.finish_reason': '<Reason>\r\nretained',
          };
          assert.equal((await post('/InputReport/EditTop', input)).status, 403);
          assert.deepEqual((await client.query('SELECT * FROM rep_top WHERE rep_top_id=801')).rows[0], before);
          await client.query('UPDATE mst_group SET role_rep_super_manager=1 WHERE group_id=10');
          try {
            const form = await get('/InputReport/EditTop?repTopId=801');
            assert.match(await form.text(), /id="IsCompleteSuperManager"/);
            const oversized = await post('/InputReport/EditTop', {
              ...input,
              'rep_top.finish_reason': 'x'.repeat(4001),
            });
            assert.equal(oversized.status, 400);
            assert.match(await oversized.text(), /id="IsCompleteSuperManager"[^>]*checked/);
            await client.query(
              "UPDATE rep_top SET xml_data=replace(xml_data,'<sheets>','<useAutoNumbering>1</useAutoNumbering><autoNumbering><numberingTiming>1</numberingTiming></autoNumbering><sheets>') WHERE rep_top_id=801",
            );
            const unsupported = (await client.query('SELECT * FROM rep_top WHERE rep_top_id=801')).rows[0];
            const rejected = await post('/InputReport/EditTop', input);
            assert.equal(rejected.status, 400);
            const html = await rejected.text();
            assert.match(html, /numbering/);
            assert.match(html, /&lt;Reason&gt;/);
            assert.deepEqual((await client.query('SELECT * FROM rep_top WHERE rep_top_id=801')).rows[0], unsupported);
            await client.query(
              "UPDATE rep_top SET xml_data=replace(xml_data,'<useAutoNumbering>1</useAutoNumbering><autoNumbering><numberingTiming>1</numberingTiming></autoNumbering>','') WHERE rep_top_id=801",
            );
            assert.equal((await post('/InputReport/EditTop', input)).status, 302);
            const after = (await client.query('SELECT * FROM rep_top WHERE rep_top_id=801')).rows[0];
            assert.equal(Number(after.edit_refer_status), 4);
            assert.equal(Number(after.finish_compulsory_type), 1);
            assert.equal(after.finish_reason, input['rep_top.finish_reason']);
            assert.equal(after.sys_update_user, 'fixture');
            const details = await get('/InputReport/DetailsTop?repTopId=801');
            assert.match(await details.text(), /Reason for compulsory input completion<\/th><td>&lt;Reason&gt;/);
            assert.equal(
              (await client.query('SELECT input_value,verified FROM rep_cluster WHERE rep_sheet_id=8012')).rows[0]
                .input_value,
              '',
            );
          } finally {
            await client.query('UPDATE mst_group SET role_rep_super_manager=0 WHERE group_id=10');
          }
        },
      );
      await t.test(
        'Basic final-save numbering persists relational/XML clusters, history and generated names without renumbering saved numbers',
        async () => {
          const numbering =
            '<useAutoNumbering>1</useAutoNumbering><autoNumbering><startValue>7</startValue><increment>2</increment><digit>3</digit><zeroPadding>1</zeroPadding><numberingTiming>1</numberingTiming><part><partId>1</partId><type>value</type><value>IR-</value></part><part><partId>2</partId><type>autoNumber</type><value/></part></autoNumbering>';
          const xml =
            '<conmas><top><repTopId>802</repTopId><defTopId>802</defTopId><repTopName>Before number</repTopName><editStatus>1</editStatus><nameRegenerate>1</nameRegenerate><nameParts><part><partId>1</partId><type>displayValue</type><value>1,1</value></part></nameParts>' +
            numbering +
            '<sheets><sheet><repSheetId>8021</repSheetId><sheetNo>1</sheetNo><clusters><cluster><clusterId>1</clusterId><type>KeyboardText</type><inputParameters>AutoNumber=1</inputParameters><value/><displayValue/></cluster></clusters></sheet></sheets></top></conmas>';
          await client.query('INSERT INTO def_top(def_top_id,def_top_org,auto_numbering_rev_no) VALUES (802,802,1)');
          await client.query(
            "INSERT INTO rep_top(rep_top_id,rep_top_org,rev_no,rep_top_name,def_top_id,deleted,edit_refer_status,finish_output,xml_data) VALUES(802,802,1,'Before number',802,0,1,0,$1)",
            [xml],
          );
          await client.query(`INSERT INTO rep_current(rep_top_org,rep_top_id) VALUES (802,802);
        INSERT INTO rep_role(rep_top_id,group_id,role_rep_read,role_rep_update) VALUES (802,10,1,1);
        INSERT INTO rep_sheet(rep_sheet_id,rep_top_id,rep_sheet_no,rep_sheet_name) VALUES (8021,802,1,'Number sheet');
        INSERT INTO rep_cluster(rep_sheet_id,cluster_id,cluster_type,input_parameter,input_value,display_value) VALUES (8021,1,'KeyboardText','AutoNumber=1','','');
        CREATE TEMP SEQUENCE rep_auto_numbering_802_1 INCREMENT 2 MINVALUE 1 MAXVALUE 999 START 7;`);
          const failing = {
            ...db,
            connect: async () => ({
              query: async (sql: string, values?: unknown[]) => {
                if (sql.startsWith('INSERT INTO rep_top_option')) throw new Error('Private numbered save failure');
                return client.query(sql, values);
              },
              release() {},
            }),
          } as unknown as pg.Pool;
          await assert.rejects(
            documentSaveTop(failing, 802, { IsComplete: 'true' }, 'fixture'),
            /Private numbered save failure/,
          );
          assert.equal(
            (await client.query('SELECT input_value FROM rep_cluster WHERE rep_sheet_id=8021')).rows[0].input_value,
            '',
          );
          assert.equal((await client.query('SELECT xml_data FROM rep_top WHERE rep_top_id=802')).rows[0].xml_data, xml);
          // PostgreSQL sequences retain gaps after rollback, as the source sequence implementation does.
          assert.equal(
            String((await client.query('SELECT last_value FROM rep_auto_numbering_802_1')).rows[0].last_value),
            '7',
          );
          await documentSaveTop(db, 802, { IsComplete: 'true' }, 'fixture');
          const report = (await client.query('SELECT * FROM rep_top WHERE rep_top_id=802')).rows[0];
          assert.equal(report.auto_numbering_value, 'IR-009');
          assert.equal(report.rep_top_name, 'IR-009');
          assert.equal(Number(report.edit_refer_status), 4);
          assert.match(report.xml_data, /<value>IR-009<\/value><displayValue>IR-009<\/displayValue>/);
          assert.match(
            (await client.query('SELECT xml_data FROM rep_sheet WHERE rep_sheet_id=8021')).rows[0].xml_data,
            /IR-009/,
          );
          const value = (await client.query('SELECT * FROM rep_cluster WHERE rep_sheet_id=8021')).rows[0];
          assert.equal(value.input_value, 'IR-009');
          assert.equal(value.display_value, 'IR-009');
          assert.equal(value.sys_update_user, 'fixture');
          await client.query('UPDATE rep_top SET edit_refer_status=1 WHERE rep_top_id=802');
          await documentSaveTop(db, 802, { IsComplete: 'true' }, 'fixture');
          assert.equal(
            String((await client.query('SELECT last_value FROM rep_auto_numbering_802_1')).rows[0].last_value),
            '9',
          );
          await client.query(
            "UPDATE rep_top SET edit_refer_status=1,auto_numbering_value=NULL WHERE rep_top_id=802; SELECT setval('pg_temp.rep_auto_numbering_802_1',999,true)",
          );
          await assert.rejects(documentSaveTop(db, 802, { IsComplete: 'true' }, 'fixture'), /maximum/);
          const resetRule = numbering
            .match(/<autoNumbering>[\s\S]*<\/autoNumbering>/)![0]
            .replace('<startValue>7</startValue>', '<startValue>11</startValue>')
            .replace(
              '</autoNumbering>',
              '<useReset>1</useReset><reset><termType>1</termType><interval>1</interval><startDate>2026/01/01</startDate><executeTime>00:00</executeTime></reset></autoNumbering>',
            );
          await client.query(
            "INSERT INTO def_auto_numbering_reset_setting(def_top_org,auto_numbering_rev_no,auto_numbering_setting,next_reset_time) VALUES(802,1,$1,'2026-01-01')",
            [resetRule],
          );
          await documentSaveTop(db, 802, { IsComplete: 'true' }, 'fixture');
          assert.equal(
            (await client.query('SELECT auto_numbering_value FROM rep_top WHERE rep_top_id=802')).rows[0]
              .auto_numbering_value,
            'IR-011',
          );
          assert.equal(
            (await client.query("SELECT 1 FROM log_auto_numbering WHERE def_top_org=802 AND action='AUTO_RESET'"))
              .rowCount,
            1,
          );
        },
      );
      await t.test(
        'Basic internal Excel repair preserves the first shared-definition backup, permissions, CSRF and rollback',
        async () => {
          const directory = await mkdtemp('/tmp/opencode/document-excel-');
          const original = Buffer.from('private original workbook'),
            patched = Buffer.from('private patched workbook'),
            second = Buffer.from('private replacement workbook');
          const type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
          const body = { 'rep_top.rep_top_id': '804' };
          const upload = (files: Array<[string, Buffer, string]>, csrf = token) =>
            multipart(body, files, csrf, '/InputReport/UploadInnerExcel');
          try {
            await client.query(
              "INSERT INTO def_top(def_top_id,def_top_name,def_file_type,def_file) VALUES(804,'Excel form','xlsx',$1)",
              [original],
            );
            await client.query(`INSERT INTO rep_top(rep_top_id,rep_top_org,rev_no,def_top_id,rep_top_name,deleted,edit_refer_status,xml_data)
            VALUES(804,804,1,804,'Excel report',0,4,'<conmas><top><repTopId>804</repTopId><defTopId>804</defTopId><sheets/></top></conmas>');
            INSERT INTO rep_current(rep_top_id,rep_top_org) VALUES(804,804);
            INSERT INTO rep_role(rep_top_id,group_id,role_rep_read,role_rep_update) VALUES(804,10,1,1),(804,20,1,0);
            INSERT INTO mst_common(com_key,com_name,com_value,com_index) VALUES('FUNCTION_SETTING','EXCELFILE_RECOVERY','1',90);`);
            const snapshot = async () => (await client.query('SELECT * FROM def_top WHERE def_top_id=804')).rows[0];
            const before = await snapshot();
            const form = await (await get('/InputReport/DetailsTop?repTopId=804')).text();
            assert.match(form, /id="UploadInnerExcel"[^>]*enctype="multipart\/form-data"/);
            assert.match(form, /DownLoadInnerExcel\?repTopId=804/);
            assert.doesNotMatch(form, /<form[^>]*id="form0"/);
            assert.doesNotMatch(
              await (await get('/InputReport/DetailsTop?repTopId=804&isLayer=true')).text(),
              /id="patchExcel"/,
            );
            assert.equal((await upload([['patchedExcel', patched, type]], 'bad')).status, 403);
            const missing = await upload([]);
            assert.match(missing.headers.get('location') ?? '', /errorCode=PatchExcelFileNotExists$/);
            const invalid = await upload([['patchedExcel', patched, 'text/plain']]);
            assert.match(invalid.headers.get('location') ?? '', /errorCode=PatchExcelNotExcelFile$/);
            actor = 'reader';
            assert.equal((await get('/InputReport/DownLoadInnerExcel?repTopId=804')).status, 403);
            assert.match(
              (await upload([['patchedExcel', patched, type]])).headers.get('location') ?? '',
              /errorCode=RoleError$/,
            );
            assert.doesNotMatch(await (await get('/InputReport/DetailsTop?repTopId=804')).text(), /id="patchExcel"/);
            actor = 'fixture';
            await client.query('UPDATE rep_role SET role_rep_update=0 WHERE rep_top_id=804 AND group_id=10');
            assert.equal((await get('/InputReport/DownLoadInnerExcel?repTopId=804')).status, 403);
            await client.query('UPDATE rep_role SET role_rep_update=1 WHERE rep_top_id=804 AND group_id=10');
            assert.deepEqual(await snapshot(), before);
            const path = join(directory, 'workbook');
            await writeFile(path, patched);
            const file = {
              path,
              fieldname: 'patchedExcel',
              mimetype: type,
              size: patched.length,
            } as Express.Multer.File;
            const failing = {
              ...db,
              connect: async () => ({
                query: async (sql: string, values?: unknown[]) => {
                  if (sql.startsWith('UPDATE def_top SET def_file='))
                    throw new Error('Private workbook update failure');
                  return client.query(sql, values);
                },
                release() {},
              }),
            } as unknown as pg.Pool;
            await assert.rejects(
              documentInnerExcel(failing, 804, 'fixture', [file]),
              /Private workbook update failure/,
            );
            assert.deepEqual(await snapshot(), before);
            const download = await get('/InputReport/DownLoadInnerExcel?repTopId=804');
            assert.equal(download.status, 200);
            assert.match(download.headers.get('content-disposition') ?? '', /def804\.xlsx/);
            assert.deepEqual(Buffer.from(await download.arrayBuffer()), original);
            assert.deepEqual((await snapshot()).def_file_backup, original);
            assert.match(
              (await upload([['patchedExcel', patched, type]])).headers.get('location') ?? '',
              /errorCode=Success$/,
            );
            assert.deepEqual((await snapshot()).def_file, patched);
            assert.deepEqual((await snapshot()).def_file_backup, original);
            assert.match(
              (await upload([['patchedExcel', second, type]])).headers.get('location') ?? '',
              /errorCode=Success$/,
            );
            assert.deepEqual((await snapshot()).def_file, second);
            const retained = await get('/InputReport/DownLoadInnerExcel?repTopId=804');
            assert.deepEqual(Buffer.from(await retained.arrayBuffer()), original);
            assert.deepEqual((await snapshot()).def_file_backup, original);
            assert.match(
              await (await get('/InputReport/DetailsTop?repTopId=804&errorCode=PatchExcelNotExcelFile')).text(),
              /A non-EXCEL file was selected/,
            );
            await client.query(
              "INSERT INTO mst_common(com_key,com_name,com_value,com_index) VALUES('OUTPUT_SETTING','EXCEL_MANUAL_OUTPUT','false',90)",
            );
            assert.doesNotMatch(await (await get('/InputReport/DetailsTop?repTopId=804')).text(), /id="patchExcel"/);
          } finally {
            actor = 'fixture';
            await client.query(
              "DELETE FROM mst_common WHERE com_key='FUNCTION_SETTING' AND com_name='EXCELFILE_RECOVERY' AND com_index=90",
            );
            await client.query(
              "DELETE FROM mst_common WHERE com_key='OUTPUT_SETTING' AND com_name='EXCEL_MANUAL_OUTPUT' AND com_index=90",
            );
            await rm(directory, { recursive: true, force: true });
          }
        },
      );
      await t.test(
        'sheet numbering increments stored save counts atomically, refreshes names/previews and saturates at the configured limit',
        async () => {
          const settings =
            '<autoNumbering><startValue>1</startValue><increment>1</increment><digit>3</digit><zeroPadding>1</zeroPadding><numberingTiming>0</numberingTiming><useSaveCount>1</useSaveCount><saveCount><digit>2</digit><zeroPadding>1</zeroPadding></saveCount><part><partId>1</partId><type>autoNumber</type><value/></part><part><partId>2</partId><type>saveCount</type><value/></part></autoNumbering>';
          const xml =
            '<conmas><top><repTopId>803</repTopId><defTopId>100</defTopId><repTopName>Before counter</repTopName><editStatus>1</editStatus><useAutoNumbering>1</useAutoNumbering><nameRegenerate>0</nameRegenerate><nameParts><part><partId>1</partId><type>displayValue</type><value>1,1</value></part></nameParts>' +
            settings +
            '<sheets><sheet><repSheetId>8031</repSheetId><sheetNo>1</sheetNo><repSheetName>Numbered sheet</repSheetName><clusters><cluster><clusterId>1</clusterId><type>KeyboardText</type><inputParameters>AutoNumber=1</inputParameters><value>IR-007-02</value><displayValue>IR-007-02</displayValue></cluster></clusters></sheet></sheets></top></conmas>';
          const pdf = await PDFDocument.create();
          pdf.addPage([300, 600]);
          await client.query(
            `INSERT INTO rep_top(rep_top_id,rep_top_org,rev_no,rep_top_name,def_top_id,deleted,edit_refer_status,edit_output,finish_output,use_input_history,rep_sheet_count,auto_numbering_value,auto_numbering_save_count,xml_data,background_image_file)
          VALUES(803,803,1,'Before counter',100,0,1,0,0,2,1,'IR-007-{SAVE_COUNT}',2,$1,$2)`,
            [xml, Buffer.from(await pdf.save())],
          );
          await client.query(`INSERT INTO rep_current(rep_top_id,rep_top_org) VALUES(803,803);
          INSERT INTO rep_role(rep_top_id,group_id,role_rep_read,role_rep_update) VALUES(803,10,1,1);
          INSERT INTO rep_sheet(rep_sheet_id,rep_top_id,rep_sheet_no,rep_sheet_name) VALUES(8031,803,1,'Numbered sheet');
          INSERT INTO rep_cluster(rep_sheet_id,cluster_id,cluster_type,input_parameter,input_value,display_value,left_position,top_position,right_position,bottom_position)
          VALUES(8031,1,'KeyboardText','AutoNumber=1','IR-007-02','IR-007-02',.1,.1,.9,.3);`);
          const input = { 'rep_sheets[0].rep_sheet_id': '8031' };
          const snapshot = async () => ({
            top: (await client.query('SELECT * FROM rep_top WHERE rep_top_id=803')).rows[0],
            sheet: (await client.query('SELECT * FROM rep_sheet WHERE rep_sheet_id=8031')).rows[0],
            cluster: (await client.query('SELECT * FROM rep_cluster WHERE rep_sheet_id=8031')).rows[0],
            history: (
              await client.query('SELECT * FROM history_rep_cluster WHERE rep_sheet_id=8031 ORDER BY history_id')
            ).rows,
          });
          const before = await snapshot();
          const failing = {
            ...db,
            connect: async () => ({
              query: async (sql: string, values?: unknown[]) => {
                if (sql.startsWith('UPDATE rep_top SET thumbnail_file'))
                  throw new Error('Private numbering preview failure');
                return client.query(sql, values);
              },
              release() {},
            }),
          } as unknown as pg.Pool;
          await assert.rejects(
            documentSaveSheetMetadata(failing, 803, 0, input, 'fixture'),
            /Private numbering preview failure/,
          );
          assert.deepEqual(await snapshot(), before);
          await documentSaveSheetMetadata(db, 803, 0, input, 'fixture');
          const saved = await snapshot();
          assert.equal(Number(saved.top.auto_numbering_save_count), 3);
          assert.equal(saved.top.auto_numbering_display_save_count, '03');
          assert.equal(saved.top.auto_numbering_value, 'IR-007-{SAVE_COUNT}');
          assert.equal(saved.top.rep_top_name, 'IR-007-03');
          assert.equal(saved.cluster.input_value, 'IR-007-03');
          assert.equal(saved.cluster.display_value, 'IR-007-03');
          assert.match(saved.top.xml_data, /<readOnly>1<\/readOnly>/);
          assert.match(saved.sheet.xml_data, /<value>IR-007-03<\/value>/);
          assert(saved.history.some((row) => row.input_value === 'IR-007-03'));
          assert(Buffer.isBuffer(saved.top.thumbnail_file) && saved.top.thumbnail_file.length > 0);
          await client.query('UPDATE rep_top SET auto_numbering_save_count=99 WHERE rep_top_id=803');
          await documentSaveSheetMetadata(db, 803, 0, input, 'fixture');
          const capped = await snapshot();
          assert.equal(Number(capped.top.auto_numbering_save_count), 99);
          assert.equal(capped.cluster.input_value, 'IR-007-99');
          await documentSaveSheetMetadata(db, 803, 0, input, 'fixture');
          assert.equal(Number((await snapshot()).top.auto_numbering_save_count), 99);
          const omittedPadding = xml.replace('<zeroPadding>1</zeroPadding></saveCount>', '</saveCount>');
          await client.query('UPDATE rep_top SET xml_data=$1,auto_numbering_save_count=2 WHERE rep_top_id=803', [
            omittedPadding,
          ]);
          await documentSaveSheetMetadata(db, 803, 0, input, 'fixture');
          assert.equal((await snapshot()).cluster.input_value, 'IR-007-3');
          for (const bad of [
            '<digit>0</digit>',
            '<digit>2</digit><zeroPadding>bad</zeroPadding>',
            '<zeroPadding>1</zeroPadding>',
          ]) {
            await client.query('UPDATE rep_top SET xml_data=$1 WHERE rep_top_id=803', [
              xml.replace(/<saveCount>[\s\S]*?<\/saveCount>/, '<saveCount>' + bad + '</saveCount>'),
            ]);
            const invalid = await snapshot();
            await assert.rejects(documentSaveSheetMetadata(db, 803, 0, input, 'fixture'), /automatic-numbering/);
            assert.deepEqual(await snapshot(), invalid);
          }
        },
      );
      await t.test(
        'Basic manual re-numbering rechecks all three permissions and atomically preserves save counts and refreshes history/XML/preview',
        async () => {
          const settings =
            '<useAutoNumbering>1</useAutoNumbering><autoNumbering><startValue>7</startValue><increment>2</increment><digit>3</digit><zeroPadding>1</zeroPadding><numberingTiming>0</numberingTiming><useSaveCount>1</useSaveCount><saveCount><digit>2</digit><zeroPadding>1</zeroPadding></saveCount><part><partId>1</partId><type>value</type><value>IR-</value></part><part><partId>2</partId><type>autoNumber</type><value/></part><part><partId>3</partId><type>saveCount</type><value/></part></autoNumbering>';
          const xml =
            '<conmas><top><repTopId>805</repTopId><defTopId>805</defTopId><repTopName>Manual report</repTopName><editStatus>4</editStatus>' +
            settings +
            '<sheets><sheet><repSheetId>8051</repSheetId><sheetNo>1</sheetNo><clusters><cluster><clusterId>1</clusterId><type>KeyboardText</type><inputParameters>AutoNumber=1</inputParameters><value>old</value><displayValue>old</displayValue></cluster></clusters></sheet></sheets></top></conmas>';
          const pdf = await PDFDocument.create();
          pdf.addPage([300, 600]);
          await client.query('INSERT INTO def_top(def_top_id,def_top_org,auto_numbering_rev_no) VALUES(805,805,1)');
          await client.query(
            `INSERT INTO rep_top(rep_top_id,rep_top_org,rev_no,rep_top_name,def_top_id,deleted,edit_refer_status,use_input_history,rep_sheet_count,auto_numbering_value,auto_numbering_save_count,xml_data,background_image_file)
          VALUES(805,805,1,'Manual report',805,0,4,2,1,'OLD-{SAVE_COUNT}',3,$1,$2)`,
            [xml, Buffer.from(await pdf.save())],
          );
          await client.query(`INSERT INTO rep_current(rep_top_id,rep_top_org) VALUES(805,805);
          INSERT INTO rep_role(rep_top_id,group_id,role_rep_read,role_rep_update) VALUES(805,10,1,1),(805,20,1,0);
          INSERT INTO rep_sheet(rep_sheet_id,rep_top_id,rep_sheet_no,rep_sheet_name) VALUES(8051,805,1,'Manual sheet');
          INSERT INTO rep_cluster(rep_sheet_id,cluster_id,cluster_type,input_parameter,input_value,display_value,left_position,top_position,right_position,bottom_position)
            VALUES(8051,1,'KeyboardText','AutoNumber=1','old','old',.1,.1,.9,.3);
          CREATE TEMP SEQUENCE rep_auto_numbering_805_1 INCREMENT 2 MINVALUE 1 MAXVALUE 999 START 7;`);
          const input = { repTopId: '805', defTopId: '805' };
          const snapshot = async () => ({
            top: (await client.query('SELECT * FROM rep_top WHERE rep_top_id=805')).rows[0],
            sheet: (await client.query('SELECT * FROM rep_sheet WHERE rep_sheet_id=8051')).rows[0],
            cluster: (await client.query('SELECT * FROM rep_cluster WHERE rep_sheet_id=8051')).rows[0],
            history: (
              await client.query('SELECT * FROM history_rep_cluster WHERE rep_sheet_id=8051 ORDER BY history_id')
            ).rows,
          });
          const before = await snapshot();
          try {
            assert.match(
              await (await get('/InputReport/DetailsTop?repTopId=805')).text(),
              /value="Manual numbering" disabled/,
            );
            assert.equal((await post('/InputReport/UpdateAutoNumber', input)).status, 403);
            await client.query('UPDATE mst_group SET role_rep_super_manager=1 WHERE group_id=10');
            assert.match(
              await (await get('/InputReport/DetailsTop?repTopId=805')).text(),
              /action="[^"]*UpdateAutoNumber"[^>]*data-ajax-confirm=/,
            );
            assert.equal((await post('/InputReport/UpdateAutoNumber', input, 'bad')).status, 403);
            actor = 'reader';
            assert.equal((await post('/InputReport/UpdateAutoNumber', input)).status, 403);
            actor = 'fixture';
            await client.query('UPDATE mst_group SET role_rep_update_manager=0 WHERE group_id=10');
            await assert.rejects(documentManualNumber(db, 805, 805, 'fixture', 'en-US'), /Role authority/);
            await client.query('UPDATE mst_group SET role_rep_update_manager=1 WHERE group_id=10');
            await client.query('UPDATE rep_role SET role_rep_update=0 WHERE rep_top_id=805 AND group_id=10');
            assert.equal((await post('/InputReport/UpdateAutoNumber', input)).status, 403);
            await client.query('UPDATE rep_role SET role_rep_update=1 WHERE rep_top_id=805 AND group_id=10');
            assert.equal((await post('/InputReport/UpdateAutoNumber', { ...input, defTopId: '100' })).status, 400);
            assert.notEqual((await get('/InputReport/UpdateAutoNumber?repTopId=805&defTopId=805')).status, 200);
            assert.deepEqual(await snapshot(), before);
            assert.equal(
              (await client.query('SELECT is_called FROM rep_auto_numbering_805_1')).rows[0].is_called,
              false,
            );
            const failing = {
              ...db,
              connect: async () => ({
                query: async (sql: string, values?: unknown[]) => {
                  if (sql.startsWith('UPDATE rep_top SET thumbnail_file'))
                    throw new Error('Private manual preview failure');
                  return client.query(sql, values);
                },
                release() {},
              }),
            } as unknown as pg.Pool;
            await assert.rejects(
              documentManualNumber(failing, 805, 805, 'fixture', 'en-US'),
              /Private manual preview failure/,
            );
            assert.deepEqual(await snapshot(), before);
            const result = await post('/InputReport/UpdateAutoNumber', input);
            assert.equal(result.status, 302);
            assert.equal(result.headers.get('location'), '/ConMasManager/InputReport/DetailsTop?repTopId=805');
            const saved = await snapshot();
            assert.equal(saved.top.auto_numbering_value, 'IR-009{SAVE_COUNT}');
            assert.equal(Number(saved.top.auto_numbering_save_count), 3);
            assert.equal(saved.top.auto_numbering_display_save_count, '03');
            assert.equal(saved.top.rep_top_name, 'Manual report');
            assert.equal(Number(saved.top.edit_refer_status), 4);
            assert.equal(saved.top.sys_update_user, 'fixture');
            assert.equal(saved.cluster.input_value, 'IR-00903');
            assert.match(saved.top.xml_data, /<value>IR-00903<\/value>/);
            assert.match(saved.sheet.xml_data, /<value>IR-00903<\/value>/);
            assert(saved.history.some((row) => row.input_value === 'IR-00903'));
            assert(Buffer.isBuffer(saved.top.thumbnail_file) && saved.top.thumbnail_file.length > 0);
            await post('/InputReport/UpdateAutoNumber', input);
            assert.equal((await snapshot()).top.auto_numbering_value, 'IR-011{SAVE_COUNT}');
          } finally {
            actor = 'fixture';
            await client.query(
              'UPDATE mst_group SET role_rep_update_manager=1,role_rep_super_manager=0 WHERE group_id=10',
            );
          }
        },
      );
      await t.test(
        'Basic standard CSV downloads preserve permissions, source modes, omission and optional original-byte media archives without data changes',
        async () => {
          const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fefefe' } })
            .png()
            .toBuffer();
          await client.query(`INSERT INTO rep_top(rep_top_id,rep_top_org,rev_no,rep_top_name,def_top_id,deleted,edit_refer_status,rep_sheet_count,no_need_to_fill_string,xml_data)
          VALUES(806,806,1,'CSV report',100,0,1,1,'N/A','<conmas><top><repTopId>806</repTopId><defTopId>100</defTopId><sheets/></top></conmas>');
          INSERT INTO rep_current(rep_top_id,rep_top_org) VALUES(806,806);
          INSERT INTO rep_role(rep_top_id,group_id,role_rep_read,role_rep_update) VALUES(806,10,1,1),(806,20,1,0);
          INSERT INTO rep_sheet(rep_sheet_id,rep_top_id,rep_sheet_no,rep_sheet_name) VALUES(8061,806,3,'CSV sheet');
          INSERT INTO rep_cluster(rep_sheet_id,cluster_id,cluster_type,cluster_name,input_value,display_value,verified)
          VALUES(8061,1,'KeyboardText','Quoted "name"','input','Display','0'),(8061,2,'Check','Omitted','FALSE','False','1'),
          (8061,3,'Image','Picture','','','0'),(8061,4,'KeyboardText','Secret','secret-csv-value','hidden-csv-display','0');
          INSERT INTO rep_cluster_refer(rep_sheet_id,cluster_id,group_id) VALUES(8061,4,30);
          INSERT INTO mst_common(com_key,com_name,com_value,com_index) VALUES('OUTPUT_SETTING','BASE_FILE','csv_fixture',92),('OUTPUT_SETTING','CSV_MODE','0',92),('OUTPUT_SETTING','CSV_IMAGE_OUTPUT','false',92),('OUTPUT_SETTING','CSV_ZIP','false',92);`);
          await client.query('UPDATE rep_cluster SET image_file=$1 WHERE rep_sheet_id=8061 AND cluster_id=3', [png]);
          const snapshot = async () => ({
            top: (await client.query('SELECT * FROM rep_top WHERE rep_top_id=806')).rows[0],
            clusters: (await client.query('SELECT * FROM rep_cluster WHERE rep_sheet_id=8061 ORDER BY cluster_id'))
              .rows,
          });
          const before = await snapshot();
          const download = () => get('/InputReport/DownLoadAction?repTopId=806&downloadMode=csv');
          try {
            const form = await (await get('/InputReport/DetailsTop?repTopId=806')).text();
            assert.match(form, /class="csv_link"[^>]*downloadMode=csv/);
            const plain = await download();
            assert.equal(plain.status, 200);
            assert.match(plain.headers.get('content-disposition') ?? '', /csv_fixture\.csv/);
            const bytes = Buffer.from(await plain.arrayBuffer());
            assert.deepEqual([...bytes.subarray(0, 3)], [239, 187, 191]);
            assert.equal(
              bytes.toString('utf8'),
              '\ufeff"1","Quoted ""name""","input"\r\n"2","Omitted","N/A"\r\n"3","Picture","3_cluster_3.png"\r\n',
            );
            actor = 'reader';
            assert.equal((await download()).status, 200);
            actor = 'other';
            assert.equal((await download()).status, 403);
            actor = 'fixture';
            await client.query(
              "UPDATE mst_common SET com_value='true' WHERE com_key='OUTPUT_SETTING' AND com_name='CSV_IMAGE_OUTPUT' AND com_index=92",
            );
            const archive = await download();
            assert.match(archive.headers.get('content-type') ?? '', /application\/zip/);
            const zip = Buffer.from(await archive.arrayBuffer()),
              entries = new Map<string, Buffer>();
            let offset = 0;
            while (zip.readUInt32LE(offset) === 0x04034b50) {
              assert.equal(zip.readUInt16LE(offset + 8), 0);
              const length = zip.readUInt32LE(offset + 18),
                nameLength = zip.readUInt16LE(offset + 26),
                extra = zip.readUInt16LE(offset + 28),
                start = offset + 30 + nameLength + extra;
              entries.set(
                zip.subarray(offset + 30, offset + 30 + nameLength).toString('utf8'),
                zip.subarray(start, start + length),
              );
              offset = start + length;
            }
            assert.deepEqual([...entries.keys()], ['csv_fixture_3_cluster_3.png', 'csv_fixture.csv']);
            assert.deepEqual(entries.get('csv_fixture_3_cluster_3.png'), png);
            assert.deepEqual(entries.get('csv_fixture.csv'), bytes);
            await client.query(
              "UPDATE mst_common SET com_value='3' WHERE com_key='OUTPUT_SETTING' AND com_name='CSV_MODE' AND com_index=92",
            );
            await client.query(
              "UPDATE mst_common SET com_value='false' WHERE com_key='OUTPUT_SETTING' AND com_name='CSV_IMAGE_OUTPUT' AND com_index=92",
            );
            const display = await (await download()).text();
            assert.match(display, /"1","Quoted ""name""","Display"/);
            assert.doesNotMatch(display, /secret-csv-value|hidden-csv-display/);
            for (const mode of ['1', '2']) {
              await client.query(
                "UPDATE mst_common SET com_value=$1 WHERE com_key='OUTPUT_SETTING' AND com_name='CSV_MODE' AND com_index=92",
                [mode],
              );
              assert.equal((await download()).status, 501);
            }
            await client.query(
              "INSERT INTO mst_common(com_key,com_name,com_value,com_index) VALUES('OUTPUT_SETTING','CSV_MANUAL_OUTPUT','false',92)",
            );
            assert.doesNotMatch(await (await get('/InputReport/DetailsTop?repTopId=806')).text(), /class="csv_link"/);
            assert.deepEqual(await snapshot(), before);
          } finally {
            actor = 'fixture';
            await client.query("DELETE FROM mst_common WHERE com_key='OUTPUT_SETTING' AND com_index=92");
          }
        },
      );
      await t.test(
        'Basic approval/rejection rechecks identity and row permissions and atomically saves carbon copies, signatures, history, completion and preview',
        async () => {
          const xml =
            '<conmas><top><repTopId>807</repTopId><defTopId>100</defTopId><repTopName>Approval report</repTopName><editStatus>2</editStatus><reEditDisable>1</reEditDisable><nameRegenerate>1</nameRegenerate><nameParts><part><partId>1</partId><type>displayValue</type><value>1,1</value></part></nameParts><sheets>' +
            '<sheet><repSheetId>8071</repSheetId><sheetNo>1</sheetNo><clusters><cluster><clusterId>1</clusterId><type>Approve</type><inputParameters>Required=true</inputParameters><value>2</value><displayValue>2</displayValue><carbonCopy><targetCluster><sheetNo>3</sheetNo><clusterId>1</clusterId></targetCluster></carbonCopy></cluster></clusters></sheet>' +
            '<sheet><repSheetId>8073</repSheetId><sheetNo>3</sheetNo><clusters><cluster><clusterId>1</clusterId><type>Approve</type><inputParameters/><value>2</value><displayValue>2</displayValue></cluster><cluster><clusterId>2</clusterId><type>Text</type><inputParameters>Required=true</inputParameters><value>ready</value><displayValue>ready</displayValue></cluster></clusters></sheet></sheets></top></conmas>';
          const pdf = await PDFDocument.create();
          for (let page = 0; page < 3; page++) pdf.addPage([300, 600]);
          const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#222222' } })
            .png()
            .toBuffer();
          await client.query(
            `INSERT INTO rep_top(rep_top_id,rep_top_org,rev_no,rep_top_name,def_top_id,deleted,edit_refer_status,rep_sheet_count,finish_output,use_input_history,xml_data,background_image_file)
          VALUES(807,807,1,'Approval report',100,0,2,3,0,2,$1,$2)`,
            [xml, Buffer.from(await pdf.save())],
          );
          await client.query(`INSERT INTO rep_current(rep_top_id,rep_top_org) VALUES(807,807);
          INSERT INTO rep_role(rep_top_id,group_id,role_rep_read,role_rep_update) VALUES(807,10,1,1),(807,20,1,0);
          INSERT INTO rep_sheet(rep_sheet_id,rep_top_id,rep_sheet_no,rep_sheet_name) VALUES(8071,807,1,'Approval sheet'),(8073,807,3,'Carbon sheet');
          INSERT INTO rep_cluster(rep_sheet_id,cluster_id,cluster_type,cluster_name,input_parameter,input_value,display_value,applicant,applicant_name,applicant_comment,left_position,top_position,right_position,bottom_position)
          VALUES(8071,1,'Approve','Primary','Required=true','2','2','applicant','Original applicant','Retained applicant',.1,.1,.9,.3),
            (8073,1,'Approve','Carbon','','2','2','applicant','Original applicant','Retained applicant',.1,.1,.9,.3),
            (8073,2,'Text','Required','Required=true','ready','ready',NULL,NULL,NULL,.1,.5,.9,.8);`);
          await client.query('UPDATE mst_user SET approval_sign=$1 WHERE user_id=$2', [
            png.toString('base64'),
            'fixture',
          ]);
          const input = {
            'rep_top.rep_top_id': '807',
            approveRepSheetId: '8071',
            approveClusterId: '1',
            approveEditStatus: '3',
            approveComment: '<safe>\r\ncomment',
          };
          const snapshot = async () => ({
            top: (await client.query('SELECT * FROM rep_top WHERE rep_top_id=807')).rows[0],
            sheets: (await client.query('SELECT * FROM rep_sheet WHERE rep_top_id=807 ORDER BY rep_sheet_id')).rows,
            clusters: (
              await client.query(
                'SELECT * FROM rep_cluster WHERE rep_sheet_id IN (8071,8073) ORDER BY rep_sheet_id,cluster_id',
              )
            ).rows,
            history: (
              await client.query(
                'SELECT * FROM history_rep_cluster WHERE rep_sheet_id IN (8071,8073) ORDER BY history_id',
              )
            ).rows,
          });
          const before = await snapshot();
          try {
            const shell = await (await get('/InputReport/Details?repTopId=807', false)).text();
            assert.match(shell, /id="GetIdentificationRequiredForm"/);
            const form = await (await get('/InputReport/DetailsTop?repTopId=807')).text();
            assert.match(form, /id="approveForm" method="post"/);
            assert.match(form, /approveAction\('4', 8071, 1, 0\)/);
            assert.match(form, /id="approveComment_8071_1"/);
            assert.equal((await post('/InputReport/DetailsTop', input, 'bad')).status, 403);
            assert.equal((await post('/InputReport/DetailsTop', { ...input, approveEditStatus: '4' })).status, 400);
            actor = 'reader';
            assert.equal((await post('/InputReport/DetailsTop', input)).status, 403);
            assert.doesNotMatch(
              await (await get('/InputReport/DetailsTop?repTopId=807')).text(),
              /class="image-approve-btn"/,
            );
            actor = 'fixture';
            await client.query('UPDATE mst_group SET role_rep_update_manager=0 WHERE group_id=10');
            assert.equal((await post('/InputReport/DetailsTop', input)).status, 403);
            await client.query('UPDATE mst_group SET role_rep_update_manager=1 WHERE group_id=10');
            await client.query('INSERT INTO rep_cluster_role(rep_sheet_id,cluster_id,group_id) VALUES(8071,1,30)');
            assert.equal((await post('/InputReport/DetailsTop', input)).status, 403);
            await client.query('DELETE FROM rep_cluster_role WHERE rep_sheet_id=8071 AND cluster_id=1');
            await client.query("INSERT INTO rep_lock(rep_top_id,user_id) VALUES(807,'other')");
            assert.equal((await post('/InputReport/DetailsTop', input)).status, 403);
            await client.query('DELETE FROM rep_lock WHERE rep_top_id=807');
            assert.equal((await post('/InputReport/DetailsTop', { ...input, approveRepSheetId: '8061' })).status, 403);
            assert.equal((await post('/InputReport/DetailsTop', { ...input, approveEditStatus: '9' })).status, 400);
            assert.deepEqual(await snapshot(), before);
            const network = xml.replace('</top>', '<networks><network/></networks></top>');
            await client.query('UPDATE rep_top SET xml_data=$1 WHERE rep_top_id=807', [network]);
            assert.equal((await post('/InputReport/DetailsTop', input)).status, 501);
            await client.query('UPDATE rep_top SET xml_data=$1 WHERE rep_top_id=807', [xml]);
            const failing = {
              ...db,
              connect: async () => ({
                query: async (sql: string, values?: unknown[]) => {
                  if (sql.startsWith('UPDATE rep_top SET thumbnail_file'))
                    throw new Error('Private approval preview failure');
                  return client.query(sql, values);
                },
                release() {},
              }),
            } as unknown as pg.Pool;
            await assert.rejects(
              documentApprove(failing, 807, 8071, 1, '3', input.approveComment, 'fixture', 'en-US'),
              /Private approval preview failure/,
            );
            assert.deepEqual(await snapshot(), before);
            const rejected = await post('/InputReport/DetailsTop', input);
            assert.equal(rejected.status, 302);
            const remand = await snapshot();
            assert.equal(Number(remand.top.edit_refer_status), 3);
            assert.equal(remand.top.rep_top_name, '3');
            for (const row of remand.clusters.filter((row) => row.cluster_type === 'Approve')) {
              assert.equal(row.input_value, '3');
              assert.equal(row.approver, 'fixture');
              assert.equal(row.approver_comment, input.approveComment);
              assert.equal(row.applicant_comment, 'Retained applicant');
              assert.equal(row.approval_sign, null);
            }
            assert(remand.history.some((row) => row.input_value === '3'));
            assert(Buffer.isBuffer(remand.top.thumbnail_file));
            await client.query('UPDATE rep_top SET xml_data=$1,edit_refer_status=2 WHERE rep_top_id=807', [xml]);
            await client.query(
              "UPDATE rep_cluster SET input_value='2',display_value='2' WHERE rep_sheet_id IN (8071,8073) AND cluster_type='Approve'",
            );
            const identity = (await (
              await post('/InputReport/GetIdentificationRequired', { repTopIds: '807' })
            ).json()) as { state: string };
            assert(identity.state);
            assert.equal(
              (
                await post('/InputReport/DetailsTop', {
                  ...input,
                  approveEditStatus: '4',
                  approveIdentificationState: 'bad',
                })
              ).status,
              400,
            );
            const approved = await post('/InputReport/DetailsTop', {
              ...input,
              approveEditStatus: '4',
              approveIdentificationState: identity.state,
            });
            assert.equal(approved.status, 302);
            const complete = await snapshot();
            assert.equal(Number(complete.top.edit_refer_status), 4);
            assert.equal(complete.top.rep_top_name, '4');
            assert.match(complete.top.xml_data, /<editStatus>4<\/editStatus>/);
            assert.match(complete.top.xml_data, /<copyDisable>1<\/copyDisable>/);
            assert.match(complete.top.xml_data, /<approvalSignImage>/);
            for (const row of complete.clusters.filter((row) => row.cluster_type === 'Approve')) {
              assert.equal(row.input_value, '4');
              assert.equal(row.approval_sign, png.toString('base64'));
              assert.equal(row.applicant_comment, 'Retained applicant');
            }
            assert.match(complete.clusters[0].input_parameter, /Locked=1/);
            assert.equal(Number(complete.sheets[0].copy_disable), 1);
            assert.equal(
              (
                await post('/InputReport/DetailsTop', {
                  ...input,
                  approveEditStatus: '4',
                  approveIdentificationState: identity.state,
                })
              ).status,
              400,
            );
            assert.deepEqual(await snapshot(), complete);
            const details = await (await get('/InputReport/DetailsTop?repTopId=807')).text();
            assert.match(details, /&lt;safe&gt;/);
            assert.doesNotMatch(details, /<safe>|class="image-approve-btn"/);
          } finally {
            actor = 'fixture';
            await client.query('UPDATE mst_user SET approval_sign=NULL WHERE user_id=$1', ['fixture']);
          }
        },
      );
      await t.test(
        'Basic copy creates a new editable revision with original inputs, approval/binary data, permissions and libraries, or rolls back the entire revision',
        async () => {
          await client.query(
            'CREATE TEMP SEQUENCE rep_top_rep_top_id_seq START 10000; CREATE TEMP SEQUENCE rep_sheet_rep_sheet_id_seq START 10000; CREATE TEMP SEQUENCE rep_auto_numbering_808_1 START 7;',
          );
          const numbering =
            '<useAutoNumbering>1</useAutoNumbering><autoNumbering><startValue>7</startValue><increment>1</increment><digit>3</digit><zeroPadding>1</zeroPadding><numberingTiming>0</numberingTiming><numberingForReeditFromComplete>0</numberingForReeditFromComplete><useSaveCount>1</useSaveCount><saveCount><digit>2</digit><zeroPadding>1</zeroPadding></saveCount><part><partId>1</partId><type>autoNumber</type><value/></part><part><partId>2</partId><type>saveCount</type><value/></part></autoNumbering>';
          const xml =
            '<conmas><top><repTopId>808</repTopId><defTopId>808</defTopId><repTopName>Retained name</repTopName><editStatus>4</editStatus><publicStatus>2</publicStatus><registUser>original</registUser><registUserName>Original name</registUserName><nameRegenerate>1</nameRegenerate><nameParts><part><partId>1</partId><type>displayValue</type><value>3,1</value></part></nameParts><sheets><sheet><repSheetId>8083</repSheetId><sheetNo>3</sheetNo><clusters><cluster><clusterId>1</clusterId><type>KeyboardText</type><inputParameters>AutoNumber=1</inputParameters><value>Retained input</value><displayValue>Retained display</displayValue></cluster><cluster><clusterId>2</clusterId><type>Approve</type><inputParameters/><value>4</value><displayValue>4</displayValue></cluster></clusters></sheet></sheets></top></conmas>';
          await client.query(`INSERT INTO def_top(def_top_id,def_top_org,auto_numbering_rev_no) VALUES(808,808,1);
          INSERT INTO rep_current(rep_top_id,rep_top_org) VALUES(808,808);
          INSERT INTO rep_role(rep_top_id,group_id,role_rep_read,role_rep_update,role_rep_delete) VALUES(808,10,1,1,1),(808,20,1,0,0);
          INSERT INTO rep_label(rep_top_id,mst_label_id) VALUES(808,999);
          INSERT INTO rep_report_document(rep_top_id,document_id) VALUES(808,101);
          INSERT INTO rep_sheet(rep_sheet_id,rep_top_id,rep_sheet_no,rep_sheet_name,sys_regist_user,sys_regist_time,copy_disable) VALUES(8083,808,3,'Sparse sheet','original','2026-01-01',1);
          INSERT INTO rep_cluster(rep_sheet_id,cluster_id,cluster_type,cluster_name,input_parameter,input_value,display_value,sys_regist_user)
          VALUES(8083,1,'KeyboardText','Text','AutoNumber=1','Retained input','Retained display','original'),(8083,2,'Approve','Approval','','4','4','original');
          INSERT INTO rep_cluster_role(rep_sheet_id,cluster_id,group_id) VALUES(8083,2,10);
          INSERT INTO rep_cluster_refer(rep_sheet_id,cluster_id,group_id) VALUES(8083,1,10);
          INSERT INTO rep_reference(rep_sheet_id,reference_id,rep_top_id,rep_sheet_no,reference_name,reference_type,document_id) VALUES(8083,1,808,3,'Library','PDF',101);`);
          const bytes = Buffer.from('private binary fixture');
          await client.query(
            `INSERT INTO rep_top(rep_top_id,rep_top_org,rev_no,rep_top_name,def_top_id,deleted,public_status,edit_refer_status,rep_sheet_count,xml_data,sys_regist_user,sys_regist_time,background_image_file,thumbnail_file,def_file)
          VALUES(808,808,1,'Retained name',808,0,2,4,1,$1,'original','2026-01-01',$2,$2,$2)`,
            [xml, bytes],
          );
          await client.query(
            `UPDATE rep_cluster SET image_file=$1,binary_file=$1,recording_file=$1,recording_file_extension='m4a',approval_sign='AQID',applicant='applicant',applicant_comment='Original application',approver='approver',approver_comment='Original approval',verified='1',change_reason='retained reason' WHERE rep_sheet_id=8083`,
            [bytes],
          );
          await client.query(
            `INSERT INTO rep_fd_sheet(top_id,fd_sheet_no,sheet_index,pdf_file,irfd_file) VALUES(808,1,1,$1,$1);
        `,
            [bytes],
          );
          await client.query(
            'INSERT INTO rep_layer(rep_sheet_id,layer_id,rep_top_id,rep_sheet_no,image_file,binary_file) VALUES(8083,1,808,3,$1,$1)',
            [bytes],
          );
          await client.query(
            'INSERT INTO rep_cluster_draw(rep_sheet_id,key_id,image_no,image_file) VALUES(8083,1,1,$1)',
            [bytes],
          );
          await client.query(
            'INSERT INTO rep_layer_draw(rep_sheet_id,key_id,image_no,image_file) VALUES(8083,1,1,$1)',
            [bytes],
          );
          const before = (await client.query('SELECT * FROM rep_top WHERE rep_top_id=808')).rows[0];
          const count = async () =>
            Number((await client.query('SELECT count(*) FROM rep_top WHERE rep_top_org=808')).rows[0].count);
          try {
            assert.match(
              await (await get('/InputReport/DetailsTop?repTopId=808')).text(),
              /action="[^"]*CopyTop"[^>]*onsubmit="return copyReport/,
            );
            assert.equal((await post('/InputReport/CopyTop', { repTopId: '808' }, 'bad')).status, 403);
            actor = 'reader';
            assert.equal((await post('/InputReport/CopyTop', { repTopId: '808' })).status, 403);
            actor = 'fixture';
            assert.notEqual((await get('/InputReport/CopyTop?repTopId=808')).status, 200);
            await client.query('UPDATE rep_top SET edit_refer_status=1 WHERE rep_top_id=808');
            assert.equal((await post('/InputReport/CopyTop', { repTopId: '808' })).status, 400);
            await client.query('UPDATE rep_top SET edit_refer_status=4 WHERE rep_top_id=808');
            await client.query("INSERT INTO rep_lock(rep_top_id,user_id) VALUES(808,'other')");
            assert.equal((await post('/InputReport/CopyTop', { repTopId: '808' })).status, 400);
            await client.query('DELETE FROM rep_lock WHERE rep_top_id=808');
            assert.equal(await count(), 1);
            assert.equal((await client.query('SELECT is_called FROM rep_top_rep_top_id_seq')).rows[0].is_called, false);
            const failing = {
              ...db,
              connect: async () => ({
                query: async (sql: string, values?: unknown[]) => {
                  if (sql.startsWith('INSERT INTO rep_cluster_draw')) throw new Error('Private copy failure');
                  return client.query(sql, values);
                },
                release() {},
              }),
            } as unknown as pg.Pool;
            await assert.rejects(documentCopy(failing, 808, 'fixture', 'en-US'), /Private copy failure/);
            assert.equal(await count(), 1);
            assert.equal(
              Number(
                (await client.query('SELECT rep_top_id FROM rep_current WHERE rep_top_org=808')).rows[0].rep_top_id,
              ),
              808,
            );
            const result = await post('/InputReport/CopyTop', { repTopId: '808' });
            assert.equal(result.status, 302);
            const id = Number(result.headers.get('location')?.match(/repTopId=(\d+)/)?.[1]);
            assert(id >= 10000);
            const saved = (await client.query('SELECT * FROM rep_top WHERE rep_top_id=$1', [id])).rows[0];
            assert.equal(Number(saved.rev_no), 2);
            assert.equal(Number(saved.edit_refer_status), 1);
            assert.equal(saved.rep_top_name, 'Retained display');
            assert.equal(saved.sys_regist_user, 'original');
            assert.equal(saved.sys_update_user, 'fixture');
            assert.deepEqual(saved.sys_regist_time, before.sys_regist_time);
            assert.deepEqual(saved.background_image_file, bytes);
            assert.deepEqual(saved.def_file, bytes);
            assert.match(saved.xml_data, new RegExp('<repTopId>' + id + '</repTopId>'));
            assert.match(saved.xml_data, /<registUser>fixture<\/registUser>/);
            const sheet = (await client.query('SELECT * FROM rep_sheet WHERE rep_top_id=$1', [id])).rows[0];
            assert.equal(Number(sheet.rep_sheet_no), 3);
            assert.equal(sheet.sys_regist_user, 'original');
            assert.equal(Number(sheet.copy_disable), 1);
            const clusters = (
              await client.query('SELECT * FROM rep_cluster WHERE rep_sheet_id=$1 ORDER BY cluster_id', [
                sheet.rep_sheet_id,
              ])
            ).rows;
            for (const row of clusters) {
              assert.deepEqual(row.image_file, bytes);
              assert.deepEqual(row.recording_file, bytes);
              assert.equal(row.approval_sign, 'AQID');
              assert.equal(row.applicant_comment, 'Original application');
              assert.equal(row.approver_comment, 'Original approval');
              assert.equal(row.sys_regist_user, 'fixture');
            }
            assert.equal(clusters[0].input_value, 'Retained input');
            assert.equal(clusters[1].input_value, '4');
            for (const table of ['rep_role', 'rep_label', 'rep_report_document'])
              assert((await client.query(`SELECT 1 FROM ${table} WHERE rep_top_id=$1`, [id])).rowCount);
            for (const table of [
              'rep_layer',
              'rep_reference',
              'rep_layer_draw',
              'rep_cluster_draw',
              'rep_cluster_role',
              'rep_cluster_refer',
            ])
              assert.equal(
                (await client.query(`SELECT 1 FROM ${table} WHERE rep_sheet_id=$1`, [sheet.rep_sheet_id])).rowCount,
                1,
              );
            assert.deepEqual(
              (await client.query('SELECT irfd_file FROM rep_fd_sheet WHERE top_id=$1', [id])).rows[0].irfd_file,
              bytes,
            );
            assert.deepEqual((await client.query('SELECT * FROM rep_top WHERE rep_top_id=808')).rows[0], before);
            assert.equal(
              Number(
                (await client.query('SELECT rep_top_id FROM rep_current WHERE rep_top_org=808')).rows[0].rep_top_id,
              ),
              id,
            );
            // Re-copying a historical revision allocates the next revision, never overwrites the current one.
            await client.query(
              'INSERT INTO rep_top(rep_top_id,rep_top_org,rev_no,public_status,deleted) VALUES(809,808,NULL,0,1)',
            );
            const numberedXml = xml.replace('<sheets>', numbering + '<sheets>');
            await client.query(
              "UPDATE rep_top SET xml_data=$1,auto_numbering_value='OLD{SAVE_COUNT}',auto_numbering_save_count=3 WHERE rep_top_id=808",
              [numberedXml],
            );
            const numbered = await documentCopy(db, 808, 'fixture', 'en-US');
            const numberedTop = (await client.query('SELECT * FROM rep_top WHERE rep_top_id=$1', [numbered])).rows[0];
            assert.equal(Number(numberedTop.rev_no), 3);
            assert.equal(numberedTop.auto_numbering_value, '007{SAVE_COUNT}');
            assert.equal(Number(numberedTop.auto_numbering_save_count), 1);
            assert.equal(numberedTop.rep_top_name, '00701');
            for (const [rule, value, count] of [
              [
                numberedXml.replace('<numberingForReeditFromComplete>0', '<numberingForReeditFromComplete>1'),
                'OLD{SAVE_COUNT}',
                4,
              ],
              [numberedXml.replace('<numberingTiming>0', '<numberingTiming>2'), 'OLD{SAVE_COUNT}', 4],
              [
                numberedXml
                  .replace('<numberingTiming>0', '<numberingTiming>1')
                  .replace('<useSaveCount>1', '<useSaveCount>0')
                  .replace(/<part><partId>2<\/partId><type>saveCount<\/type><value\/><\/part>/, ''),
                null,
                null,
              ],
            ] as const) {
              await client.query('UPDATE rep_top SET xml_data=$1 WHERE rep_top_id=808', [rule]);
              const copied = await documentCopy(db, 808, 'fixture', 'en-US');
              const row = (
                await client.query(
                  'SELECT auto_numbering_value,auto_numbering_save_count FROM rep_top WHERE rep_top_id=$1',
                  [copied],
                )
              ).rows[0];
              assert.equal(row.auto_numbering_value, value);
              assert.equal(row.auto_numbering_save_count == null ? null : Number(row.auto_numbering_save_count), count);
            }
            await client.query(
              "INSERT INTO mst_common(com_key,com_name,com_value,com_index) VALUES('ROLE_SETTING','MANAGER_INPUT_REPORT_MANGERROLE_TYPE','1',93)",
            );
            assert.equal((await post('/InputReport/CopyTop', { repTopId: '808' })).status, 403);
            assert.doesNotMatch(
              await (await get('/InputReport/DetailsTop?repTopId=808')).text(),
              /action="[^"]*CopyTop"/,
            );
            await client.query('UPDATE mst_group SET role_rep_super_manager=1 WHERE group_id=10');
            await client.query('UPDATE rep_role SET role_rep_update=0 WHERE rep_top_id=808 AND group_id=10');
            assert.match(await (await get('/InputReport/DetailsTop?repTopId=808')).text(), /action="[^"]*CopyTop"/);
            await documentCopy(db, 808, 'fixture', 'en-US');
            await client.query("DELETE FROM mst_common WHERE com_key='ROLE_SETTING' AND com_index=93");
            await client.query('UPDATE mst_group SET role_rep_super_manager=0 WHERE group_id=10');
            await client.query('UPDATE rep_role SET role_rep_update=1 WHERE rep_top_id=808 AND group_id=10');
            const cooperativeXml = xml
              .replace('<publicStatus>2', '<publicStatus>0')
              .replace('<sheets>', '<cooperationTable>1</cooperationTable><sheets>');
            await client.query('UPDATE rep_top SET xml_data=$1 WHERE rep_top_id=808', [cooperativeXml]);
            await client.query('UPDATE def_top SET xml_data=$1 WHERE def_top_id=808', [cooperativeXml]);
            await client.query(`CREATE TEMP TABLE report_808(rep_top_id int PRIMARY KEY,rep_top_name text,edit_refer_status int,sys_update_user text,cluster_3_1_t text);
              INSERT INTO report_808 VALUES(808,'Retained original',4,'original','Retained cooperation input');
              INSERT INTO mst_report_table(report_file_name,xml_data) VALUES('808.xml','<report/>');`);
            const originalCooperation = (await client.query('SELECT * FROM report_808 WHERE rep_top_id=808')).rows[0];
            const cooperationFailure = {
              ...db,
              connect: async () => ({
                query: async (sql: string, values?: unknown[]) => {
                  if (sql.startsWith('INSERT INTO pg_temp.report_808'))
                    throw new Error('Private cooperation copy failure');
                  return client.query(sql, values);
                },
                release() {},
              }),
            } as unknown as pg.Pool;
            const previousCount = await count(),
              current = (await client.query('SELECT * FROM rep_current WHERE rep_top_org=808')).rows;
            await assert.rejects(
              documentCopy(cooperationFailure, 808, 'fixture', 'en-US'),
              /Private cooperation copy failure/,
            );
            assert.equal(await count(), previousCount);
            assert.deepEqual((await client.query('SELECT * FROM rep_current WHERE rep_top_org=808')).rows, current);
            const cooperativeCopy = await documentCopy(db, 808, 'fixture', 'en-US');
            assert.equal(
              (await client.query('SELECT auto_numbering_value FROM rep_top WHERE rep_top_id=$1', [cooperativeCopy]))
                .rows[0].auto_numbering_value,
              null,
            );
            const cooperativeRow = (
              await client.query('SELECT * FROM report_808 WHERE rep_top_id=$1', [cooperativeCopy])
            ).rows[0];
            assert.equal(cooperativeRow.cluster_3_1_t, 'Retained input');
            assert.equal(Number(cooperativeRow.edit_refer_status), 1);
            assert.equal(cooperativeRow.rep_top_name, 'Retained display');
            assert.deepEqual(
              (await client.query('SELECT * FROM report_808 WHERE rep_top_id=808')).rows[0],
              originalCooperation,
            );
          } finally {
            actor = 'fixture';
            await client.query("DELETE FROM mst_common WHERE com_key='ROLE_SETTING' AND com_index=93");
            await client.query('UPDATE mst_group SET role_rep_super_manager=0 WHERE group_id=10');
          }
        },
      );
      await t.test(
        'Basic DocuWorks download serves only the authorized stored artifact with source UI gates and safe missing-file errors',
        async () => {
          const directory = await mkdtemp('/tmp/opencode/conmas-xdw-'),
            previous = process.env.CONMAS_CLIENT_SETTINGS;
          const path = join(directory, 'interface', 'report', 'DW', 'report');
          const contents = Buffer.from('private generated DocuWorks fixture');
          const download = () => get('/InputReport/DownLoadAction?downloadMode=xdw&repTopId=806');
          try {
            await mkdir(path, { recursive: true });
            await writeFile(join(directory, 'Admin.xml'), '<ConMas><userId>private-xdw-admin</userId></ConMas>');
            process.env.CONMAS_CLIENT_SETTINGS = directory;
            await client.query(
              "INSERT INTO mst_common(com_key,com_name,com_value,com_index) VALUES('OUTPUT_SETTING','BASE_FILE','xdw_fixture',94),('OUTPUT_SETTING','XDW_MANUAL_OUTPUT','true',94)",
            );
            assert.doesNotMatch(await (await get('/InputReport/DetailsTop?repTopId=806')).text(), /class="xdw_link"/);
            const missing = await download();
            assert.equal(missing.status, 400);
            assert.doesNotMatch(await missing.text(), /opencode|806\.xml|ENOENT/);
            const file = join(directory, 'generated.xdw');
            await writeFile(file, contents);
            await writeFile(
              join(path, '806.xml'),
              '<report><variables><pdfpath>' + join(directory, 'generated.pdf') + '</pdfpath></variables></report>',
            );
            const form = await (await get('/InputReport/DetailsTop?repTopId=806')).text();
            assert.match(form, /class="xdw_link"[^>]*downloadMode=xdw/);
            const result = await download();
            assert.equal(result.status, 200);
            assert.match(result.headers.get('content-type') ?? '', /application\/vnd\.fujixerox\.docuworks/);
            assert.match(result.headers.get('content-disposition') ?? '', /xdw_fixture\.xdw/);
            assert.deepEqual(Buffer.from(await result.arrayBuffer()), contents);
            actor = 'other';
            assert.equal((await download()).status, 403);
            actor = 'fixture';
            await client.query(
              "UPDATE mst_common SET com_value='false' WHERE com_key='OUTPUT_SETTING' AND com_name='XDW_MANUAL_OUTPUT' AND com_index=94",
            );
            assert.doesNotMatch(await (await get('/InputReport/DetailsTop?repTopId=806')).text(), /class="xdw_link"/);
            // The source setting controls visibility; authorized direct downloads still serve an existing artifact.
            assert.equal((await download()).status, 200);
            await writeFile(
              join(path, '806.xml'),
              '<report><variables><pdfpath>relative.pdf</pdfpath></variables></report>',
            );
            assert.equal((await download()).status, 400);
            await writeFile(
              join(path, '806.xml'),
              '<report><variables><pdfpath>' + file + '.txt</pdfpath></variables></report>',
            );
            assert.equal((await download()).status, 400);
            assert.deepEqual(await readFile(file), contents);
          } finally {
            actor = 'fixture';
            if (previous === undefined) delete process.env.CONMAS_CLIENT_SETTINGS;
            else process.env.CONMAS_CLIENT_SETTINGS = previous;
            await client.query("DELETE FROM mst_common WHERE com_key='OUTPUT_SETTING' AND com_index=94");
            await rm(directory, { recursive: true, force: true });
          }
        },
      );
      await t.test(
        'Basic source radio controls preserve disabled detail state and voice-input boolean/ID/retry contracts',
        async () => {
          const html = await (await get('/InputReport/EditTop?repTopId=1')).text();
          for (const name of [
            'output_setting',
            'edit_output_setting',
            'PdfAutoOutputSheetSelect',
            'no_need_to_fill_type',
            'no_need_to_fill_out_mode',
            'IsReportCopy',
            'reportCopyType',
            'CalculateMode',
            'IndexType',
            'UseVoiceInputEndTime',
            'NetworkAnswerbackMode',
          ]) {
            assert.match(html, new RegExp('type="radio"[^>]*name="rep_top\\.' + name + '"'));
            assert.doesNotMatch(html, new RegExp('<select[^>]*name="rep_top\\.' + name + '"'));
          }
          assert.match(html, /id="VoiceInputEndTime" name="rep_top.VoiceInputEndTime"/);
          assert.match(html, /setDefaultValue\(&#39;#VoiceInputEndTime&#39;, 650\)/);
          const input = {
            'rep_top.rep_top_id': '1',
            'rep_top.UseVoiceInputEndTime': 'true',
            'rep_top.VoiceInputEndTime': '9',
          };
          const retry = await post('/InputReport/EditTop', input);
          assert.equal(retry.status, 400);
          const retryHtml = await retry.text();
          assert.match(retryHtml, /name="rep_top.UseVoiceInputEndTime" value="true" checked/);
          assert.match(retryHtml, /id="VoiceInputEndTime"[^>]*value="9"/);
          const details = await (await get('/InputReport/DetailsTop?repTopId=1')).text();
          assert.match(details, /name="rep_top.output_setting"[^>]*disabled/);
          await client.query(
            "INSERT INTO mst_common(com_key,com_name,com_value,com_index) VALUES('CUSTOM_GRID','REP_REPORT','<custom-report-label>',95)",
          );
          try {
            const custom = await (await get('/InputReport/DetailsTop?repTopId=1')).text();
            assert.match(custom, /&lt;custom-report-label&gt;/);
            assert.doesNotMatch(custom, /<custom-report-label>/);
          } finally {
            await client.query("DELETE FROM mst_common WHERE com_key='CUSTOM_GRID' AND com_index=95");
          }
        },
      );
      await t.test('detail delete/restore/unlock preserve CSRF, permissions, locks, data and rollback', async () => {
        actor = 'fixture';
        await client.query('UPDATE mst_group SET role_rep_delete_manager=1 WHERE group_id=10');
        await client.query(
          `INSERT INTO rep_top(rep_top_id,rep_top_org,rev_no,rep_top_name,def_top_id,deleted,edit_refer_status,workflow_lock,xml_data)
          VALUES (901,901,1,'First revision',100,0,1,0,$1),(902,901,2,'Current revision',100,0,1,0,$1),
          (903,903,1,'Trash',100,1,1,0,$1),(904,904,1,'Workflow',100,0,1,1,$1),
          (905,905,1,'Unlock target',100,0,1,0,$1)`,
          ['<conmas><top><retained>private fixture</retained></top></conmas>'],
        );
        await client.query(`INSERT INTO rep_current(rep_top_org,rep_top_id) VALUES (901,902),(903,903),(904,904),(905,905);
          INSERT INTO rep_role(rep_top_id,group_id,role_rep_read,role_rep_update,role_rep_delete)
          SELECT rep_top_id,10,1,1,1 FROM rep_top WHERE rep_top_id BETWEEN 901 AND 905;
          INSERT INTO rep_role(rep_top_id,group_id,role_rep_read,role_rep_update,role_rep_delete)
          SELECT rep_top_id,20,1,0,0 FROM rep_top WHERE rep_top_id BETWEEN 901 AND 905;
          INSERT INTO rep_lock(rep_top_id,user_id) VALUES (901,'fixture'),(902,'other'),(903,'other'),(904,'other'),(905,'other')`);
        const row = async (id: number) =>
          (await client.query('SELECT * FROM rep_top WHERE rep_top_id=$1', [id])).rows[0];
        const lockIds = async () =>
          (await client.query('SELECT rep_top_id FROM rep_lock WHERE rep_top_id>=901 ORDER BY rep_top_id')).rows.map(
            (row) => row.rep_top_id,
          );
        const original = await row(905),
          unrelated = await saved();
        const locked = await get('/InputReport/DetailsTop?repTopId=905');
        assert.equal(locked.status, 200);
        assert.match(await locked.text(), /class="img_locked"[^>]*aria-label="Unlock"/);
        assert.equal((await post('/InputReport/UnLock', { 'rep_top.rep_top_id': '905' }, 'bad')).status, 403);
        actor = 'reader';
        assert.equal((await post('/InputReport/UnLock', { 'rep_top.rep_top_id': '905' })).status, 403);
        assert.equal((await post('/InputReport/Delete', { 'rep_top.rep_top_id': '901', actMode: 'REV' })).status, 403);
        actor = 'fixture';
        await client.query('UPDATE rep_role SET role_rep_update=0 WHERE rep_top_id=905 AND group_id=10');
        assert.equal((await post('/InputReport/UnLock', { 'rep_top.rep_top_id': '905' })).status, 403);
        await client.query('UPDATE rep_role SET role_rep_update=1 WHERE rep_top_id=905 AND group_id=10');
        assert.equal((await post('/InputReport/UnLock', { 'rep_top.rep_top_id': '904' })).status, 403);
        assert.equal((await post('/InputReport/UnLock', { 'rep_top.rep_top_id': '903' })).status, 403);
        assert.equal((await get('/InputReport/UnLock?repTopId=905')).status, 501);
        assert.equal((await get('/InputReport/Delete?repTopId=901')).status, 501);
        const failing = {
          connect: async () => ({
            query: async (sql: string, values?: unknown[]) => {
              if (sql === 'DELETE FROM rep_lock WHERE rep_top_id=$1') throw new Error('Private unlock failure');
              return client.query(sql, values);
            },
            release() {},
          }),
        } as unknown as pg.Pool;
        await assert.rejects(documentUnlock(failing, 905, 'fixture'));
        assert.deepEqual(await lockIds(), [901, 902, 903, 904, 905]);
        const unlocked = await post('/InputReport/UnLock', { 'rep_top.rep_top_id': '905' });
        assert.equal(unlocked.headers.get('location'), '/ConMasManager/InputReport/Details?repTopId=905');
        assert.deepEqual(await row(905), original);
        assert.deepEqual(await lockIds(), [901, 902, 903, 904]);
        assert.equal(
          (await post('/InputReport/Delete', { 'rep_top.rep_top_id': '901', actMode: 'bogus' })).status,
          400,
        );
        assert.equal(
          (await post('/InputReport/Delete', { 'rep_top.rep_top_id': '901', actMode: 'REV' }, 'bad')).status,
          403,
        );
        await client.query('UPDATE rep_role SET role_rep_delete=0 WHERE rep_top_id=901 AND group_id=10');
        assert.equal((await post('/InputReport/Delete', { 'rep_top.rep_top_id': '901', actMode: 'REV' })).status, 403);
        await client.query('UPDATE rep_role SET role_rep_delete=1 WHERE rep_top_id=901 AND group_id=10');
        const conflict = await row(902);
        assert.equal(
          (await post('/InputReport/Delete', { 'rep_top.rep_top_id': '902', actMode: 'ALL' })).headers.get('location'),
          '/ConMasManager/InputReport/Details?repTopId=902',
        );
        assert.deepEqual(await row(902), conflict);
        const deleted = await post('/InputReport/Delete', { 'rep_top.rep_top_id': '901', actMode: 'REV' });
        assert.equal(deleted.headers.get('location'), '/ConMasManager/InputReport');
        assert.equal(Number((await row(901)).deleted), 1);
        assert.deepEqual(await row(902), conflict);
        assert.equal(
          (await client.query('SELECT rep_top_id FROM rep_current WHERE rep_top_org=901')).rows[0].rep_top_id,
          902,
        );
        const restored = await post('/InputReport/Delete', { 'rep_top.rep_top_id': '903', actMode: 'REVIVAL' });
        assert.equal(restored.headers.get('location'), '/ConMasManager/InputReport/Details?repTopId=903');
        assert.equal(Number((await row(903)).deleted), 0);
        assert.deepEqual(await lockIds(), [902, 904]);
        await post('/InputReport/UnLock', { 'rep_top.rep_top_id': '902' });
        await post('/InputReport/Delete', { 'rep_top.rep_top_id': '902', actMode: 'ALL' });
        assert.equal(Number((await row(901)).deleted), 1);
        assert.equal(Number((await row(902)).deleted), 1);
        assert.deepEqual(await saved(), unrelated);
        assert.deepEqual(await row(905), original);
      });
    } finally {
      if (server)
        await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
      client.release();
      await pool.end();
    }
  },
);
