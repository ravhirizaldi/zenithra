import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import { mock, test } from 'node:test';
import type { Server } from 'node:http';
import pg from 'pg';
import session from 'express-session';
import ejs from 'ejs';
import express from 'express';
import {
  documentAppLaunch,
  documentDate,
  documentLabels,
  documentLinkLabels,
  documentList,
  documentPermissions,
  documentQuery,
  documentSettings,
  documentState,
} from '../../../../src/models/manager/documents/index.js';
import { documentSchemeAuth, documentViewSource } from '../../../../src/services/manager/documents.js';
import { legacyDecrypt, legacyEncrypt, legacyPassword } from '../../../../src/shared/legacy-auth.js';
import { createApp as runtimeApp } from '../../../../src/app.js';
import { registerDocumentController } from '../../../../src/controllers/manager/documents/index.js';
import { createPageRenderer } from '../../../../src/services/manager/page.js';
import { labelPermissions } from '../../../../src/models/manager/labels/index.js';

const common = [
  ['DEFAULT_PUBLIC_STATUS_REPORT', 'DEFAULT', '2'],
  ['DEFAULT_PAGE_SIZE', 'DEFAULT', '2'],
  ['PAGE_SIZE', '2', '2'],
  ['CONMAS_FUNCTION', 'INPUTREPORT_LABEL_INIT_LOAD', '1'],
  ['CONMAS_FUNCTION', 'INPUTREPORT_LABEL_ALL_DISPLAY', '1'],
  ['SEARCH_SETTING', 'CLUSTER_VALUE_FILTER', '1'],
  ['NEW_DISPLAY_TIME', 'DisplayTime', '10'],
  ['NEW_DISPLAY_TIME', 'Interval', '1'],
].map(([com_key, com_name, com_value], com_index) => ({ com_key, com_name, com_value, com_index }));
const row = {
  rep_top_id: 101,
  rep_top_name: '<fixture>',
  rep_top_org: 101,
  rev_no: 1,
  top_remarks1: 'fixture',
  edit_refer_status: 2,
  registered: '2026/11/08 00:00',
  created_by: 'fixture',
  updated: '2026/11/08 00:00',
  updated_by: 'fixture',
  update_time: '2026/11/08 00:00:00',
  locked: false,
  role_update: 1,
  role_delete: 1,
  approve: true,
  auto_numbering_value: 'fixture-1',
  auto_numbering_message: '',
  labels: ['fixture label'],
};
const queries: string[] = [];
const db = {
  query: async (sql: string) => {
    queries.push(sql);
    if (/FROM mst_common/.test(sql)) return { rows: common, rowCount: common.length };
    if (/MAX\(role_rep_read_manager\)/.test(sql))
      return { rows: [{ read: 1, update: 1, delete: 1, super: 0, schedule: 0 }], rowCount: 1 };
    if (/MAX\(role_label_read_manager\)/.test(sql))
      return { rows: [{ read: 0, create: 0, edit: 0, delete: 0 }], rowCount: 1 };
    if (/COUNT\(\*\) AS total/.test(sql)) return { rows: [{ total: '1' }], rowCount: 1 };
    if (/SELECT a.rep_top_id/.test(sql)) return { rows: [row], rowCount: 1 };
    if (/WITH RECURSIVE tree/.test(sql)) return { rows: [], rowCount: 0 };
    throw new Error('Unexpected fixture query.');
  },
  connect: async () => {
    throw new Error('Fixture must not connect.');
  },
} as unknown as pg.Pool;
async function started(server: Server) {
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test('Documents filters preserve MVC checkboxes, defaults, page/back state, date and sort validation', async () => {
  const settings = await documentSettings(db);
  const state = documentState({}, settings);
  assert.equal(state.ReportTypeSheet, true);
  assert.equal(state.ReportTypeSet, true);
  assert.equal(state.SortColumn, 'SYS_UPDATE_TIME');
  assert.equal(state.SortDirection, 'DESC');
  assert.equal(state.PublicStatus, '2');
  assert.equal(
    documentState({ ReportTypeSheet: ['true', 'false'], ReportTypeSet: 'false' }, settings).ReportTypeSheet,
    true,
  );
  assert.equal(documentState({ ReportTypeSet: 'false' }, settings).ReportTypeSet, false);
  assert.equal(documentState({ PageSize: '0' }, settings).PageSize, settings.pageSize);
  const previous = { ...state, PageIndex: 3, SearchInfo: { ...state.SearchInfo, ReportName: 'fixture' } };
  assert.equal(documentState({ act: 'BACK_INDEX' }, settings, previous).PageIndex, 3);
  assert.equal(documentState({ act: 'BACK_INDEX' }, settings, previous).SearchInfo.ReportName, 'fixture');
  assert.throws(() => documentState({ SortColumn: 'REP_TOP_ID; DROP TABLE rep_top' }, settings));
  assert.throws(() => documentState({ PageIndex: '-1' }, settings));
  assert.throws(() => documentState({ PublicStatus: '3' }, settings));
  assert.throws(() => documentDate('2026/02/29', '12:00'));
  assert.equal(documentDate('2024/02/29', 'bad'), '2024/02/29 00:00:00');
  assert.equal(documentDate('2026/11/08', '2:03'), '2026/11/08 02:03:00');
});

test('Documents SQL preserves current/trash/no-label, approval permissions and parameterized multi-word search', async () => {
  const settings = await documentSettings(db),
    state = documentState({}, settings);
  const standard = documentQuery(state, settings, 'fixture');
  assert.match(standard.from, /a.deleted=0/);
  assert.match(standard.from, /rep_current/);
  assert.match(standard.from, /rl.role_rep_read>0/);
  assert.doesNotMatch(standard.from, /role_rep_update>0/);
  assert.equal(documentQuery(state, { ...settings, initLoad: false }, 'fixture').label, '-1');
  assert.equal(documentQuery(state, { ...settings, allDisplay: false }, 'fixture').label, 'NoLabel');
  const trash = documentQuery({ ...state, LabelID: 'Trash' }, settings, 'fixture');
  assert.match(trash.from, /a.deleted=1/);
  assert.doesNotMatch(trash.from, /rep_current/);
  assert.match(
    documentQuery({ ...state, LabelID: 'NoLabel' }, settings, 'fixture').from,
    /NOT EXISTS \(SELECT 1 FROM rep_label/,
  );
  assert.match(
    documentQuery({ ...state, LabelID: '10', IsLabelUnderSearch: true }, settings, 'fixture').from,
    /WITH RECURSIVE tree/,
  );
  for (const approval of ['0', '1', '2', '3']) {
    const query = documentQuery({ ...state, ApprovalStatus: approval }, { ...settings, approvalMode: true }, 'fixture');
    assert.match(query.from, /rep_cluster_approval/);
    if (approval === '1') assert.match(query.from, /rl.role_rep_update>0/);
    else assert.doesNotMatch(query.from, /rl.role_rep_update>0/);
    if (approval === '0') assert.match(query.from, /a.edit_refer_status IN \(2,3\)/);
    if (approval === '1') assert.match(query.from, /rep_cluster_role_approval/);
    if (approval === '2') assert.match(query.from, /e.input_value='3' AND e.applicant=\$1/);
    if (approval === '3') assert.match(query.from, /a.edit_refer_status=2 AND e.applicant=\$1/);
  }
  const query = documentQuery(
    {
      ...state,
      SearchInfo: {
        ...state.SearchInfo,
        ReportName: 'ＦＯＯ　bar',
        Remarks: "O'Reilly",
        SystemKey: '10%_key',
        InputValue: 'fixture',
        RegistDateTo: '2026/11/08',
      },
    },
    settings,
    'fixture',
  );
  assert(query.values.includes('%FOO%'));
  assert(query.values.includes('%bar%'));
  assert(query.values.includes("%O'Reilly%"));
  assert.doesNotMatch(query.from, /O'Reilly|FOO|10%_key/);
  assert.match(query.from, /a.top_remarks10/);
  assert.match(query.from, /a.system_key5/);
  assert.match(query.from, /E?e\.cluster_type NOT IN/);
  assert.match(query.from, /a.sys_regist_time<=\$\d+::timestamp/);
});

test('Documents no-count paging skips COUNT and retains source next-page and last-page controls', async () => {
  const settings = await documentSettings(db),
    state = documentState({}, settings),
    source = await documentViewSource();
  const noCount = { ...settings, noCount: true, virtualCount: 1000 };
  const before = queries.length;
  const list = await documentList(db, state, noCount, 'fixture');
  assert.equal(list.total, 1000);
  assert.equal(list.pages, 500);
  assert.equal(queries.length - before, 1);
  assert.doesNotMatch(queries[before], /COUNT\(/);
  const render = (rows: typeof list.rows) =>
    ejs.renderFile('src/views/manager/documents/list.ejs', {
      base: '/ConMasManager',
      ...source,
      ...list,
      rows,
      settings: noCount,
    });
  const full = await render([row, row]);
  assert.equal((full.match(/class="img_page_next_e"/g) ?? []).length, 2);
  assert.doesNotMatch(full, /style="padding-left:5px;"/);
  assert(!full.includes('(1000)'));
  assert.match(full, /onchange="return pageSizeFilter\(this\);"/);
  for (const rows of [[], [row]]) assert.doesNotMatch(await render(rows), /class="img_page_next_e"/);
  const counted = await ejs.renderFile('src/views/manager/documents/list.ejs', {
    base: '/ConMasManager',
    ...source,
    ...list,
    rows: [row],
    settings,
    total: 3,
    pages: 2,
  });
  assert.match(counted, /style="padding-left:5px;">Last<\/a>/);
  assert(counted.includes('(3)'));
  for (const value of ['0', '-1', '2147483647', ' 25 ']) {
    const settingsDb = {
      query: async () => ({
        rows: [
          { com_key: 'SEARCH_SETTING', com_name: 'REPORT_LIST_IS_COUNT', com_value: '0' },
          { com_key: 'SEARCH_SETTING', com_name: 'VIRTUAL_COUNT_MAX', com_value: value },
        ],
      }),
    } as unknown as pg.Pool;
    assert.equal((await documentSettings(settingsDb)).virtualCount, Number(value));
  }
  for (const value of ['', 'invalid', '2147483648']) {
    const settingsDb = {
      query: async () => ({
        rows: [
          { com_key: 'SEARCH_SETTING', com_name: 'REPORT_LIST_IS_COUNT', com_value: '0' },
          { com_key: 'SEARCH_SETTING', com_name: 'VIRTUAL_COUNT_MAX', com_value: value },
        ],
      }),
    } as unknown as pg.Pool;
    await assert.rejects(documentSettings(settingsDb));
  }
});

test('Documents table matches installed headers, sort controls, status icons and lock/trash row states', async () => {
  const settings = await documentSettings(db),
    state = documentState({}, settings),
    source = await documentViewSource();
  const render = (
    items: (typeof row)[],
    label = 'All',
    sortColumn = 'SYS_UPDATE_TIME',
    sortDirection: 'ASC' | 'DESC' = 'DESC',
  ) =>
    ejs.renderFile('src/views/manager/documents/list.ejs', {
      base: '/ConMasManager',
      ...source,
      settings,
      state: { ...state, LabelID: label, SortColumn: sortColumn, SortDirection: sortDirection },
      rows: items,
      total: items.length,
      pages: 1,
    });
  const headings = [
    source.r.Id,
    source.r.rep_top_name,
    source.r.OrgId,
    source.r.Rev,
    source.v.status,
    source.v.entryDate,
    source.v.entryUser,
    source.v.updateDate,
    source.v.updateUser,
  ];
  const columns = [
    'REP_TOP_ID',
    'REP_TOP_NAME',
    'REP_TOP_ORG',
    'REV_NO',
    'EDIT_REFER_STATUS',
    'SYS_REGIST_TIME',
    'SYS_REGIST_USER',
    'SYS_UPDATE_TIME',
    'SYS_UPDATE_USER',
  ];
  for (const column of columns)
    for (const direction of ['ASC', 'DESC'] as const) {
      const html = await render([row], 'All', column, direction);
      assert.deepEqual(
        [...html.matchAll(/<th[^>]*><span>([^<]*)<\/span>/g)].map((match) => match[1]),
        headings,
      );
      assert.deepEqual(
        [...html.matchAll(/onclick="return sort\('([^']+)'\);"/g)].map((match) => match[1]),
        columns,
      );
      assert.match(html, new RegExp(`class="sort ${direction.toLowerCase()}" onclick="return sort\\('${column}'\\);"`));
      assert.equal((html.match(/class="sorting"/g) ?? []).length, 1);
      assert.equal((html.match(/style="width:45px;"/g) ?? []).length, 3);
    }
  const names = [
    source.r.BeforeEditing,
    source.r.InEditing,
    source.r.WaitingForApproval,
    source.r.Rejected,
    source.r['BizDataOutputResource-Completed'],
  ];
  for (let status = 0; status < 5; status++) {
    const html = await render([{ ...row, edit_refer_status: status }]);
    assert(html.includes(`grid_status_${status + 1}.png`));
    assert(html.includes(names[status]));
    assert.equal(html.includes('class="approve_enable"'), status === 2);
  }
  const locked = await render([{ ...row, locked: true }]);
  assert.match(locked, /height="15px" width="15px"/);
  assert.match(locked, /type="hidden" name="Cbx" value="101"/);
  assert.doesNotMatch(locked, /type="checkbox" id="Cbx"/);
  const trash = await render([{ ...row, locked: true }], 'Trash');
  assert.match(trash, /type="checkbox" id="Cbx"/);
  assert.doesNotMatch(trash, /name="details_101"/);
  assert.match(trash, /name="lockedFlg" value="1"/);
  const striped = await render([
    row,
    { ...row, rep_top_id: 102, auto_numbering_value: '', auto_numbering_message: '<fixture error>' },
  ]);
  assert.match(striped, /<tr class="odd">/);
  assert.match(striped, /<tr class="even">/);
  assert.match(striped, /class="error-message"/);
  assert(striped.includes('&lt;fixture error&gt;'));
  assert.match(striped, /name="item.sys_update_time" id="item_sys_update_time" value="2026\/11\/08 00:00:00"/);
  assert.match(striped, /<li style="float:left;">fixture label&nbsp;<\/li>/);
  assert.match(await render([]), /id="RepReportList"/);
});

test('Documents installed JavaScript submits paging, sorting, filtering and label-mode controls', async () => {
  const source = await documentViewSource();
  const values = new Map<string, string>([
    ['#SortColumn', 'SYS_UPDATE_TIME'],
    ['#SortDirection', 'DESC'],
  ]);
  const events: string[] = [];
  const $ = (selector: string | (() => void)) => ({
    val(value?: string | number) {
      if (value === undefined) return values.get(String(selector)) ?? '';
      values.set(String(selector), String(value));
      return this;
    },
    trigger(event: string) {
      events.push(String(selector) + ':' + event);
      return this;
    },
    hide() {
      events.push(String(selector) + ':hide');
      return this;
    },
    show() {
      events.push(String(selector) + ':show');
      return this;
    },
  });
  const context = {
    $: Object.assign($, { ajaxSetup() {} }),
    document: { getElementById: (id: string) => ({ submit: () => events.push(id + ':submit') }) },
    fConMasLockView: () => events.push('lock'),
    alert: () => events.push('alert'),
    confirm: () => true,
  };
  const script = new Script(
    source.js +
      `
    page(3); sort('SYS_UPDATE_TIME'); sort('REP_TOP_ID'); filter();
    label('Trash'); label('All'); fConmasChangeLabelMode('1'); fConmasChangeLabelMode('0');
  `,
  );
  script.runInNewContext(context);
  assert.equal(values.get('#PageIndex'), '3');
  assert.equal(values.get('#Act'), 'PAGE');
  assert.equal(values.get('#SortColumn'), 'REP_TOP_ID');
  assert.equal(values.get('#SortDirection'), 'ASC');
  assert.equal(values.get('#LabelID'), 'All');
  assert.equal(values.get('#LabelAct'), 'LABEL_MODE_CHANGE_NORMAL');
  assert.equal(events.filter((event) => event === '#formReportIndex:submit').length, 6);
  assert.equal(events.filter((event) => event === 'labelForm:submit').length, 2);
  assert(events.includes('lock'));
  assert(events.includes('#physicalDeleteButton:show'));
  assert(events.includes('#physicalDeleteButton:hide'));
});

test('Documents app-launch platform settings, original icons and encrypted authentication retain the source contract', async () => {
  const settings = await documentSettings(db),
    state = documentState({}, settings),
    source = await documentViewSource();
  for (const enable of ['', '0', '1', '2', '3', '4'])
    for (const agent of ['Windows', 'iPad', 'iPhone', 'iPod', 'Macintosh', 'Linux', '']) {
      const launch = await documentAppLaunch(db, { ...settings, schemeEnable: enable }, 'fixture', agent);
      const windows = agent === 'Windows',
        ios = ['iPad', 'iPhone', 'iPod', 'Macintosh'].includes(agent);
      const expected = (windows && ['2', '3'].includes(enable)) || (ios && ['1', '3'].includes(enable));
      assert.equal(Boolean(launch), expected, `${enable}/${agent}`);
      if (launch)
        assert.deepEqual(launch, {
          template: 'ireporter.openreport:repid={rep_top_id}',
          icon: windows ? 'win_ir.ico' : 'ios_ir.png',
        });
    }
  const key = process.env.CONMAS_LEGACY_KEY;
  const schemeKey = process.env.CONMAS_URL_SCHEME_KEY;
  process.env.CONMAS_LEGACY_KEY = 'documents-fixture-key';
  process.env.CONMAS_URL_SCHEME_KEY = 'documents-scheme-fixture-key';
  try {
    for (const passwordEncrypted of [false, true]) {
      const privateDb = {
        query: async (sql: string, values: unknown[]) => {
          assert.equal(sql, 'SELECT password FROM mst_user WHERE user_id=$1');
          assert.deepEqual(values, ['fixture']);
          return {
            rows: [
              {
                password: passwordEncrypted
                  ? legacyPassword('fixture', 'fixture-password', 'documents-fixture-key')
                  : 'fixture-password',
              },
            ],
          };
        },
      } as unknown as pg.Pool;
      const launch = await documentAppLaunch(
        privateDb,
        { ...settings, schemeEnable: '2', schemeAuth: true, passwordEncrypted },
        'fixture',
        'Windows',
      );
      assert(launch);
      assert(launch.template.endsWith('&auth=' + (await documentSchemeAuth('fixture', 'fixture-password'))));
      assert(!launch.template.includes('fixture-password'));
      assert(
        legacyDecrypt(decodeURIComponent(launch.template.split('&auth=')[1]), 'documents-scheme-fixture-key') ===
          'user=fixture&pass=fixture-password',
      );
      const html = await ejs.renderFile('src/views/manager/documents/list.ejs', {
        base: '/ConMasManager',
        ...source,
        settings,
        state,
        rows: [row],
        pages: 1,
        total: 1,
        appLaunch: launch,
      });
      assert.match(html, /<span>Edit<\/span>/);
      assert.match(html, /win_ir\.ico/);
      assert.match(html, /border-style:none; width:20px; height:20px;/);
      assert.match(html, /ireporter\.openreport:repid=101&amp;auth=/);
      assert(!html.includes('fixture-password'));
      assert.equal((html.match(/<th\s/g) ?? []).length, 11);
      assert.equal((html.match(/<td(?:\s|>)/g) ?? []).length, 11);
      assert.equal((html.match(/style="width:45px;"/g) ?? []).length, 4);
    }
    const missing = { query: async () => ({ rows: [] }) } as unknown as pg.Pool;
    await assert.rejects(
      documentAppLaunch(missing, { ...settings, schemeEnable: '2', schemeAuth: true }, 'fixture', 'Windows'),
      /account is unavailable/,
    );
  } finally {
    if (key === undefined) delete process.env.CONMAS_LEGACY_KEY;
    else process.env.CONMAS_LEGACY_KEY = key;
    if (schemeKey === undefined) delete process.env.CONMAS_URL_SCHEME_KEY;
    else process.env.CONMAS_URL_SCHEME_KEY = schemeKey;
  }
});

test('Documents hidden-label filtering is model-owned, parameterized and retains parent paths', async () => {
  const rows = [10, 11, 12].map((mst_label_id) => ({
    mst_label_id,
    label_name: 'fixture',
    label_remarks: '',
    label_icon_id: 0,
  }));
  const sql: string[] = [];
  const privateDb = {
    query: async (text: string, values: unknown[]) => {
      sql.push(text);
      assert.equal(values[0], 'fixture');
      return { rows: text.startsWith('WITH RECURSIVE') ? rows : [{ id: '10' }, { id: '11' }] };
    },
  } as unknown as pg.Pool;
  assert.deepEqual(
    (await documentLabels(privateDb, 'fixture', '', false)).map((row) => row.mst_label_id),
    [10, 11, 12],
  );
  assert.equal(sql.length, 1);
  assert.deepEqual(
    (await documentLabels(privateDb, 'fixture', '', true)).map((row) => row.mst_label_id),
    [10, 11],
  );
  assert.match(sql[2], /JOIN rep_current/);
  assert.match(sql[2], /t.deleted=0 AND rl.role_rep_read>0/);
});

test('Documents uses project-owned EJS scripts and original controls/resources, not preview styling', async () => {
  const source = await documentViewSource();
  new Script(source.js);
  new Script(source.searchJs);
  assert.match(source.js, /function fConMasInit\(\)/);
  assert.match(source.js, /setTimeout\("timer\(\)"/);
  assert.doesNotMatch(source.js, /@IR|@string|@\*/);
  const settings = await documentSettings(db),
    state = documentState({}, settings);
  const page = {
    ...source,
    settings,
    state,
    permissions: { read: true, update: true, delete: true, schedule: true },
    hidden: false,
  };
  const html = await ejs.renderFile('src/views/manager/page.ejs', {
    ...source,
    base: '/ConMasManager',
    menus: [['Documents', 'InputReport']],
    active: 'InputReport',
    section: '',
    login: false,
    title: 'Document list',
    authEnabled: true,
    databaseReady: true,
    userName: 'fixture',
    csrfToken: 'fixture',
    labelPermissions: { create: true, delete: true },
    webhookPage: null,
    documentPage: page,
  });
  assert.doesNotMatch(html, /preview\.css|preview-workspace|disabled-menu/);
  assert.match(html, /class="current"><a href="\/ConMasManager\/InputReport"/);
  for (const id of [
    'formLabelView',
    'conmasLabelContent',
    'formReportIndex',
    'FiltersUl',
    'SearchDialog',
    'ApproveDialog',
    'DeleteDialog',
    'GridSection',
    'content',
    'conmasReportCopyForm',
    'labelManagementForm',
    'formLabelSelectListView',
    'IdentificationDialog',
  ])
    assert(html.includes(`id="${id}"`), id);
  for (const script of [
    'MicrosoftAjax.js',
    'MicrosoftMvcAjax.js',
    'conmas.identification.js',
    'jquery.unobtrusive-ajax.min.js',
  ])
    assert(html.includes(script), script);
  assert.match(html, /onclick="return fConmasChangeLabelMode\('1'\);"/);
  assert(
    html.includes(`data-val-required="${ejs.escapeXML(source.r.MSG_REQUIRED.replace('{0}', source.r.label_name))}"`),
  );
  assert(html.includes(`data-val-required="${ejs.escapeXML(source.r.MSG_REQUIRED_ICON)}"`));
  assert.match(source.js, /function fConmasChangeLabelMode\(val\)/);
  const custom = await ejs.renderFile('src/views/manager/page.ejs', {
    ...source,
    base: '/ConMasManager',
    menus: [['Documents', 'InputReport']],
    active: 'InputReport',
    section: '',
    login: false,
    title: 'Document list',
    authEnabled: true,
    databaseReady: true,
    userName: 'fixture',
    csrfToken: 'fixture',
    labelPermissions: null,
    webhookPage: null,
    documentPage: {
      ...page,
      copyDocuments: true,
      settings: { ...settings, menu: { FONT_SIZE: '16', WIDTH: '115', REP_REPORT: '<fixture menu>' } },
    },
  });
  assert.match(custom, /id="GMenu"><ul>/);
  assert.match(custom, /href="\/ConMasManager\/InputReport">&lt;fixture menu&gt;/);
  const navigation = custom.slice(custom.indexOf('id="GMenu"'), custom.indexOf('id="Main"'));
  assert.doesNotMatch(navigation, /style=|font-size:|width:/);
  assert.match(custom, /id="isReportDocumentCopy"[^>]*checked="checked"/);
  const list = await ejs.renderFile('src/views/manager/documents/list.ejs', {
    base: '/ConMasManager',
    ...source,
    settings,
    state,
    rows: [row],
    pages: 1,
    total: 1,
  });
  assert.match(list, /GridCommon/);
  assert.match(list, /grid_status_3\.png/);
  assert.match(list, /approve_enable/);
  assert.match(list, /&lt;fixture&gt;/);
  assert.doesNotMatch(list, /<fixture>/);
  const locked = await ejs.renderFile('src/views/manager/documents/list.ejs', {
    base: '/ConMasManager',
    ...source,
    settings,
    state,
    rows: [{ ...row, locked: true }],
    pages: 1,
    total: 1,
  });
  assert.match(locked, /locked\.png/);
  assert.doesNotMatch(locked, /type="checkbox" id="Cbx"/);
});

test('Manager root/login landing, Documents AJAX, session restoration, CSRF and unsupported writes stay isolated', async () => {
  const store = new session.MemoryStore();
  const id = 'documents-fixture';
  const secret = 'documents-isolated-secret';
  const previous = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = secret;
  const app = runtimeApp(db, true, store);
  if (previous === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = previous;
  await new Promise<void>((resolve, reject) =>
    store.set(
      id,
      {
        cookie: new session.Cookie(),
        userId: 'fixture',
        userName: 'fixture',
        userStart: '2000-01-01T00:00:00Z',
        userEnd: '2100-01-01T00:00:00Z',
        csrfToken: 'fixture-token',
      },
      (error) => (error ? reject(error) : resolve()),
    ),
  );
  const signature = createHmac('sha256', secret).update(id).digest('base64').replace(/=+$/, '');
  const cookie = 'conmas_node_sid=' + encodeURIComponent(`s:${id}.${signature}`);
  const server = app.listen(0, '127.0.0.1'),
    origin = await started(server),
    base = origin + '/ConMasManager';
  try {
    assert.equal((await fetch(origin + '/', { redirect: 'manual' })).headers.get('location'), '/ConMasManager/');
    assert.equal(
      (await fetch(base + '/', { redirect: 'manual' })).headers.get('location'),
      '/ConMasManager/Account/LogOn',
    );
    assert.equal(
      (await fetch(base + '/Account/LogOn', { headers: { cookie }, redirect: 'manual' })).headers.get('location'),
      '/ConMasManager/',
    );
    for (const path of ['/', '/InputReport', '/InputReport/Index'])
      assert.equal((await fetch(base + path, { headers: { cookie } })).status, 200);
    for (const image of [
      ...Array.from({ length: 5 }, (_, index) => `grid/grid_status_${index + 1}.png`),
      'win_ir.ico',
    ]) {
      const response = await fetch(base + '/Content/ConMas/images/' + image);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /^image\//);
      assert.deepEqual(
        Buffer.from(await response.arrayBuffer()),
        await readFile('/mnt/c/Users/DELL/CONMASSERVER/ConMasManager/Content/ConMas/images/' + image),
      );
    }
    const post = (path: string, body: Record<string, string>) =>
      fetch(base + path, {
        method: 'POST',
        headers: { cookie, 'X-Requested-With': 'XMLHttpRequest' },
        body: new URLSearchParams(body),
        redirect: 'manual',
      });
    assert.equal((await post('/InputReport/IndexList', {})).status, 403);
    const response = await post('/InputReport/IndexList', {
      __RequestVerificationToken: 'fixture-token',
      ReportTypeSheet: 'true',
      ReportTypeSet: 'true',
      IsLabelUnderSearch: 'true',
      'SearchInfo.ReportName': 'fixture',
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /RepReportList/);
    assert((response.headers.get('set-cookie') ?? '').includes('ConMasCookie_ReportIndex_IsLabelUnderSearch=true'));
    const back = await fetch(base + '/InputReport?act=BACK_INDEX', { headers: { cookie } });
    const backHtml = await back.text();
    assert.match(backHtml, /name="SearchInfo.ReportName" value="fixture"/);
    assert.match(backHtml, /id="IsLabelUnderSearch"[^>]*checked="checked"/);
    const falseCookie = await fetch(base + '/InputReport?act=BACK_INDEX', {
      headers: { cookie: cookie + '; ConMasCookie_ReportIndex_IsLabelUnderSearch=false' },
    });
    assert.match(await falseCookie.text(), /id="IsLabelUnderSearch"[^>]*checked="checked"/);
    const trueCookie = await fetch(base + '/InputReport', {
      headers: {
        cookie:
          cookie +
          '; ConMasCookie_ReportIndex_IsLabelUnderSearch=TRUE; ConMasCookie_ReportIndex_ApprovalStatusSelectedValue=2',
      },
    });
    const cookieHtml = await trueCookie.text();
    assert.match(cookieHtml, /id="IsLabelUnderSearch"[^>]*checked="checked"/);
    assert.match(cookieHtml, /<option value="2" selected="selected">/);
    const invalidCookie = await fetch(base + '/InputReport', {
      headers: { cookie: cookie + '; ConMasCookie_ReportIndex_ApprovalStatusSelectedValue=unknown' },
    });
    assert.match(await invalidCookie.text(), /<option value="-1" selected="selected">/);
    const mode = await post('/InputReport', {
      __RequestVerificationToken: 'fixture-token',
      LabelAct: 'LABEL_MODE_CHANGE_HIDDEN',
    });
    assert.equal(mode.status, 302);
    assert.equal(mode.headers.get('location'), '/ConMasManager/InputReport?act=BACK_INDEX');
    const hiddenHtml = await (await fetch(base + '/InputReport?act=BACK_INDEX', { headers: { cookie } })).text();
    assert.match(hiddenHtml, /onclick="return fConmasChangeLabelMode\('0'\);"/);
    assert.equal(
      (
        await post('/InputReport', {
          __RequestVerificationToken: 'fixture-token',
          LabelAct: 'LABEL_MODE_CHANGE_NORMAL',
        })
      ).status,
      302,
    );
    const before = queries.length;
    for (const Act of ['APPROVE', 'unknown'])
      assert.equal(
        (await post('/InputReport/IndexList', { __RequestVerificationToken: 'fixture-token', Act })).status,
        501,
      );
    for (const Act of ['DELETE_REPORT', 'DELETE_RETURN_REPORT', 'DELETE_PHYSICAL'])
      assert.equal(
        (await post('/InputReport/IndexList', { __RequestVerificationToken: 'fixture-token', Act })).status,
        400,
      );
    assert.equal(
      (await post('/InputReport/IndexList', { __RequestVerificationToken: 'fixture-token', Act: 'LINK_LABEL' })).status,
      400,
    );
    for (const LabelAct of ['LABEL_MANAGEMENT_ADD', 'LABEL_MANAGEMENT_DELETE'])
      assert.equal((await post('/InputReport', { __RequestVerificationToken: 'fixture-token', LabelAct })).status, 403);
    assert(
      queries.slice(before).every((sql) => /^SELECT/.test(sql.trim())),
      'No mutations on pending actions',
    );
    const tree = await post('/Common/LabelListView', {
      __RequestVerificationToken: 'fixture-token',
      reportMode: 'Rep',
      isLabelAllDisplay: 'true',
    });
    assert.equal(tree.status, 200);
    assert.match(await tree.text(), /id="Labels"/);
    const selector = await post('/Common/LabelSelectListView', {
      __RequestVerificationToken: 'fixture-token',
      reportMode: 'Rep',
    });
    assert.equal(selector.status, 200);
    assert.equal(
      await (await fetch(base + '/InputReport/DetailsTop?repTopId=101', { headers: { cookie } })).text(),
      '',
    );
    assert.equal((await fetch(base + '/DefReport', { headers: { cookie } })).status, 503);
  } finally {
    await close(server);
    store.clear();
  }
});

test(
  'Documents SQL executes only against private fixture tables and retains role/current/trash filtering',
  { skip: !process.env.DATABASE_URL },
  async () => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }),
      client = await pool.connect();
    try {
      for (const table of [
        'mst_common',
        'mst_group',
        'mst_group_affiation',
        'mst_user',
        'rep_top',
        'rep_role',
        'rep_current',
        'rep_lock',
        'rep_label',
        'mst_label_rep',
        'rep_sheet',
        'rep_cluster',
        'rep_cluster_role',
      ])
        await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table})`);
      await client.query(
        "INSERT INTO pg_temp.mst_group (group_id,role_rep_read_manager,role_rep_update_manager,role_rep_delete_manager) VALUES (10,1,1,1); INSERT INTO pg_temp.mst_group_affiation (group_id,user_id) VALUES (10,'fixture')",
      );
      await client.query(
        "INSERT INTO pg_temp.rep_top (rep_top_id,rep_top_org,rep_top_name,rev_no,deleted,public_status,report_type,edit_refer_status) VALUES (101,101,'fixture',1,0,2,1,0),(102,102,'denied',1,0,2,1,0),(103,103,'trash',1,1,2,1,0),(104,101,'old',1,0,2,1,0)",
      );
      await client.query(
        'INSERT INTO pg_temp.rep_role (rep_top_id,group_id,role_rep_read,role_rep_update,role_rep_delete) VALUES (101,10,1,1,1),(103,10,1,1,1),(104,10,1,1,1); INSERT INTO pg_temp.rep_current (rep_top_org,rep_top_id) VALUES (101,101),(102,102)',
      );
      const privateDb = {
        query: client.query.bind(client),
        connect: async () => ({ query: client.query.bind(client), release() {} }),
      } as unknown as pg.Pool;
      const settings = await documentSettings(privateDb),
        state = documentState({}, settings);
      assert.equal((await documentPermissions(privateDb, 'fixture', settings)).refer, true);
      assert.equal((await documentPermissions(privateDb, 'denied', settings)).refer, false);
      assert.deepEqual(
        (await documentList(privateDb, state, settings, 'fixture')).rows.map((r) => r.rep_top_id),
        [101],
      );
      const source = await documentViewSource();
      for (let status = 0; status < 5; status++) {
        await client.query('UPDATE pg_temp.rep_top SET edit_refer_status=$1 WHERE rep_top_id=101', [status]);
        const list = await documentList(privateDb, state, settings, 'fixture');
        assert.equal(list.rows[0].edit_refer_status, status, 'Normalize the PostgreSQL numeric status for rendering');
        const html = await ejs.renderFile('src/views/manager/documents/list.ejs', {
          base: '/ConMasManager',
          ...source,
          ...list,
          settings,
        });
        assert.match(html, new RegExp(`/grid/grid_status_${status + 1}\\.png`));
        assert.doesNotMatch(html, /grid_status_(?:01|11|21|31|41)\.png/);
      }
      assert.deepEqual(
        (await documentList(privateDb, { ...state, LabelID: 'Trash' }, settings, 'fixture')).rows.map(
          (r) => r.rep_top_id,
        ),
        [103],
      );
      await client.query("UPDATE pg_temp.rep_top SET rep_top_name='  fixture  ' WHERE rep_top_id=101");
      assert.equal((await documentList(privateDb, state, settings, 'fixture')).rows[0].rep_top_name, '  fixture  ');
      await client.query("UPDATE pg_temp.rep_top SET rep_top_name='   ' WHERE rep_top_id=101");
      assert.equal((await documentList(privateDb, state, settings, 'fixture')).rows[0].rep_top_name, '...');
      assert.equal((await documentList(privateDb, state, settings, 'denied')).total, 0);
      await client.query('ALTER TABLE pg_temp.rep_label ADD UNIQUE (rep_top_id,mst_label_id)');
      await client.query(
        "INSERT INTO pg_temp.mst_label_rep (mst_label_id,label_name,binder_rep_id) VALUES (10,'First',NULL),(11,'Second',NULL),(12,'Binder',101)",
      );
      await documentLinkLabels(privateDb, '101,101', '10,11', 'add', 'fixture');
      assert.deepEqual(
        (await client.query('SELECT mst_label_id FROM pg_temp.rep_label ORDER BY mst_label_id')).rows.map(
          (row) => row.mst_label_id,
        ),
        [10, 11],
      );
      const audit = (await client.query('SELECT * FROM pg_temp.rep_label ORDER BY mst_label_id')).rows;
      await documentLinkLabels(privateDb, '101', '10,11', 'add', 'fixture');
      assert.deepEqual((await client.query('SELECT * FROM pg_temp.rep_label ORDER BY mst_label_id')).rows, audit);
      for (const [reports, labels, operation, actor] of [
        ['101', '10,12', 'delete', 'fixture'],
        ['101,102', '10', 'delete', 'fixture'],
        ['101', '99', 'add', 'fixture'],
        ['101', '10', 'add', 'denied'],
        ['', '10', 'add', 'fixture'],
        ['101', '0', 'add', 'fixture'],
        ['101', '10', 'invalid', 'fixture'],
        ['101); DROP TABLE rep_top', '10', 'add', 'fixture'],
      ])
        await assert.rejects(documentLinkLabels(privateDb, reports, labels, operation, actor));
      assert.deepEqual((await client.query('SELECT * FROM pg_temp.rep_label ORDER BY mst_label_id')).rows, audit);
      await client.query("INSERT INTO pg_temp.rep_lock (rep_top_id,user_id) VALUES (101,'fixture')");
      await assert.rejects(documentLinkLabels(privateDb, '101', '10', 'delete', 'fixture'), /locked/);
      await client.query('DELETE FROM pg_temp.rep_lock');
      await client.query('UPDATE pg_temp.rep_role SET role_rep_update=0 WHERE rep_top_id=101');
      await assert.rejects(documentLinkLabels(privateDb, '101', '10', 'delete', 'fixture'), /not editable/);
      await client.query('UPDATE pg_temp.rep_role SET role_rep_update=1 WHERE rep_top_id=101');
      const failingDb = {
        connect: async () => ({
          query: async (sql: string, values?: unknown[]) => {
            const result = await client.query(sql, values);
            if (sql.startsWith('DELETE FROM rep_label')) throw new Error('Fixture failure after mutation.');
            return result;
          },
          release() {},
        }),
      } as unknown as pg.Pool;
      await assert.rejects(documentLinkLabels(failingDb, '101', '10', 'delete', 'fixture'), /Fixture failure/);
      assert.deepEqual((await client.query('SELECT * FROM pg_temp.rep_label ORDER BY mst_label_id')).rows, audit);
      await documentLinkLabels(privateDb, '101', '10', 'delete', 'fixture');
      assert.deepEqual(
        (await client.query('SELECT mst_label_id FROM pg_temp.rep_label')).rows.map((row) => row.mst_label_id),
        [11],
      );
    } finally {
      client.release();
      await pool.end();
    }
  },
);

test('Documents FreeDrawOnly denial precedes database access without changing any license file', async () => {
  const key = process.env.CONMAS_LICENSE_KEY;
  const originalRead = fs.readFileSync;
  process.env.CONMAS_LICENSE_KEY = 'documents-private-license-key';
  const xml =
    '<ConMas><license>' + legacyEncrypt('FreeDrawOnly=1;', 'documents-private-license-key') + '</license></ConMas>';
  const readMock = mock.method(fs, 'readFileSync', (path: fs.PathOrFileDescriptor, ...options: unknown[]) =>
    /\/License(?:\.node)?\.xml$/.test(String(path)) ? xml : Reflect.apply(originalRead, fs, [path, ...options]),
  );
  syncBuiltinESMExports();
  let server: Server | undefined;
  let queries = 0;
  try {
    const privateDb = {
      query: () => {
        queries++;
        throw new Error('License-denied routes must not query.');
      },
      connect: () => {
        throw new Error('License-denied routes must not connect.');
      },
    } as unknown as pg.Pool;
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(session({ secret: 'documents-license-fixture', resave: false, saveUninitialized: true }));
    registerDocumentController(
      app,
      privateDb,
      true,
      () => {
        throw new Error('License-denied routes must not render.');
      },
      (_req, _res, next) => next(),
    );
    server = app.listen(0, '127.0.0.1');
    const origin = await started(server);
    for (const path of [
      '/',
      '/InputReport',
      '/InputReport/Index',
      '/InputReport/Details?repTopId=1',
      '/InputReport/DetailsRole?repTopId=1',
      '/DefReport/EditLabel?defTopId=1&mode=Rep',
      '/DefReport/EditRole?defTopId=1&mode=Rep',
      '/Common/LabelListView',
    ])
      assert.equal((await fetch(origin + '/ConMasManager' + path)).status, 403);
    for (const path of [
      '/InputReport',
      '/InputReport/IndexList',
      '/DefReport/EditLabel?mode=Rep',
      '/DefReport/EditRole?mode=Rep',
    ])
      assert.equal((await fetch(origin + '/ConMasManager' + path, { method: 'POST' })).status, 403);
    assert.equal(queries, 0);
  } finally {
    if (server) await close(server);
    readMock.mock.restore();
    syncBuiltinESMExports();
    if (key === undefined) delete process.env.CONMAS_LICENSE_KEY;
    else process.env.CONMAS_LICENSE_KEY = key;
  }
});

test(
  'Documents Index quick-label create/sibling/child/delete and validation use only private tables and sequence',
  { skip: !process.env.DATABASE_URL },
  async () => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }),
      client = await pool.connect();
    let server: Server | undefined;
    const mutations: string[] = [];
    const privateDb = {
      query: client.query.bind(client),
      connect: async () => ({
        query: (sql: string, values?: unknown[]) => {
          if (/^(INSERT|UPDATE|DELETE)/.test(sql)) mutations.push(sql);
          return client.query(sql, values);
        },
        release() {},
      }),
    } as unknown as pg.Pool;
    try {
      await client.query('CREATE TEMP SEQUENCE mst_label_def_mst_label_id_seq START 100');
      assert.equal(
        (
          await client.query(
            "SELECT 'mst_label_def_mst_label_id_seq'::regclass='pg_temp.mst_label_def_mst_label_id_seq'::regclass AS private",
          )
        ).rows[0].private,
        true,
      );
      for (const table of [
        'mst_common',
        'mst_group',
        'mst_group_affiation',
        'mst_label_rep',
        'rep_label',
        'rep_label_role',
        'mst_user',
        'rep_top',
        'rep_role',
        'rep_current',
        'rep_lock',
        'rep_sheet',
        'rep_cluster',
        'rep_cluster_role',
      ])
        await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
      await client.query(`ALTER TABLE pg_temp.mst_label_rep ADD FOREIGN KEY (upper_label_id) REFERENCES pg_temp.mst_label_rep(mst_label_id) ON DELETE CASCADE;
        ALTER TABLE pg_temp.rep_label ADD FOREIGN KEY (mst_label_id) REFERENCES pg_temp.mst_label_rep(mst_label_id) ON DELETE CASCADE`);
      await client.query(
        "INSERT INTO pg_temp.mst_group (group_id,role_rep_read_manager,role_rep_update_manager,role_label_create_manager,role_label_delete_manager) VALUES (10,1,1,1,1); INSERT INTO pg_temp.mst_group_affiation (group_id,user_id) VALUES (10,'fixture')",
      );
      await client.query(
        "INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value,com_index) VALUES (1,'CUSTOM_URL_SCHEME','ENABLE','2',0)",
      );
      await client.query(
        "INSERT INTO pg_temp.rep_top (rep_top_id,rep_top_org,rep_top_name,deleted,public_status,report_type,edit_refer_status) VALUES (101,101,'Fixture',0,2,1,0); INSERT INTO pg_temp.rep_role (rep_top_id,group_id,role_rep_read,role_rep_update) VALUES (101,10,1,1); INSERT INTO pg_temp.rep_current (rep_top_org,rep_top_id) VALUES (101,101)",
      );
      const app = express();
      app.set('views', 'src/views');
      app.set('view engine', 'ejs');
      app.use(express.urlencoded({ extended: false }));
      app.use(session({ secret: 'documents-private-label-secret', resave: false, saveUninitialized: true }));
      app.use(async (req, res, next) => {
        req.session.userId = 'fixture';
        req.session.userName = 'fixture';
        req.session.csrfToken = 'fixture-token';
        res.locals.labelPermissions = await labelPermissions(privateDb, 'fixture');
        next();
      });
      registerDocumentController(app, privateDb, true, createPageRenderer(true, true), (_req, _res, next) => next());
      server = app.listen(0, '127.0.0.1');
      const origin = await started(server);
      const post = (body: Record<string, string>, path = '/InputReport') =>
        fetch(origin + '/ConMasManager' + path, {
          method: 'POST',
          headers: { 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
          body: new URLSearchParams({ __RequestVerificationToken: 'fixture-token', ...body }),
          redirect: 'manual',
        });
      const create = (name: string, base = 'All', mode = '0') =>
        post({
          LabelAct: 'LABEL_MANAGEMENT_ADD',
          LabelSelectID: base,
          LabelCreateMode: mode,
          'mst_label.label_name': name,
          'mst_label.label_remarks': '<fixture remarks>',
          'mst_label.label_icon_id': '3',
          'mst_label.IsAutoDelete': 'true',
        });
      const root = await create('Root');
      assert.equal(root.status, 302);
      assert.equal(root.headers.get('location'), '/ConMasManager/InputReport?act=BACK_INDEX');
      assert.equal((await create('Child', '100', '1')).status, 302);
      assert.equal((await create('Sibling', '101', '0')).status, 302);
      const rows = (
        await client.query(
          'SELECT mst_label_id,upper_label_id,label_name,label_id_path,label_icon_id,auto_delete,auto_creation,sys_regist_user FROM pg_temp.mst_label_rep ORDER BY mst_label_id',
        )
      ).rows;
      assert.deepEqual(
        rows.map((row) => [row.mst_label_id, row.upper_label_id, row.label_id_path]),
        [
          [100, null, '100'],
          [101, 100, '100/101'],
          [102, 100, '100/102'],
        ],
      );
      assert(
        rows.every(
          (row) =>
            row.label_icon_id === 3 &&
            row.auto_delete === 1 &&
            row.auto_creation === 0 &&
            row.sys_regist_user === 'fixture',
        ),
      );
      const link = { Act: 'LINK_LABEL', ChkRepTopID: '101', ChkLinkLabelID: '100', LinkLabelStatus: 'add' };
      const linked = await post(link, '/InputReport/IndexList');
      assert.equal(linked.status, 200);
      const linkedHtml = await linked.text();
      assert.match(linkedHtml, /Root&nbsp;/);
      assert.match(linkedHtml, /<span>Edit<\/span>/);
      assert.match(linkedHtml, /ireporter\.openreport:repid=101/);
      assert.match(linkedHtml, /\/Content\/ConMas\/images\/win_ir\.ico/);
      assert.equal((linkedHtml.match(/<th\s/g) ?? []).length, 11);
      assert.equal((linkedHtml.match(/<td(?:\s|>)/g) ?? []).length, 11);
      await client.query('UPDATE pg_temp.mst_group SET role_rep_update_manager=0');
      assert.equal((await post({ ...link, LinkLabelStatus: 'delete' }, '/InputReport/IndexList')).status, 403);
      assert.equal((await client.query('SELECT count(*) FROM pg_temp.rep_label')).rows[0].count, '1');
      await client.query('UPDATE pg_temp.mst_group SET role_rep_update_manager=1');
      const unlinked = await post({ ...link, LinkLabelStatus: 'delete' }, '/InputReport/IndexList');
      assert.equal(unlinked.status, 200);
      assert.doesNotMatch(await unlinked.text(), /Root&nbsp;/);
      const before = mutations.length;
      const invalid = await create('', '100', '1');
      assert.equal(invalid.status, 200);
      const html = await invalid.text();
      assert.match(html, /id="IsLabelError"[^>]*value="1"/);
      assert.match(html, /class="field-validation-error"/);
      assert(html.includes('&lt;fixture remarks&gt;'));
      assert.match(html, /id="label_icon_id3"[^>]*checked="checked"/);
      assert.match(html, /id="mst_label_IsAutoDelete"[^>]*checked="checked"/);
      const invalidMode = await create('Invalid', 'All', '1');
      assert.equal(invalidMode.status, 200);
      assert.match(await invalidMode.text(), /Invalid label creation mode/);
      assert.equal(mutations.length, before);
      await client.query('UPDATE pg_temp.mst_group SET role_label_create_manager=0,role_label_delete_manager=0');
      assert.equal((await create('Denied')).status, 403);
      assert.equal((await post({ LabelAct: 'LABEL_MANAGEMENT_DELETE', LabelSelectID: '100' })).status, 403);
      assert.equal(mutations.length, before);
      await client.query('UPDATE pg_temp.mst_group SET role_label_create_manager=1,role_label_delete_manager=1');
      assert.equal(
        (
          await post({
            __RequestVerificationToken: 'invalid',
            LabelAct: 'LABEL_MANAGEMENT_DELETE',
            LabelSelectID: '100',
          })
        ).status,
        403,
      );
      await client.query('INSERT INTO pg_temp.rep_label (rep_top_id,mst_label_id) VALUES (101,101)');
      assert.equal((await post({ LabelAct: 'LABEL_MANAGEMENT_DELETE', LabelSelectID: '100' })).status, 302);
      assert.equal((await client.query('SELECT count(*) FROM pg_temp.mst_label_rep')).rows[0].count, '0');
      assert.equal((await client.query('SELECT count(*) FROM pg_temp.rep_label')).rows[0].count, '0');
    } finally {
      if (server) await close(server);
      client.release();
      await pool.end();
    }
  },
);
