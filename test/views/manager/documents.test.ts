import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { Script, runInNewContext } from 'node:vm';
import ejs from 'ejs';
import { root } from '../../../src/config/manager.js';
import {
  documentDetailScript,
  documentSchemeAuth,
  documentTaskScript,
  documentViewSource,
} from '../../../src/services/manager/documents.js';
import { legacyDecrypt, legacyEncrypt } from '../../../src/shared/legacy-auth.js';
import { documentClusterInput } from '../../../src/models/manager/documents/clusters.js';

// Prior rendered outputs: report ID 123, copyError=false, task closed=0, English resources.
const originalScripts = {
  index: 'c3f1dfa532ddda580ace2940797e947ace39f7a97bdbd67e969cfbde8277ad57',
  search: '680b9207991949fbe0051e211ef37b9be23936b26cf41712fa8609589beae2b0',
  'regist-task': 'effb965dd14be1e654eb9064df6beb84328127d9c0c174bbadd5be0e8870bedc',
  Details: 'a994511e7cd5ec97f3a36d3012ee2548850a732552c488a4504a7f133b1e048b',
  DetailsLabel: 'fce06cf12a91b2ae291803240a76ecd0776b353135c5b5ba4e0cc2f0f64c28fc',
  DetailsRole: 'fce06cf12a91b2ae291803240a76ecd0776b353135c5b5ba4e0cc2f0f64c28fc',
  EditLabel: 'fce06cf12a91b2ae291803240a76ecd0776b353135c5b5ba4e0cc2f0f64c28fc',
  EditRole: '518b28d64b53dee6c1129693da6180cb0cceb3732992a7411df51976adfa04e2',
  DetailsTop: '5d63b5f81a835032b3030e3e17c773c081f68deca3a3b22bbc2e06a266941804',
  EditTop: '4fb28d2ee9856df0e1d47e38dfd63ed23ac078ec5aa429ea05640f1f4ebf6859',
  DetailsSheet: '746b5774e846240b9705c3a22ff3ddd9b3028392e7e94fc50a6d0d8c8ffea775',
  EditSheet: 'fd566a56adee17318f857cf8a1b7dc0a73518742d57f6211fc1cb8b4641f4938',
  DetailsClusterHistory: 'fce06cf12a91b2ae291803240a76ecd0776b353135c5b5ba4e0cc2f0f64c28fc',
};

test('Documents renders only project-owned EJS with original script outputs when legacy reads are blocked', async () => {
  const allowed = join(root, 'src/views') + '/';
  const reads: string[] = [];
  const check = (path: fs.PathLike) => {
    const name = String(path);
    assert(name.startsWith(allowed) && name.endsWith('.ejs'), 'Only Node EJS templates may be read.');
    reads.push(name);
  };
  const original = fs.readFile;
  const promiseRead = fs.promises.readFile;
  const fileLoader = ejs.fileLoader;
  mock.method(ejs, 'fileLoader', (path: string) => {
    check(path);
    return fileLoader(path);
  });
  mock.method(fs, 'readFile', (...args: Parameters<typeof fs.readFile>) => {
    assert(typeof args[0] !== 'number');
    check(args[0]);
    return original(...args);
  });
  mock.method(fs.promises, 'readFile', (...args: Parameters<typeof fs.promises.readFile>) => {
    assert(!(typeof args[0] === 'object' && 'fd' in args[0]));
    check(args[0] as fs.PathLike);
    return promiseRead(...args);
  });
  syncBuiltinESMExports();
  try {
    ejs.clearCache();
    const source = await documentViewSource();
    const scripts = new Map<string, string>([
      ['index', source.js],
      ['search', source.searchJs],
      ['regist-task', await documentTaskScript('0')],
    ]);
    for (const view of Object.keys(originalScripts)) {
      if (scripts.has(view)) continue;
      scripts.set(view, await documentDetailScript(view as Parameters<typeof documentDetailScript>[0], 123));
    }
    for (const [view, script] of scripts) {
      assert.doesNotMatch(script, /@(?:Model|IR|Html)|<%|__REP_ID__|__COPY_ERROR__|__TASK_CLOSED__/);
      assert.doesNotThrow(() => new Script(script), view);
      assert.equal(
        createHash('sha256').update(script).digest('hex'),
        originalScripts[view as keyof typeof originalScripts],
        view,
      );
    }
    assert.equal(reads.length, 10);
    for (const event of ['Edit', 'Complete'])
      for (const type of ['Direct', 'Webhook']) {
        assert(source.r[event + type + 'Templete'], 'Computed notification labels must be cloned too.');
      }
    const changed = await documentDetailScript('Details', 456, true);
    assert.match(changed, /localStorage\.setItem\('selectedRepTopId', 456\)/);
    assert.match(changed, /if \('TRUE' == 'TRUE'\)/);
    assert.doesNotMatch(changed, /selectedRepTopId', 123/);
    assert.notEqual(await documentTaskScript('2'), scripts.get('regist-task'));
    const html = await ejs.renderFile(join(root, 'src/views/manager/documents/details.ejs'), {
      ...source,
      base: '/ConMasManager',
      js: changed,
      report: { rep_top_id: 456, def_top_id: 100 },
      sheets: [],
      csrfToken: 'fixture',
      initPageIndex: '',
      errorViewName: '',
      initDetailsFunction: '',
      errorCode: '',
      backHref: '/ConMasManager/InputReport',
      directLinked: false,
      webhookLinked: false,
      externalTypes: 0,
    });
    assert.match(html, /id="conmasRepLabelFunction"/);
    assert.match(html, /id="conmasRoleFunction"/);
    assert.match(html, /InputReport\/DetailsTop\?/);
    assert.doesNotMatch(html, /\/mnt\/c\/|legacy\/decompiled|\.cshtml|\.resx/);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    ejs.clearCache();
  }
});

test('Basic toolbar preserves delete/restore/unlock, applicant and completed/history gates and confirmed POST forms', async () => {
  const source = await documentViewSource();
  const model = {
    ...source,
    base: '/ConMasManager',
    edit: false,
    error: '',
    csrfToken: '<fixture-token>',
    js: await documentDetailScript('DetailsTop', 123),
    previewOptions: { isLayer: false, isInitJudgeDisplay: false, isForciblyFontSize: false, isClusterLine: false },
    fields: [],
    outputs: [],
    lineColors: [],
    notifications: [],
    history: [],
    approvals: [],
    fontDeduction: '',
    audioFormat: 'm4a',
    attachment: false,
    openPdf: false,
    biometrics: false,
    identification: false,
    historyEnabled: true,
    permissions: { update: true, delete: true },
    report: {
      rep_top_id: 123,
      def_top_id: 100,
      rep_top_name: '<report>',
      public_status: 2,
      edit_refer_status: 1,
      current: true,
      role_update: true,
      role_delete: true,
      deleted: 0,
      locked: false,
      workflow_locked: false,
      applicant_locked: false,
      sys_update_user_name: '<workflow-user>',
      lock_user_name: '<locking-user>',
    },
  };
  for (const [changes, expected] of [
    [{}, ['img_edit', 'img_delete']],
    [{ current: false }, ['img_delete']],
    [{ edit_refer_status: 4 }, ['img_delete']],
    [{ applicant_locked: true }, ['img_delete']],
    [{ locked: true }, ['img_locked']],
    [{ locked: true, workflow_locked: true }, []],
    [{ locked: true, role_update: false }, []],
    [{ role_update: false, role_delete: false }, []],
    [{ deleted: 1 }, ['img_rivive']],
  ] as const) {
    const html = await ejs.renderFile(join(root, 'src/views/manager/documents/top.ejs'), {
      ...model,
      report: { ...model.report, ...changes },
    });
    const toolbar = html.slice(html.indexOf('id="functionBar"'), html.indexOf('<form id="form0"'));
    for (const name of ['img_edit', 'img_delete', 'img_locked', 'img_rivive'])
      assert.equal(toolbar.includes(`class="${name}"`), (expected as readonly string[]).includes(name));
    assert.match(html, /&lt;report&gt;/);
    if ('deleted' in changes) assert.match(toolbar, />Deleted<\/span>/);
    assert.doesNotMatch(html, /<locking-user>|<workflow-user>|<fixture-token>/);
    assert.match(html, /id="conmasDetailsTopForm" method="post" action="\/ConMasManager\/InputReport\/Delete"/);
    assert.match(html, /id="conmasUnLockForm" method="post" action="\/ConMasManager\/InputReport\/UnLock"/);
    assert.match(html, /id="actMode" name="actMode"/);
    assert.match(html, /name="__RequestVerificationToken" value="&lt;fixture-token&gt;"/);
  }
  const denied = await ejs.renderFile(join(root, 'src/views/manager/documents/top.ejs'), {
    ...model,
    permissions: { update: false, delete: false },
  });
  assert.doesNotMatch(
    denied.slice(denied.indexOf('id="functionBar"'), denied.indexOf('<form id="form0"')),
    /class="img_(edit|delete|locked|rivive)"/,
  );
  const actions: string[] = [];
  let confirmed = false;
  const context = {
    confirm: () => confirmed,
    $: (selector: unknown) => ({
      val: (value: unknown) => actions.push(`${selector}:${value}`),
      trigger: (value: unknown) => actions.push(`${selector}:${value}`),
    }),
  };
  runInNewContext(model.js + '\ndelDetailsTop("confirm", "ALL"); linkUnLock("confirm");', context);
  assert.deepEqual(actions, []);
  confirmed = true;
  runInNewContext(model.js + '\ndelDetailsTop("confirm", "ALL"); linkUnLock("confirm");', context);
  assert.deepEqual(actions, ['#actMode:ALL', '#conmasDetailsTopForm:submit', '#conmasUnLockForm:submit']);
});

test('Documents app-launch uses private configuration and fails explicitly without its compatibility key', async () => {
  const previous = process.env.CONMAS_URL_SCHEME_KEY;
  try {
    delete process.env.CONMAS_URL_SCHEME_KEY;
    await assert.rejects(documentSchemeAuth('fixture', 'password'), /not configured/);
    process.env.CONMAS_URL_SCHEME_KEY = 'fixture-scheme-key';
    const auth = await documentSchemeAuth('fixture', 'password');
    assert.equal(
      auth,
      encodeURIComponent(legacyEncrypt('user=fixture&pass=password', 'fixture-scheme-key')).replace(
        /%[0-9A-F]{2}/g,
        (value) => value.toLowerCase(),
      ),
    );
    assert.equal(legacyDecrypt(decodeURIComponent(auth), 'fixture-scheme-key'), 'user=fixture&pass=password');
    assert(!auth.includes('password'));
  } finally {
    if (previous === undefined) delete process.env.CONMAS_URL_SCHEME_KEY;
    else process.env.CONMAS_URL_SCHEME_KEY = previous;
  }
});

test('sheet EJS renders source text/date/time/select/check controls, conditional columns and all three inline fragments', async () => {
  const source = await documentViewSource();
  const row = (cluster_type: string, input_value: string, input_parameter = '', cluster_role = '1') => {
    const data = {
      cluster_type,
      input_value,
      input_parameter,
      cluster_role,
      display_value: input_value,
      cluster_name: cluster_type,
      rep_sheet_id: 11,
      cluster_id: 0,
      verified: 0,
      change_reason: '',
      comment_value: '',
      pin_value: '',
    };
    return { ...data, ...documentClusterInput(data) };
  };
  const clusters = [
    row('CalendarDate', '2026/11/09 13:14:15', 'UseTime=1'),
    row('Time', '12:34'),
    row('Select', 'Custom', 'Items=A,B;Labels=Alpha,Beta;Display=ItemsAndLabels;UseKeyboard=1'),
    row('MultiSelect', 'A,B', 'Items=A,B'),
    row('MultipleChoiceNumber', '2', 'Items=1,2;Labels=One,Two'),
    row('Check', 'True'),
    row('KeyboardText', '<textarea-fixture>'),
    row('InputNumeric', '1', 'KeypadMode=2', '0'),
    row('Select', 'hidden-secret', 'Items=hidden-secret;UseKeyboard=1', '2'),
  ];
  clusters[4].selected = 'Two';
  const html = await ejs.renderFile(join(root, 'src/views/manager/documents/sheet.ejs'), {
    ...source,
    base: '/ConMasManager',
    js: '',
    report: { rep_top_id: 1, def_top_id: 100, rep_top_name: 'Fixture' },
    sheet: { rep_sheet_id: 11, rep_sheet_name: 'Fixture sheet', rep_sheet_no: 1, show_change_reason: true },
    edit: true,
    error: '',
    permissions: { update: true },
    csrfToken: 'fixture',
    pageIndex: 0,
    pages: 1,
    clusters,
    references: [],
    layers: [],
    draws: [],
    isLayer: false,
    isInitJudgeDisplay: false,
  });
  assert.match(html, /name="rep_clusters\[0\]\.input_value_date" value="2026\/11\/09"/);
  assert.match(html, /name="rep_clusters\[0\]\.input_value_time" value="13:14:15"/);
  assert.match(html, /id="idConmasSelectBox2"/);
  assert.match(html, /<option value="A">A - Alpha<\/option>/);
  assert.match(html, /name="rep_clusters\[2\]\.IsKeyboardInput" value="true" checked/);
  assert.match(html, /class="cluster_edit"[^>]*>Custom<\/textarea>/);
  assert.match(html, /name="rep_clusters\[3\]\.multi_input_value" multiple/);
  assert.match(html, /<option value="Two" selected>2 - Two<\/option>/);
  assert.match(html, /name="rep_clusters\[5\]\.input_check_value" value="true" checked/);
  assert.match(html, /&lt;textarea-fixture&gt;/);
  assert.doesNotMatch(html, /hidden-secret|name="rep_clusters\[7\]\.input_value" value="1"[^>]*onChange/);
  assert.match(html, /cluster_setting_image\.png/);
  assert.match(html, /name="rep_clusters\[0\]\.Verified" value="true" disabled/);
  assert.match(html, /name="rep_clusters\[5\]\.comment_value"/);
  assert.match(html, /name="rep_clusters\[0\]\.ChangeReason"/);
  const calls: unknown[] = [];
  for (const script of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))
    runInNewContext(script[1], {
      $: (selector: string) => ({ timepicker: (options: unknown) => calls.push([selector, options]) }),
      fConmasKeyboardEnable: (index: string) => calls.push(index),
    });
  assert.equal(
    JSON.stringify(calls),
    JSON.stringify([
      ['#rep_clusters_0__input_value_time', { timeFormat: 'H:i:s' }],
      ['#rep_clusters_1__input_value', { timeFormat: 'H:i' }],
      '2',
    ]),
  );
});

test('shared cluster detail/history keeps boolean check values and does not replace filled values with stale verified marks', async () => {
  const source = await documentViewSource();
  const render = (cluster_type: string, input_value: string, display_value: string, verified: number) =>
    ejs.renderFile(join(root, 'src/views/manager/documents/cluster-value.ejs'), {
      ...source,
      base: '/ConMasManager',
      row: { cluster_type, input_value, display_value, verified, cluster_role: '1', rep_sheet_id: 11, cluster_id: 0 },
    });
  for (const input of ['True', 'TRUE', '1']) assert.match(await render('Check', input, 'True', 1), /○/);
  assert.doesNotMatch(await render('Check', 'False', 'False', 0), /○/);
  assert.match(await render('Check', 'False', 'False', 1), /Display non-required mark/);
  assert.match(await render('KeyboardText', 'filled', 'filled', 1), /filled/);
  assert.match(await render('KeyboardText', '', '', 1), /Display non-required mark/);
});

test('shared sheet previews preserve source detail/history switches, sparse sheet numbers and edit-only navigation', async () => {
  const source = await documentViewSource();
  const model = {
    ...source,
    base: '/ConMasManager',
    report: { rep_top_id: 7, def_top_id: 100 },
    sheet: { rep_sheet_no: 3, rep_sheet_name: '<sheet>' },
    pageIndex: 1,
    pages: 3,
    isLayer: true,
    isInitJudgeDisplay: true,
  };
  const render = (edit: boolean, clusterId: number | null) =>
    ejs.renderFile(join(root, 'src/views/manager/documents/sheet-preview.ejs'), { ...model, edit, clusterId });
  const details = await render(false, null);
  assert.match(details, /sheetNo=3&amp;isLayer=true&amp;isInitJudgeDisplay=true/);
  assert.match(details, /DetailsSheet\?repTopId=7&amp;pageIndex=1&amp;isLayer=false&amp;isInitJudgeDisplay=true/);
  assert.match(details, /DetailsSheet\?repTopId=7&amp;pageIndex=1&amp;isLayer=true&amp;isInitJudgeDisplay=false/);
  assert.match(details, /pageIndex=0/);
  assert.match(details, /pageIndex=2/);
  assert.match(details, /&lt;sheet&gt;/);
  const editing = await render(true, null);
  assert.doesNotMatch(editing, /layer_change|isLayer=|isInitJudgeDisplay=/);
  assert.match(editing, /EditSheet\?repTopId=7&amp;pageIndex=2/);
  const history = await render(false, 42);
  assert.match(history, /isClusterLine=true&amp;clusterId=42/);
  assert.match(history, /DetailsClusterHistory\?repTopId=7&amp;pageIndex=1&amp;clusterId=42/);
  assert.doesNotMatch(history, /img_preview_(?:prev|next)_e/);
});

test('sheet/history share protected GPS and approval/media rendering without exposing hidden values or executable data', async () => {
  const source = await documentViewSource();
  const gps = (row: Record<string, unknown>) =>
    ejs.renderFile(join(root, 'src/views/manager/documents/cluster-gps.ejs'), { ...source, row });
  assert.match(
    await gps({ gps_lat: '35.123456', gps_lon: '139.123456', gps_alt: '2', cluster_role: '1' }),
    /onclick="linkGMapl\(35\.123456,139\.123456\);"/,
  );
  assert.doesNotMatch(await gps({ gps_lat: '0.000000', gps_lon: '139.123456', cluster_role: '1' }), /Map/);
  assert.doesNotMatch(await gps({ gps_lat: '35.123456', gps_lon: '139.123456', cluster_role: '2' }), /35\.123456|Map/);
  const injection = await gps({ gps_lat: '1);alert(1)', gps_lon: '2', cluster_role: '1' });
  assert.doesNotMatch(injection, /onclick|<script/);
  const render = (row: Record<string, unknown>) =>
    ejs.renderFile(join(root, 'src/views/manager/documents/cluster-value.ejs'), {
      ...source,
      base: '/ConMasManager',
      row: { rep_sheet_id: 11, cluster_id: 4, cluster_role: '1', verified: 0, ...row },
    });
  const issued = await render({
    cluster_type: 'Create',
    input_value: '4',
    approver_name: '<issuer>',
    has_signature: true,
  });
  assert.match(issued, /\[Issuer\]/);
  assert.match(issued, /\[Date of issue\]/);
  assert.match(issued, /&lt;issuer&gt;/);
  assert.match(issued, /signFlg=true/);
  const remanded = await render({ cluster_type: 'Approve', input_value: '3', has_signature: true });
  assert.match(remanded, /applicant_detail_table/);
  assert.match(remanded, /approve_detail_table/);
  assert.doesNotMatch(remanded, /<img/);
  const drawing = await render({
    cluster_type: 'FreeDraw',
    input_value: '1',
    display_value: '<text>,second',
    draws: [{ key_id: 4, image_no: 3 }],
  });
  assert.match(drawing, /Input Text/);
  assert.match(drawing, /&lt;text&gt;/);
  assert.match(drawing, /GetLayerDraw\?repSheetId=11&amp;layerId=4&amp;imageNo=3&amp;type=cluster/);
  const historic = await render({
    cluster_type: 'Image',
    input_value: '',
    has_image: true,
    history_id: 'image-history',
  });
  assert.match(historic, /GetHistoryImage\?historyId=image-history/);
  assert.doesNotMatch(
    await render({ cluster_type: 'Image', input_value: '1', has_image: false, history_id: 'empty-history' }),
    /<img/,
  );
  assert.doesNotMatch(
    await render({
      cluster_type: 'FreeDraw',
      input_value: '1',
      display_value: 'hidden-drawing',
      draws: [{ key_id: 4, image_no: 3 }],
      cluster_role: '2',
    }),
    /GetLayerDraw|hidden-drawing/,
  );
});
