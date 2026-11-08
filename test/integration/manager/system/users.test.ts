import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import sharp from 'sharp';
import ejs from 'ejs';
import { Script } from 'node:vm';
import { createApp } from '../../../helpers/app.js';
import { userDate, validUserId } from '../../../../src/controllers/manager/system/users.js';
import { passwordRuleErrors } from '../../../../src/shared/user-password-strength.js';

test('Create User renders the legacy confirmation, blank text dates and group search controls', async () => {
  const html = await ejs.renderFile('src/views/manager/system/user-form.ejs', {
    base: '/ConMasManager',
    csrfToken: 'fixture',
    userPage: {
      mode: 'CreateUser',
      record: { user_id: '', user_name: '', e_mail: '', use_start_time: '', use_end_time: '' },
      groups: [],
    },
  });
  assert.equal((html.match(/value="Confirm"/g) || []).length, 2);
  assert.match(html, /Enter the password for confirmation/);
  for (const field of ['use_start_time', 'use_end_time'])
    assert.ok(html.includes(`class="text-box single-line" name="mst_user.${field}" type="text" value=""`));
  assert.doesNotMatch(html, /datetime-local|value="Fix"/);
  assert.match(html, /Group Name<\/label>&nbsp;/);
  assert.match(html, /datepicker\(\$\.datepicker\.regional\[browserLanguage\(\)\]\)/);
  for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) new Script(script[1]);
});

test('user validity and password rules retain the original boundaries', () => {
  assert.equal(userDate('2028-02-29', true), '2028-02-29 23:59:59');
  assert.equal(userDate('2027-02-29'), null);
  assert.equal(userDate('2028-01-01T00:00:01', true), '2028-01-01 00:00:01');
  assert.equal(validUserId('user:name'), false);
  assert.equal(validUserId('user.'), false);
  assert.equal(validUserId('longname', 3), false);
  assert.equal(validUserId('operator-01'), true);
  assert.match(passwordRuleErrors({ SIMILAR_PASSWORD: '1' }, 'operator', 'xx123yy').join(), /sequences/);
  assert.match(passwordRuleErrors({ INCLUDE_MIXED_CASE: '1' }, 'operator', 'lowercase').join(), /uppercase/);
});

test(
  'user create/edit/delete persist encrypted fields and group membership atomically',
  { skip: !process.env.DATABASE_URL || !process.env.CONMAS_TEST_PASSWORD },
  async () => {
    const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const server = createApp(db).listen(0, '127.0.0.1');
    const id = `node-test-${randomUUID().slice(0, 8)}`;
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
      const form = await (await fetch(`${root}/System/CreateUser`, { headers: { cookie } })).text();
      const token = form.match(/name="__RequestVerificationToken" value="([^"]+)"/)?.[1];
      assert(token);
      const group = (
        await db.query(
          'SELECT group_id FROM mst_group WHERE deleted=0 AND group_id > -999 ORDER BY group_name_path,group_id LIMIT 1',
        )
      ).rows[0];
      assert(group);
      const password = 'Z9!hR7#kL5@qV2$mN8&fX6';
      const data = new URLSearchParams({
        __RequestVerificationToken: token,
        'mst_user.user_id': id,
        'mst_user.user_name': 'Port test',
        'mst_user.e_mail': 'port@example.test',
        'mst_user.use_start_time': '2020-01-01T00:00',
        'mst_user.use_end_time': '2050-01-01T00:00',
        'mst_user.password': password,
        confirm_password: password,
        'mst_user.IdentificationCode': '1234',
        'userGroupsPage[0].group_id': String(group.group_id),
        'userGroupsPage[0].chk': 'true',
        'userGroupsPage[0].use_start_time': '2020-01-01T00:00',
        'userGroupsPage[0].use_end_time': '2050-01-01T00:00',
      });
      assert.equal(await (await fetch(`${root}/System/GetTemporaryUserSign`, { headers: { cookie } })).text(), '');
      const stamp = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#123456' } })
        .png()
        .toBuffer();
      const upload = new FormData();
      for (const [key, value] of data) upload.append(key, key === 'mst_user.user_name' ? '' : value);
      upload.append('file', new Blob([new Uint8Array(stamp)], { type: 'image/png' }), 'stamp.png');
      const invalid = await fetch(`${root}/System/CreateUser`, { method: 'POST', headers: { cookie }, body: upload });
      assert.equal(invalid.status, 400);
      assert.match(await invalid.text(), /src="\/ConMasManager\/System\/GetTemporaryUserSign"/);
      assert.equal((await db.query('SELECT 1 FROM mst_user WHERE user_id=$1', [id])).rowCount, 0);
      const temporary = await fetch(`${root}/System/GetTemporaryUserSign`, { headers: { cookie } });
      assert.equal(temporary.status, 200);
      assert.equal(temporary.headers.get('content-disposition'), 'attachment; filename="sign"');
      assert.deepEqual(Buffer.from(await temporary.arrayBuffer()), stamp);
      const privateSession = await fetch(`${root}/Account/LogOn`, {
        method: 'POST',
        body: new URLSearchParams({ UserName: 'conmasadmin', Password: process.env.CONMAS_TEST_PASSWORD! }),
        redirect: 'manual',
      });
      const privateCookie = privateSession.headers.get('set-cookie')?.split(';')[0];
      assert(privateCookie);
      assert.equal(
        await (await fetch(`${root}/System/GetTemporaryUserSign`, { headers: { cookie: privateCookie } })).text(),
        '',
      );
      const created = await fetch(`${root}/System/CreateUser`, {
        method: 'POST',
        headers: { cookie },
        body: data,
        redirect: 'manual',
      });
      assert.equal(created.status, 302, await created.text());
      const before = (
        await db.query(
          "SELECT password,identification_code,to_char(use_end_time,'HH24:MI:SS') AS end_time FROM mst_user WHERE user_id=$1",
          [id],
        )
      ).rows[0];
      assert.notEqual(before.password, password);
      assert.notEqual(before.identification_code, '1234');
      assert.equal(before.end_time, '23:59:59');
      assert.equal(
        (await db.query('SELECT approval_sign FROM mst_user WHERE user_id=$1', [id])).rows[0].approval_sign,
        stamp.toString('base64'),
      );
      assert.equal(
        (await db.query('SELECT 1 FROM mst_group_affiation WHERE user_id=$1 AND group_id=$2', [id, group.group_id]))
          .rowCount,
        1,
      );
      const detail = await fetch(`${root}/System/DetailsUser?id=${id}`, { headers: { cookie } });
      assert.equal(detail.status, 200);
      assert.match(await detail.text(), /Port test/);
      const editForm = await fetch(`${root}/System/EditUser?id=${id}`, { headers: { cookie } });
      assert.equal(editForm.status, 200);
      assert.equal(await (await fetch(`${root}/System/GetTemporaryUserSign`, { headers: { cookie } })).text(), '');
      data.set('mst_user.user_name', 'Updated');
      data.delete('mst_user.password');
      data.set('confirm_password', '');
      data.set('IsClearImage', 'true');
      data.set('mst_user.user_name', '');
      const invalidClear = await fetch(`${root}/System/EditUser`, { method: 'POST', headers: { cookie }, body: data });
      assert.equal(invalidClear.status, 400);
      assert.match(await invalidClear.text(), /name="IsClearImage" value="true" checked/);
      data.set('mst_user.user_name', 'Updated');
      const edited = await fetch(`${root}/System/EditUser`, {
        method: 'POST',
        headers: { cookie },
        body: data,
        redirect: 'manual',
      });
      assert.equal(edited.status, 302, await edited.text());
      const after = (
        await db.query('SELECT user_name,password,identification_code FROM mst_user WHERE user_id=$1', [id])
      ).rows[0];
      assert.equal(after.user_name, 'Updated');
      assert.equal(after.password, before.password);
      assert.equal(after.identification_code, before.identification_code);
      assert.equal(
        (await db.query('SELECT approval_sign FROM mst_user WHERE user_id=$1', [id])).rows[0].approval_sign,
        '',
      );
      data.set('act', 'delete');
      const deleted = await fetch(`${root}/System/DetailsUser`, {
        method: 'POST',
        headers: { cookie },
        body: data,
        redirect: 'manual',
      });
      assert.equal(deleted.status, 302);
      assert.equal((await db.query('SELECT 1 FROM mst_user WHERE user_id=$1', [id])).rowCount, 0);
      assert.equal((await db.query('SELECT 1 FROM mst_group_affiation WHERE user_id=$1', [id])).rowCount, 0);
    } finally {
      await db.query('DELETE FROM mst_user WHERE user_id=$1', [id]);
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await db.end();
    }
  },
);
