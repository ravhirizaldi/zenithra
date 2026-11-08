import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { createApp } from '../helpers/app.js';
import { licenseCounts } from '../../src/shared/license-counts.js';

test(
  'local administrator can log in and read the imported Users list',
  { skip: !process.env.DATABASE_URL || !process.env.CONMAS_TEST_PASSWORD },
  async () => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const server = createApp(pool, true).listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      assert(address && typeof address !== 'string');
      const origin = `http://127.0.0.1:${address.port}`;
      const url = `${origin}/ConMasManager`;

      const unauthenticated = await fetch(`${url}/System/UserList`, { redirect: 'manual' });
      assert.equal(unauthenticated.status, 302);

      const wrong = await fetch(`${url}/Account/LogOn`, {
        method: 'POST',
        body: new URLSearchParams({ UserName: 'conmasadmin', Password: 'wrong-password' }),
        redirect: 'manual',
      });
      assert.equal(wrong.status, 401);

      const login = await fetch(`${url}/Account/LogOn`, {
        method: 'POST',
        body: new URLSearchParams({ UserName: 'conmasadmin', Password: process.env.CONMAS_TEST_PASSWORD! }),
        redirect: 'manual',
      });
      assert.equal(login.status, 302);
      const cookie = login.headers.get('set-cookie')?.split(';')[0];
      assert(cookie);

      const users = await fetch(`${url}/System/UserList`, { headers: { cookie } });
      const html = await users.text();
      assert.equal(users.status, 200);
      assert.match(html, /user01/);
      const quota = licenseCounts().User;
      assert.match(html, new RegExp(`id="infoTitle"[^>]*>Users(?:\\s|&nbsp;)+\\(\\d+/${quota}\\)</div>`));
      assert.doesNotMatch(html, /External system linkage setting/);

      const search = await fetch(`${url}/System/UserList?searchId=missing`, { headers: { cookie } });
      const searchHtml = await search.text();
      assert.match(searchHtml, new RegExp(`id="infoTitle"[^>]*>Users(?:\\s|&nbsp;)+\\(0/${quota}\\)</div>`));
      const logout = await fetch(`${url}/Account/LogOff`, { headers: { cookie }, redirect: 'manual' });
      assert.equal(logout.status, 302);
      assert.equal(logout.headers.get('location'), '/ConMasManager/Account/LogOn');
      const revoked = await fetch(`${url}/System/UserList`, { headers: { cookie }, redirect: 'manual' });
      assert.equal(revoked.status, 302);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await pool.end();
    }
  },
);
