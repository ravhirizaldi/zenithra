import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Script, createContext } from 'node:vm';
import type pg from 'pg';
import type { Response } from 'express';
import ejs from 'ejs';
import { createApp } from '../../src/app.js';
import { minifyHtml } from '../../src/services/html-minify.js';
import { documentDetailScript, documentTaskScript, documentViewSource } from '../../src/services/manager/documents.js';
import { createPageRenderer } from '../../src/services/manager/page.js';

test('HTML minification preserves values, escaping, inline spacing, templates and license/conditional comments', async () => {
  const pre = '<pre> first  line\n second\tline </pre>';
  const textarea = '<textarea name="value"> first  line\n second\tline &lt;/textarea&gt; </textarea>';
  const styled = '<span style="white-space:pre-wrap;"> first  line\n second\tline </span>';
  const template = '<script type="text/x-jquery-tmpl"><div> ${name}  ${value} </div></script>';
  const html = `<!-- remove me -->\n<div><b>First</b> <b>Second</b></div>\n${pre}${textarea}${styled}${template}
    <!--! Fixture license --><!--[if IE]><span>Conditional</span><![endif]-->
    <form data-ajax="true" data-ajax-complete="onComplete"><input name="__RequestVerificationToken" value="fixture-token"></form>
    <style>.preview { color: #ffffff; margin: 0px 0px 0px 0px; }</style>
    <script>function onComplete() { var localValue = 20 + 1; window.result = localValue * 2; }
      window.encoded = "\\u003c/script\\u003e";</script>`;
  const output = await minifyHtml(html);
  assert(output.length < html.length);
  assert.doesNotMatch(output, /remove me|localValue|sourceMappingURL/);
  for (const fragment of [pre, textarea.replace(/&gt;/g, '>'), template]) assert(output.includes(fragment));
  assert.match(output, /<span style="white-space:pre-wrap"> first {2}line\n second\tline <\/span>/);
  assert.match(output, /<b>First<\/b> <b>Second<\/b>/);
  assert.match(output, /Fixture license/);
  assert.match(output, /\[if IE\]/);
  assert.match(output, /data-ajax-complete="onComplete"/);
  assert.match(output, /name="__RequestVerificationToken" value="fixture-token"/);
  assert.match(output, /<style>\.preview\{color:#fff;margin:0\}<\/style>/);
  const script = output.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert(script);
  const context = createContext({ window: {} });
  new Script(script).runInContext(context);
  assert.equal(context.onComplete.name, 'onComplete');
  context.onComplete();
  assert.equal(context.window.result, 42);
  assert.equal(context.window.encoded, '</script>');
  assert.equal((output.match(/<\/script>/g) ?? []).length, 2);
});

test('styled whitespace survives nested same-tag elements, quotes and important declarations', async () => {
  for (const mode of ['pre', 'pre-wrap', 'pre-line', 'break-spaces']) {
    const html = `<div title="x > y" style="WHITE-SPACE: ${mode} !important"> first  line\n<div> nested  text </div>\n last  line </div>`;
    const output = await minifyHtml(html);
    assert.match(output, /> first {2}line\n<div> nested {2}text <\/div>\n last {2}line <\/div>$/);
  }
});

test('inline handlers keep return/this/arguments and invalid scripts fail without exposing source', async () => {
  const output = await minifyHtml(
    '<button onclick="var localValue = arguments[0]; this.value = localValue; return false;">Click</button>',
  );
  const handler = output.match(/onclick="([^"]*)"/)?.[1];
  assert(handler);
  const context = createContext({});
  const callback = new Script('(function(event){' + handler + '})').runInContext(context);
  const element = { value: '' };
  assert.equal(callback.call(element, 'fixture'), false);
  assert.equal(element.value, 'fixture');
  await assert.rejects(minifyHtml('<script>function fixture_private_source( {</script>'), {
    message: 'HTML minification failed.',
    code: 'HTML_MINIFICATION_FAILED',
  });
});

test('EJS-escaped inline handlers minify as decoded JavaScript without exposing escaped markup', async () => {
  const html = ejs.render('<button onclick="<%= handler %>"><%= text %></button>', {
    handler: "return select('SearchDialog');",
    text: '<script>unsafe</script> &lt;fixture&gt;',
  });
  const output = await minifyHtml(html);
  assert.doesNotMatch(output, /<script>/);
  const context = createContext({ select: (name: string) => name });
  const handler = output.match(/onclick="([^"]*)"/)?.[1];
  assert(handler);
  const callback = new Script('(function(){' + handler.replace(/&#34;/g, '"') + '})').runInContext(context);
  assert.equal(callback(), 'SearchDialog');
});

test('production Express EJS engine minifies full pages and AJAX partials; development output stays unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'conmas-render-minify-'));
  let databaseCalls = 0;
  const fail = () => {
    databaseCalls++;
    throw new Error('Minification must not access the database.');
  };
  try {
    await writeFile(
      join(directory, 'page.ejs'),
      '<!doctype html>\n<html>\n<body>\n<%- include("partial") %>\n</body>\n</html>',
    );
    await writeFile(
      join(directory, 'partial.ejs'),
      '<!-- remove -->\n<div>\n  <b><%= value %></b>\n</div>\n<textarea><%= value %></textarea>',
    );
    for (const mode of ['development', 'production']) {
      const previous = process.env.NODE_ENV;
      let app: ReturnType<typeof createApp>;
      try {
        process.env.NODE_ENV = mode;
        app = createApp({ query: fail, connect: fail } as unknown as pg.Pool, false);
      } finally {
        if (previous === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previous;
      }
      app.set('views', directory);
      for (const view of ['page', 'partial']) {
        const data = { value: '<unsafe>  first\n second' };
        const original = await ejs.renderFile(join(directory, view + '.ejs'), data);
        const html = await new Promise<string>((resolve, reject) => {
          app.render(view, data, (error, value) => (error ? reject(error) : resolve(value)));
        });
        assert.equal(html, mode === 'production' ? await minifyHtml(original) : original);
        assert.match(html, /&lt;unsafe(?:&gt;|>)/);
        assert.match(html, /<textarea>&lt;unsafe(?:&gt;|>) {2}first\n second<\/textarea>/);
      }
    }
    assert.equal(databaseCalls, 0);
    assert.match(await readFile(join(directory, 'partial.ejs'), 'utf8'), /<!-- remove -->/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Documents-generated script families remain valid after HTML minification', async () => {
  const source = await documentViewSource();
  const scripts = [source.js, source.searchJs, await documentTaskScript('0'), await documentTaskScript('2')];
  for (const view of [
    'Details',
    'DetailsLabel',
    'DetailsRole',
    'EditLabel',
    'EditRole',
    'DetailsTop',
    'EditTop',
    'DetailsSheet',
    'EditSheet',
    'DetailsClusterHistory',
    'DetailsClusterHistoryTop',
  ] as const)
    scripts.push(await documentDetailScript(view, 42));
  for (const script of scripts) {
    const html = await minifyHtml('<script>' + script + '</script>');
    const code = html.match(/^<script>([\s\S]*)<\/script>$/)?.[1];
    assert(code);
    assert.doesNotThrow(() => new Script(code));
  }
});

test('shared Manager shells minify without losing navbar/escaping or breaking their inline scripts', async () => {
  const render = createPageRenderer(true, true);
  for (const active of ['InputReport', 'System', 'Label', 'Library', 'DataOutput']) {
    let data: Record<string, unknown> = {};
    render(
      {
        locals: { labelPermissions: { refer: true } },
        render: (_view: string, locals: Record<string, unknown>) => {
          data = locals;
        },
      } as unknown as Response,
      {
        active,
        section: '',
        login: false,
        title: 'Fixture',
        userName: '<Viewer>',
        documentPage: active === 'InputReport' ? { r: {}, settings: { menu: {} } } : null,
      },
    );
    const original = await ejs.renderFile('src/views/manager/page.ejs', data, {
      includer: () => ({ template: ' ' }),
    });
    const html = await minifyHtml(original);
    assert(html.length < original.length);
    assert.match(html, /&lt;Viewer>/);
    assert.match(html, /Account\/LogOff">Logout<\/a>/);
    assert.match(html, /href="\/ConMasManager\/System">System<\/a>/);
    for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))
      assert.doesNotThrow(() => new Script(match[1]));
  }
});
