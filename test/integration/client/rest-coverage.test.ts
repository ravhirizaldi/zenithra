import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type pg from 'pg';
import { createApp } from '../../../src/app.js';
import { clientConfiguration } from '../../../src/config/client.js';
import { root } from '../../../src/config/manager.js';
import { XMLParser } from 'fast-xml-parser';

const inventory = JSON.parse(readFileSync(join(root, 'docs/client-rest-coverage.json'), 'utf8')) as {
  defaultStatus: string;
  defaultAvailability: string;
  availabilityReview: { notAvailable: string[]; unknown: string[] };
  commands: { name: string; status?: string; node?: string }[];
  directHandlers: { additional: { path: string; availability?: string }[]; static: { path: string }[] };
  generalProcesses: { target: string; process: string; status?: string; node?: string }[];
  windowsClientEvidence: { commandNames: string[] };
};

test('installation availability applies to every inventory without treating missing source or Node code as vendor removal', () => {
  for (const name of [
    'conmas-api-coverage',
    'client-rest-coverage',
    'system-route-coverage',
    'system-license-mapping',
    'system-data-import-coverage',
    'system-webhook-mapping',
    'system-logging-mapping',
  ]) {
    const area = JSON.parse(readFileSync(join(root, `docs/${name}.json`), 'utf8'));
    assert.equal(area.availabilityPolicy, 'migration-inventory.md#installation-availability-classifier', name);
    assert.equal(area.scopePolicy, 'migration-inventory.md#authentication-scope-exclusions', name);
  }
  assert.equal(inventory.defaultAvailability, 'available');
  assert.deepEqual(inventory.availabilityReview.notAvailable, []);
  assert.deepEqual(
    inventory.directHandlers.additional
      .filter((entry) => entry.availability === 'unknown')
      .map((entry) => entry.path)
      .sort(),
    ['EditReport.aspx', 'Test/Uploader.aspx'],
  );
  assert.deepEqual([...inventory.availabilityReview.unknown].sort(), ['EditReport.aspx', 'Test/Uploader.aspx']);
  const imports = JSON.parse(readFileSync(join(root, 'docs/system-data-import-coverage.json'), 'utf8'));
  for (const name of ['RegistUser', 'RegistGroup']) {
    assert.equal(imports.commands.find((entry: { value: string }) => entry.value === name).status, 'pending');
  }
});

test('REST inventory retains all source commands, direct pages and GeneralProcess pairs without claiming routing is parity', () => {
  const configuration = clientConfiguration();
  assert.equal(inventory.defaultStatus, 'not-implemented');
  assert.equal(inventory.commands.length, 63);
  assert.equal(new Set(inventory.commands.map((command) => command.name)).size, 63);
  assert.deepEqual([...configuration.commands].sort(), inventory.commands.map((command) => command.name).sort());
  assert.equal(inventory.directHandlers.additional.length + inventory.commands.length, 74);
  assert.equal(inventory.directHandlers.static.length, 3);
  assert.equal(inventory.generalProcesses.length, 8);
  assert.equal(new Set(inventory.generalProcesses.map((pair) => pair.target + '/' + pair.process)).size, 8);
  assert.deepEqual(
    [...configuration.directHandlers].sort(),
    inventory.directHandlers.additional
      .filter((handler) => handler.path !== 'ConMasIReporter.aspx')
      .map((handler) => handler.path.slice(0, -5))
      .sort(),
  );
  for (const command of inventory.commands) {
    if (command.node) assert(readFileSync(join(root, command.node), 'utf8').includes(command.name), command.name);
  }
  assert.equal(inventory.commands.find((command) => command.name === 'RegistDefinition')?.status, 'partial');
  assert.equal(
    inventory.commands.find((command) => command.name === 'GetDefinitionUpdateList')?.status,
    'local-path-implemented',
  );
  assert.equal(inventory.commands.find((command) => command.name === 'DocumentRegistration')?.status, undefined);
  assert.equal(inventory.commands.find((command) => command.name === 'GetUserId')?.status, 'scope-excluded');
  assert.equal(
    inventory.commands.find((command) => command.name === 'GetAuthenticationType')?.status,
    'local-path-implemented',
  );
  for (const name of ['GetMasterList', 'GetMasterRecordList'])
    assert.equal(inventory.commands.find((command) => command.name === name)?.status, 'partial');
  for (const name of ['GetCustomMasterLabel', 'GetDocumentInfo'])
    assert.equal(inventory.commands.find((command) => command.name === name)?.status, 'local-path-implemented');
  assert.equal(
    inventory.generalProcesses.find((pair) => pair.target === 'Library' && pair.process === 'DocumentRegistration')
      ?.status,
    'local-path-implemented',
  );
  assert.equal(inventory.windowsClientEvidence.commandNames.length, 36);
  assert.equal(new Set(inventory.windowsClientEvidence.commandNames).size, 36);
  for (const command of inventory.windowsClientEvidence.commandNames)
    assert(configuration.commands.has(command), command);
});

test('direct-only REST pages recognize implemented diagnostics while retaining explicit failures and no fabricated command aliases', async () => {
  const db = {
    query: () => {
      throw new Error('Unexpected query');
    },
  } as unknown as pg.Pool;
  const server = createApp(db).listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/ConMasWeb/Rests`;
    for (const handler of clientConfiguration().directHandlers) {
      const response = await fetch(`${base}/${handler.toLowerCase()}.ASPX`);
      const diagnostics = [
        'Test/GetTest',
        'Test/PostTest',
        'Test/UploadTest',
        'Test/SessionTest',
        'Test/Sample',
      ].includes(handler);
      assert.equal(response.status, handler === 'GeneralProcess' || diagnostics ? 200 : 501, handler);
      assert.match(
        await response.text(),
        handler === 'GeneralProcess'
          ? /<code>1<\/code>/
          : diagnostics
            ? /<ConMas>|<data type="error">/
            : /<code>-1<\/code>/,
      );
    }
    const unknown = await fetch(`${base}/Unknown.aspx`, { redirect: 'manual' });
    assert.equal(unknown.status, 404);
    const unmapped = await fetch(`${base}/ConMasIReporter.aspx?command=GeneralProcess`);
    assert.equal(unmapped.status, 200);
    assert.match(await unmapped.text(), /<code>1<\/code>/);
    const missing = await fetch(`${base}/ConMasIReporter.aspx`, { redirect: 'manual' });
    assert.equal(missing.headers.get('location'), '/ConMasWeb/Rests/Error.htm');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('native binary failures use text/xml so unchanged Windows decoders do not treat XML as image bytes', async () => {
  const db = {
    query: () => {
      throw new Error('Unexpected query');
    },
  } as unknown as pg.Pool;
  const server = createApp(db).listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/ConMasWeb/Rests`;
    for (const command of ['GetMasterImage', 'GetBackgroundImage', 'GetDefinitionExcel', 'GetSheetBinaries']) {
      for (const direct of [false, true]) {
        const response = await fetch(`${base}/${direct ? command : 'ConMasIReporter'}.aspx`, {
          method: 'POST',
          body: new URLSearchParams(direct ? { topId: '1' } : { command, topId: '1' }),
        });
        assert.equal(response.status, 200);
        const mimeType = response.headers.get('content-type')!.split(';')[0];
        const data = await response.text();
        // GetMasterImageCommand.cs:56 treats every non-text/xml response as a successful image.
        assert(mimeType.startsWith('text/xml'), `${command}: Windows would decode this failure as binary data`);
        assert.equal(new XMLParser().parse(data).conmas.error.code, 5);
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
