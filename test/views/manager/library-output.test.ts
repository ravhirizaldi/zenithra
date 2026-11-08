import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Script, runInNewContext } from 'node:vm';
import ejs from 'ejs';
import {
  outputFieldLabels,
  outputSheetFields,
  outputTopFields,
} from '../../../src/models/manager/data-output/index.js';

const base = '/ConMasManager';
const labels = [
  {
    mst_label_id: 1,
    label_name: '<Library>',
    label_name_path: 'Parent/<Library>',
    label_id_path: '1',
    label_icon_id: 1,
  },
];
const list = { rows: [], index: 0, size: 10, pages: 1, total: 0, order: 'document_id', direction: 'ASC' };
const document = { document_id: 1, document_name: '<Document>', document_save_kbn: 0 };
const library = {
  base,
  csrfToken: 'fixture',
  error: '',
  mode: 'ComLIb',
  freeDrawOnly: false,
  input: {},
  labels,
  list,
  document,
  labelPermissions: { create: true, delete: true },
  permissions: { create: true, read: true, edit: true, delete: true },
  create: false,
  edit: false,
  fd: false,
  referenceTypes: ['OTHERS', 'PDF', 'URL'],
  draft: { files: [] },
  attached: [],
  noRoles: false,
  groups: [],
  roles: {},
  groupId: '',
  groupSearch: '',
  size: 10,
  index: 0,
  pages: 1,
  rows: [],
  irfd: {
    documentName: '<Revision>',
    pdfName: 'file.pdf',
    irfdName: 'file.irfd',
    selectedRevision: 2,
    history: [],
    images: [],
    texts: [],
    useHistory: false,
  },
};
const layout = {
  org: 1,
  name: '<Form>',
  fields: ['Top_rep_top_id'],
  sheets: [1, 2].map((org) => ({
    org,
    fields: ['Sheet_rep_sheet_name'],
    clusters: [{ id: 1, name: '<Cluster>', selected: true, display: false }],
  })),
};
const output = {
  base,
  csrfToken: 'fixture',
  error: '',
  labels,
  input: {},
  list,
  selection: { layouts: [layout], definitions: [], reports: [] },
  layout,
  topFields: outputTopFields,
  sheetFields: outputSheetFields,
  fieldLabels: outputFieldLabels,
  previews: [{ name: '<Preview>', rows: [['Header'], ['<value>']] }],
  row: { name: '<Info>' },
};

function checkMarkup(html: string) {
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) new Script(match[1]);
  const markup = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  const stack: string[] = [];
  for (const match of markup.matchAll(/<(\/?)(div|form|table|tr|th|td|fieldset|h2|button|span|ul|li)\b[^>]*>/gi)) {
    if (match[1]) assert.equal(stack.pop(), match[2], `Unbalanced ${match[0]}`);
    else {
      if (match[2] === 'form') assert(!stack.includes('form'), 'Nested forms');
      stack.push(match[2]);
    }
  }
  assert.deepEqual(stack, []);
  const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'Duplicate IDs');
  for (const match of markup.matchAll(/aria-controls="([^"]+)"/g))
    assert(ids.includes(match[1]), `Missing section ${match[1]}`);
  assert.match(markup, /id="Wrap" class="manager-transfer-workspace(?: manager-index-workspace)?"/);
  assert.doesNotMatch(markup, /image-edit_btn|sortAsc|sortDesc|class="title"/);
}

test('Library renders all existing view families with legacy controls, balanced sections and storage-specific fields', async () => {
  for (const mode of ['ComLIb', 'RepLIb', 'ImageLib']) {
    for (const view of ['index', 'details', 'info', 'role', 'history', 'images', 'log']) {
      const html = await ejs.renderFile('views/manager/library/index.ejs', { ...library, mode, view });
      checkMarkup(html);
      assert.doesNotMatch(html, /<Document>|<Library>/);
      if (view === 'index') {
        assert.match(html, /id="GridSection" class="manager-grid-scroll"/);
        assert.match(html, /class="sort asc"/);
        assert.match(html, /aria-label="Close search"/);
        assert.match(html, /aria-label="Close labels"/);
        assert.match(html, /id="labelForm" method="post"/);
        assert.match(html, /name="LabelCreateMode" value="1" disabled/);
        assert.match(html, /class="current" href="[^"]+LabelID=All/);
      }
    }
    for (const storage of [0, 1, 2]) {
      const html = await ejs.renderFile('views/manager/library/index.ejs', {
        ...library,
        mode,
        view: 'details',
        create: true,
        document: { ...document, document_save_kbn: storage },
      });
      checkMarkup(html);
      for (const match of html.matchAll(/<(?:tr|span|div)[^>]*data-library-storage="([012,]+)"([^>]*)>/g)) {
        assert.equal(/\bhidden\b/.test(match[2]), !match[1].split(',').includes(String(storage)));
      }
      assert.match(html, /aria-controls="documentInfo"/);
      assert.match(html, /aria-controls="labelInfo"/);
      assert.match(html, /aria-controls="GruopRoleSection"/);
    }
  }
});

test('IRFD images/history encode attachment identity, escape text/GPS and retain revision/section controls', async () => {
  const data = {
    ...library,
    fd: true,
    document: { ...document, document_save_kbn: 2 },
    irfd: {
      ...library.irfd,
      useHistory: true,
      history: [{ rev_no: 1, created_by: '<User>', updated_by: '<User>' }, { rev_no: 2 }],
      images: [
        {
          name: '<image>&名',
          format: 'jpeg',
          pageNumber: 3,
          location: { latitude: -6.5, longitude: 106.75, altitude: 12.5 },
        },
      ],
      texts: [{ pageNumber: 3, text: '<script>alert(1)</script>\nsecond line' }],
    },
  };
  for (const view of ['history', 'images']) {
    const html = await ejs.renderFile('views/manager/library/index.ejs', { ...data, view });
    checkMarkup(html);
    assert.match(html, /pageNumber=3&amp;format=jpeg&amp;name=%3Cimage%3E%26%E5%90%8D/);
    assert.match(html, /revNo=2/);
    assert.match(html, /isResize=true/);
    assert.match(html, /width="200" height="150"/);
    assert.match(html, /latitude:-6.5/);
    assert.match(html, /longitude:106.75/);
    assert.match(html, /maps\?q=-6.5%2C106.75/);
    assert.match(html, /selectedRevNo=1/);
    assert.match(html, /class="new"/);
    assert.match(html, /&lt;User&gt;/);
    assert.doesNotMatch(html, /<script>alert|<image>|imageNo=/);
    if (view === 'history') {
      assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
      assert.match(html, /GetPdf\?[^"]+revNo=2/);
      assert.match(html, /aria-controls="TextList"/);
    } else assert.doesNotMatch(html, /id="TextList"/);
  }
  const empty = await ejs.renderFile('views/manager/library/index.ejs', {
    ...data,
    view: 'history',
    irfd: library.irfd,
  });
  checkMarkup(empty);
  assert.doesNotMatch(empty, /id="historyList"|maps.google.com/);
});

test('Data Output lists, layouts, previews and error/info states keep original table/button selectors', async () => {
  for (const view of ['index', 'details', 'confirm', 'info', 'error']) {
    for (const kind of ['def', 'rep']) {
      const html = await ejs.renderFile('views/manager/data-output/index.ejs', { ...output, view, kind });
      checkMarkup(html);
      assert.doesNotMatch(html, /<Form>|<Preview>|<value>|<Cluster>|<Info>/);
      if (view === 'index') {
        assert.match(html, /id="GridSection" class="manager-grid-scroll"/);
        assert.match(html, /aria-label="Close search"/);
        assert.match(html, /class="img_next"/);
      }
      if (view === 'details') {
        assert.match(html, /id="infoTitle"/);
        assert.match(html, /id="outputSaveContent"/);
        for (const field of outputTopFields) assert(html.includes(`name="TopFields" value="${field}"`));
        for (const sheet of layout.sheets) {
          for (const field of outputSheetFields)
            assert(html.includes(`name="SheetFields_${sheet.org}" value="${field}"`));
          assert(html.includes(`aria-controls="outputSheet_${sheet.org}"`));
          assert(html.includes(`name="Cluster_${sheet.org}_1"`));
          assert(html.includes(`name="Display_${sheet.org}_1"`));
        }
      }
      if (view === 'confirm') assert.match(html, /class="preview_box manager-grid-scroll"/);
    }
  }
});

test('scoped layout corrections contain filters/tables without changing other Manager menus', async () => {
  const shared = await readFile('views/manager/shared/transfer-layout.ejs', 'utf8');
  assert.match(shared, /#Wrap\.manager-transfer-workspace \{ display:flex/);
  assert.match(shared, /#MainWrap \{ flex:1; min-width:0;/);
  assert.match(shared, /#Filters ul \{ position:static; float:none; display:flex; flex-wrap:wrap/);
  assert.match(shared, /\.manager-grid-scroll \{ overflow:auto;/);
  for (const file of ['manager/library/index', 'manager/data-output/index']) {
    const template = await readFile(`views/${file}.ejs`, 'utf8');
    assert(template.includes("include('../shared/transfer-layout')"));
    assert.doesNotMatch(template, /css\('margin-left'/);
  }
  const css = await readFile('public/Content/ConMas/grid.css', 'utf8');
  for (const selector of ['a.sort', 'a.asc', 'a.desc', 'th.sorting']) assert(css.includes(selector));
  assert((await readFile('public/Content/ConMas/styles.css', 'utf8')).includes('.img_edit2'));
});

test('Library wording, previews and permission controls match the installed English view families', async () => {
  const group = { group_id: 10, group_name_path: '<Group>' };
  const data = {
    ...library,
    document: { ...document, document_name_org: 'original.pdf', document_type: 'PDF' },
    groups: [group],
    roles: { 10: { read: true, edit: false } },
  };
  const detail = await ejs.renderFile('views/manager/library/index.ejs', { ...data, view: 'details' });
  assert.match(detail, /Original file name/);
  assert.match(detail, /Type of storage/);
  assert.match(detail, /Availability to save on tablet/);
  assert.match(detail, /Term of valid on tablet/);
  assert.match(detail, /<embed src="[^"]+\/GetPdf\?documentId=1"/);
  const editable = await ejs.renderFile('views/manager/library/index.ejs', { ...data, view: 'details', edit: true });
  assert.equal((editable.match(/class="image-ok_btn" type="submit">Confirm/g) || []).length, 2);
  assert.doesNotMatch(editable, />Fix</);
  const image = await ejs.renderFile('views/manager/library/index.ejs', { ...data, view: 'details', mode: 'ImageLib' });
  assert.match(
    image,
    /GetFreeDrawImageThumbnail\?documentId=1&amp;customSize=200|GetFreeDrawImageThumbnail\?documentId=1&customSize=200/,
  );
  const readOnly = await ejs.renderFile('views/manager/library/index.ejs', { ...data, view: 'role' });
  assert.match(readOnly, /Another group permission settings/);
  assert.match(readOnly, /Available to refer/);
  assert.match(readOnly, /name="GroupRolePage\[0\]\.IsReferRole" value="true"/);
  assert.doesNotMatch(readOnly, /<fieldset[^>]*disabled|type="checkbox"[^>]*aria-label="Refer/);
  assert.match(readOnly, /name="GroupSearchData.GroupId"/);
  const edit = await ejs.renderFile('views/manager/library/index.ejs', {
    ...data,
    view: 'role',
    edit: true,
    noRoles: true,
  });
  assert.match(edit, /class="manager-role-check"[^>]*checked disabled/);
  assert.match(edit, /name="IsRoleNone" value="true" checked/);
  assert.match(edit, /&lt;Group&gt;/);
  checkMarkup(edit);
});

test('Data Output toolbar, audit columns, field choices and confirmation use original-sized controls', async () => {
  const index = await ejs.renderFile('views/manager/data-output/index.ejs', { ...output, view: 'index', kind: 'def' });
  assert.match(index, /Select forms for data output/);
  assert(index.indexOf('onclick="outputNext()"') < index.indexOf('id="IndexList"'));
  for (const label of [
    'Original ID',
    'REV',
    'Registration date and time',
    'Registrant',
    'Last update date and time',
    'Last updated by',
  ])
    assert(index.includes(label));
  assert.match(index, /name="CheckedStateValue"[^>]*aria-label="Selected state"/);
  assert.match(index, /class="img_next cooperation_view"/);
  const details = await ejs.renderFile('views/manager/data-output/index.ejs', {
    ...output,
    layout: { ...layout, clusterDetails: true },
    view: 'details',
    kind: 'rep',
  });
  assert.match(details, /Basic information/);
  assert.match(details, /style="width:250px;">Input value \/ Displayed value/);
  assert.match(details, /type="radio" name="Display_1_1" value="false" checked/);
  assert.match(details, /name="IsClusterDetails" value="true" checked/);
  const confirm = await ejs.renderFile('views/manager/data-output/index.ejs', {
    ...output,
    view: 'confirm',
    kind: 'rep',
  });
  assert.match(confirm, /class="img_output_csv">OUTPUT/);
  assert.match(confirm, /\/DataOutput\/Details\?act=BACK_INDEX/);
  assert(confirm.indexOf('class="img_output_csv"') < confirm.indexOf('CSV preview'));
  const css = await readFile('public/Content/ConMas/styles.css', 'utf8');
  assert.match(css, /\.img_output_csv\s*\{[^}]*width:\s*178px;[^}]*height:\s*29px;/);
  const shared = await readFile('views/manager/shared/transfer-layout.ejs', 'utf8');
  assert.match(shared, /#ConMasOutputForm td > label/);
  assert.match(shared, /\.img_next\.cooperation_view \{ width:170px; background-size:170px 30px;/);
});

test('section and storage controls update visible state without clearing submitted values', async () => {
  const html = await ejs.renderFile('views/manager/library/index.ejs', { ...library, view: 'details', create: true });
  type Control = {
    value?: string;
    getAttribute?: (name: string) => string;
    setAttribute?: (name: string, value: string) => void;
  };
  type Handler = (this: Control, event?: unknown) => void;
  const handlers = new Map<string, Handler>();
  const fields = ['0', '1', '0,2', '1,2'].map((storage) => ({
    hidden: false,
    value: 'preserve',
    getAttribute: () => storage,
  }));
  const section = { hidden: false };
  const jquery = Object.assign(
    (arg: unknown) => {
      if (typeof arg === 'function') {
        arg();
        return;
      }
      return {
        on: (event: string, selector: string, callback: Handler) => {
          if (callback) handlers.set(selector, callback);
        },
        each: (callback: (this: (typeof fields)[number]) => void) => fields.forEach((field) => callback.call(field)),
        datepicker() {},
      };
    },
    { datepicker: { regional: { en: {} } } },
  );
  const context = {
    $: jquery,
    browserLanguage: () => 'en',
    document: { getElementById: () => section, querySelector: () => null },
  };
  const inline = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .filter((text) => text.trim());
  runInNewContext(inline[0], context);
  runInNewContext(inline[1], context);
  let expanded = 'true';
  const control = {
    getAttribute: (name: string) => (name === 'aria-expanded' ? expanded : 'documentInfo'),
    setAttribute: (_name: string, value: string) => {
      expanded = value;
    },
  };
  handlers.get('.manager-section-toggle')!.call(control);
  assert.equal(section.hidden, true);
  assert.equal(expanded, 'false');
  handlers.get('.manager-section-toggle')!.call(control);
  assert.equal(section.hidden, false);
  assert.equal(expanded, 'true');
  for (const value of ['0', '1', '2']) {
    handlers.get('input[name="Document.document_save_kbn"]')!.call({ value });
    for (const field of fields) {
      assert.equal(field.hidden, !field.getAttribute().split(',').includes(value));
      assert.equal(field.value, 'preserve');
    }
  }
});

test('Library hierarchy and populated rows retain nested label navigation and original row annotations', async () => {
  const child = { ...labels[0], mst_label_id: 2, label_name: 'Child', label_id_path: '1/2', children: [] };
  const parent = { ...labels[0], children: [child] };
  const html = await ejs.renderFile('views/manager/library/index.ejs', {
    ...library,
    view: 'index',
    input: { LabelID: '2' },
    labels: [parent, child],
    list: {
      ...list,
      rows: [
        { document_id: 3, document_name: 'Report', document_mobile_save: 1, document_save_kbn: 0, label_ids: [2] },
      ],
    },
  });
  checkMarkup(html);
  assert.match(html, /id="sidetreecontrol"/);
  assert.match(html, /<ul class="rank0">/);
  assert.equal((html.match(/href="[^"]+LabelID=2"/g) || []).length, 1);
  assert.match(html, /class="current" href="[^"]+LabelID=2"/);
  assert.match(html, /class="manager-document-labels"><li>Child<\/li>/);
  assert.match(html, /name="LabelSelectID" value="2"/);
  assert.doesNotMatch(html, /name="LabelCreateMode" value="1" disabled/);
  const denied = await ejs.renderFile('views/manager/library/index.ejs', {
    ...library,
    view: 'index',
    labelPermissions: { create: false, delete: false },
  });
  assert.doesNotMatch(denied, />Label Issue<|>Label Delete</);
});

test('list height follows the viewport/header on resize and initializes the original tree controls', async () => {
  const shared = await readFile('views/manager/shared/transfer-layout.ejs', 'utf8');
  const script = /<script>([\s\S]*?)<\/script>/.exec(shared)![1];
  const workspace = { style: { height: '' }, getBoundingClientRect: () => ({ top: 150 }) };
  const window = { innerHeight: 900 };
  let resize = () => {},
    treeOptions: Record<string, unknown> = {};
  const jquery = Object.assign(
    (arg: unknown) => {
      if (typeof arg === 'function') {
        arg();
        return;
      }
      return {
        on: (event: string, callback: () => void) => {
          if (arg === window && event === 'resize') resize = callback;
        },
        treeview: (options: Record<string, unknown>) => {
          treeOptions = options;
        },
        datepicker() {},
      };
    },
    { datepicker: { regional: { en: {} } } },
  );
  runInNewContext(script, {
    $: jquery,
    window,
    browserLanguage: () => 'en',
    document: { querySelector: () => workspace },
  });
  assert.equal(workspace.style.height, '740px');
  assert.equal(treeOptions.control, '#sidetreecontrol');
  for (const height of [600, 1080, 200]) {
    window.innerHeight = height;
    resize();
    assert.equal(workspace.style.height, `${Math.max(180, height - 160)}px`);
  }
});
