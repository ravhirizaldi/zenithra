import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type pg from 'pg';
import ejs from 'ejs';
import { createApp } from '../../src/app.js';

test('full-page and AJAX EJS rendering preserves output in development and production without minification', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'conmas-plain-render-'));
  let databaseCalls = 0;
  const fail = () => {
    databaseCalls++;
    throw new Error('Rendering must not access the database.');
  };
  try {
    await writeFile(
      join(directory, 'page.ejs'),
      '<!doctype html>\n<html>\n<body>\n<%- include("partial") %>\n</body>\n</html>',
    );
    const partial = `<!-- preserve -->
<button onclick="<%= handler %>"><%= value %></button>
<textarea><%= value %>  first\n second</textarea>
<span style="white-space:pre-wrap"> first  line\n second </span>
<script>function fixtureCallback() { var descriptiveLocalValue = 21; return descriptiveLocalValue * 2; }</script>`;
    await writeFile(join(directory, 'partial.ejs'), partial);
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
        const data = { value: '<unsafe>', handler: "return select('SearchDialog');" };
        const original = await ejs.renderFile(join(directory, view + '.ejs'), data);
        const html = await new Promise<string>((resolve, reject) =>
          app.render(view, data, (error, value) => (error ? reject(error) : resolve(value))),
        );
        assert.equal(html, original);
        assert.match(html, /<!-- preserve -->/);
        assert.match(html, /onclick="return select\(&#39;SearchDialog&#39;\);"/);
        assert.match(html, /&lt;unsafe&gt;/);
        assert.match(html, /descriptiveLocalValue/);
      }
    }
    assert.equal(databaseCalls, 0);
    assert.equal(await readFile(join(directory, 'partial.ejs'), 'utf8'), partial);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
