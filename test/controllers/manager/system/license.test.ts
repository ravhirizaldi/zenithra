import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import ejs from 'ejs';
import {
  directorySize,
  licenseNeedsActivation,
  summarizeLicense,
} from '../../../../src/controllers/manager/system/license.js';

test('legacy license activation uses expiration-field presence or positive storage', () => {
  assert.equal(licenseNeedsActivation(false, null), true);
  assert.equal(licenseNeedsActivation(false, 0), true);
  assert.equal(licenseNeedsActivation(false, 1), false);
  assert.equal(licenseNeedsActivation(true, null), false);
});

test('legacy storage totals omit fonts, logs, and symbolic links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'conmas-license-storage-'));
  try {
    await mkdir(join(root, 'fonts'));
    await mkdir(join(root, 'logs'));
    await mkdir(join(root, 'data'));
    await writeFile(join(root, 'main.bin'), '1234');
    await writeFile(join(root, 'fonts', 'font.bin'), 'ignored');
    await writeFile(join(root, 'logs', 'log.bin'), 'ignored');
    await writeFile(join(root, 'data', 'row.bin'), '12');
    const linkedFile = join(root, 'linked.bin');
    await symlink(join(root, 'main.bin'), linkedFile);

    assert.equal(await directorySize(root), '6');
    assert.equal(await directorySize(linkedFile), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy Excel and API defaults are enabled unless explicitly disabled', () => {
  const fields = new Map([
    ['User', '40'],
    ['Type', '1'],
  ]);
  assert.equal(summarizeLicense(fields)?.summary.excel, true);
  assert.equal(
    summarizeLicense(fields)?.summary.features.some((f) => f.name === 'API external system coordination'),
    true,
  );
  fields.set('Excel', '0');
  fields.set('ApiOption', '0');
  assert.equal(summarizeLicense(fields)?.summary.excel, false);
  assert.equal(
    summarizeLicense(fields)?.summary.features.some((f) => f.name === 'API external system coordination'),
    false,
  );
});

test('license upload shows legacy quotas, subscription wording and confirmation controls', async () => {
  const current = summarizeLicense(
    new Map([
      ['User', '40'],
      ['Type', '1'],
    ]),
  )!.summary;
  const uploaded = {
    ...current,
    user: 250,
    features: [{ name: 'i-Repo FreeDraw option', limit: 100, expires: '2099/12/31' }],
  };
  const used = { user: 1, freeDraw: 0 };
  const html = await ejs.renderFile('src/views/manager/system/license.ejs', {
    base: '/ConMasManager',
    csrfToken: 'test-token',
    systemLicensePage: {
      mode: 'upload',
      current: { license: {}, details: current, used },
      uploaded,
      fileHasUploaded: true,
      canUpload: true,
      uploadEnabled: true,
    },
  });
  assert.match(html, />Update License</);
  assert.match(html, />Current License Information</);
  assert.match(html, />New License Information</);
  assert.match(html, /width:400px;">40<\/td>/);
  assert.match(html, /width:400px;">250<\/td>/);
  assert.match(html, /Number of users : 100/);
  assert.match(html, /Subscription ends:2099\/12\/31/);
  assert.doesNotMatch(html, /1 \/ 40|0 \/ 250|0 \/ 100|Expire:/);
  assert.match(html, /value="Confirm"/);
  assert.match(html, /fConMasLockView\(\);">\s+<a /);
  const details = await ejs.renderFile('src/views/manager/system/license-summary.ejs', { license: current, used });
  assert.match(details, />1 \/ 40<\/td>/);
});
