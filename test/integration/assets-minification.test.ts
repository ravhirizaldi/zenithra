import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createContext, Script } from 'node:vm';
import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { minifyAssets } from '../../scripts/minify-assets.js';

test('minified AJAX plugin does not leak helper globals and retains missing/named callbacks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'conmas-ajax-minify-'));
  try {
    const source = join(directory, 'source');
    const output = join(directory, 'output');
    await mkdir(source);
    const original = await readFile('public/Scripts/jquery.unobtrusive-ajax.min.js', 'utf8');
    await writeFile(join(source, 'ajax.js'), original);
    await minifyAssets(source, output);
    const code = await readFile(join(output, 'ajax.js'), 'utf8');
    const handlers = new Map<string, (this: unknown, event: { preventDefault(): void }) => void>();
    let request:
      | {
          beforeSend(xhr: unknown): unknown;
          complete(): void;
          success(data: string, status: string, xhr: unknown): void;
          data: { name: string; value: string }[];
        }
      | undefined;
    let completed = 0;
    const attributes: Record<string, string> = {
      'data-ajax-update': '#content',
      'data-ajax-complete': 'callbacks.onComplete',
    };
    const jquery = Object.assign(
      () => ({
        on: (_event: string, selector: string, handler: (this: unknown, event: { preventDefault(): void }) => void) =>
          handlers.set(selector, handler),
        data: () => undefined,
        attr: (name: string) => attributes[name],
        is: () => true,
        serializeArray: () => [],
        each: () => undefined,
        show: () => undefined,
        hide: () => undefined,
      }),
      {
        extend: (target: Record<string, unknown>, source: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(source)) if (value !== undefined) target[key] = value;
          return target;
        },
        ajax: (options: typeof request) => {
          request = options;
        },
      },
    );
    const context = createContext({
      document: {},
      window: {
        callbacks: {
          onComplete: () => {
            completed++;
          },
        },
      },
      jQuery: jquery,
    });
    const globals = Object.keys(context).sort();
    new Script(code).runInContext(context);
    assert.deepEqual(Object.keys(context).sort(), globals);
    Object.assign(context, { T: Object.defineProperty, u: Object.defineProperty, i: Object.defineProperty });
    const submit = handlers.get('form[data-ajax=true]');
    assert(submit);
    submit.call(
      { action: '/fixture', method: 'POST', getAttribute: (name: string) => attributes[name] ?? null },
      {
        preventDefault: () => undefined,
      },
    );
    assert(request);
    assert.equal(request.beforeSend({}), undefined);
    request.success('<div>Fixture</div>', 'success', { getResponseHeader: () => 'text/html' });
    request.complete();
    assert.equal(completed, 1);
    assert.equal(request.data[0].name, 'X-Requested-With');
    assert.equal(request.data[0].value, 'XMLHttpRequest');
    assert.equal(await readFile(join(source, 'ajax.js'), 'utf8'), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('all current browser and native/API static assets minify into an isolated copy without changing originals', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'conmas-all-assets-minify-'));
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  try {
    const originals = new Map<string, Buffer>();
    for (const file of await readdir('public', { recursive: true, withFileTypes: true })) {
      if (file.isFile()) {
        const path = join(file.parentPath, file.name);
        originals.set(path, await readFile(path));
      }
    }
    await minifyAssets('public', directory);
    let before = 0;
    let after = 0;
    for (const [file, original] of originals) {
      assert.equal(hash(await readFile(file)), hash(original));
      if (extname(file).toLowerCase() === '.map') continue;
      const output = await readFile(join(directory, file.slice('public/'.length)));
      before += original.length;
      after += output.length;
      const extension = extname(file).toLowerCase();
      if (extension === '.js') assert.doesNotThrow(() => new Script(output.toString('utf8')));
      else if (!['.css', '.html', '.htm'].includes(extension)) assert.equal(hash(output), hash(original));
    }
    assert(after < before);
    for (const file of ['src/routes/client.ts', 'src/routes/api.ts']) {
      const source = await readFile(file, 'utf8');
      assert.doesNotMatch(source, /CONMASSERVER|\/mnt\/c\//);
      assert.match(source, /productionBuild \? 'dist\/public' : 'public'/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('asset copies minify JS/CSS/HTML, preserve URLs/binaries/global functions and omit maps', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'conmas-assets-minify-'));
  try {
    const source = join(directory, 'source');
    const output = join(directory, 'output');
    await mkdir(join(source, 'nested'), { recursive: true });
    const script =
      '/*! Fixture license */\nfunction calculate(input) { var localValue = input + 1; return localValue * 2; }';
    const css = '/*! Fixture CSS license */\n.preview { color: #ffffff; background-image: url("../logo.png"); }';
    const binary = Buffer.from([0, 255, 13, 10, 128]);
    await writeFile(join(source, 'nested', 'script.js'), script);
    await writeFile(join(source, 'nested', 'style.css'), css);
    await writeFile(join(source, 'nested', 'script.js.map'), '{"sourcesContent":["private fixture source"]}');
    await writeFile(join(source, 'page.htm'), '<!-- fixture -->\n<div>\n  <b>Fixture</b>\n</div>');
    await writeFile(join(source, 'logo.png'), binary);
    await minifyAssets(source, output);
    const code = await readFile(join(output, 'nested', 'script.js'), 'utf8');
    const context = createContext({});
    new Script(code).runInContext(context);
    assert.equal(context.calculate(20), 42);
    assert.match(code, /Fixture license/);
    assert.doesNotMatch(code, /localValue|sourceMappingURL/);
    const style = await readFile(join(output, 'nested', 'style.css'), 'utf8');
    assert.match(style, /Fixture CSS license/);
    assert.match(style, /\.preview\{color:#fff;background-image:url\([^)]*\.\.\/logo\.png[^)]*\)\}/);
    assert.equal((await readFile(join(output, 'page.htm'), 'utf8')).trim(), '<div> <b>Fixture</b> </div>');
    assert.deepEqual(await readFile(join(output, 'logo.png')), binary);
    assert.equal(
      (await readdir(join(output, 'nested'))).some((file) => file.endsWith('.map')),
      false,
    );
    assert.equal(await readFile(join(source, 'nested', 'script.js'), 'utf8'), script);
    assert.equal(await readFile(join(source, 'nested', 'style.css'), 'utf8'), css);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
