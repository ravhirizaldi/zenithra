import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../../helpers/app.js';
import {
  commonSettingVisible,
  validateCommonSetting,
  cloudOutputPrefix,
  storedOutputPath,
} from '../../../../src/controllers/manager/system/common.js';

test(
  'Common Master forms and list are available',
  { skip: !process.env.DATABASE_URL || !process.env.CONMAS_TEST_PASSWORD },
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
      const cookie = login.headers.get('set-cookie')?.split(';')[0];
      assert(cookie);

      for (const route of ['CreateCom', 'EditCom?id=1']) {
        const response: Response = await fetch(`${root}/System/${route}`, { headers: { cookie } });
        assert.equal(response.status, 200, route);
        const body = await response.text();
        assert.ok(body.includes('name="mst_common.com_key"'), route);
      }
      const list = await fetch(`${root}/System/ComList`, { headers: { cookie } });
      assert.equal(list.status, 200);
      assert.ok((await list.text()).includes('Common key'));
      const generatedKey = 'CODEX_LICENSE_PARITY_' + randomUUID();
      let generatedId: number | undefined;
      try {
        const formHtml = await (await fetch(`${root}/System/CreateCom`, { headers: { cookie } })).text();
        const csrf = formHtml.match(/name="__RequestVerificationToken" value="([^"]+)"/)?.[1];
        assert(csrf);
        const fields = {
          __RequestVerificationToken: csrf,
          'mst_common.com_key': generatedKey,
          'mst_common.com_name': 'isolated parity check',
          'mst_common.com_index': '1',
          'mst_common.com_value': 'before',
          'mst_common.com_locale': '-1',
        };
        const created = await fetch(`${root}/System/CreateCom`, {
          method: 'POST',
          headers: { cookie },
          body: new URLSearchParams(fields),
          redirect: 'manual',
        });
        assert.equal(created.status, 302);
        generatedId = Number(created.headers.get('location')?.match(/id=(\d+)/)?.[1]);
        assert(Number.isSafeInteger(generatedId) && generatedId > 0);
        const saved = await pool.query('SELECT com_value,com_locale FROM mst_common WHERE com_id=$1 AND com_key=$2', [
          generatedId,
          generatedKey,
        ]);
        assert.equal(saved.rows[0]?.com_value, 'before');
        assert.equal(saved.rows[0]?.com_locale, '');
        const edited = await fetch(`${root}/System/EditCom`, {
          method: 'POST',
          headers: { cookie },
          body: new URLSearchParams({
            ...fields,
            'mst_common.com_id': String(generatedId),
            'mst_common.com_value': 'after',
          }),
          redirect: 'manual',
        });
        assert.equal(edited.status, 302);
        assert.equal(
          (
            await pool.query('SELECT com_value FROM mst_common WHERE com_id=$1 AND com_key=$2', [
              generatedId,
              generatedKey,
            ])
          ).rows[0]?.com_value,
          'after',
        );
        const deleted = await fetch(`${root}/System/DetailsCom`, {
          method: 'POST',
          headers: { cookie },
          body: new URLSearchParams({
            __RequestVerificationToken: csrf,
            'mst_common.com_id': String(generatedId),
            act: 'delete',
          }),
          redirect: 'manual',
        });
        assert.equal(deleted.status, 302);
        assert.equal(
          (
            await pool.query('SELECT com_id FROM mst_common WHERE com_id=$1 AND com_key=$2', [
              generatedId,
              generatedKey,
            ])
          ).rowCount,
          0,
        );
      } finally {
        await pool.query('DELETE FROM mst_common WHERE com_key=$1 AND com_name=$2', [
          generatedKey,
          'isolated parity check',
        ]);
      }
      const writeWithoutCsrf = await fetch(`${root}/System/CreateCom`, {
        method: 'POST',
        headers: { cookie },
        body: new URLSearchParams(),
        redirect: 'manual',
      });
      assert.equal(writeWithoutCsrf.status, 403);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await pool.end();
    }
  },
);

test('Common Master preserves hidden settings and FreeDrawOnly key restrictions', () => {
  assert.equal(commonSettingVisible('SYSTEM', 'LICENSE_UPLOADING_IS_ENABLED', false), false);
  assert.equal(commonSettingVisible('OTHER', 'PASSWORD_ENCRYPTION', false), false);
  assert.equal(commonSettingVisible('CLOUD_SETTING', 'ANY', false), false);
  assert.equal(commonSettingVisible('LIBRARY', 'BASE_FOLDER', true), true);
  assert.equal(commonSettingVisible('LIBRARY', 'FILE_LOCATION', true), false);
  assert.equal(commonSettingVisible('OTHER', 'ANY', true), false);
  assert.equal(commonSettingVisible('OTHER', 'ANY', false), true);
});

test('Common Master validates legacy enums, FreeDrawOnly writes and output paths', () => {
  const row = { com_key: 'IDENTIFICATION_SETTING', com_name: 'ENABLE_IDENTIFICATION', com_index: '1', com_value: '2' };
  assert.notEqual(validateCommonSetting(row, 'edit', false, false), '');
  assert.equal(validateCommonSetting({ ...row, com_value: '-1' }, 'edit', false, false), '');
  assert.notEqual(validateCommonSetting(row, 'create', true, false), '');
  assert.equal(validateCommonSetting({ ...row, com_value: '' }, 'create', false, false), '');
  assert.notEqual(validateCommonSetting({ ...row, com_index: '2147483648' }, 'create', false, false), '');
  assert.equal(cloudOutputPrefix('C:/ConMas/SettingFiles/output/sub'), 'C:/ConMas/SettingFiles/output/');
  assert.equal(
    storedOutputPath('/sub', 'C:/ConMas/SettingFiles/output/', true),
    'C:\\ConMas\\SettingFiles\\output\\sub\\',
  );
});
