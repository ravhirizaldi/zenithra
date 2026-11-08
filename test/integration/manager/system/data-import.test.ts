import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { createApp } from '../../../helpers/app.js';
import {
  commonImportRows,
  meIdImportRows,
  importMeIdRows,
  decodeImport,
  parseImportCsv,
} from '../../../../src/models/manager/system/data-import.js';

test('legacy common import parses quoted multiline CSV, XML fields and Windows encodings', () => {
  assert.deepEqual(parseImportCsv('"A","","key","1","a""b","line1\r\nline2","en-US"\r\n'), [
    ['A', '', 'key', '1', 'a"b', 'line1\r\nline2', 'en-US'],
  ]);
  assert.throws(() => parseImportCsv('"unfinished'));
  assert.deepEqual(
    commonImportRows(
      '<?xml version="1.0"?><conmas><common><action>A</action><comKey>a&amp;b</comKey><comIndex>1</comIndex><comName>n</comName><comValue>v</comValue><comLocale>en-US</comLocale></common></conmas>',
      'xml',
    ),
    [['A', '', 'a&b', '1', 'n', 'v', 'en-US']],
  );
  assert.throws(() => commonImportRows('<!DOCTYPE conmas><conmas/>', 'xml'));
  assert.equal(decodeImport(Buffer.from([0x82, 0xa0]), 'csv', '932'), 'あ');
  assert.equal(decodeImport(Buffer.from([0xff, 0xfe, 0x41, 0x00]), 'xml', '65001'), 'A');
});

test(
  'Common Master multipart imports commit valid rows and report invalid rows independently',
  { skip: !process.env.DATABASE_URL || !process.env.CONMAS_TEST_PASSWORD },
  async () => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const server = createApp(pool).listen(0, '127.0.0.1');
    const generatedKey = 'CODEX_IMPORT_PARITY_' + randomUUID();
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      assert(address && typeof address !== 'string');
      const root = `http://127.0.0.1:${address.port}/ConMasManager`;
      const login: Response = await fetch(root + '/Account/LogOn', {
        method: 'POST',
        body: new URLSearchParams({ UserName: 'conmasadmin', Password: process.env.CONMAS_TEST_PASSWORD! }),
        redirect: 'manual',
      });
      const cookie = login.headers.get('set-cookie')?.split(';')[0];
      assert(cookie);
      const page: Response = await fetch(root + '/System/DataInput', { headers: { cookie } });
      assert.equal(page.status, 200);
      const html = await page.text();
      const token = html.match(/name="__RequestVerificationToken" value="([^"]+)"/)?.[1];
      assert(token);
      assert.ok(html.includes('name="file1"'));
      assert.ok(html.includes('RegistCommon'));
      const upload = async (text: string) => {
        const body = new FormData();
        body.set('__RequestVerificationToken', token);
        body.set('DataInputType', 'RegistCommon');
        body.set('type', 'csv');
        body.set('encoding', '65001');
        body.set('file1', new Blob([text], { type: 'text/csv' }), 'generated.csv');
        const response: Response = await fetch(root + '/System/DataInput', {
          method: 'POST',
          headers: { cookie },
          body,
        });
        assert.equal(response.status, 200);
        return response.text();
      };
      const result = await upload('A,,,,name,value,en-US\r\n' + `A,,${generatedKey},1,isolated import,first,en-US\r\n`);
      assert.ok(result.includes('11010'));
      assert.ok(result.includes('Registration is successful.'));
      const row = (await pool.query('SELECT com_id,com_value FROM mst_common WHERE com_key=$1', [generatedKey]))
        .rows[0];
      assert(row);
      assert.equal(row.com_value, 'first');
      const updated = await upload(`M,${row.com_id},${generatedKey},2,isolated import,second,en-US\r\n`);
      assert.ok(updated.includes('Registration is successful.'));
      assert.equal(
        (
          await pool.query('SELECT com_value FROM mst_common WHERE com_id=$1 AND com_key=$2', [
            row.com_id,
            generatedKey,
          ])
        ).rows[0]?.com_value,
        'second',
      );
      const deleted = await upload(`D,${row.com_id},,,,,\r\n`);
      assert.ok(deleted.includes('Registration is successful.'));
      assert.equal(
        (await pool.query('SELECT com_id FROM mst_common WHERE com_id=$1 AND com_key=$2', [row.com_id, generatedKey]))
          .rowCount,
        0,
      );
    } finally {
      await pool.query('DELETE FROM mst_common WHERE com_key=$1 AND com_name=$2', [generatedKey, 'isolated import']);
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await pool.end();
    }
  },
);

test('Entra ID import retains XML field-count rules and admin exclusion', async () => {
  assert.deepEqual(meIdImportRows('<conmas><user><userId>a</userId><meidUpn/></user></conmas>', 'xml'), [['a', '']]);
  let query = '';
  let parameters: unknown[] = [];
  const pool = {
    async query(text: string, values: unknown[]) {
      query = text;
      parameters = values;
      return { rowCount: 0 };
    },
  } as unknown as pg.Pool;
  const result = await importMeIdRows(pool, [['conmasadmin', '{ignore}', '']], 'actor', 'host');
  assert.equal(result[0].code, '10060');
  assert.ok(query.includes('user_id<>$5'));
  assert.equal(parameters[4], 'conmasadmin');
  assert.ok(!query.includes('meid_upn='));
  assert.ok(query.includes('meid_oid='));
  assert.equal(parameters[5], null);
});

test(
  'generated-user Entra ID and membership imports preserve legacy behavior',
  { skip: !process.env.DATABASE_URL || !process.env.CONMAS_TEST_PASSWORD },
  async () => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const id = 'CODEX_MEID_' + randomUUID();
    const groupKey = 'CODEX_IMPORT_GROUP_' + randomUUID();
    let generatedGroup: number | undefined;
    const server = createApp(pool).listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      await pool.query('INSERT INTO mst_user (user_id,user_name,meid_upn,meid_oid) VALUES ($1,$2,$3,$4)', [
        id,
        'isolated import',
        'old@example.invalid',
        'old-oid',
      ]);
      const address = server.address();
      assert(address && typeof address !== 'string');
      const root = `http://127.0.0.1:${address.port}/ConMasManager`;
      const login: Response = await fetch(root + '/Account/LogOn', {
        method: 'POST',
        body: new URLSearchParams({ UserName: 'conmasadmin', Password: process.env.CONMAS_TEST_PASSWORD! }),
        redirect: 'manual',
      });
      const cookie = login.headers.get('set-cookie')?.split(';')[0];
      assert(cookie);
      const page: Response = await fetch(root + '/System/DataInput', { headers: { cookie } });
      const token = (await page.text()).match(/name="__RequestVerificationToken" value="([^"]+)"/)?.[1];
      assert(token);
      const upload = async (text: string, format: string, command = 'RegistUserMeId') => {
        const body = new FormData();
        body.set('__RequestVerificationToken', token);
        body.set('DataInputType', command);
        body.set('type', format);
        body.set('encoding', '65001');
        body.set('file1', new Blob([text]), 'generated.' + format);
        const response: Response = await fetch(root + '/System/DataInput', {
          method: 'POST',
          headers: { cookie },
          body,
        });
        assert.equal(response.status, 200);
        return response.text();
      };
      const first = await upload(`${id}, {ignore} , \r\n${id}_missing,upn,oid\r\n`, 'csv');
      assert.ok(first.includes('Registration is successful.'));
      assert.ok(first.includes('10060'));
      const kept = (
        await pool.query('SELECT meid_upn,meid_oid,sys_update_term,sys_update_user FROM mst_user WHERE user_id=$1', [
          id,
        ])
      ).rows[0];
      assert.equal(kept.meid_upn, 'old@example.invalid');
      assert.equal(kept.meid_oid, null);
      assert.equal(kept.sys_update_user, 'conmasadmin');
      assert.match(kept.sys_update_term, /^WEBAPI\//);
      const xml = `<conmas><user><userId> ${id} </userId><meidUpn> new@example.invalid </meidUpn><meidOid> new-oid </meidOid></user><user><userId>${id}</userId><meidUpn/></user></conmas>`;
      const second = await upload(xml, 'xml');
      assert.ok(second.includes('10010'));
      const updated = (await pool.query('SELECT meid_upn,meid_oid FROM mst_user WHERE user_id=$1', [id])).rows[0];
      assert.equal(updated.meid_upn, 'new@example.invalid');
      assert.equal(updated.meid_oid, 'new-oid');
      generatedGroup = Number(
        (
          await pool.query(
            "INSERT INTO mst_group (group_id,group_name,system_key) VALUES (nextval('mst_group_group_id_seq'),$1,$2) RETURNING group_id",
            ['isolated membership import', groupKey],
          )
        ).rows[0].group_id,
      );
      const keyMode =
        (
          await pool.query(
            'SELECT com_value FROM mst_common WHERE com_key=$1 AND com_name=$2 ORDER BY com_index LIMIT 1',
            ['API_MODE', 'MST_GROUP_KEY_MODE'],
          )
        ).rows[0]?.com_value === '1';
      const inputGroup = keyMode ? groupKey : String(generatedGroup);
      const membership = await upload(`A,${inputGroup},${id}\r\n`, 'csv', 'RegistGroupAffiliation');
      assert.ok(membership.includes('Registration is successful.'));
      assert.equal(
        (
          await pool.query('SELECT group_id FROM mst_group_affiation WHERE group_id=$1 AND user_id=$2', [
            generatedGroup,
            id,
          ])
        ).rowCount,
        1,
      );
      const removal = await upload(
        `<conmas><groupAffiliation><action>D</action><groupId>${inputGroup}</groupId><userId>${id}</userId></groupAffiliation></conmas>`,
        'xml',
        'RegistGroupAffiliation',
      );
      assert.ok(removal.includes('Registration is successful.'));
      assert.equal(
        (
          await pool.query('SELECT group_id FROM mst_group_affiation WHERE group_id=$1 AND user_id=$2', [
            generatedGroup,
            id,
          ])
        ).rowCount,
        0,
      );
    } finally {
      await pool.query('DELETE FROM conmas_user_account_operation_log WHERE user_id=$1', [id]);
      if (generatedGroup !== undefined) {
        await pool.query('DELETE FROM mst_group_affiation WHERE group_id=$1 AND user_id=$2', [generatedGroup, id]);
        await pool.query('DELETE FROM mst_group WHERE group_id=$1 AND system_key=$2', [generatedGroup, groupKey]);
      }
      await pool.query('DELETE FROM mst_user WHERE user_id=$1 AND user_name=$2', [id, 'isolated import']);
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await pool.end();
    }
  },
);
