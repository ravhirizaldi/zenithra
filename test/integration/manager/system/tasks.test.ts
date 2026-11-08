import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { createApp } from '../../../helpers/app.js';
import { licenseStatus } from '../../../../src/shared/license-counts.js';

test(
  'task routes follow the installed FreeDrawOnly license status',
  {
    skip: !process.env.DATABASE_URL || !process.env.CONMAS_TEST_PASSWORD || !process.env.CONMAS_LEGACY_KEY,
  },
  async () => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const server = createApp(pool).listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      assert(address && typeof address !== 'string');
      const root = `http://127.0.0.1:${address.port}/ConMasManager`;
      const login = await fetch(`${root}/Account/LogOn`, {
        method: 'POST',
        body: new URLSearchParams({ UserName: 'conmasadmin', Password: process.env.CONMAS_TEST_PASSWORD! }),
        redirect: 'manual',
      });
      assert.equal(login.status, 302);
      const cookie = login.headers.get('set-cookie')?.split(';')[0];
      assert(cookie);

      for (const path of ['/System/TaskList', '/System/EditTask?id=-1']) {
        const response: Response = await fetch(root + path, { headers: { cookie } });
        assert.equal(response.status, licenseStatus().freeDrawOnly ? 403 : 200);
        const html = await response.text();
        if (licenseStatus().freeDrawOnly) assert.equal(html, 'Role authority is insufficient.');
        else {
          assert.match(html, path.includes('TaskList') ? /id="task-list-form"/ : /name="Task.task_name"/);
          assert.doesNotMatch(html, /blocked until|counts only|License information is unavailable/);
        }
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await pool.end();
    }
  },
);
