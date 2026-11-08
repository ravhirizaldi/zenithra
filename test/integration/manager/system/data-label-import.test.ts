import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { createApp } from '../../../helpers/app.js';
import {
  importLabelLinks,
  labelLinkCommands,
  labelLinkImportRows,
} from '../../../../src/models/manager/system/data-label-import.js';

async function fixture(run: (db: pg.Pool, client: pg.PoolClient) => Promise<void>) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const db = {
    query: pool.query.bind(pool),
    connect: async () => ({ query: client.query.bind(client), release: () => {} }),
  } as unknown as pg.Pool;
  try {
    await client.query(`CREATE TEMP TABLE def_label (LIKE public.def_label INCLUDING ALL);
      CREATE TEMP TABLE def_rep_label (LIKE public.def_rep_label INCLUDING ALL);
      CREATE TEMP TABLE rep_label (LIKE public.rep_label INCLUDING ALL);
      CREATE TEMP TABLE mst_label_rep (mst_label_id integer PRIMARY KEY,binder_rep_id integer);
      INSERT INTO pg_temp.mst_label_rep VALUES (99,777),(10,NULL),(11,NULL);`);
    await run(db, client);
  } finally {
    await client.query(
      'DROP TABLE IF EXISTS pg_temp.def_label,pg_temp.def_rep_label,pg_temp.rep_label,pg_temp.mst_label_rep',
    );
    client.release();
    await pool.end();
  }
}

const variants = [
  {
    kind: 'definition',
    table: 'def_label',
    column: 'def_top_id',
    field: 'defTopId',
    tag: 'definitionLabel',
    command: 'RegistDefenitionLabel',
  },
  {
    kind: 'reportDefinition',
    table: 'def_rep_label',
    column: 'def_top_id',
    field: 'defTopId',
    tag: 'reportLabelDefinition',
    command: 'RegistReportLabelDefenition',
  },
  {
    kind: 'report',
    table: 'rep_label',
    column: 'rep_top_id',
    field: 'repTopId',
    tag: 'reportLabel',
    command: 'RegistReportLabel',
  },
] as const;

test('label-link XML uses source tags and explicit missing fields', () => {
  for (const variant of variants) {
    assert.equal(labelLinkCommands[variant.command], variant.kind);
    assert.deepEqual(
      labelLinkImportRows(
        `<conmas><${variant.tag}><labelId>4</labelId><action>A</action></${variant.tag}></conmas>`,
        'xml',
        variant.kind,
      ),
      [['A', '', '4']],
    );
    assert.throws(() => labelLinkImportRows('<!DOCTYPE conmas><conmas/>', 'xml', variant.kind));
  }
});

test(
  'all label-link variants retain A/D-only validation, independent duplicate errors and whole-target deletion',
  { skip: !process.env.DATABASE_URL },
  async () =>
    fixture(async (db, client) => {
      for (const variant of variants) {
        const run = (csv: string) =>
          importLabelLinks(db, labelLinkImportRows(csv, 'csv', variant.kind), variant.kind, 'actor', 'host');
        const result = await run('A,1,10\nA,1,11\nA,1,10\nU,1,12\nM,,12\nA,0,0\nA,-1,10\nA,1,\nD,1\n');
        assert.deepEqual(
          result.map((row) => row.code),
          [
            '0',
            '0',
            '10020',
            '11020',
            variant.kind === 'definition' ? '11020' : '11010',
            '0',
            '11030',
            '11010',
            '10010',
          ],
        );
        assert.equal(
          result[4].remark,
          variant.kind === 'definition' ? 'Input Error(action).' : `No Value Error(${variant.field}).`,
        );
        const rows = (
          await client.query(
            `SELECT mst_label_id,sys_regist_term,sys_regist_user FROM pg_temp.${variant.table} WHERE ${variant.column}=1 ORDER BY mst_label_id`,
          )
        ).rows;
        assert.deepEqual(rows, [
          { mst_label_id: 10, sys_regist_term: 'WEBAPI/host', sys_regist_user: 'actor' },
          { mst_label_id: 11, sys_regist_term: 'WEBAPI/host', sys_regist_user: 'actor' },
        ]);
        assert.equal((await run('D,1,999\n'))[0].code, '0');
        assert.equal(
          (await client.query(`SELECT 1 FROM pg_temp.${variant.table} WHERE ${variant.column}=1`)).rowCount,
          0,
        );
        assert.equal(
          (await client.query(`SELECT 1 FROM pg_temp.${variant.table} WHERE ${variant.column}=0`)).rowCount,
          1,
        );
      }
    }),
);

test(
  'report label assignments protect binder labels before add and delete',
  { skip: !process.env.DATABASE_URL },
  async () =>
    fixture(async (db, client) => {
      const results = await importLabelLinks(
        db,
        [
          ['A', '1', '10'],
          ['A', '1', '99'],
          ['D', '1', '99'],
        ],
        'report',
        'actor',
        'host',
      );
      assert.deepEqual(
        results.map((row) => row.code),
        ['0', '11000', '11000'],
      );
      assert.equal(results[1].remark, 'Field Error(labelId).');
      assert.deepEqual((await client.query('SELECT mst_label_id FROM pg_temp.rep_label WHERE rep_top_id=1')).rows, [
        { mst_label_id: 10 },
      ]);
    }),
);

test(
  'three label-link commands dispatch authenticated multipart CSV/XML and reject missing CSRF',
  { skip: !process.env.DATABASE_URL || !process.env.CONMAS_TEST_PASSWORD },
  async () =>
    fixture(async (db, client) => {
      const server = createApp(db).listen(0, '127.0.0.1');
      try {
        await new Promise<void>((resolve) => server.once('listening', resolve));
        const address = server.address();
        assert(address && typeof address !== 'string');
        const root = `http://127.0.0.1:${address.port}/ConMasManager`;
        const login = await fetch(root + '/Account/LogOn', {
          method: 'POST',
          body: new URLSearchParams({ UserName: 'conmasadmin', Password: process.env.CONMAS_TEST_PASSWORD! }),
          redirect: 'manual',
        });
        const cookie = login.headers.get('set-cookie')?.split(';')[0];
        assert(cookie);
        const page = await fetch(root + '/System/DataInput', { headers: { cookie } });
        assert.equal(page.status, 200);
        const token = (await page.text()).match(/name="__RequestVerificationToken" value="([^"]+)"/)?.[1];
        assert(token);
        const upload = (command: string, text: string, format: string, csrf = token) => {
          const body = new FormData();
          body.set('DataInputType', command);
          body.set('type', format);
          body.set('encoding', '65001');
          body.set('__RequestVerificationToken', csrf);
          body.set('file1', new Blob([text]), 'label-links.' + format);
          return fetch(root + '/System/DataInput', { method: 'POST', headers: { cookie }, body });
        };
        for (const variant of variants) {
          assert.equal((await upload(variant.command, 'A,1,10', 'csv', '')).status, 403);
          assert.equal((await client.query(`SELECT 1 FROM pg_temp.${variant.table}`)).rowCount, 0);
          const add = await upload(variant.command, 'A,1,10', 'csv');
          assert.equal(add.status, 200);
          assert.match(await add.text(), /Registration is successful/);
          assert.equal(
            (await client.query(`SELECT sys_regist_user FROM pg_temp.${variant.table} WHERE ${variant.column}=1`))
              .rows[0].sys_regist_user,
            'conmasadmin',
          );
          const xml = `<conmas><${variant.tag}><action>D</action><${variant.field}>1</${variant.field}><labelId>999</labelId></${variant.tag}></conmas>`;
          const remove = await upload(variant.command, xml, 'xml');
          assert.equal(remove.status, 200);
          assert.match(await remove.text(), /Registration is successful/);
          assert.equal((await client.query(`SELECT 1 FROM pg_temp.${variant.table}`)).rowCount, 0);
        }
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }
    }),
);
