import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import express from 'express';
import pg from 'pg';
import { XMLParser } from 'fast-xml-parser';
import { apiConfiguration } from '../../../src/config/api.js';
import { apiEntitlements, apiLoginResult, logApiOperation } from '../../../src/models/api-account.js';
import { apiDataLists, getApiData } from '../../../src/models/api-data.js';
import { apiDataImports } from '../../../src/controllers/api-data.js';
import { authenticate } from '../../../src/shared/authenticate.js';
import { legacyPassword } from '../../../src/shared/legacy-auth.js';
import { registerApiRoutes } from '../../../src/routes/api.js';
import { registerClientRoutes } from '../../../src/routes/client.js';
import { requestLog } from '../../../src/middleware/request-log.js';
import { ManagerSessionStore } from '../../../src/shared/manager-session.js';
import { createNativeUploadBody } from '../../../src/middleware/client-upload.js';

const parser = new XMLParser({ parseTagValue: false });
test('API configuration preserves every installed command, case-sensitive aliases and separate direct pages', async () => {
  const inventory = JSON.parse(await readFile('docs/conmas-api-coverage.json', 'utf8')),
    config = apiConfiguration();
  assert.equal(config.idleMs, 60 * 60 * 1000);
  assert.equal(config.maxRequestBytes, 160000000);
  assert.equal(config.culture, 'en-US');
  assert.equal(config.executeType, '1');
  assert.deepEqual(
    [...config.commands],
    inventory.commands.map((entry: { name: string; path: string }) => [entry.name, entry.path.slice(0, -5)]),
  );
  assert.deepEqual([...config.freeDrawCommands], inventory.freeDrawCommands);
  assert.deepEqual(
    [...config.directHandlers].sort(),
    inventory.endpoints
      .filter((entry: { deployed: boolean }) => entry.deployed)
      .map((entry: { path: string }) => entry.path.slice(0, -5))
      .sort(),
  );
  assert.equal(config.commands.get('WebAPI'), 'GeneralProcess');
  assert.equal(config.commands.get('LockWorkFlow'), 'LockWorkflow');
  assert(!config.commands.has('GeneralProcess'));
  assert(!config.commands.has('login'));
  assert.equal(inventory.counts.mappedTargetsAbsent, 12);
  assert.equal(inventory.counts.deployedClassesAbsent, 10);
  assert.equal(inventory.artifact.mvid, 'ac427b2b-efa0-44b3-81f2-16b6540d6bc2');
  assert.deepEqual(
    inventory.endpoints
      .filter((entry: { status: string }) => entry.status === 'partial')
      .map((entry: { path: string }) => entry.path)
      .sort(),
    [
      ...Object.keys(apiDataLists),
      ...apiDataImports,
      'Login',
      'Logout',
      'GeneralProcess',
      'GetCustomMasterLabel',
      'GetMasterList',
      'GetMasterRecordList',
      'GetMasterImage',
    ]
      .map((name) => name + '.aspx')
      .sort(),
  );
  assert.deepEqual(inventory.implementationCounts, {
    endpoints: { 'not-available': 12, 'not-implemented': 73, partial: 35, 'routing-only': 1 },
    mappedCommands: { 'not-available': 12, 'not-implemented': 62, partial: 35 },
    generalProcesses: { 'not-implemented': 1, partial: 7 },
  });
  assert.deepEqual(inventory.availabilityCounts, {
    endpoints: { available: 99, 'not-available': 12, unknown: 10 },
    mappedCommands: { available: 96, 'not-available': 12, unknown: 1 },
    generalProcesses: { available: 8 },
  });
  for (const entry of inventory.endpoints) {
    assert.equal(
      entry.availability,
      !entry.deployed ? 'not-available' : entry.handler ? 'available' : 'unknown',
      entry.path,
    );
    assert.equal(entry.status === 'not-available', !entry.deployed, entry.path);
    if (entry.deployed && !entry.handler) assert.equal(entry.status, 'not-implemented', entry.path);
  }
  assert.deepEqual(parser.parse(apiLoginResult(5, '<&')), { conmas: { loginResult: { code: '5', remark: '<&' } } });
  assert.deepEqual(parser.parse(apiLoginResult(0, '', true)), {
    conmas: {
      loginResult: [
        { code: '0', remark: '' },
        { code: '1', remark: 'User Password Expiration' },
      ],
    },
  });
});

test('API entitlement defaults, alternative licenses, counts, expiry boundaries and legacy global expiry', () => {
  const today = new Date(2026, 10, 7, 12),
    fields = new Map<string, string>();
  assert(apiEntitlements(fields, today).api);
  fields.set('ApiOption', '0');
  assert(!apiEntitlements(fields, today).api);
  for (const [name, value] of [
    ['ConMasIoTGateway', '+1'],
    ['MappingTool', '1'],
    ['WorkFlow', '2'],
    ['nXProjectHub', '1'],
    ['i-RepoWeb', '1'],
    ['i-RepoChat', '3'],
    ['i-RepoLink', '1'],
  ]) {
    fields.set(name, value);
    fields.set(name + 'Expire', '20261107');
    assert(apiEntitlements(fields, today).api, name);
    fields.set(name + 'Expire', '20261106');
    assert(!apiEntitlements(fields, today).api, name);
    fields.delete(name);
    fields.delete(name + 'Expire');
  }
  fields.set('MotionboardCloudAPIOption', '1');
  fields.set('IrPlus', '1');
  const special = apiEntitlements(fields, today);
  assert(!special.api);
  assert(special.motionboard);
  assert(special.irPlus);
  fields.set('FreeDrawOnlyApiOption', '1');
  fields.set('FreeDrawOnlyApiOptionExpire', '20261107');
  assert(!apiEntitlements(fields, today).freeDrawExpired);
  fields.set('FreeDrawOnlyApiOptionExpire', '20261106');
  assert(apiEntitlements(fields, today).freeDrawExpired);
  fields.set('Expiration', '20261106');
  assert(apiEntitlements(fields, today).notExpired);
  fields.set('User', '1');
  fields.set('iPad', '1');
  fields.set('Designer', '1');
  assert(!apiEntitlements(fields, today).notExpired);
  fields.set('Expiration', '20261107');
  assert(apiEntitlements(fields, today).notExpired);
  fields.set('User', 'invalid');
  assert(!apiEntitlements(fields, today).notExpired);
});

test('shared authentication uses API password setting only; Manager/client encryption and rollback remain intact', async () => {
  const key = 'private-fixture-key';
  for (const [mode, setting] of [
    ['manager', '0'],
    ['client', '0'],
    ['api', '0'],
    ['api', '1'],
    ['api', ''],
  ] as const) {
    const queries: string[] = [],
      encrypted = mode !== 'api' || setting === '1';
    let released = false;
    const db = {
      connect: async () => ({
        async query(sql: string, values?: unknown[]) {
          queries.push(sql);
          if (sql.startsWith('SELECT user_id,user_name,password'))
            return {
              rows: [
                {
                  user_id: 'fixture',
                  user_name: 'Fixture',
                  password: encrypted ? legacyPassword('fixture', 'password', key) : 'password',
                  active: true,
                },
              ],
            };
          if (sql.includes("com_key='PASSWORD_ENCRYPTION'")) return { rows: setting ? [{ com_value: setting }] : [] };
          if (sql.startsWith('DELETE')) assert.deepEqual(values, ['fixture']);
          return { rows: [] };
        },
        release() {
          released = true;
        },
      }),
    } as unknown as pg.Pool;
    assert.equal((await authenticate(db, 'fixture', 'password', key, mode)).user?.user_id, 'fixture');
    assert.equal(
      queries.some((sql) => sql.includes("com_key='PASSWORD_ENCRYPTION'")),
      mode === 'api',
    );
    assert(queries.includes('COMMIT'));
    assert(!queries.includes('ROLLBACK'));
    assert(released);
  }
  const queries: string[] = [];
  const failed = {
    connect: async () => ({
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes('FROM mst_user')) throw new Error('private-db-detail');
        return { rows: [] };
      },
      release() {},
    }),
  } as unknown as pg.Pool;
  await assert.rejects(authenticate(failed, 'fixture', 'password', key, 'api'));
  assert.equal(queries.at(-1), 'ROLLBACK');
});

async function fixture(run: (db: pg.Pool) => Promise<void>) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }),
    client = await pool.connect();
  try {
    for (const table of [
      'mst_user',
      'mst_common',
      'mst_group',
      'mst_group_affiation',
      'user_lock',
      'mst_terminal',
      'conmas_operation_log',
      'conmas_user_account_operation_log',
      'def_top',
      'rep_top',
      'def_role',
      'rep_role',
      'def_sheet',
      'rep_sheet',
      'def_reference',
      'rep_reference',
      'def_label',
      'rep_label',
      'def_rep_label',
      'mst_label_rep',
      'mst_label_def',
      'def_label_role',
      'rep_label_role',
      'def_lock',
      'def_cluster',
    ]) {
      await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    for (const sequence of [
      'mst_common_com_id_seq',
      'conmas_operation_history_seq',
      'mst_label_def_mst_label_id_seq',
      'mst_label_rep_mst_label_id_seq',
    ]) {
      await client.query(`CREATE TEMP SEQUENCE ${sequence} START 1000`);
      assert.equal(
        (await client.query(`SELECT '${sequence}'::regclass::oid='pg_temp.${sequence}'::regclass::oid AS private`))
          .rows[0].private,
        true,
      );
    }
    await client.query(`INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value,com_locale) VALUES
      (1,'PASSWORD_ENCRYPTION','PASSWORD_ENCRYPTION','1',''),(2,'ENCODING','CSV','65001','en-US'),
      (3,'LOG_SETTING','OPERATION','1',''),(4,'LOG_SETTING','USER_ACCOUNT_OPERATION_LOG','1','');
      INSERT INTO pg_temp.mst_group (group_id,group_name,role_api_execute,role_mst_read,role_mst_system_read,system_key) VALUES (1,'Fixture',1,1,1,'fixture-key'),(2,'Denied',0,0,0,'denied-key');
      INSERT INTO pg_temp.mst_group_affiation (group_id,user_id) VALUES (1,'fixture'),(2,'denied');`);
    await client.query('UPDATE pg_temp.mst_common SET com_index=1,sys_regist_time=now(),sys_update_time=now()');
    for (const user of ['fixture', 'denied', 'expired'])
      await client.query(
        `INSERT INTO pg_temp.mst_user (user_id,user_name,password,use_start_time,use_end_time,password_change_time) VALUES ($1,$2,$3,now()-interval '1 day',now()+interval '1 day',now())`,
        [user, 'Private Fixture', legacyPassword(user, 'private-password', process.env.CONMAS_LEGACY_KEY!)],
      );
    await run({
      query: client.query.bind(client),
      connect: async () => ({ query: client.query.bind(client), release() {} }),
    } as unknown as pg.Pool);
  } finally {
    client.release(true);
    await pool.end();
  }
}
const enabled = {
  skip: !process.env.DATABASE_URL || !process.env.CONMAS_LEGACY_KEY || !process.env.CONMAS_LICENSE_KEY,
};

test(
  'API list SQL and XML/CSV preserve source filters, defaults, nulls and reserved roles with private tables',
  enabled,
  async () =>
    fixture(async (db) => {
      await db.query(`INSERT INTO pg_temp.def_role (def_top_id,group_id,role_def_read) VALUES (20,1,1),(20,-999,1);
    INSERT INTO pg_temp.rep_role (rep_top_id,group_id,role_rep_read) VALUES (30,1,1),(30,-999,1);
    INSERT INTO pg_temp.mst_terminal (term_id,term_type,deleted) VALUES (1,'iPad',0),(2,'Windows',1);
    INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (5,'VIRTUAL_DIRECTORY','REFERENCE_PHYSICAL',''),(6,'VIRTUAL_DIRECTORY','REFERENCE_VIRTUAL','/references///');`);
      for (const handler of Object.keys(apiDataLists) as (keyof typeof apiDataLists)[]) {
        const xml = await getApiData(db, handler, 'xml', {}),
          csv = await getApiData(db, handler, 'csv', {});
        assert.match(xml, /<conmas(?:>| \/>)/, handler);
        assert(!csv || csv.endsWith('\r\n'), handler);
        if (handler === 'GetDefinitionRole' || handler === 'GetReportRole') {
          assert(!xml.includes('-999'));
          assert(!csv.includes('-999'));
        }
      }
      const filtered = await getApiData(db, 'GetUser', 'xml', { userId: 'fixture', withImprint: ' False ' });
      assert.match(filtered, /<userId>fixture<\/userId>/);
      assert(!filtered.includes('approvalSign'));
      assert(!filtered.includes('denied'));
      assert(!(await getApiData(db, 'GetUser', 'csv', { userId: "' OR 1=1 --" })));
      assert.match(await getApiData(db, 'GetTerminal', 'xml', { deleted: ' 1 ' }), /<termId>2<\/termId>/);
      assert(!(await getApiData(db, 'GetTerminal', 'xml', { deleted: '1' })).includes('<termId>1</termId>'));
      for (const kind of ['def', 'rep']) {
        const handler = kind === 'def' ? 'GetDefinitionLabelMaster' : 'GetReportLabelMaster';
        await db.query(`INSERT INTO pg_temp.mst_label_${kind} (mst_label_id,upper_label_id,label_name,label_id_path,label_icon_id,diplay_number,auto_delete,sys_regist_time,sys_update_time) VALUES
      (10,NULL,'Root','10',1,0,1,now(),now()),(11,10,'Hidden','10/11',1,0,0,now(),now()),(12,11,'Hidden child','10/11/12',1,0,0,now(),now()),(13,10,'Visible','10/13',1,0,0,now(),now());
      INSERT INTO pg_temp.${kind}_label_role (mst_label_id,group_id) VALUES (11,2),(13,1);`);
        const filtered = await getApiData(db, handler, 'xml', { useAuth: '1' }, 'fixture');
        assert.match(filtered, /<labelId>10<\/labelId>/);
        assert.match(filtered, /<labelId>13<\/labelId>/);
        assert(!filtered.includes('<labelId>11</labelId>'));
        assert(!filtered.includes('<labelId>12</labelId>'));
        assert.match(filtered, /<labelRoleGroup>1<\/labelRoleGroup>/);
        const all = await getApiData(db, handler, 'xml', {});
        assert.match(all, /<labelId>11<\/labelId>/);
        const admin = await getApiData(db, handler, 'csv', { useAuth: '1' }, 'conmasadmin');
        assert.match(admin, /"Hidden child"/);
        assert.match(admin, /,"1",""\r\n/);
        assert.match(admin, /,"0","2"\r\n/);
        const csv = await getApiData(db, handler, 'csv', { useAuth: '1' }, 'fixture');
        assert(!csv.includes('Hidden'));
        assert.match(csv, /,"0","1"\r\n/);
        await assert.rejects(getApiData(db, handler, 'xml', { useAuth: '1' }));
        assert.equal(
          await getApiData(db, handler, 'xml', { useAuth: '1' }, "' OR 1=1 --"),
          await getApiData(db, handler, 'xml', { useAuth: '1' }, 'no-membership'),
        );
      }
    }),
);

test(
  'API HTTP authentication, separate sessions, dispatcher, imports, failures and every-request diagnostics',
  enabled,
  async () =>
    fixture(async (db) => {
      const directory = await mkdtemp('/tmp/opencode/conmas-api-log-');
      const store = new ManagerSessionStore(async (data) => {
        if (data.apiAccount) await logApiOperation(db, data.apiAccount, data.logoutContent ?? 'LogoutTimeout');
      });
      const app = express();
      app.use(requestLog(directory));
      app.use(express.urlencoded({ extended: false }));
      registerClientRoutes(app, db);
      registerApiRoutes(app, db, store);
      const server = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', resolve));
      try {
        const address = server.address();
        assert(address && typeof address !== 'string');
        const origin = `http://127.0.0.1:${address.port}`,
          base = origin + '/ConMasAPI/Rests/';
        const call = async (path: string, options: RequestInit = {}) => {
          const response = await fetch(base + path, options),
            text = await response.text();
          assert(response.headers.get('x-request-id'));
          return { response, text };
        };
        const login = (user = 'fixture', password = 'private-password') =>
          call('APIExecute.aspx?command=Login', { method: 'POST', body: new URLSearchParams({ user, password }) });
        assert.match((await call('APIExecute.aspx?command=login')).text, /<code>1<\/code>/);
        assert.equal(
          (await call('APIExecute.aspx', { redirect: 'manual' })).response.headers.get('location'),
          '/ConMasAPI/Rests/Error.htm',
        );
        assert.match((await call('GetCommon.aspx?type=xml')).text, /<code>5<\/code>/);
        assert.match(
          (await call('GeneralProcess.aspx?target=InputReport&process=DownloadMergedPdf')).text,
          /<code>5<\/code>/,
        );
        assert.match((await login('denied')).text, /<code>3<\/code>/);
        assert.match((await login('fixture', 'wrong')).text, /<loginResult><code>1<\/code>/);
        await db.query(`INSERT INTO pg_temp.mst_group_affiation (group_id,user_id) VALUES (1,'expired');
      INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (105,'PASSWORD_SETTING','PASSWORD_MAXIMUM_AGE','1');
      UPDATE pg_temp.mst_user SET password_change_time=now()-interval '3 days' WHERE user_id='expired';`);
        const expired = await login('expired');
        assert.deepEqual(parser.parse(expired.text).conmas.loginResult, [
          { code: '0', remark: '' },
          { code: '1', remark: 'User Password Expiration' },
        ]);
        const expiredCookie = expired.response.headers.get('set-cookie')?.split(';')[0] ?? '';
        assert.match(
          (await call('GetCommon.aspx?type=xml', { headers: { cookie: expiredCookie } })).text,
          /<code>5<\/code>/,
        );
        assert.deepEqual(parser.parse((await login('expired', 'wrong')).text).conmas.loginResult, [
          { code: '1', remark: 'AuthFailure' },
          { code: '1', remark: 'User Password Expiration' },
        ]);
        const success = await login();
        assert.match(success.text, /<loginResult><code>0<\/code>/);
        let cookie = success.response.headers.get('set-cookie')!.split(';')[0];
        assert.match(success.response.headers.get('set-cookie')!, /Path=\/ConMasAPI/);
        assert.match((await call('getcommon.aspx?type=xml', { headers: { cookie } })).text, /<common>/);
        const csv = await call('APIExecute.aspx?command=GetCommon&type=csv&encoding=65001', { headers: { cookie } });
        assert.match(csv.response.headers.get('content-type')!, /^text\/plain/);
        assert(csv.text.endsWith('\r\n'));
        assert.match((await call('GetCommon.aspx?type=XML', { headers: { cookie } })).text, /<code>2<\/code>/);
        assert.match(
          (await call('GetDefinitionLabelMaster.aspx?type=xml&useAuth=', { headers: { cookie } })).text,
          /<code>2<\/code>/,
        );
        assert.match(
          (await call('GetReportLabelMaster.aspx?type=xml&useAuth=2', { headers: { cookie } })).text,
          /<code>2<\/code>/,
        );
        assert.equal(
          (await call('GetCommon.aspx?type=csv&encoding=1252', { headers: { cookie } })).response.status,
          501,
        );
        assert.match(
          (await call('GetCommon.aspx?type=csv&encoding=invalid', { headers: { cookie } })).text,
          /PASSWORD_ENCRYPTION/,
        );
        assert.equal(
          (await call('GetCommon.aspx?type=xml', { headers: { cookie, origin: 'https://example.invalid' } })).response
            .status,
          403,
        );
        assert.equal((await call('APIExecute.aspx?command=GetUserInfo', { headers: { cookie } })).response.status, 501);
        assert.equal((await call('GetUserInfo.aspx', { headers: { cookie } })).response.status, 404);
        assert.equal((await call('CopyReport.aspx', { headers: { cookie } })).response.status, 501);
        assert.match(
          (
            await call('GeneralProcess.aspx?target=System&process=LicenseStatusInquiry&item=ConMasIoTGateway', {
              headers: { cookie },
            })
          ).text,
          /<license>/,
        );
        assert.match(
          (
            await call(
              'APIExecute.aspx?command=WebAPI&target=System&process=LicenseStatusInquiry&item=ConMasIoTGateway',
              { headers: { cookie } },
            )
          ).text,
          /<license>/,
        );
        const native = await fetch(origin + '/ConMasWeb/Rests/ConMasIReporter.aspx?command=GetUser', {
          headers: { cookie },
        });
        assert.match(await native.text(), /<code>5<\/code>/);
        const upload = async (command: string, text: string, type = 'csv', options: Record<string, string> = {}) => {
          const body = new FormData();
          body.set('command', command);
          body.set('type', type);
          body.set('encoding', '65001');
          for (const [key, value] of Object.entries(options)) body.set(key, value);
          body.append('arbitrary-file-part', new Blob([text]), 'private-file.xml');
          body.append('ignored-second-part', new Blob(['private-ignored']), 'private-second.xml');
          return call('APIExecute.aspx', { method: 'POST', headers: { cookie }, body });
        };
        const common = await upload('RegistCommon', 'A,,PRIVATE_API,1,name,value,en-US\r\nA,,,,name,value,en-US\r\n');
        assert.match(common.text, /<code>0<\/code>/);
        assert.match(common.text, /<code>11010<\/code>/);
        assert.equal(
          (await db.query("SELECT com_value FROM pg_temp.mst_common WHERE com_key='PRIVATE_API'")).rows[0].com_value,
          'value',
        );
        assert.match(
          (await upload('RegistUserMeId', 'fixture,fixture@example.invalid,oid\r\nmissing,u,o\r\n')).text,
          /<code>10060<\/code>/,
        );
        assert.equal(
          (await db.query("SELECT meid_oid FROM pg_temp.mst_user WHERE user_id='fixture'")).rows[0].meid_oid,
          'oid',
        );
        assert.match((await upload('RegistGroupAffiliation', 'A,2,fixture\r\n')).text, /<code>0<\/code>/);
        assert.equal(
          (await db.query("SELECT app_type FROM pg_temp.conmas_user_account_operation_log WHERE user_id='fixture'"))
            .rows[0].app_type,
          'Api',
        );
        await db.query(`INSERT INTO pg_temp.def_sheet (def_sheet_id,def_top_id,def_sheet_no) VALUES (100,20,1);
      INSERT INTO pg_temp.rep_sheet (rep_sheet_id,rep_top_id,rep_sheet_no) VALUES (200,30,1);
      INSERT INTO pg_temp.def_reference (def_sheet_id,reference_id) VALUES (100,10);
      INSERT INTO pg_temp.rep_reference (rep_sheet_id,reference_id) VALUES (200,10);
      INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (100,'REFERENCE_TYPE','type','URL');`);
        for (const [command, text, table] of [
          ['RegistDefinitionRole', 'A,20,1,1,1,0,1,1,1,0\r\n', 'def_role'],
          ['RegistReportRole', 'A,30,1,1,1,0\r\n', 'rep_role'],
          ['RegistDefinitionLabel', 'A,20,10\r\n', 'def_label'],
          ['RegistReportLabelDefinition', 'A,20,10\r\n', 'def_rep_label'],
          ['RegistReportLabel', 'A,30,10\r\n', 'rep_label'],
          ['RegistDefinitionReference', 'U,20,1,10,URL,link,https://example.invalid,1\r\n', 'def_reference'],
          ['RegistReportReference', 'U,30,1,10,URL,link,https://example.invalid,1\r\n', 'rep_reference'],
          ['RegistDefinitionLabelMaster', 'M,10,,Fixture label,1,,0,1,0\r\n', 'mst_label_def'],
          ['RegistReportLabelMaster', 'M,10,,Fixture label,1,,0,1,0\r\n', 'mst_label_rep'],
        ]) {
          const result = await upload(command, text);
          assert.match(result.text, /<code>0<\/code>/, command);
          assert.equal((await db.query(`SELECT count(*) FROM pg_temp.${table}`)).rows[0].count, '1', command);
        }
        assert.match(
          (await upload('RegistDefinitionRole', 'private-invalid', 'csv', { defRoleModeTarget: 'bad' })).text,
          /Invalid Parameter \(defRoleModeTarget\)/,
        );
        assert.match(
          (await upload('RegistUserMeId', '<conmas><user><userId>fixture</userId><meidUpn/></user></conmas>', 'xml'))
            .text,
          /<code>10010<\/code>/,
        );
        assert.match((await upload('RegistCommon', '<!DOCTYPE conmas><conmas/>', 'xml')).text, /<code>-1<\/code>/);
        const definition =
          '<conmas><top><defTopId>20</defTopId><sheets><sheet><sheetNo>1</sheetNo><defSheetId>100</defSheetId><clusters><cluster><clusterId>1</clusterId><type>Select</type><inputParameters>Items=a;Labels=A;Mode=keep</inputParameters></cluster></clusters></sheet></sheets><networks/><unknown>retained</unknown></top></conmas>';
        await db.query('INSERT INTO pg_temp.def_top (def_top_id,xml_data) VALUES (20,$1)', [definition]);
        await db.query(
          "INSERT INTO pg_temp.def_cluster (def_sheet_id,cluster_id,input_parameter) VALUES (100,1,'Items=a;Labels=A')",
        );
        assert.match((await upload('UpdateSelectItem', '20,S,1,1,B,b,b\r\n')).text, /<code>0<\/code>/);
        assert.match(
          (await db.query('SELECT xml_data FROM pg_temp.def_top WHERE def_top_id=20')).rows[0].xml_data,
          /Items=b;Labels=B;Selected=b;Mode=keep/,
        );
        await db.query(
          "INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value,com_locale) VALUES (101,'API_MODE','MST_LABEL_REP_KEY_MODE','1','')",
        );
        assert.equal(
          (await upload('RegistReportLabelMaster', 'M,11,,Unsupported system key,1,,0,1,0\r\n')).response.status,
          501,
        );
        assert.equal((await db.query('SELECT 1 FROM pg_temp.mst_label_rep WHERE mst_label_id=11')).rowCount, 0);
        await db.query(
          "UPDATE pg_temp.mst_common SET com_value='0' WHERE com_key='API_MODE' AND com_name='MST_LABEL_REP_KEY_MODE'",
        );
        assert.match(
          (await call('GetReportLabelMaster.aspx?type=xml&useAuth=1', { headers: { cookie } })).text,
          /<labelId>10<\/labelId>/,
        );
        await db.query(
          "INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (106,'API_MODE','MST_GROUP_KEY_MODE','1')",
        );
        assert.match(
          (await upload('RegistReportLabelMaster', 'M,12,,API group system key,1,,0,fixture-key,0\r\n')).text,
          /<code>0<\/code>/,
        );
        assert.equal(
          (await db.query('SELECT group_id FROM pg_temp.rep_label_role WHERE mst_label_id=12')).rows[0].group_id,
          1,
        );
        const referenceDirectory = await mkdtemp('/tmp/opencode/conmas-api-reference-');
        try {
          await db.query(
            "INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (102,'VIRTUAL_DIRECTORY','REFERENCE_PHYSICAL',$1)",
            [referenceDirectory],
          );
          await db.query(
            "INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (103,'VIRTUAL_DIRECTORY','REFERENCE_VIRTUAL','/references///')",
          );
          const files = new FormData();
          files.append('first', new Blob(['reference one']), 'first.txt');
          files.append('second', new Blob(['reference two']), 'second.txt');
          assert.match(
            (await call('RegistReference.aspx', { method: 'POST', headers: { cookie }, body: files })).text,
            /<code>0<\/code>/,
          );
          assert.equal(await readFile(join(referenceDirectory, 'first.txt'), 'utf8'), 'reference one');
          assert.equal(await readFile(join(referenceDirectory, 'second.txt'), 'utf8'), 'reference two');
          const filename = 'あ,"&.txt',
            stamp = new Date(2026, 10, 7, 12, 34, 56);
          await writeFile(join(referenceDirectory, filename), 'fixture');
          await utimes(join(referenceDirectory, filename), stamp, stamp);
          await mkdir(join(referenceDirectory, 'nested'));
          await symlink(join(referenceDirectory, 'first.txt'), join(referenceDirectory, 'linked.txt'));
          const listing = await call('GetReference.aspx?type=xml', { headers: { cookie } });
          const references = parser.parse(listing.text).conmas.references;
          assert.equal(references.length, 3);
          assert.deepEqual(
            references.find((row: { fileName: string }) => row.fileName === filename),
            { fileName: filename, url: '/references/' + filename, size: '7', uploadTime: '2026/11/07 12:34:56' },
          );
          const csv = await call('GetReference.aspx?type=csv&encoding=65001', { headers: { cookie } });
          assert(csv.text.includes('"あ,""&.txt","/references/あ,""&.txt","7","2026/11/07 12:34:56"\r\n'));
          await db.query(
            "UPDATE pg_temp.mst_common SET com_value=$1 WHERE com_key='VIRTUAL_DIRECTORY' AND com_name='REFERENCE_PHYSICAL'",
            [join(referenceDirectory, 'absent')],
          );
          assert.equal(
            parser.parse((await call('GetReference.aspx?type=xml', { headers: { cookie } })).text).conmas,
            '',
          );
        } finally {
          await rm(referenceDirectory, { recursive: true, force: true });
        }
        const sid = (
          await db.query(
            "SELECT session_id FROM pg_temp.conmas_operation_log WHERE operation_content='LoginSuccess' ORDER BY log_time DESC LIMIT 1",
          )
        ).rows[0].session_id;
        const state = await new Promise<import('express-session').SessionData>((resolve, reject) =>
          store.get(sid, (error, data) => (error || !data ? reject(error) : resolve(data))),
        );
        state.apiAccount!.freeDrawOnly = true;
        await new Promise<void>((resolve) => store.set(sid, state, () => resolve()));
        assert.match(
          (await call('APIExecute.aspx?command=GetCommon&type=xml', { headers: { cookie } })).text,
          /<code>1<\/code>/,
        );
        assert.match((await call('APIExecute.aspx?command=GetUser&type=xml', { headers: { cookie } })).text, /<user>/);
        const failed = await call('Login.aspx', {
          method: 'POST',
          headers: { cookie },
          body: new URLSearchParams({ user: 'fixture', password: 'wrong' }),
        });
        assert.match(failed.text, /<code>1<\/code>/);
        assert.match((await call('GetCommon.aspx?type=xml', { headers: { cookie } })).text, /<code>5<\/code>/);
        cookie = (await login()).response.headers.get('set-cookie')!.split(';')[0];
        assert.notEqual(cookie, success.response.headers.get('set-cookie')!.split(';')[0]);
        assert.match((await call('Logout.aspx', { headers: { cookie } })).text, /<code>0<\/code>/);
        assert.match((await call('GetCommon.aspx?type=xml', { headers: { cookie } })).text, /<code>5<\/code>/);
        assert(
          (
            await db.query(
              "SELECT 1 FROM pg_temp.conmas_operation_log WHERE operation_content='Logout' AND app_type='Api'",
            )
          ).rowCount,
        );
        let logs = '';
        for (let i = 0; i < 100; i++) {
          const files = await readdir(directory);
          logs = (await Promise.all(files.map((file) => readFile(join(directory, file), 'utf8')))).join('');
          if (logs.includes('Logout.aspx') && logs.includes('rowResults')) break;
          await setTimeout(20);
        }
        const entries = logs
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        const entry = entries.find((row) => row.requestId === common.response.headers.get('x-request-id'));
        assert.deepEqual(entry.rowResults, { total: 2, failed: 1, codes: { '0': 1, '11010': 1 } });
        const expiredEntry = entries.find((row) => row.requestId === expired.response.headers.get('x-request-id'));
        assert.equal(expiredEntry.resultCode, 1);
        assert.deepEqual(expiredEntry.loginResults, [0, 1]);
        assert.deepEqual(entry.parameters, { command: 'RegistCommon', type: 'csv', encoding: '65001' });
        assert.equal(entry.uploadFiles, 2);
        assert(entry.session);
        assert(!logs.includes('private-'));
        assert(!logs.includes('PRIVATE_API'));
        assert(!logs.includes(sid));
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        store.clear();
        await rm(directory, { recursive: true, force: true });
      }
    }),
);

test('native multipart total limits reject authenticated overflow and unauthenticated requests without processing files', async () => {
  const app = express();
  app.use((_req, res, next) => {
    res.type('text/xml');
    next();
  });
  app.use(createNativeUploadBody(1024, (req) => req.get('x-private-auth') === '1'));
  app.post('/', (req, res) => res.send(String(req.file?.size ?? 0)));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const address = server.address();
    assert(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/`;
    const body = new FormData();
    body.append('file', new Blob(['x'.repeat(2048)]), 'private.xml');
    const denied = await fetch(url, { method: 'POST', body });
    assert.match(await denied.text(), /<code>5<\/code>/);
    const overflow = await fetch(url, { method: 'POST', body, headers: { 'x-private-auth': '1' } });
    assert.equal(overflow.status, 413);
    assert.match(await overflow.text(), /<code>-1<\/code>/);
    const small = new FormData();
    small.append('file', new Blob(['abc']), 'private.xml');
    assert.equal(
      await (await fetch(url, { method: 'POST', body: small, headers: { 'x-private-auth': '1' } })).text(),
      '3',
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
