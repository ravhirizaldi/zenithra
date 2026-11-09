import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

test('production build minifies JavaScript without breaking ESM paths, exports or diagnostic names', async () => {
  const { scripts, devDependencies } = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(
    scripts.build,
    'tsc --noEmit && esbuild "src/**/*.ts" --outbase=src --outdir=dist --platform=node --format=esm --target=es2022 --minify --keep-names --legal-comments=none --define:__CONMAS_MINIFY__=true && tsx scripts/minify-assets.ts',
  );
  assert.equal(devDependencies.esbuild, '0.28.2');
  assert.equal(scripts.start, 'node dist/server.js');

  const directory = await mkdtemp(join(tmpdir(), 'conmas-minified-build-'));
  try {
    await mkdir(join(directory, 'src', 'nested'), { recursive: true });
    await mkdir(join(directory, 'test'));
    await writeFile(join(directory, 'package.json'), '{"type":"module"}');
    await writeFile(join(directory, 'test', 'excluded.test.ts'), 'throw new Error("Never emitted");');
    await writeFile(
      join(directory, 'src', 'server.ts'),
      `
      import { fileURLToPath } from 'node:url';
      import { calculate, FixtureError } from './nested/helper.js';
      export { calculate } from './nested/helper.js';
      export const result = await Promise.resolve(calculate(20));
      export const diagnosticName = new FixtureError().constructor.name;
      export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
      declare const __CONMAS_MINIFY__: boolean;
      export const minifyOutput = typeof __CONMAS_MINIFY__ !== 'undefined' && __CONMAS_MINIFY__;
    `,
    );
    await writeFile(
      join(directory, 'src', 'nested', 'helper.ts'),
      `
      /*! BUILD_COMMENT_MUST_NOT_SHIP */
      export class FixtureError extends Error {}
      export function calculate(input: number) {
        const descriptiveLocalValue = input + 1;
        return descriptiveLocalValue * 2;
      }
    `,
    );
    await build({
      absWorkingDir: directory,
      entryPoints: ['src/**/*.ts'],
      outbase: 'src',
      outdir: 'dist',
      platform: 'node',
      format: 'esm',
      target: 'es2022',
      minify: true,
      keepNames: true,
      legalComments: 'none',
      define: { __CONMAS_MINIFY__: 'true' },
    });
    const files = (await readdir(join(directory, 'dist'), { recursive: true })).sort();
    assert.deepEqual(files, ['nested', join('nested', 'helper.js'), 'server.js'].sort());
    for (const file of ['server.js', join('nested', 'helper.js')]) {
      const code = await readFile(join(directory, 'dist', file), 'utf8');
      assert.equal(code.trim().split('\n').length, 1);
      assert.doesNotMatch(code, /BUILD_COMMENT_MUST_NOT_SHIP|descriptiveLocalValue|sourceMappingURL/);
    }
    const emitted = await import(pathToFileURL(join(directory, 'dist', 'server.js')).href);
    assert.equal(emitted.result, 42);
    assert.equal(emitted.calculate(0), 2);
    assert.equal(emitted.calculate.name, 'calculate');
    assert.equal(emitted.diagnosticName, 'FixtureError');
    assert.equal(emitted.projectRoot, directory + sep);
    assert.equal(emitted.minifyOutput, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
