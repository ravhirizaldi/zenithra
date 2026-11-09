import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { root } from '../../src/config/manager.js';
import { clientLibraryDirectory } from '../../src/models/client-library.js';

test('library defaults to the project root independently of installed settings and working directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'conmas-library-path-'));
  const previousCwd = process.cwd();
  const previousSettings = process.env.CONMAS_CLIENT_SETTINGS;
  let configured: string | undefined;
  const db = {
    query: (async (_sql: string, values: string[]) => {
      assert.deepEqual(values, ['LIBRARY', 'BASE_FOLDER']);
      return { rows: configured === undefined ? [] : [{ com_value: configured }] };
    }) as pg.Pool['query'],
  };
  try {
    process.chdir(directory);
    process.env.CONMAS_CLIENT_SETTINGS = directory;
    const expected = join(root, 'SettingFiles', 'xml', 'Library');
    assert.equal(await clientLibraryDirectory(db), expected);
    configured = '';
    assert.equal(await clientLibraryDirectory(db), expected);
    configured = join(directory, 'missing');
    assert.equal(await clientLibraryDirectory(db), expected);
    configured = join(directory, 'file');
    await writeFile(configured, 'not a directory');
    assert.equal(await clientLibraryDirectory(db), expected);
    configured = directory;
    assert.equal(await clientLibraryDirectory(db), directory);
  } finally {
    process.chdir(previousCwd);
    if (previousSettings === undefined) delete process.env.CONMAS_CLIENT_SETTINGS;
    else process.env.CONMAS_CLIENT_SETTINGS = previousSettings;
    await rm(directory, { recursive: true, force: true });
  }
});
