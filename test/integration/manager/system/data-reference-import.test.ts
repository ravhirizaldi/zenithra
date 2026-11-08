import 'dotenv/config';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import { createApp } from '../../../helpers/app.js';
import {
  importReferenceFiles,
  importReferences,
  referenceImportRows,
} from '../../../../src/models/manager/system/data-reference-import.js';

async function fixture(run: (db: pg.Pool, client: pg.PoolClient, directory: string) => Promise<void>) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const directory = await mkdtemp(join(tmpdir(), 'conmas-reference-route-'));
  const db = {
    query: async (text: string, values?: unknown[]) => {
      if (text.includes("com_name='REFERENCE_PHYSICAL'")) return { rows: [{ com_value: directory }] };
      if (values?.[0] === 'VIRTUAL_DIRECTORY')
        return {
          rows: [
            { com_name: 'REFERENCE_PHYSICAL', com_value: directory },
            { com_name: 'REFERENCE_VIRTUAL', com_value: '/fixture-reference' },
          ],
        };
      return pool.query(text, values);
    },
    connect: async () => ({ query: client.query.bind(client), release: () => {} }),
  } as unknown as pg.Pool;
  try {
    await client.query(`CREATE TEMP TABLE def_sheet (LIKE public.def_sheet INCLUDING ALL);
      CREATE TEMP TABLE rep_sheet (LIKE public.rep_sheet INCLUDING ALL);
      CREATE TEMP TABLE def_reference (LIKE public.def_reference INCLUDING ALL);
      CREATE TEMP TABLE rep_reference (LIKE public.rep_reference INCLUDING ALL);
      CREATE TEMP TABLE mst_common (LIKE public.mst_common INCLUDING ALL);
      CREATE TEMP TABLE user_lock (LIKE public.user_lock INCLUDING ALL);
      INSERT INTO pg_temp.mst_common (com_id,com_key,com_value) VALUES (1,'REFERENCE_TYPE','file'),(2,'REFERENCE_TYPE','url');`);
    for (const kind of ['def', 'rep']) {
      await client.query(
        `INSERT INTO pg_temp.${kind}_sheet (${kind}_sheet_id,${kind}_top_id,${kind}_sheet_no) VALUES (1,10,0),(2,11,0)`,
      );
      await client.query(
        `INSERT INTO pg_temp.${kind}_reference (${kind}_sheet_id,reference_id,reference_type,reference_name,reference_value,diplay_number,document_id) VALUES (1,1,'file','Original','original',0,777),(2,1,'file','Untouched','untouched',0,888)`,
      );
      await client.query(`ALTER TABLE pg_temp.${kind}_reference ADD CHECK (reference_value<>'reject')`);
    }
    await run(db, client, directory);
  } finally {
    await client.query(
      'DROP TABLE IF EXISTS pg_temp.def_reference,pg_temp.rep_reference,pg_temp.def_sheet,pg_temp.rep_sheet,pg_temp.mst_common,pg_temp.user_lock',
    );
    client.release();
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
}

test('reference XML retains source tag, field order, missing values and entities', () => {
  assert.deepEqual(
    referenceImportRows(
      '<conmas><reportReference><action>U</action><repTopId>10</repTopId><sheetNo>0</sheetNo><referenceId>1</referenceId><referenceType>url</referenceType><referenceName>A&amp;B</referenceName><displayNumber>2</displayNumber></reportReference></conmas>',
      'xml',
      'rep',
    ),
    [['U', '10', '0', '1', 'url', 'A&B', '', '2']],
  );
  assert.throws(() => referenceImportRows('<!DOCTYPE conmas><conmas/>', 'xml', 'def'));
});

test(
  'definition/report references retain U-only rules, slot limits, document clearing and independent row commits',
  { skip: !process.env.DATABASE_URL },
  async () =>
    fixture(async (db, client) => {
      for (const kind of ['def', 'rep'] as const) {
        const csv =
          'U,10,0,1,file,name,value\nA,10,0,1,file,name,value,0\nU,,0,1,file,name,value,0\nU,10,-1,1,file,name,value,0\nU,10,0,0,file,name,value,0\nU,10,0,11,file,name,value,0\nU,10,0,1,,name,value,0\nU,10,0,1,{ignore},name,value,0\nU,10,0,1,file,{ignore},value,0\nU,10,0,1,file,name,{ignore},0\nU,10,0,1,file,name,value,\nU,10,0,1,file,name,value,-1\nU,999,0,1,file,name,value,0\nU,10,0,1,file,name,reject,0\nU,10,0,1,url,,,3\n';
        const result = await importReferences(db, referenceImportRows(csv, 'csv', kind), kind, 'actor', 'host');
        assert.deepEqual(
          result.map((row) => row.code),
          [
            '10010',
            '11020',
            '11010',
            '11030',
            '11020',
            '11020',
            '11010',
            '11020',
            '11020',
            '11020',
            '11010',
            '11030',
            '0',
            '10020',
            '0',
          ],
        );
        assert.deepEqual(
          (
            await client.query(
              `SELECT reference_type,reference_name,reference_value,diplay_number,document_id,sys_update_term,sys_update_user FROM pg_temp.${kind}_reference WHERE ${kind}_sheet_id=1`,
            )
          ).rows[0],
          {
            reference_type: 'url',
            reference_name: '',
            reference_value: '',
            diplay_number: 3,
            document_id: null,
            sys_update_term: 'WEBAPI/host',
            sys_update_user: 'actor',
          },
        );
        assert.equal(
          (await client.query(`SELECT document_id FROM pg_temp.${kind}_reference WHERE ${kind}_sheet_id=2`)).rows[0]
            .document_id,
          888,
        );
        await assert.rejects(
          importReferences(
            db,
            [
              ['U', '10', '0', '1', 'file', 'name', 'committed', '0'],
              ['U', '10', '0', '1', 'file', 'name', 'not applied', '{ignore}'],
              ['U', '10', '0', '1', 'file', 'name', 'not reached', '0'],
            ],
            kind,
            'actor',
            'host',
          ),
        );
        assert.equal(
          (await client.query(`SELECT reference_value FROM pg_temp.${kind}_reference WHERE ${kind}_sheet_id=1`)).rows[0]
            .reference_value,
          'committed',
        );
      }
    }),
);

test('reference file import overwrites, streams disk files, skips empty uploads and confines file names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'conmas-reference-file-'));
  const directory = join(root, 'reference');
  await mkdir(directory);
  const db = { query: async () => ({ rows: [{ com_value: directory }] }) } as unknown as pg.Pool;
  try {
    const bytes = Buffer.from([0, 255, 1, 2]);
    await writeFile(join(directory, 'manual.bin'), 'old');
    await writeFile(join(root, 'disk.bin'), bytes);
    await writeFile(join(root, 'sentinel'), 'untouched');
    assert.deepEqual(
      await importReferenceFiles(db, [
        { originalname: 'C:\\files\\manual.bin', path: join(root, 'disk.bin'), size: bytes.length },
        { originalname: 'empty.bin', buffer: Buffer.alloc(0) },
        { originalname: '../sentinel', buffer: bytes },
      ]),
      [{ code: '0', remark: '' }],
    );
    assert.deepEqual(await readFile(join(directory, 'manual.bin')), bytes);
    assert.deepEqual(await readFile(join(directory, 'sentinel')), bytes);
    assert.equal(await readFile(join(root, 'sentinel'), 'utf8'), 'untouched');
    await assert.rejects(readFile(join(directory, 'empty.bin')));
    await symlink(join(root, 'sentinel'), join(directory, 'link.bin'));
    await assert.rejects(
      importReferenceFiles(db, [
        { originalname: 'first.bin', buffer: bytes },
        { originalname: 'link.bin', buffer: bytes },
      ]),
    );
    assert.deepEqual(await readFile(join(directory, 'first.bin')), bytes);
    assert.equal(await readFile(join(root, 'sentinel'), 'utf8'), 'untouched');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'reference imports and Create Upload parse multipart before CSRF and preserve overwrite differences',
  { skip: !process.env.DATABASE_URL || !process.env.CONMAS_TEST_PASSWORD },
  async () =>
    fixture(async (db, client, directory) => {
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
        const upload = (route: string, command: string, content: string | Buffer, format: string, csrf = token) => {
          const body = new FormData();
          body.set('DataInputType', command);
          body.set('type', format);
          body.set('encoding', '65001');
          body.set('__RequestVerificationToken', csrf);
          body.set(
            'file1',
            new Blob([typeof content === 'string' ? content : new Uint8Array(content)]),
            'reference.bin',
          );
          return fetch(root + '/System/' + route, { method: 'POST', headers: { cookie }, body, redirect: 'manual' });
        };
        assert.equal((await upload('DataInput', 'RegistReference', 'denied', 'csvZip', '')).status, 403);
        await assert.rejects(readFile(join(directory, 'reference.bin')));
        const first = await upload('DataInput', 'RegistReference', Buffer.from([0, 255, 1]), 'csvZip');
        assert.equal(first.status, 200);
        assert.deepEqual(await readFile(join(directory, 'reference.bin')), Buffer.from([0, 255, 1]));
        const overwrite = await upload('DataInput', 'RegistReference', 'replaced', 'csv');
        assert.equal(overwrite.status, 200);
        assert.equal(await readFile(join(directory, 'reference.bin'), 'utf8'), 'replaced');
        const multiple = new FormData();
        multiple.set('DataInputType', 'RegistReference');
        multiple.set('type', 'xmlZip');
        multiple.set('__RequestVerificationToken', token);
        multiple.set('file1', new Blob(['replaced']), 'reference.bin');
        multiple.set('file2', new Blob(['second']), 'second.bin');
        assert.equal(
          (await fetch(root + '/System/DataInput', { method: 'POST', headers: { cookie }, body: multiple })).status,
          200,
        );
        assert.equal(await readFile(join(directory, 'second.bin'), 'utf8'), 'second');
        const duplicate = await upload('CreateUpload', '', 'keep old', '');
        assert.equal(duplicate.status, 200);
        assert.match(await duplicate.text(), /same name file already existed/);
        assert.equal(await readFile(join(directory, 'reference.bin'), 'utf8'), 'replaced');
        await rm(join(directory, 'reference.bin'));
        const created = await upload('CreateUpload', '', 'registered', '');
        assert.equal(created.status, 302);
        assert.equal(await readFile(join(directory, 'reference.bin'), 'utf8'), 'registered');
        for (const [command, kind] of [
          ['RegistDefenitionReference', 'def'],
          ['RegistReportReference', 'rep'],
        ] as const) {
          const text =
            kind === 'def'
              ? 'U,10,0,1,url,New title,new-value,2'
              : `<conmas><reportReference><action>U</action><repTopId>10</repTopId><sheetNo>0</sheetNo><referenceId>1</referenceId><referenceType>url</referenceType><referenceName>New title</referenceName><referenceValue>new-value</referenceValue><displayNumber>2</displayNumber></reportReference></conmas>`;
          const result = await upload('DataInput', command, text, kind === 'def' ? 'csv' : 'xml');
          assert.equal(result.status, 200);
          assert.match(await result.text(), /Registration is successful/);
          assert.equal(
            (await client.query(`SELECT reference_name FROM pg_temp.${kind}_reference WHERE ${kind}_sheet_id=1`))
              .rows[0].reference_name,
            'New title',
          );
        }
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }
    }),
);
