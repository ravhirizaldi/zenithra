import 'dotenv/config';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { Script } from 'node:vm';
import { test } from 'node:test';
import express from 'express';
import session from 'express-session';
import pg from 'pg';
import { registerSystemMiddleware } from '../../../../src/middleware/manager/system.js';
import { registerDocumentController } from '../../../../src/controllers/manager/documents/index.js';
import { createPageRenderer } from '../../../../src/services/manager/page.js';
import { documentDetailScript, documentViewSource } from '../../../../src/services/manager/documents.js';
import {
  documentDetailSheets,
  documentSaveLabelChanges,
  documentSaveRoleChanges,
} from '../../../../src/models/manager/documents/details.js';

test('Documents detail and shared-editor EJS scripts retain the original functions with resolved values', async () => {
  for (const view of ['Details', 'DetailsLabel', 'DetailsRole', 'EditLabel', 'EditRole'] as const) {
    const script = await documentDetailScript(view, 123);
    assert.doesNotMatch(script, /@(?:Model|IR|Html)|__COPY_ERROR__|__REP_ID__/);
    assert.doesNotThrow(() => new Script(script), view);
  }
  const script = await documentDetailScript('Details', 123, true);
  assert.match(script, /localStorage\.setItem\('selectedRepTopId', 123\)/);
  assert.match(script, /if \('TRUE' == 'TRUE'\)/);
  assert.match(script, /conmasRepLabelFunction|conmasRoleFunction/);
  const source = await documentViewSource();
  for (const view of ['details', 'detail-settings', 'edit-labels', 'edit-roles', 'settings-paging']) {
    const template = await readFile(`src/views/manager/documents/${view}.ejs`, 'utf8');
    for (const match of template.matchAll(/\b([rv])\.(\w+)/g))
      assert(Object.hasOwn(source[match[1] as 'r' | 'v'], match[2]), `${view}: ${match[0]}`);
  }
  const values = new Map<string, unknown>([['#ReportMode', 'Rep']]);
  const checks = new Map<string, { checked: boolean }>();
  const submitted: string[] = [];
  const $ = (selector: unknown) => {
    if (typeof selector !== 'string') return;
    return {
      0: checks.get(selector),
      length: selector.includes('input[class=') ? 2 : 1,
      val(value?: unknown) {
        if (arguments.length) values.set(selector, value);
        return values.get(selector);
      },
      trigger(event: string) {
        submitted.push(selector + ':' + event);
      },
    };
  };
  const context = {
    $: Object.assign($, { ajaxSetup: (options: { cache: boolean }) => assert.equal(options.cache, false) }),
  };
  new Script(
    script +
      '\n' +
      (await documentDetailScript('EditRole', 123)) +
      '\n' +
      (await readFile('public/Scripts/conmas.paging.action.js', 'utf8')),
  ).runInNewContext(context);
  new Script("fConMasLabelSubmitAction('EditType',7,true); fConMasPageSave(1);").runInNewContext(context);
  assert.equal(values.get('#ActionCommonType'), 'EditType');
  assert.equal(values.get('#SaveLabelId'), 7);
  assert.equal(values.get('#IsSaveLabelType'), true);
  assert.equal(values.get('#PageIndex'), 1);
  assert.deepEqual(submitted, ['#form0:submit']);
  for (let index = 0; index < 2; index++)
    for (const field of ['read', 'update', 'delete'])
      checks.set(`#conmas_check_role_rep_${field}_${index}`, { checked: field !== 'delete' });
  new Script(
    "fConMasGrouphorizontalAllEditFlgON(0); fConMasGroupVerticalAllEditFlgON('roles_role_rep_read_check','rep_read'); fConMasGroupAllEditFlgON(); fConMasPageAction(1,'PageType');",
  ).runInNewContext(context);
  for (let index = 0; index < 2; index++) {
    assert.equal(values.get(`#RolePages_${index}__EditFlg`), '1');
    assert.equal(values.get(`#RolePages_${index}__role_rep_read`), true);
    assert.equal(values.get(`#RolePages_${index}__role_rep_update`), true);
    assert.equal(values.get(`#RolePages_${index}__role_rep_delete`), false);
  }
  assert.equal(values.get('#PageData_PageIndex'), 1);
  assert.equal(values.get('#ActionCommonType'), 'PageType');
  assert.equal(submitted.at(-1), '#conmasPageForm:submit');
});

test(
  'Documents details, label drafts and report permission drafts use only private fixtures',
  { skip: !process.env.DATABASE_URL },
  async (t) => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }),
      client = await pool.connect();
    let server: Server | undefined;
    try {
      for (const table of [
        'mst_common',
        'mst_user',
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
        'rep_label_role',
        'rep_label',
        'def_external_output',
      ])
        await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
      await client.query(`SET search_path TO pg_temp;
      INSERT INTO mst_common(com_key,com_name,com_value,com_index) VALUES
        ('DEFAULT_PAGE_SIZE','DEFAULT','1',1),('PAGE_SIZE','1','1',2),('PAGE_SIZE','2','2',3),('LABEL_SETTING','SORT_TYPE','0',4),('WEBHOOK','WEBHOOK_VALID_ENABLE','1',5);
      INSERT INTO mst_group(group_id,group_name_path,role_rep_read_manager,role_rep_update_manager) VALUES
        (-999,'Administrator',1,1),(-1000,'Reserved',1,1),(10,'A fixture editor',1,1),(20,'B fixture reader',1,0),(30,'C other group',1,1);
      INSERT INTO mst_group_affiation(group_id,user_id) VALUES (10,'fixture'),(20,'reader'),(30,'other');
      INSERT INTO mst_user(user_id,user_name) VALUES ('fixture','Fixture editor'),('other','Other fixture'),('reader','Fixture reader');
      INSERT INTO rep_top(rep_top_id,rep_top_org,rev_no,rep_top_name,def_top_id,deleted,use_init_input_judge,xml_data,sys_regist_time,sys_update_time) VALUES
        (1,1,2,'<Fixture report>',100,0,1,'<fixture/>','2026-01-01','2026-01-02'),(2,1,1,'Historical fixture',100,0,0,'<history/>','2026-01-01','2026-01-02'),
        (3,3,1,'Inaccessible fixture',100,0,0,'<private/>','2026-01-01','2026-01-02'),(4,4,1,'Update-only fixture',100,0,0,'<update/>','2026-01-01','2026-01-02');
      INSERT INTO rep_current(rep_top_org,rep_top_id) VALUES (1,1),(3,3),(4,4);
      INSERT INTO rep_role(rep_top_id,group_id,role_rep_read,role_rep_update,role_rep_delete) VALUES
        (1,10,1,1,0),(1,20,1,0,0),(2,10,1,1,0),(3,30,1,1,1),(4,10,0,1,0);
      INSERT INTO def_role(def_top_id,group_id,role_def_update) VALUES (100,10,1);
      INSERT INTO rep_sheet(rep_sheet_id,rep_top_id,rep_sheet_no,rep_sheet_name) VALUES (11,1,1,'First'),(12,1,3,''),(31,3,1,'Hidden');
      INSERT INTO rep_fd_sheet(top_id,fd_sheet_no,sheet_index) VALUES (1,1,2),(1,2,99),(1,3,0);
      INSERT INTO def_external_output(def_top_id,enabled_system_types) VALUES (100,3);
      INSERT INTO mst_label_rep(mst_label_id,label_name,label_name_path,label_id_path,label_icon_id,diplay_number,binder_rep_id,auto_creation,auto_label_name) VALUES
        (1,'A label','A label','1',1,1,NULL,0,''),(2,'B label','B label','2',2,2,NULL,0,''),
        (3,'C label','C label','3',3,3,NULL,0,''),(4,'Hidden label','Hidden label','4',4,4,NULL,0,''),
        (5,'Binder label','Binder label','5',5,5,123,0,''),(6,'Automatic','Automatic','6',6,6,NULL,1,'{USER}'),
        (7,'Generated','Generated','7',7,7,NULL,2,'{USER}');
      INSERT INTO rep_label_role(mst_label_id,group_id) VALUES (4,30);
      INSERT INTO rep_label(rep_top_id,mst_label_id,sys_regist_user,sys_regist_time) VALUES (1,1,'original','2026-01-01'),(1,5,'original','2026-01-01'),(1,6,'original','2026-01-01'),(3,1,'other','2026-01-01');`);
      const db = {
        query: client.query.bind(client),
        connect: async () => ({ query: client.query.bind(client), release() {} }),
      } as unknown as pg.Pool;
      let actor: string | undefined = 'fixture';
      const app = express();
      app.set('views', 'src/views');
      app.set('view engine', 'ejs');
      app.use(express.urlencoded({ extended: false }));
      app.use(session({ secret: 'documents-detail-fixture', resave: false, saveUninitialized: true }));
      app.use((req, _res, next) => {
        req.session.userId = actor;
        req.session.userName = 'Fixture';
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
      const post = (path: string, body: Record<string, string>, csrf = token) =>
        fetch(origin + path, {
          method: 'POST',
          headers: { cookie, 'X-Requested-With': 'XMLHttpRequest' },
          body: new URLSearchParams({ __RequestVerificationToken: csrf, ...body }),
          redirect: 'manual',
        });
      const labelPost = (body: Record<string, string>, csrf = token) =>
        post('/DefReport/EditLabel', { mode: 'Rep', def_top_id: '1', ...body }, csrf);
      const rolePost = (body: Record<string, string>, csrf = token) =>
        post('/DefReport/EditRole', { ReportMode: 'Rep', defTopId: '1', ...body }, csrf);
      const topBefore = (
        await client.query(
          'SELECT rep_top_id,xml_data,sys_regist_time,sys_update_time FROM rep_top ORDER BY rep_top_id',
        )
      ).rows;

      await t.test(
        'main detail keeps original navigation, sheet indexes, escaped content and blocked neighboring Forms modes',
        async () => {
          const response = await get('/InputReport/Details?repTopId=1', false);
          assert.equal(response.status, 200);
          const html = await response.text();
          token = html.match(/name="__RequestVerificationToken" value="([^"]+)"/)![1];
          assert.match(html, /conmasRepLabelFunction|conmasRoleFunction/);
          assert.match(html, /DetailsSheet\?repTopId=1&amp;pageIndex=0/);
          assert.match(html, /DetailsSheet\?repTopId=1&amp;pageIndex=1/);
          assert.match(html, /DetailsFdSheet\?repTopId=1&amp;fdSheetNo=1/);
          assert(html.indexOf('1:First') < html.indexOf('1:i-Repo FreeDraw'));
          assert.doesNotMatch(html, /3:i-Repo FreeDraw/);
          assert.match(html, /conmasWebhookFunction|conmasLogGoogleFunction|conmasLogBoxFunction/);
          assert.doesNotMatch(html, /id="conmasLogBim360Function"|id="\d+conmasDirectChatFunction"/);
          assert.match(html, /InputReport\?act=BACK_INDEX/);
          assert.match(html, /isInitJudgeDisplay=true/);
          assert.equal((await get('/InputReport/Details?repTopId=3', false)).status, 403);
          assert.equal((await get('/InputReport/Details?repTopId=4', false)).status, 200);
          assert.equal((await get('/InputReport/Details?repTopId=1;DROP', false)).status, 400);
          assert.equal((await get('/InputReport/Details?repTopId=1&backController=..', false)).status, 400);
          const back = await (
            await get(
              '/InputReport/Details?repTopId=1&backController=Library&backAction=Index&backRequestParam=mode%3DComLIb',
              false,
            )
          ).text();
          assert.match(back, /href="\/ConMasManager\/Library\?mode=ComLIb"/);
          const selected = await (
            await get('/InputReport/Details?repTopId=1&initDetailsFunction=conmasRepLabelFunction', false)
          ).text();
          assert.match(selected, /id="initDetailsFunction" value="conmasRepLabelFunction"/);
          for (const path of [
            '/DefReport',
            '/DefReport/Index',
            '/DefReport/EditLabel?defTopId=1&mode=Def',
            '/DefReport/EditRole?defTopId=1&mode=Def',
            '/DefReport/EditLabelOther?mode=Rep',
          ])
            assert.equal((await get(path)).status, 503, path);
          assert.deepEqual(
            (await documentDetailSheets(db, 1)).map((row) => [row.rownum, row.fdSheetNo]),
            [
              [0, 0],
              [-1, 1],
              [1, 0],
              [-1, 2],
            ],
          );
        },
      );
      await t.test(
        'detail label and permission partials retain distinct edit gates and source-owned lock cleanup',
        async () => {
          const labels = await (await get('/InputReport/DetailsLabel?repTopId=1')).text();
          assert.match(labels, /&lt;Fixture report&gt;/);
          assert.doesNotMatch(labels, /<Fixture report>/);
          assert.match(labels, /A label|Binder label/);
          assert.doesNotMatch(labels, /Automatic|Hidden label/);
          assert.match(labels, /DefReport\/EditLabel\?defTopId=1&amp;mode=Rep/);
          await client.query(
            "INSERT INTO rep_lock(rep_top_id,user_id,sys_regist_user,sys_regist_term) VALUES (1,$1,$1,$2),(2,$1,$1,'other-host'),(3,'other','other',$2)",
            ['fixture', hostname()],
          );
          await client.query(
            "INSERT INTO document_lock(document_id,user_id,sys_regist_user,sys_regist_term) VALUES (100,$1,$1,$2),(101,'other','other',$2)",
            ['fixture', hostname()],
          );
          const locked = await (await get('/InputReport/DetailsLabel?repTopId=1')).text();
          assert.match(locked, /user_lock_label/);
          assert.doesNotMatch(locked, /class="img_edit"/);
          const roles = await (await get('/InputReport/DetailsRole?repTopId=1')).text();
          assert.match(roles, /DefReport\/EditRole\?defTopId=1&amp;mode=Rep/);
          assert.doesNotMatch(roles, /user_lock_label|Administrator|Reserved/);
          assert.deepEqual(
            (await client.query('SELECT rep_top_id FROM rep_lock ORDER BY rep_top_id')).rows.map(
              (row) => row.rep_top_id,
            ),
            [2, 3],
          );
          assert.deepEqual(
            (await client.query('SELECT document_id FROM document_lock')).rows.map((row) => row.document_id),
            [101],
          );
          const historical = await (await get('/InputReport/DetailsRole?repTopId=2')).text();
          assert.doesNotMatch(historical, /class="img_edit"/);
          await client.query('DELETE FROM rep_lock WHERE rep_top_id=2');
          assert.match(await (await get('/InputReport/DetailsLabel?repTopId=2')).text(), /class="img_edit"/);
          await client.query('UPDATE def_role SET role_def_update=0 WHERE def_top_id=100');
          assert.doesNotMatch(await (await get('/InputReport/DetailsRole?repTopId=1')).text(), /class="img_edit"/);
          await client.query('UPDATE def_role SET role_def_update=1 WHERE def_top_id=100');
          await client.query("UPDATE rep_top SET workflow_lock=1,sys_update_user='other' WHERE rep_top_id=1");
          assert.match(await (await get('/InputReport/DetailsLabel?repTopId=1')).text(), /Other fixture/);
          await client.query('UPDATE rep_top SET workflow_lock=0 WHERE rep_top_id=1');
          assert.equal(await (await get('/InputReport/DetailsLabel?repTopId=1', false)).text(), '');
          await client.query(
            'INSERT INTO rep_lock(rep_top_id,user_id,sys_regist_user,sys_regist_term) VALUES (1,$1,$1,$2)',
            ['fixture', hostname()],
          );
          await client.query(
            'INSERT INTO document_lock(document_id,user_id,sys_regist_user,sys_regist_term) VALUES (100,$1,$1,$2)',
            ['fixture', hostname()],
          );
          assert.equal(await (await get('/InputReport/DetailsRole?repTopId=1', false)).text(), '');
          assert.equal((await client.query('SELECT 1 FROM rep_lock WHERE rep_top_id=1')).rowCount, 0);
          assert.equal((await client.query('SELECT 1 FROM document_lock WHERE document_id=100')).rowCount, 0);
        },
      );
      await t.test(
        'label search, per-report drafts, cancel, audit refresh and saving preserve unselected links',
        async () => {
          let response = await get('/DefReport/EditLabel?defTopId=1&mode=Rep');
          assert.equal(response.status, 200);
          assert.doesNotMatch(await response.text(), /id="labelsPage_0__Chk"/);
          response = await labelPost({ ActionCommonType: 'SearchType', 'LabelSerach.PageSize': '1' });
          let html = await response.text();
          assert.equal(response.status, 200);
          assert.match(html, /A label/);
          assert.doesNotMatch(html, /B label|Hidden label|Binder label|Automatic/);
          response = await labelPost({
            ActionCommonType: 'EditType',
            SaveLabelId: '2',
            IsSaveLabelType: 'true',
            'LabelSerach.PageSize': '1',
            PageIndex: '1',
          });
          assert.equal(response.status, 200);
          html = await response.text();
          assert.match(html, /id="labelsPage_0__Chk"[^>]*checked/);
          assert.equal(
            (await client.query('SELECT 1 FROM rep_label WHERE rep_top_id=1 AND mst_label_id=2')).rowCount,
            0,
          );
          response = await labelPost({
            ActionCommonType: 'EditType',
            SaveLabelId: '1',
            IsSaveLabelType: 'false',
            'LabelSerach.PageSize': '1',
          });
          assert.equal(response.status, 200);
          response = await labelPost({ ActionCommonType: 'SaveType' }, 'wrong-token');
          assert.equal(response.status, 403);
          response = await labelPost({ ActionCommonType: 'SaveType', def_top_id: '2' });
          assert.equal(response.status, 400);
          response = await labelPost({ ActionCommonType: 'SaveType' });
          assert.equal(response.status, 302);
          assert.equal(response.headers.get('location'), '/ConMasManager/InputReport/DetailsLabel?repTopId=1');
          assert.deepEqual(
            (
              await client.query('SELECT mst_label_id FROM rep_label WHERE rep_top_id=1 ORDER BY mst_label_id')
            ).rows.map((row) => row.mst_label_id),
            [2, 5, 6],
          );
          assert.equal(
            (await client.query('SELECT sys_regist_user FROM rep_label WHERE rep_top_id=1 AND mst_label_id=2')).rows[0]
              .sys_regist_user,
            'fixture',
          );
          assert.equal(
            (await client.query('SELECT sys_regist_user FROM rep_label WHERE rep_top_id=1 AND mst_label_id=5')).rows[0]
              .sys_regist_user,
            'original',
          );
          await get('/DefReport/EditLabel?defTopId=1&mode=Rep');
          response = await labelPost({ ActionCommonType: 'SearchType', 'LabelSerach.LabelName': 'b label' });
          assert.doesNotMatch(await response.text(), /labelsPage_0__Chk/);
          response = await labelPost({ ActionCommonType: 'SearchType', 'LabelSerach.LabelCheckedType': '1' });
          assert.match(await response.text(), /B label/);
          response = await labelPost({ ActionCommonType: 'SearchType', 'LabelSerach.LabelCheckedType': '2' });
          html = await response.text();
          assert.match(html, /A label|C label/);
          assert.doesNotMatch(html, /B label/);
          await labelPost({
            ActionCommonType: 'EditType',
            SaveLabelId: '-1',
            IsSaveLabelType: 'true',
            'LabelSerach.LabelCheckedType': '2',
          });
          response = await labelPost({ isCanceled: 'true' });
          assert.equal(response.status, 302);
          assert.equal(
            (await client.query('SELECT 1 FROM rep_label WHERE rep_top_id=1 AND mst_label_id=1')).rowCount,
            0,
          );
          await get('/DefReport/EditLabel?defTopId=1&mode=Rep');
          assert.equal(
            (await labelPost({ ActionCommonType: 'EditType', SaveLabelId: '5', IsSaveLabelType: 'false' })).status,
            400,
          );
          assert.equal(
            (await labelPost({ ActionCommonType: 'EditType', SaveLabelId: '4', IsSaveLabelType: 'true' })).status,
            400,
          );
        },
      );
      await t.test(
        'label saving rolls back all draft changes and cannot remove inaccessible or binder links',
        async () => {
          const before = (await client.query('SELECT * FROM rep_label ORDER BY rep_top_id,mst_label_id')).rows;
          await assert.rejects(documentSaveLabelChanges(db, 1, { 5: false }, 'fixture'));
          await assert.rejects(documentSaveLabelChanges(db, 1, { 4: true }, 'fixture'));
          await assert.rejects(documentSaveLabelChanges(db, 3, { 2: true }, 'fixture'));
          await client.query('ALTER TABLE rep_label ADD CONSTRAINT fixture_reject_label CHECK(mst_label_id<>3)');
          await assert.rejects(documentSaveLabelChanges(db, 1, { 1: true, 3: true }, 'fixture'));
          assert.deepEqual(
            (await client.query('SELECT * FROM rep_label ORDER BY rep_top_id,mst_label_id')).rows,
            before,
          );
          await client.query('ALTER TABLE rep_label DROP CONSTRAINT fixture_reject_label');
        },
      );
      await t.test(
        'permission drafts survive paging, merge untouched groups, restore administrator role and roll back on failure',
        async () => {
          let response = await get('/DefReport/EditRole?defTopId=1&mode=Rep');
          assert.equal(response.status, 200);
          let html = await response.text();
          assert.match(html, /RolePages\[0\]\.group_id" value="10"/);
          assert.doesNotMatch(html, /Administrator|Reserved/);
          response = await rolePost({
            ActionCommonType: 'PageType',
            'PageData.PageSize': '1',
            'PageData.PageIndex': '1',
            'RolePages[0].group_id': '10',
            'RolePages[0].EditFlg': '1',
            'RolePages[0].role_rep_read': 'true',
            'RolePages[0].role_rep_update': 'true',
            'RolePages[0].role_rep_delete': 'true',
          });
          assert.equal(response.status, 200);
          response = await rolePost({
            ActionCommonType: 'SaveType',
            'RolePages[0].group_id': '20',
            'RolePages[0].EditFlg': '',
            'RolePages[0].role_rep_read': 'false',
          });
          assert.equal(response.status, 302);
          const roles = (
            await client.query(
              'SELECT group_id,role_rep_read,role_rep_update,role_rep_delete,sys_regist_user FROM rep_role WHERE rep_top_id=1 ORDER BY group_id',
            )
          ).rows;
          assert.deepEqual(
            roles.map((row) => [
              row.group_id,
              Number(row.role_rep_read),
              Number(row.role_rep_update),
              Number(row.role_rep_delete),
            ]),
            [
              [-999, 1, 1, 1],
              [10, 1, 1, 1],
              [20, 1, 0, 0],
            ],
          );
          assert.equal(typeof roles[0].sys_regist_user, 'string');
          assert(roles[0].sys_regist_user.length > 0);
          assert.equal(roles[1].sys_regist_user, 'fixture');
          await get('/DefReport/EditRole?defTopId=1&mode=Rep');
          response = await rolePost({ ActionCommonType: 'PageType', 'GroupSearchData.GroupId': '20' });
          html = await response.text();
          assert.match(html, /B fixture reader/);
          assert.doesNotMatch(html, /A fixture editor/);
          response = await rolePost({ ActionCommonType: 'PageType', 'GroupSearchData.GroupName': '%' });
          assert.doesNotMatch(await response.text(), /RolePages\[0\]\.group_id/);
          assert.equal((await rolePost({ ActionCommonType: 'SaveType' }, '')).status, 403);
          assert.equal((await rolePost({ ActionCommonType: 'SaveType', defTopId: '2' })).status, 400);
          assert.equal(
            (
              await rolePost({
                ActionCommonType: 'PageType',
                'RolePages[0].group_id': '-999',
                'RolePages[0].EditFlg': '1',
              })
            ).status,
            400,
          );
          const before = (await client.query('SELECT * FROM rep_role ORDER BY rep_top_id,group_id')).rows;
          await client.query(
            'ALTER TABLE rep_role ADD CONSTRAINT fixture_reject_role CHECK(rep_top_id<>1 OR group_id<>30)',
          );
          await assert.rejects(
            documentSaveRoleChanges(db, 1, { 30: { read: true, update: true, delete: true } }, 'fixture'),
          );
          assert.deepEqual((await client.query('SELECT * FROM rep_role ORDER BY rep_top_id,group_id')).rows, before);
          await client.query('ALTER TABLE rep_role DROP CONSTRAINT fixture_reject_role');
          await assert.rejects(
            documentSaveRoleChanges(db, 1, { 999: { read: true, update: true, delete: true } }, 'fixture'),
          );
          assert.equal((await rolePost({ isCanceled: 'true' })).status, 302);
        },
      );
      await t.test(
        'rejected writes retain complete drafts for retry without leaking database errors or staging partial permissions',
        async () => {
          await get('/DefReport/EditLabel?defTopId=1&mode=Rep');
          await labelPost({ ActionCommonType: 'SearchType', 'LabelSerach.PageSize': '1' });
          await labelPost({
            ActionCommonType: 'EditType',
            SaveLabelId: '-1',
            IsSaveLabelType: 'true',
            'LabelSerach.PageSize': '1',
          });
          await client.query(
            'ALTER TABLE rep_label ADD CONSTRAINT fixture_retry_label CHECK(rep_top_id<>1 OR mst_label_id<>1)',
          );
          const before = (await client.query('SELECT * FROM rep_label ORDER BY rep_top_id,mst_label_id')).rows;
          let response = await labelPost({ ActionCommonType: 'SaveType', 'LabelSerach.PageSize': '1' });
          assert.equal(response.status, 500);
          let html = await response.text();
          assert.match(html, /Server error has occurred/);
          assert.doesNotMatch(html, /fixture_retry_label|23514|check constraint/);
          assert.match(html, /id="labelsPage_0__Chk"[^>]*checked/);
          assert.deepEqual(
            (await client.query('SELECT * FROM rep_label ORDER BY rep_top_id,mst_label_id')).rows,
            before,
          );
          await client.query('ALTER TABLE rep_label DROP CONSTRAINT fixture_retry_label');
          assert.equal((await labelPost({ ActionCommonType: 'SaveType' })).status, 302);
          assert.equal(
            (await client.query('SELECT 1 FROM rep_label WHERE rep_top_id=1 AND mst_label_id=1')).rowCount,
            1,
          );
          assert.equal(
            (await client.query('SELECT 1 FROM rep_label WHERE rep_top_id=1 AND mst_label_id=3')).rowCount,
            0,
          );

          await get('/DefReport/EditRole?defTopId=1&mode=Rep');
          const flags = {
            'RolePages[0].group_id': '30',
            'RolePages[0].EditFlg': '1',
            'RolePages[0].role_rep_read': 'true',
            'RolePages[0].role_rep_update': 'true',
            'RolePages[0].role_rep_delete': 'true',
          };
          response = await rolePost({
            ActionCommonType: 'PageType',
            ...flags,
            'RolePages[1].group_id': '20',
            'RolePages[1].EditFlg': '1',
            'RolePages[1].role_rep_read': 'invalid',
            'RolePages[1].role_rep_update': 'false',
            'RolePages[1].role_rep_delete': 'false',
          });
          assert.equal(response.status, 400);
          response = await rolePost({ ActionCommonType: 'SaveType' });
          assert.equal(response.status, 302);
          assert.equal((await client.query('SELECT 1 FROM rep_role WHERE rep_top_id=1 AND group_id=30')).rowCount, 0);
          await get('/DefReport/EditRole?defTopId=1&mode=Rep');
          await client.query(
            'ALTER TABLE rep_role ADD CONSTRAINT fixture_retry_role CHECK(rep_top_id<>1 OR group_id<>30)',
          );
          const roleBefore = (await client.query('SELECT * FROM rep_role ORDER BY rep_top_id,group_id')).rows;
          response = await rolePost({ ActionCommonType: 'SaveType', ...flags });
          assert.equal(response.status, 500);
          html = await response.text();
          assert.match(html, /Server error has occurred/);
          assert.doesNotMatch(html, /fixture_retry_role|23514|check constraint/);
          assert.deepEqual(
            (await client.query('SELECT * FROM rep_role ORDER BY rep_top_id,group_id')).rows,
            roleBefore,
          );
          await client.query('ALTER TABLE rep_role DROP CONSTRAINT fixture_retry_role');
          assert.equal((await rolePost({ ActionCommonType: 'SaveType' })).status, 302);
          assert.equal((await client.query('SELECT 1 FROM rep_role WHERE rep_top_id=1 AND group_id=30')).rowCount, 1);
          await client.query('DELETE FROM rep_role WHERE rep_top_id=1 AND group_id=30');
        },
      );
      await t.test(
        'administrator audit identity comes from effective settings and missing configuration cannot change roles',
        async () => {
          const directory = await mkdtemp('/tmp/opencode/document-admin-fixture-');
          const original = process.env.CONMAS_CLIENT_SETTINGS;
          try {
            await writeFile(join(directory, 'Admin.xml'), '<ConMas><userId>fixture-admin</userId></ConMas>');
            process.env.CONMAS_CLIENT_SETTINGS = directory;
            await documentSaveRoleChanges(db, 1, {}, 'fixture');
            const roles = (await client.query('SELECT * FROM rep_role WHERE rep_top_id=1 ORDER BY group_id')).rows;
            assert.equal(roles[0].sys_regist_user, 'fixture-admin');
            assert.equal(roles[0].sys_update_user, 'fixture-admin');
            await writeFile(join(directory, 'Admin.xml'), '<ConMas/>');
            await assert.rejects(documentSaveRoleChanges(db, 1, {}, 'fixture'));
            assert.deepEqual(
              (await client.query('SELECT * FROM rep_role WHERE rep_top_id=1 ORDER BY group_id')).rows,
              roles,
            );
          } finally {
            if (original === undefined) delete process.env.CONMAS_CLIENT_SETTINGS;
            else process.env.CONMAS_CLIENT_SETTINGS = original;
            await unlink(join(directory, 'Admin.xml'));
            await rmdir(directory);
          }
        },
      );
      await t.test(
        'authentication, global/row write roles and explicit unsupported actions never bypass admission',
        async () => {
          actor = 'reader';
          assert.equal((await get('/InputReport/Details?repTopId=1', false)).status, 200);
          assert.equal((await get('/DefReport/EditLabel?defTopId=1&mode=Rep')).status, 403);
          assert.equal((await rolePost({ ActionCommonType: 'SaveType' })).status, 403);
          actor = 'other';
          assert.equal((await get('/DefReport/EditRole?defTopId=1&mode=Rep')).status, 403);
          assert.equal((await labelPost({ ActionCommonType: 'SaveType' })).status, 403);
          actor = undefined;
          assert.equal(
            (await get('/InputReport/Details?repTopId=1', false)).headers.get('location'),
            '/ConMasManager/Account/LogOn',
          );
          actor = 'fixture';
          await get('/DefReport/EditRole?defTopId=1&mode=Rep');
          assert.equal((await rolePost({ ActionCommonType: 'Unknown' })).status, 501);
          await get('/DefReport/EditLabel?defTopId=1&mode=Rep');
          assert.equal((await labelPost({ ActionCommonType: 'Unknown' })).status, 501);
          assert.deepEqual(
            (
              await client.query(
                'SELECT rep_top_id,xml_data,sys_regist_time,sys_update_time FROM rep_top ORDER BY rep_top_id',
              )
            ).rows,
            topBefore,
          );
        },
      );
    } finally {
      if (server)
        await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
      client.release();
      await pool.end();
    }
  },
);
