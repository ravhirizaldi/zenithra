import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import { Script, createContext } from 'node:vm';
import ejs from 'ejs';
import { createApp, systemMenuFor } from '../../src/server.js';
import type { SystemPermissionMap, SystemPermissionScope } from '../../src/middleware/manager/system/permissions.js';

let server: Server;
let origin: string;

test('System menu matches legacy permission and FreeDrawOnly visibility combinations', () => {
  const scopes: SystemPermissionScope[] = ['user', 'group', 'terminal', 'system', 'data', 'customTable'];
  const flags = {
    directLinked: true,
    webhookLinked: true,
    uploadEnabled: true,
    backupLogEnabled: true,
    backupImageEnabled: true,
    autoOutputEnabled: true,
    serverLogEnabled: true,
    licenseUploadEnabled: true,
    hasFreeDrawLicense: true,
    freeDrawOnly: false,
  };
  const ids = (items: ReturnType<typeof systemMenuFor>): Set<string> =>
    new Set(items.flatMap((item) => [...(item.id ? [item.id] : []), ...ids(item.children ?? [])]));
  for (let bits = 0; bits < 64; bits++) {
    const permissions = { systemTab: true } as SystemPermissionMap;
    scopes.forEach(
      (scope, index) =>
        (permissions[scope] = { read: Boolean(bits & (1 << index)), edit: true, create: false, delete: true }),
    );
    for (const freeDrawOnly of [false, true]) {
      const visible = ids(systemMenuFor('fixture', permissions, { ...flags, freeDrawOnly }));
      const expected: Record<string, boolean> = {
        userFunction: permissions.user.read,
        userAccountOperationLogFunction: permissions.user.read && permissions.data.read,
        userDirectFunction: permissions.user.read && permissions.data.read && !freeDrawOnly,
        groupFunction: permissions.group.read,
        irfdFunction: permissions.group.read,
        termFunction: permissions.terminal.read,
        mailFunction: permissions.system.read && !freeDrawOnly,
        directFunction: permissions.system.read && !freeDrawOnly,
        webhookFunction: permissions.system.read && !freeDrawOnly,
        comFunction: permissions.system.read,
        uploadFunction: permissions.data.read && !freeDrawOnly,
        taskFunction: permissions.data.read && !freeDrawOnly,
        dataInputFunction: permissions.group.read && !freeDrawOnly,
        dataOutputFunction: permissions.group.read && !freeDrawOnly,
        lockManageFunction: permissions.data.read && !freeDrawOnly,
        opeartionLogFunction: permissions.data.read,
        definitionFormOperationLogFunction: permissions.data.read && !freeDrawOnly,
        inputReportOperationLogFunction: permissions.data.read && !freeDrawOnly,
        customMasterMaintenanceFunction: permissions.data.read && !freeDrawOnly,
        voiceCommonGrammarFunction: permissions.data.read && !freeDrawOnly,
        backupLogFunction: permissions.data.read && !freeDrawOnly,
        backupImageFunction: permissions.data.read && !freeDrawOnly,
        autoOutputFileFunction: permissions.data.read && !freeDrawOnly,
        serverLogFileFunction: permissions.system.read && !freeDrawOnly,
        licenseFunction: permissions.system.read,
        uploadLicenseFunction: permissions.system.read,
      };
      for (const [id, allowed] of Object.entries(expected))
        assert.equal(visible.has(id), allowed, `${bits}/${freeDrawOnly}/${id}`);
      for (const id of [
        'googleFunction',
        'boxFunction',
        'bim360Function',
        'mbCloudFunction',
        'meidFunction',
        'iwproFunction',
        'edgeOCRFunction',
      ])
        assert.equal(visible.has(id), false);
    }
  }
  const denied = { systemTab: false } as SystemPermissionMap;
  scopes.forEach((scope) => (denied[scope] = { read: false, edit: false, create: false, delete: false }));
  const standard = ids(systemMenuFor('conmasadmin', denied, { ...flags, hasFreeDrawLicense: false }));
  assert.equal(standard.has('irfdFunction'), false);
  assert.equal(standard.has('webhookFunction'), true);
  const limited = ids(systemMenuFor('conmasadmin', denied, { ...flags, freeDrawOnly: true }));
  assert.equal(limited.has('webhookFunction'), false);
  assert.equal(limited.has('licenseFunction'), true);
});

before(async () => {
  server = createApp(null, false).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

test('renders the reused Manager shell and System menu', async () => {
  const response = await fetch(`${origin}/ConMasManager/System`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /ConMas Manager/);
  assert.match(html, /System Manager/);
  assert.match(html, /Content\/ConMas\/styles\.css/);
  assert.match(html, /href="\/ConMasManager\/System"/);
  assert.doesNotMatch(html, /href="\/ConMasManager\/System\/Index/);
  assert.equal((await fetch(`${origin}/ConMasManager/System/Index`)).status, 200);
});

test('legacy browser-language helper lets the user date fields initialize their calendar popup', async () => {
  const html = await (await fetch(`${origin}/ConMasManager/System/Index`)).text();
  const helper = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].find((match) =>
    match[1].includes('function browserLanguage()'),
  )?.[1];
  assert(helper);
  const form = await ejs.renderFile('src/views/manager/system/user-form.ejs', {
    base: '/ConMasManager',
    csrfToken: 'fixture',
    userPage: { mode: 'CreateUser', record: {}, groups: [] },
  });
  const handler = form.split('\n').find((line) => line.includes("$(document).on('mousedown', '.datetime input'"));
  assert(handler);
  for (const navigator of [
    { language: 'en-US' },
    { language: 'ja-JP' },
    { userLanguage: 'en-US', language: 'ja-JP' },
    {},
  ]) {
    let onMouseDown: (() => void) | undefined;
    let options: unknown;
    const regional = { en: { dateFormat: 'yy/mm/dd' }, ja: { dateFormat: 'yy/mm/dd', closeText: '閉じる' } };
    const jquery = Object.assign(
      () => ({
        on: (_event: string, selector: string, callback: () => void) => {
          assert.equal(selector, '.datetime input');
          onMouseDown = callback;
        },
        datepicker: (value: unknown) => {
          options = value;
        },
      }),
      { datepicker: { regional } },
    );
    const context = createContext({ navigator, document: {}, $: jquery });
    new Script(helper).runInContext(context);
    new Script(handler).runInContext(context);
    assert(onMouseDown);
    onMouseDown();
    assert.equal(
      options,
      'userLanguage' in navigator || !('language' in navigator) || navigator.language?.startsWith('en')
        ? regional.en
        : regional.ja,
    );
  }
});

test('serves copied original assets', async () => {
  const response = await fetch(`${origin}/ConMasManager/Content/ConMas/styles.css`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /HeaderNormal/);
  const icon = await fetch(`${origin}/ConMasManager/Content/ConMas/images/base/conmas.ico`);
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get('content-type') ?? '', /image\/x-icon|image\/vnd.microsoft.icon/);
  const tree = await fetch(`${origin}/ConMasManager/Content/ConMas/images/treeview-default.gif`);
  assert.equal(tree.status, 200);
  const script = await fetch(`${origin}/ConMasManager/Scripts/jquery.treeview.js`);
  assert.equal(script.status, 200);
  assert.match(await script.text(), /treeview/);
});

test('does not accept login or unimplemented Manager routes', async () => {
  const login = await fetch(`${origin}/ConMasManager/Account/LogOn`, { method: 'POST' });
  const unknown = await fetch(`${origin}/ConMasManager/System/DeleteOperationLog`);
  const config = await fetch(`${origin}/ConMasManager/Web.config`);
  assert.equal(login.status, 501);
  assert.equal(unknown.status, 404);
  assert.equal(config.status, 503);
});

test('local Logout exits the preview without claiming to secure it', async () => {
  const response = await fetch(`${origin}/ConMasManager/Account/LogOff`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Local preview closed/);
  assert.match(html, /does not restrict access/);
});
