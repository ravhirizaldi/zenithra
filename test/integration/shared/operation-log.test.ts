import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import session from 'express-session';
import { createApp } from '../../../src/server.js';
import { ManagerSessionStore, managerSessionIdleMs } from '../../../src/shared/manager-session.js';
import {
  logManagerOperation,
  logUserAccountChange,
  userAuditChanges,
  userAuditSnapshot,
  type UserAuditSnapshot,
} from '../../../src/shared/operation-log.js';
import { authenticate } from '../../../src/shared/authenticate.js';

test('masked account-lock errors retain the distinct legacy audit event', async () => {
  const rows = [
    { com_name: 'ACCOUNT_LOCKOUT_ENABLE', com_value: '1' },
    { com_name: 'ACCOUNT_LOCKOUT_FAILCOUNT', com_value: '2' },
    { com_name: 'ACCOUNT_LOCKOUT_DURATION', com_value: '60' },
    { com_name: 'RESPONSE_TYPE', com_value: '1' },
  ];
  const db = {
    connect: async () => ({
      query: async (sql: string) => ({
        rows: sql.includes('FROM mst_common')
          ? rows
          : sql.includes('FROM user_lock')
            ? [{ failure_count: 2, update_minutes: 0 }]
            : [],
      }),
      release: () => {},
    }),
  } as unknown as pg.Pool;
  const result = await authenticate(db, 'fixture', 'unused', 'unused');
  assert.equal(result.error, 'Incorrect user name or password.');
  assert.equal(result.logContent, 'LoginLockError');
});

test('user audit uses legacy change keys, minute precision snapshots and set membership', () => {
  const before: UserAuditSnapshot = {
    user_id: 'fixture',
    user_name: 'Before',
    password: 'encrypted',
    e_mail: 'a',
    start_minute: '202001010000',
    end_minute: '205001010000',
    approval_sign: '',
    amivoice_enable: '0',
    groups: ['1', '2'],
  };
  assert.equal(userAuditChanges(before, { ...before, groups: ['2', '1'] }), '');
  assert.equal(
    userAuditChanges(before, { ...before, user_name: 'After', password: 'new encrypted', groups: ['2'] }),
    'UpdatetUserName;UpdatetUserPassWd;UpdatetUserGroup',
  );
});

test('session store renews idle expiry and ends each session once', async () => {
  assert.equal(managerSessionIdleMs, 20 * 60 * 1000);
  const ended: string[] = [];
  const store = new ManagerSessionStore(async (data) => {
    ended.push(data.userId ?? '');
  }, 40);
  const data = { cookie: new session.Cookie(), userId: 'fixture' };
  data.cookie.path = '/ConMasManager';
  store.set('fixture', data);
  await new Promise((resolve) => setTimeout(resolve, 25));
  store.touch('fixture', data);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(ended, []);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(ended, ['fixture']);
  await new Promise<void>((resolve) => store.destroy('fixture', () => resolve()));
  assert.deepEqual(ended, ['fixture']);
  store.clear();
});

test(
  'authentication audit, login history, account changes and timeout flow use private legacy tables',
  { skip: !process.env.DATABASE_URL || !process.env.CONMAS_LEGACY_KEY || !process.env.CONMAS_TEST_PASSWORD },
  async () => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }),
      client = await pool.connect();
    let enabled = true;
    const queries: string[] = [];
    const db = {
      query: (sql: string, values?: unknown[]) => {
        queries.push(sql);
        if (sql.includes("com_key='LOG_SETTING'"))
          return Promise.resolve({ rows: [{ com_value: enabled ? '1' : '0' }] });
        if (
          /\b(?:mst_user|mst_group_affiation|conmas_operation_log|conmas_user_account_operation_log|conmas_operation_history_seq)\b/.test(
            sql,
          )
        )
          return client.query(sql, values);
        return pool.query(sql, values);
      },
      connect: async () => ({ query: client.query.bind(client), release: () => {} }),
    } as unknown as pg.Pool;
    const store = new ManagerSessionStore(async (data) => {
      if (data.operationLogContext)
        await logManagerOperation(db, data.operationLogContext, data.logoutContent ?? 'LogoutTimeout');
    });
    let server: ReturnType<ReturnType<typeof createApp>['listen']> | undefined;
    try {
      await client.query(`CREATE TEMP TABLE conmas_operation_log (LIKE public.conmas_operation_log INCLUDING ALL);
      CREATE TEMP TABLE conmas_user_account_operation_log (LIKE public.conmas_user_account_operation_log INCLUDING ALL);
      CREATE TEMP TABLE mst_user (LIKE public.mst_user INCLUDING ALL);
      CREATE TEMP TABLE mst_group_affiation (LIKE public.mst_group_affiation INCLUDING ALL);
      CREATE TEMP TABLE user_lock (LIKE public.user_lock INCLUDING ALL);
      CREATE TEMP SEQUENCE conmas_operation_history_seq;
      INSERT INTO pg_temp.mst_user SELECT * FROM public.mst_user WHERE user_id='conmasadmin';
      INSERT INTO pg_temp.mst_group_affiation SELECT * FROM public.mst_group_affiation WHERE user_id='conmasadmin';`);
      assert.equal(
        (
          await client.query(
            "SELECT 'conmas_operation_history_seq'::regclass::oid='pg_temp.conmas_operation_history_seq'::regclass::oid AS private",
          )
        ).rows[0].private,
        true,
      );
      server = createApp(db, true, store).listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server!.once('listening', resolve));
      const address = server.address();
      assert(address && typeof address !== 'string');
      const root = `http://127.0.0.1:${address.port}/ConMasManager`;
      const login = (password: string) =>
        fetch(root + '/Account/LogOn', {
          method: 'POST',
          body: new URLSearchParams({ UserName: 'conmasadmin', Password: password }),
          redirect: 'manual',
          headers: { 'user-agent': 'Mozilla/5.0 Chrome/130.0.0.0' },
        });
      const good = await login(process.env.CONMAS_TEST_PASSWORD!);
      assert.equal(good.status, 302);
      let cookie = good.headers.get('set-cookie')?.split(';')[0];
      assert(cookie);
      assert.doesNotMatch(good.headers.get('set-cookie') ?? '', /Expires=|Max-Age=/);
      const history = await fetch(root + '/System/OperationLog', { headers: { cookie } });
      assert.equal(history.status, 200);
      const html = await history.text();
      assert.match(html, /LoginSuccess:Login succeeded/);
      assert.match(html, /Chrome130\.0\.0\.0/);
      assert.match(html, /conmasadmin/);
      const csrf = html.match(/name="__RequestVerificationToken" value="([^"]+)"/)?.[1];
      assert(csrf);
      const userForm = new URLSearchParams({
        __RequestVerificationToken: csrf,
        'mst_user.user_id': 'audit-fixture',
        'mst_user.user_name': 'Audit fixture',
        'mst_user.e_mail': 'fixture@example.test',
        'mst_user.use_start_time': '2020/01/01',
        'mst_user.use_end_time': '2050/01/01',
        'mst_user.password': 'Z9!hR7#kL5@qV2$mN8&fX6',
        confirm_password: 'Z9!hR7#kL5@qV2$mN8&fX6',
      });
      const writeUser = (route: string, body: URLSearchParams) =>
        fetch(root + '/System/' + route, { method: 'POST', headers: { cookie: cookie! }, body, redirect: 'manual' });
      assert.equal((await writeUser('CreateUser', userForm)).status, 302);
      userForm.delete('mst_user.password');
      userForm.set('confirm_password', '');
      userForm.set('mst_user.user_name', 'Audit edited');
      assert.equal((await writeUser('EditUser', userForm)).status, 302);
      assert.equal((await writeUser('EditUser', userForm)).status, 302);
      assert.equal(
        (
          await writeUser(
            'DetailsUser',
            new URLSearchParams({
              __RequestVerificationToken: csrf,
              'mst_user.user_id': 'audit-fixture',
              act: 'delete',
            }),
          )
        ).status,
        302,
      );
      assert.deepEqual(
        (
          await client.query(
            "SELECT operation_content FROM pg_temp.conmas_user_account_operation_log WHERE user_id='audit-fixture' ORDER BY log_id",
          )
        ).rows.map((row) => row.operation_content),
        ['RegistUser', 'UpdatetUserName', 'DeleteUser'],
      );
      await client.query(
        "INSERT INTO pg_temp.conmas_operation_log (log_id,log_time) VALUES ('2000010100000000000000000000000001','2000-01-01')",
      );
      assert.equal(
        (
          await writeUser(
            'DeleteOperationLog',
            new URLSearchParams({ __RequestVerificationToken: csrf, DeleteDays: '1' }),
          )
        ).status,
        200,
      );
      assert.equal(
        (await client.query("SELECT 1 FROM pg_temp.conmas_operation_log WHERE log_time='2000-01-01'")).rowCount,
        0,
      );
      const off = await fetch(root + '/Account/LogOff', { headers: { cookie }, redirect: 'manual' });
      assert.equal(off.status, 302);
      assert.match(off.headers.get('set-cookie') ?? '', /Expires=Thu, 01 Jan 1970/);
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::int AS n FROM pg_temp.conmas_operation_log WHERE operation_content='Logout'",
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (await fetch(root + '/System/OperationLog', { headers: { cookie }, redirect: 'manual' })).headers.get(
          'location',
        ),
        '/ConMasManager/Account/Dummy',
      );
      const timedOut = await fetch(root + '/Account/Dummy', { headers: { cookie } });
      const dummy = await timedOut.text();
      assert.match(dummy, /id="re_logon_script"/);
      assert.match(dummy, /Session was time out\. Please log-in again\./);
      assert.match(dummy, /Account\/LogOn\?timeout=false/);
      assert.equal(
        (await fetch(root + '/Account/LogOn?timeout=false', { redirect: 'manual' })).headers.get('location'),
        '/ConMasManager/Account/LogOff?timeout=true',
      );
      const fresh = await login(process.env.CONMAS_TEST_PASSWORD!);
      cookie = fresh.headers.get('set-cookie')?.split(';')[0];
      assert(cookie);
      const sessions = await new Promise<Record<string, session.SessionData>>((resolve, reject) =>
        store.all((error, data) => (error ? reject(error) : resolve(data as Record<string, session.SessionData>))),
      );
      const active = Object.entries(sessions).find(([, data]) => data.userId === 'conmasadmin');
      assert(active);
      store.set(active[0], { ...active[1], userEnd: '2000-01-01T00:00:00Z' });
      assert.equal(
        (await fetch(root + '/System/OperationLog', { headers: { cookie }, redirect: 'manual' })).headers.get(
          'location',
        ),
        '/ConMasManager/Account/Dummy',
      );
      await new Promise<void>((resolve, reject) =>
        store.destroy(active[0], (error) => (error ? reject(error) : resolve())),
      );
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::int AS n FROM pg_temp.conmas_operation_log WHERE operation_content='LogoutTimeout'",
          )
        ).rows[0].n,
        1,
      );
      const rejected = await fetch(root + '/System/DeleteOperationLog', {
        method: 'POST',
        headers: { cookie, 'X-Requested-With': 'XMLHttpRequest' },
        body: new URLSearchParams({ __RequestVerificationToken: csrf, DeleteDays: '0' }),
        redirect: 'manual',
      });
      assert.equal(rejected.headers.get('location'), '/ConMasManager/Account/Dummy');
      const bad = await login('deliberately-wrong');
      assert.equal(bad.status, 401);
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::int AS n FROM pg_temp.conmas_operation_log WHERE operation_content='LoginAuthError' AND user_name=''",
          )
        ).rows[0].n,
        1,
      );
      enabled = false;
      const previous = (await client.query('SELECT count(*)::int AS n FROM pg_temp.conmas_operation_log')).rows[0].n;
      await login(process.env.CONMAS_TEST_PASSWORD!);
      assert.equal(
        (await client.query('SELECT count(*)::int AS n FROM pg_temp.conmas_operation_log')).rows[0].n,
        previous,
      );
      enabled = true;
      const before = await userAuditSnapshot(db, 'conmasadmin');
      assert(before);
      const after = { ...before, user_name: 'Fixture changed', groups: ['123'] };
      await logUserAccountChange(db, null, before, 'fixture-actor', '127.0.0.1');
      await logUserAccountChange(db, before, after, 'fixture-actor', '127.0.0.1');
      await logUserAccountChange(db, after, after, 'fixture-actor', '127.0.0.1');
      await logUserAccountChange(db, after, null, 'fixture-actor', '127.0.0.1');
      const logs = (
        await client.query(
          "SELECT operation_type,operation_content,update_user_id FROM pg_temp.conmas_user_account_operation_log WHERE user_id='conmasadmin' ORDER BY log_id",
        )
      ).rows;
      assert.deepEqual(
        logs.map((row) => row.operation_content),
        ['RegistUser', 'UpdatetUserName;UpdatetUserGroup', 'DeleteUser'],
      );
      assert.ok(logs.every((row) => row.update_user_id === 'fixture-actor'));
      assert.ok(queries.some((sql) => sql.includes('INSERT INTO conmas_operation_log')));
    } finally {
      store.clear();
      if (server)
        await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
      await client.query(
        'DROP TABLE IF EXISTS pg_temp.conmas_operation_log,pg_temp.conmas_user_account_operation_log,pg_temp.mst_group_affiation,pg_temp.mst_user,pg_temp.user_lock;DROP SEQUENCE IF EXISTS pg_temp.conmas_operation_history_seq',
      );
      client.release();
      await pool.end();
    }
  },
);
