import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { XMLParser } from 'fast-xml-parser';
import { createApp } from '../../../helpers/app.js';
import {
  importSelectionItems,
  replaceSelectionParameters,
  splitSelectionValues,
} from '../../../../src/models/manager/system/data-selection-import.js';

const definition =
  '<conmas origin="keep"><top><defTopId>1</defTopId><sheets><sheet><sheetNo>0</sheetNo><defSheetId>10</defSheetId><clusters><cluster custom="yes"><clusterId>1</clusterId><type>Select</type><inputParameters>Items=a,b;Labels=A,B;Mode=keep</inputParameters><unknown>retain &amp; escape</unknown></cluster><cluster><clusterId>2</clusterId><type>MultiSelect</type><inputParameters>Items=x,y;Labels=X,Y;Selected=x</inputParameters></cluster></clusters></sheet></sheets><networks><network><prevSheetNo>0</prevSheetNo><prevClusterId>1</prevClusterId><nextSheetNo>0</nextSheetNo><nextClusterId>2</nextClusterId><valueLinks><valueLink><parentValue>a</parentValue><selectValues>x</selectValues></valueLink></valueLinks></network></networks><other>untouched</other></top></conmas>';
const xml = new XMLParser({ ignoreAttributes: false, parseTagValue: false });
async function fixture(run: (db: pg.Pool, client: pg.PoolClient) => Promise<void>) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }),
    client = await pool.connect();
  const db = {
    query: pool.query.bind(pool),
    connect: async () => ({ query: client.query.bind(client), release: () => {} }),
  } as unknown as pg.Pool;
  try {
    await client.query(`CREATE TEMP TABLE def_top (LIKE public.def_top INCLUDING ALL);
      CREATE TEMP TABLE def_cluster (LIKE public.def_cluster INCLUDING ALL);
      CREATE TEMP TABLE def_lock (LIKE public.def_lock INCLUDING ALL);
      CREATE TEMP TABLE user_lock (LIKE public.user_lock INCLUDING ALL);`);
    await client.query('INSERT INTO pg_temp.def_top (def_top_id,xml_data) VALUES (1,$1),(2,$1)', [definition]);
    await client.query(
      "INSERT INTO pg_temp.def_cluster (def_sheet_id,cluster_id,input_parameter) VALUES (10,1,'original'),(10,2,'original')",
    );
    await run(db, client);
  } finally {
    await client.query('DROP TABLE IF EXISTS pg_temp.def_top,pg_temp.def_cluster,pg_temp.def_lock,pg_temp.user_lock');
    client.release();
    await pool.end();
  }
}

test('selection parameters retain doubled separators and legacy replacement behavior', () => {
  assert.deepEqual(splitSelectionValues('a;;b;c', ';'), ['a;;b', 'c']);
  assert.deepEqual(splitSelectionValues('a,,b,c', ','), ['a,,b', 'c']);
  assert.equal(
    replaceSelectionParameters('Items=a,b;Labels=A,B;Mode=keep', 'x,y;', 'X,Y;', 'x;'),
    'Items=x,y;Labels=X,Y;Selected=x;Mode=keep',
  );
  assert.equal(replaceSelectionParameters('Items=a;Selected=a;Malformed', 'x', 'X', ''), 'Items=x;Selected=;=');
});

test(
  'selection CSV/XML update cluster parameters and network values atomically while preserving unknown XML',
  { skip: !process.env.DATABASE_URL },
  async () =>
    fixture(async (db, client) => {
      const csv = '1,S,0,1,"New A,New B","c,d",c\n1,L,0,1,0,2,c,x\n1,L,0,1,0,2,c,y\n';
      assert.deepEqual(
        (await importSelectionItems(db, csv, 'csv', 'actor', 'host')).map((row) => row.code),
        ['0'],
      );
      const row = (
        await client.query('SELECT xml_data,sys_update_term,sys_update_user FROM pg_temp.def_top WHERE def_top_id=1')
      ).rows[0];
      const result = xml.parse(row.xml_data).conmas;
      assert.equal(result['@_origin'], 'keep');
      assert.equal(result.top.other, 'untouched');
      assert.equal(result.top.sheets.sheet.clusters.cluster[0]['@_custom'], 'yes');
      assert.equal(result.top.sheets.sheet.clusters.cluster[0].unknown, 'retain & escape');
      assert.equal(
        result.top.sheets.sheet.clusters.cluster[0].inputParameters,
        'Items=c,d;Labels=New A,New B;Selected=c;Mode=keep',
      );
      assert.equal(result.top.networks.network.valueLinks.valueLink.selectValues, 'y');
      assert.equal(row.sys_update_term, 'WEBAPI/host');
      assert.equal(row.sys_update_user, 'actor');
      assert.equal(
        (await client.query('SELECT input_parameter FROM pg_temp.def_cluster WHERE def_sheet_id=10 AND cluster_id=1'))
          .rows[0].input_parameter,
        result.top.sheets.sheet.clusters.cluster[0].inputParameters,
      );
      assert.equal((await client.query('SELECT 1 FROM pg_temp.def_lock')).rowCount, 0);
      const clear =
        '<conmas><top><defTopId>1</defTopId><networks><network><prevSheetNo>0</prevSheetNo><prevClusterId>1</prevClusterId><nextSheetNo>0</nextSheetNo><nextClusterId>2</nextClusterId></network></networks></top></conmas>';
      assert.equal((await importSelectionItems(db, clear, 'xml', 'actor', 'host'))[0].code, '0');
      assert.equal(
        xml.parse((await client.query('SELECT xml_data FROM pg_temp.def_top WHERE def_top_id=1')).rows[0].xml_data)
          .conmas.top.networks.network.valueLinks,
        '',
      );
    }),
);

test(
  'selection imports preserve format errors, per-top rollback and exclusive/forced locks',
  { skip: !process.env.DATABASE_URL },
  async () =>
    fixture(async (db, client) => {
      assert.deepEqual(await importSelectionItems(db, '1,S,0,1,A,a', 'csv', 'actor', 'host'), [
        { code: '10050', remark: 'line:1' },
      ]);
      assert.deepEqual(await importSelectionItems(db, '1,X,0,1,A,a', 'csv', 'actor', 'host'), [
        { code: '10050', remark: 'CSV Error(line:1).' },
      ]);
      assert.deepEqual(await importSelectionItems(db, 'malformed xml', 'xml', 'actor', 'host', 'bad'), [
        { code: '2', remark: '' },
      ]);
      const csv = '1,S,0,1,"A,B","a,b",a\n1,L,0,1,0,2,missing,x\n2,S,0,1,"C,D","c,d",c\n';
      assert.deepEqual(
        (await importSelectionItems(db, csv, 'csv', 'actor', 'host')).map((row) => row.code),
        ['11020', '0'],
      );
      assert.equal(
        (await client.query('SELECT xml_data FROM pg_temp.def_top WHERE def_top_id=1')).rows[0].xml_data,
        definition,
      );
      assert.equal((await client.query('SELECT 1 FROM pg_temp.def_lock')).rowCount, 0);
      await client.query("INSERT INTO pg_temp.def_lock (def_top_id,user_id) VALUES (1,'other')");
      assert.equal((await importSelectionItems(db, '1,S,0,1,A,a,a', 'csv', 'actor', 'host'))[0].code, '10070');
      assert.equal(
        (await client.query('SELECT user_id FROM pg_temp.def_lock WHERE def_top_id=1')).rows[0].user_id,
        'other',
      );
      assert.equal((await importSelectionItems(db, '1,S,0,1,A,a,a', 'csv', 'actor', 'host', ' True '))[0].code, '0');
      assert.equal((await client.query('SELECT 1 FROM pg_temp.def_lock')).rowCount, 0);
      const errors = await importSelectionItems(
        db,
        '<conmas><top/><top><defTopId/></top><top><defTopId>-1</defTopId></top></conmas>',
        'xml',
        'actor',
        'host',
      );
      assert.deepEqual(
        errors.map((row) => row.code),
        ['11010', '11030', '10060'],
      );
      assert.equal((await importSelectionItems(db, '1,S,0,01,A,a,a', 'csv', 'actor', 'host'))[0].code, '10060');
    }),
);

test(
  'selection validation rejects duplicate labels/items and invalid selection without changing stored XML',
  { skip: !process.env.DATABASE_URL },
  async () =>
    fixture(async (db, client) => {
      for (const [csv, field] of [
        ['1,S,0,1,"A,A","a,b",a', 'labels'],
        ['1,S,0,1,"A,B","a,a",a', 'items'],
        ['1,S,0,1,A,"a,b",a', 'items'],
        ['1,S,0,1,A,a,b', 'selected'],
      ] as const) {
        const result = (await importSelectionItems(db, csv, 'csv', 'actor', 'host'))[0];
        assert.equal(result.code, '11020');
        assert.ok(result.remark.includes('[' + field + ']'));
        assert.equal(
          (await client.query('SELECT xml_data FROM pg_temp.def_top WHERE def_top_id=1')).rows[0].xml_data,
          definition,
        );
        assert.equal((await client.query('SELECT 1 FROM pg_temp.def_lock')).rowCount, 0);
      }
    }),
);

test(
  'selection command dispatches authenticated disk multipart with CSV/XML and CSRF',
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
        const token = (await page.text()).match(/name="__RequestVerificationToken" value="([^"]+)"/)?.[1];
        assert(token);
        const upload = (text: string, format: string, csrf = token) => {
          const body = new FormData();
          body.set('DataInputType', 'UpdateSelectItem');
          body.set('type', format);
          body.set('encoding', '65001');
          body.set('__RequestVerificationToken', csrf);
          body.set('file1', new Blob([text]), 'selection.' + format);
          return fetch(root + '/System/DataInput', { method: 'POST', headers: { cookie }, body });
        };
        assert.equal((await upload('1,S,0,1,A,a,a', 'csv', '')).status, 403);
        const first = await upload('1,S,0,1,A,a,a', 'csv');
        assert.equal(first.status, 200);
        assert.match(await first.text(), /Registration is successful/);
        const second = await upload('<conmas><top><defTopId>1</defTopId></top></conmas>', 'xml');
        assert.equal(second.status, 200);
        assert.match(await second.text(), /Registration is successful/);
        assert.equal(
          (await client.query('SELECT sys_update_user FROM pg_temp.def_top WHERE def_top_id=1')).rows[0]
            .sys_update_user,
          'conmasadmin',
        );
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }
    }),
);
