import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { root } from '../src/config/manager.js';
import { nodeLicenseFile } from '../src/shared/license-counts.js';

test('MVC layers contain Manager menus and test discovery stays outside the production build', () => {
  for (const menu of ['system', 'labels', 'library', 'data-output', 'catalog']) {
    assert(existsSync(`src/controllers/manager/${menu}/index.ts`));
    assert(existsSync(`src/models/manager/${menu}/${menu === 'system' ? 'navigation' : 'index'}.ts`));
    assert(existsSync(`views/manager/${menu}`));
  }
  for (const feature of ['users', 'common']) assert(existsSync(`src/models/manager/system/${feature}.ts`));
  for (const feature of ['users', 'groups', 'devices']) {
    assert(existsSync(`src/controllers/manager/system/${feature}.ts`));
    assert(existsSync(`views/manager/system/${feature}.ejs`));
  }
  assert.equal(
    readdirSync('src', { recursive: true }).some((path) => String(path).startsWith('manager/')),
    false,
  );
  assert(existsSync('src/routes/manager/system.ts'));
  assert(existsSync('test/helpers/app.ts'));
  assert.equal(
    readdirSync('src', { recursive: true }).some((path) => String(path).endsWith('.test.ts')),
    false,
  );
  const { scripts } = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(scripts.test, 'tsx --test "test/**/*.test.ts"');
  const config = JSON.parse(readFileSync('tsconfig.json', 'utf8'));
  assert.equal(config.compilerOptions.rootDir, 'src');
  assert.deepEqual(config.include, ['src/**/*.ts']);
  const testConfig = JSON.parse(readFileSync('tsconfig.test.json', 'utf8'));
  assert.equal(testConfig.compilerOptions.noEmit, true);
  assert.deepEqual(testConfig.include, ['src/**/*.ts', 'test/**/*.ts']);
});

test('relocated configuration preserves project and license paths without reading or changing a license', () => {
  assert.equal(resolve(root), process.cwd());
  assert.equal(nodeLicenseFile, resolve('legacy/SettingFiles/xml/License.node.xml'));
});
