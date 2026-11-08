import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { XMLParser } from 'fast-xml-parser';
import { createApp } from '../../../helpers/app.js';
import {
  dataOutputNames,
  encodeExport,
  exportStatement,
  serializeExportRows,
} from '../../../../src/models/manager/system/data-export.js';

test('legacy exports preserve parameterization, XML escaping, CSV line endings and encoding', () => {
  const statement = exportStatement(0, 'xml', { withAdmin: 'false', userId: "a' OR 1=1 --" });
  assert.deepEqual(statement.values, ['conmasadmin', "a' OR 1=1 --"]);
  assert.ok(!statement.text.includes("a' OR 1=1"));
  assert.match(statement.text, /user_id = \$2/);
  const noSign = exportStatement(0, 'xml', { withImprint: 'false' });
  assert.ok(!noSign.text.includes('approval_sign'));
  assert.deepEqual(exportStatement(3, 'csv', { deleted: '0' }).values, [0]);
  assert.throws(() => exportStatement(5, 'csv', {}));
  const xml = serializeExportRows(0, 'xml', 'user', [{ userId: 'a&b', email: null, userName: '<name>' }]);
  assert.deepEqual(new XMLParser().parse(xml), { conmas: { user: { userId: 'a&b', userName: '<name>' } } });
  assert.equal(serializeExportRows(0, 'csv', 'user', [{ csv: '"a","b"' }]), '"a","b"\r\n');
  assert.deepEqual(encodeExport('あ', 'csv', '932'), Buffer.from([0x82, 0xa0]));
  assert.deepEqual(encodeExport('あ', 'xml', ''), Buffer.from('あ', 'utf8'));
  assert.throws(() => encodeExport('x', 'csv', 'invalid'));
});

test(
  'authenticated System data exports download all five legacy targets',
  { skip: !process.env.DATABASE_URL || !process.env.CONMAS_TEST_PASSWORD },
  async () => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const server = createApp(pool).listen(0, '127.0.0.1');
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
      const page = await fetch(root + '/System/DataOutput', { headers: { cookie } });
      assert.equal(page.status, 200);
      const html = await page.text();
      const token = html.match(/name="__RequestVerificationToken" value="([^"]+)"/)?.[1];
      assert(token);
      for (let command = 0; command < 5; command++) {
        const fragment: Response = await fetch(root + '/System/DataOutputView?command=' + command, {
          headers: { cookie, 'X-Requested-With': 'XMLHttpRequest' },
        });
        assert.equal(fragment.status, 200);
        assert.match(await fragment.text(), /name="deleted" value="0"/);
        for (const format of ['csv', 'xml']) {
          const response: Response = await fetch(root + '/System/DataOutput', {
            method: 'POST',
            headers: { cookie },
            body: new URLSearchParams({
              __RequestVerificationToken: token,
              DataOutputType: String(command),
              type: format,
              encoding: '65001',
              deleted: '0',
            }),
            redirect: 'manual',
          });
          assert.equal(response.status, 200, `${command}/${format}`);
          assert.ok(response.headers.get('content-disposition')?.includes(dataOutputNames[command] + '.' + format));
          const body = await response.text();
          if (format === 'xml') assert.ok(new XMLParser().parse(body).conmas !== undefined);
          else if (body) assert.ok(body.endsWith('\r\n'));
        }
      }
      const denied = await fetch(root + '/System/DataOutput', {
        method: 'POST',
        headers: { cookie },
        body: new URLSearchParams({ DataOutputType: '0', type: 'csv', encoding: '65001' }),
      });
      assert.equal(denied.status, 403);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await pool.end();
    }
  },
);
