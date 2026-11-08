import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { resolvePathUnderRoot } from '../../../../src/controllers/manager/system/files.js';

test('system file paths stay within configured root and reject traversal', () => {
  const root = '/srv/conmas/output';
  assert.equal(resolvePathUnderRoot(root, 'report/2026'), resolve(root, 'report/2026'));
  assert.equal(resolvePathUnderRoot(root, root), resolve(root));
  assert.throws(() => resolvePathUnderRoot(root, '../logs'), /Invalid file path/);
  assert.throws(() => resolvePathUnderRoot(root, resolve(root, '../logs')), /Invalid file path/);
  assert.throws(() => resolvePathUnderRoot(root, 'report\\..\\logs'), /Invalid file path/);
});
