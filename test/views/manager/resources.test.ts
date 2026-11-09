import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Script } from 'node:vm';
import type { Response } from 'express';
import type pg from 'pg';
import ejs from 'ejs';
import { createApp } from '../../../src/app.js';
import { managerResourceLocals, managerResources, managerScriptText } from '../../../src/config/manager/resources.js';
import { r, v } from '../../../src/config/manager/documents/resources.js';
import { root } from '../../../src/config/manager.js';
import { createPageRenderer } from '../../../src/services/manager/page.js';

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => (entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)])),
  );
  return nested.flat();
}

test('every Manager page and partial compiles with a resource catalog and all static resource keys exist', async () => {
  const templates = (await files(join(root, 'src/views/manager'))).filter((file) => file.endsWith('.ejs'));
  assert(templates.length > 0);
  for (const file of templates) {
    const source = await readFile(file, 'utf8');
    assert.doesNotThrow(() => ejs.compile(source, { filename: file }), file);
    if (file.includes('/documents/scripts/')) continue;
    const area = source.match(/^<% const ui = managerResources\["([\w-]+)"\]; %>/)?.[1];
    assert(area && Object.hasOwn(managerResources, area), file);
    const catalog = managerResources[area as keyof typeof managerResources];
    const expressions = [...source.matchAll(/<%([\s\S]*?)%>/g)].map((match) => match[1]).join('\n');
    for (const match of expressions.matchAll(
      /\bui\[((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'))\]|\bui\.([A-Za-z_]\w*)/g,
    )) {
      const key = match[2] ?? new Script(match[1]).runInNewContext();
      assert(Object.hasOwn(catalog, key), `${file}: ${key}`);
      assert(catalog[key], `${file}: blank ${key}`);
    }
    const html = source.replace(/<%[\s\S]*?%>/g, '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
    assert.doesNotMatch(html, /<(?:label|button|th|h[1-6]|legend)\b[^>]*>\s*[A-Za-z][^<]*</, file);
  }
  for (const file of templates.filter((file) => file.includes('/documents/'))) {
    const source = await readFile(file, 'utf8');
    const expressions = [...source.matchAll(/<%([\s\S]*?)%>/g)].map((match) => match[1]).join('\n');
    for (const match of expressions.matchAll(/(?<![\w$])([rv])\.([A-Za-z_]\w*)/g))
      assert(Object.hasOwn(match[1] === 'r' ? r : v, match[2]), `${file}: ${match[0]}`);
  }
});

test('resource script strings retain both legacy quote styles and cannot close their script element', () => {
  for (const value of [
    'Logout',
    'Don\'t "mix" quotes',
    '\\"\'\n\r\t',
    '</script><script>alert(1)</script>',
    '\u2028\u2029',
  ]) {
    for (const quote of ["'", '"']) {
      const encoded = managerScriptText(value, quote);
      assert.equal(new Script(encoded).runInNewContext(), value);
      assert.equal(encoded[0], quote);
      assert.doesNotMatch(encoded, /<\/script/i);
    }
  }
});

test('Manager-owned titles, navigation, field captions and validation messages resolve to existing resource keys', async () => {
  let references = 0;
  for (const directory of ['controllers', 'models', 'services']) {
    for (const file of await files(join(root, 'src', directory, 'manager'))) {
      if (!file.endsWith('.ts')) continue;
      const source = await readFile(file, 'utf8');
      const area = source.match(/text as pageText.*?config\/manager\/([\w-]+)\/resources\.js/)?.[1];
      if (!area) continue;
      const catalog = managerResources[area as keyof typeof managerResources];
      for (const match of source.matchAll(/\bpageText\[((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'))\]/g)) {
        const key = new Script(match[1]).runInNewContext();
        assert(Object.hasOwn(catalog, key), `${file}: ${key}`);
        assert(catalog[key], `${file}: blank ${key}`);
        references++;
      }
    }
  }
  assert(references > 0);
});

test('System file lists render resource-backed controls with empty, populated and error pagination states', async () => {
  for (const mode of ['backup', 'autoOutput', 'serverLog', 'error']) {
    for (const populated of [false, true]) {
      const html = await ejs.renderFile(join(root, 'src/views/manager/system/files.ejs'), {
        ...managerResourceLocals,
        base: '/ConMasManager',
        csrfToken: 'fixture',
        systemFilesPage: {
          mode,
          type: 0,
          route: 'BackupFile',
          error: '',
          deleteErrors: [],
          title: 'Fixture files',
          searchText: '',
          searchLabel: 'Fixture search',
          emptyMessage: 'Fixture empty',
          deleteConfirmMessage: 'Fixture confirm',
          rootFolder: '',
          currentPath: '',
          rootPath: '',
          hasPermissionToDelete: false,
          files: populated
            ? [
                {
                  fileName: '<fixture.txt>',
                  folder: 'File',
                  dateText: '2026/11/09',
                  sizeText: '1',
                  src: '',
                  physicalId: '',
                },
              ]
            : [],
          page: {
            totalPages: populated ? 1 : 0,
            pageSize: 10,
            pageNo: 1,
            pageSizes: [10],
            startPageNo: 1,
            endPageNo: populated ? 1 : 0,
            hasPreviousPage: false,
            hasNextPage: false,
            startItemNo: 1,
            endItemNo: 1,
            totalItems: 1,
          },
        },
      });
      for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))
        assert.doesNotThrow(() => new Script(match[1]));
      assert.equal((html.match(/class="pagination"/g) ?? []).length, mode !== 'error' && populated ? 2 : 0);
      if (mode !== 'error' && populated) assert.match(html, /&lt;fixture\.txt&gt;/);
    }
  }
});

test('shared navbar supplies nonempty login/logout text on every Manager surface without Documents resources', async () => {
  const render = createPageRenderer(true, true);
  for (const active of [
    '',
    'InputReport',
    'System',
    'Label',
    'Library',
    'DataOutput',
    'DefReport',
    'AutoGenerate',
    'Schedule',
    'CustomMaster',
    'CustomMenu',
    'Binder',
  ]) {
    let data: Record<string, unknown> = {};
    const response = {
      locals: { labelPermissions: { refer: true } },
      render: (_view: string, locals: Record<string, unknown>) => {
        data = locals;
      },
    } as unknown as Response;
    render(response, {
      active,
      section: '',
      login: false,
      title: 'Fixture',
      userName: '<Viewer>',
      documentPage: active === 'InputReport' ? { r: {}, settings: { menu: {} } } : null,
    });
    const html = await ejs.renderFile(join(root, 'src/views/manager/page.ejs'), data, {
      includer: () => ({ template: ' ' }),
    });
    assert.match(html, /Logged-in/);
    assert.match(html, /Account\/LogOff">Logout<\/a>/);
    assert.match(html, /&lt;Viewer&gt;/);
    const header = html.slice(html.indexOf('id="LoginStatus"'), html.indexOf('id="GMenu"'));
    assert.doesNotMatch(header, /undefined|Account\/LogOff">\s*<\/a>/);
    const navigation = html.slice(html.indexOf('id="GMenu"'), html.indexOf('id="Main"'));
    assert.match(navigation, /href="\/ConMasManager\/System">System<\/a>/);
    assert.equal((navigation.match(/<li\b/g) ?? []).length, 11);
    assert.doesNotMatch(navigation, /style=|font-size:|width:/);
  }
});

test('AJAX and standalone Manager renders receive the same project-owned resources without database access', async () => {
  let calls = 0;
  const fail = () => {
    calls++;
    throw new Error('Resource render must not access the database');
  };
  const app = createApp({ query: fail, connect: fail } as unknown as pg.Pool, false);
  assert.equal(app.locals.managerResources, managerResources);
  const html = await new Promise<string>((resolve, reject) =>
    app.render('manager/account/session-timeout', { base: '/ConMasManager' }, (error, value) =>
      error ? reject(error) : resolve(value),
    ),
  );
  assert.match(html, /Session was time out\. Please log-in again\./);
  assert.equal(calls, 0);
  assert.equal(managerResourceLocals.managerResources.shared.Logout, 'Logout');
});
