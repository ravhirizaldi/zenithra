import 'dotenv/config';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
            { IsComplete: 'true' },
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
        'applicant lock follows system enablement and deregulation without an administrator bypass',
        async () => {
          await client.query(
            "UPDATE rep_top SET use_applicant_lock=1 WHERE rep_top_id=1; INSERT INTO mst_common(com_key,com_name,com_value,com_index) VALUES ('IPAD_SETTING','USE_APPLICANT_LOCK','1',20),('IPAD_SETTING','APPLICANT_LOCK_TYPE','0',21)",
          );
          assert.equal(await documentApplicantLocked(db, 1, 'fixture'), true);
          assert.equal(await documentApplicantLocked(db, 1, 'other'), false);
          await client.query(
            "UPDATE mst_common SET com_value='1' WHERE com_name='APPLICANT_LOCK_TYPE'; UPDATE rep_cluster SET applicant='fixture' WHERE cluster_id=4",
          );
          assert.equal(await documentApplicantLocked(db, 1, 'fixture'), false);
          await client.query("UPDATE rep_cluster SET applicant='other' WHERE cluster_id=4");
          assert.equal(await documentApplicantLocked(db, 1, 'fixture'), true);
          await client.query('UPDATE rep_top SET edit_refer_status=4 WHERE rep_top_id=1');
          assert.equal(await documentApplicantLocked(db, 1, 'fixture'), false);
          await client.query('UPDATE rep_top SET edit_refer_status=1,use_applicant_lock=0 WHERE rep_top_id=1');
        },
      );
      await t.test(
        'sheet metadata commits relational/XML values together only when all required effects are supported',
        async () => {
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
          await client.query('UPDATE rep_top SET use_input_history=1 WHERE rep_top_id=1');
          await assert.rejects(documentSaveSheetMetadata(db, 1, 0, input, 'fixture'), /history/);
          await client.query('UPDATE rep_top SET use_input_history=0 WHERE rep_top_id=1');
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
              501,
            );
            assert.deepEqual(await saved(), before);
            assert.deepEqual((await client.query('SELECT * FROM rep_sheet WHERE rep_sheet_id=11')).rows[0], sheet);
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
