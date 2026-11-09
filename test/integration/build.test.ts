import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

test('production build uses plain TypeScript without minification or browser asset processing', async () => {
  const { scripts, dependencies, devDependencies } = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(scripts.build, 'tsc');
  assert.equal(devDependencies.esbuild, undefined);
  assert.equal(devDependencies.terser, undefined);
  assert.equal(dependencies['html-minifier-terser'], undefined);
  assert.equal(scripts.start, 'node dist/server.js');

  const directory = await mkdtemp(join(tmpdir(), 'conmas-plain-build-'));
  try {
    await mkdir(join(directory, 'src', 'nested'), { recursive: true });
    await mkdir(join(directory, 'test'));
    await writeFile(join(directory, 'package.json'), '{"type":"module"}');
    await writeFile(join(directory, 'test', 'excluded.test.ts'), 'throw new Error("Never emitted");');
    await writeFile(
      join(directory, 'src', 'server.ts'),
      `
      import { calculate, FixtureError } from './nested/helper.js';
      export { calculate } from './nested/helper.js';
      export const result = await Promise.resolve(calculate(20));
      export const diagnosticName = new FixtureError().constructor.name;
      export const projectRoot = new URL('../', import.meta.url).href;
    `,
    );
    await writeFile(
      join(directory, 'src', 'nested', 'helper.ts'),
      `
      /*! BUILD_COMMENT_REMAINS */
      export class FixtureError extends Error {}
      export function calculate(input: number) {
        const descriptiveLocalValue = input + 1;
        return descriptiveLocalValue * 2;
      }
    `,
    );
    const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile);
    assert.equal(config.error, undefined);
    const options = ts.convertCompilerOptionsFromJson(config.config.compilerOptions, process.cwd());
    assert.equal(options.errors.length, 0);
    const program = ts.createProgram([join(directory, 'src/server.ts')], {
      ...options.options,
      rootDir: join(directory, 'src'),
      outDir: join(directory, 'dist'),
      types: [],
    });
    assert.equal(ts.getPreEmitDiagnostics(program).length, 0);
    assert.equal(program.emit().emitSkipped, false);
    const files = (await readdir(join(directory, 'dist'), { recursive: true })).sort();
    assert.deepEqual(files, ['nested', join('nested', 'helper.js'), 'server.js'].sort());
    for (const file of ['server.js', join('nested', 'helper.js')]) {
      const code = await readFile(join(directory, 'dist', file), 'utf8');
      assert(code.trim().split('\n').length > 1);
      assert.doesNotMatch(code, /sourceMappingURL/);
    }
    const helper = await readFile(join(directory, 'dist/nested/helper.js'), 'utf8');
    assert.match(helper, /BUILD_COMMENT_REMAINS/);
    assert.match(helper, /descriptiveLocalValue/);
    const emitted = await import(pathToFileURL(join(directory, 'dist', 'server.js')).href);
    assert.equal(emitted.result, 42);
    assert.equal(emitted.calculate(0), 2);
    assert.equal(emitted.calculate.name, 'calculate');
    assert.equal(emitted.diagnosticName, 'FixtureError');
    assert.equal(emitted.projectRoot, pathToFileURL(directory + sep).href);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
