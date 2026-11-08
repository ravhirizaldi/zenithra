import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { XMLParser } from 'fast-xml-parser';
import { createApp } from '../../../src/app.js';
import { legacyPassword, legacyDecrypt } from '../../../src/shared/legacy-auth.js';
import { clientConfiguration, validClientVersion } from '../../../src/config/client.js';
import { readLicenseXml, clientIoTLicenseStatus } from '../../../src/shared/license-counts.js';
import { clientElement, clientError } from '../../../src/services/client-xml.js';
import { mkdtemp, rm } from 'node:fs/promises';

test('Node-owned client configuration and legacy XML/version contracts', () => {
  const configuration = clientConfiguration();
  assert.equal(configuration.idleMs, 60 * 60 * 1000);
  assert(configuration.commands.has('RegistDefinition'));
  assert(validClientVersion('7.2.13950', '8.2.25101'));
  assert(validClientVersion('8.2.25101', '8.2.25101'));
  assert(!validClientVersion('8.2.25101', '8.2.25100'));
  assert(!validClientVersion('8.2.1', '8.2'));
  assert(!validClientVersion('8.2.1', '8.no.1'));
  assert.equal(clientElement('value', '<&"\''), '<value>&lt;&amp;&quot;&apos;</value>');
  assert.deepEqual(new XMLParser().parse(clientError(5, 'no session.')), {
    conmas: { error: { code: 5, remarks: { remark: 'no session.' } } },
  });
});

test(
  'Designer HTTP login, terminal registration, license receive, logout and isolation use private tables',
  { skip: !process.env.DATABASE_URL || !process.env.CONMAS_LEGACY_KEY || !process.env.CONMAS_LICENSE_KEY },
  async () => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const connection = await pool.connect();
    const db = {
      query: connection.query.bind(connection),
      connect: async () => ({ query: connection.query.bind(connection), release() {} }),
    } as unknown as pg.Pool;
    let server: ReturnType<ReturnType<typeof createApp>['listen']> | undefined;
    const parser = new XMLParser({ parseTagValue: false });
    const libraryDirectory = await mkdtemp('/tmp/opencode/client-http-library-');
    try {
      await connection.query(`CREATE TEMP TABLE mst_user (LIKE public.mst_user INCLUDING ALL);
        CREATE TEMP TABLE mst_common (LIKE public.mst_common INCLUDING ALL);
        CREATE TEMP TABLE mst_terminal (LIKE public.mst_terminal INCLUDING ALL);
        CREATE TEMP TABLE mst_group_affiation (LIKE public.mst_group_affiation INCLUDING ALL);
        CREATE TEMP TABLE common_data_version (LIKE public.common_data_version INCLUDING ALL);
        CREATE TEMP TABLE user_lock (LIKE public.user_lock INCLUDING ALL);
        CREATE TEMP TABLE conmas_operation_log (LIKE public.conmas_operation_log INCLUDING ALL);
        CREATE TEMP TABLE def_top (LIKE public.def_top INCLUDING ALL);
        CREATE TEMP TABLE def_lock (LIKE public.def_lock INCLUDING ALL);
        CREATE TEMP TABLE def_role (def_top_id integer,group_id integer,role_def_read integer,role_def_update integer,role_rep_create integer);
        CREATE TEMP TABLE mst_group (group_id integer,deleted integer,role_mst_read numeric,role_mst_system_read numeric,role_library_read numeric,role_library_delete numeric);
        CREATE TEMP TABLE def_current (def_top_id integer,def_top_org integer);
        CREATE TEMP TABLE def_label_role (mst_label_id integer,group_id integer);
        CREATE TEMP TABLE mst_label_def (mst_label_id integer,label_name text,label_name_path text,label_icon_id integer,diplay_number integer,upper_label_id integer,label_remarks text,label_id_path text,sys_regist_time timestamp,sys_update_time timestamp);
        CREATE TEMP TABLE def_label (def_top_id integer,mst_label_id integer);
        CREATE TEMP TABLE def_sheet (def_top_id integer,def_sheet_id integer,def_sheet_no integer,background_image_file bytea);
        CREATE TEMP TABLE def_top_backup (LIKE public.def_top_backup INCLUDING ALL);
        CREATE TEMP TABLE def_grammar (LIKE public.def_grammar INCLUDING ALL);
        CREATE TEMP TABLE common_grammar (LIKE public.common_grammar INCLUDING ALL);
        CREATE TEMP TABLE custom_master_synching_terminal (LIKE public.custom_master_synching_terminal INCLUDING ALL);
        CREATE TEMP TABLE rep_schedule (LIKE public.rep_schedule INCLUDING ALL);
        CREATE TEMP TABLE rep_schedule_user (LIKE public.rep_schedule_user INCLUDING ALL);
        CREATE TEMP TABLE rep_current (LIKE public.rep_current INCLUDING ALL);
        CREATE TEMP TABLE rep_role (LIKE public.rep_role INCLUDING ALL);
        CREATE TEMP TABLE rep_lock (LIKE public.rep_lock INCLUDING ALL);
        CREATE TEMP TABLE mst_task (LIKE public.mst_task INCLUDING ALL);
        CREATE TEMP TABLE mst_holiday (LIKE public.mst_holiday INCLUDING ALL);
        CREATE TEMP TABLE mst_message (LIKE public.mst_message INCLUDING ALL);
        CREATE TEMP TABLE mst_custom_default_record (LIKE public.mst_custom_default_record INCLUDING ALL);
        CREATE TEMP TABLE mst_custom_record (LIKE public.mst_custom_record INCLUDING ALL);
        CREATE TEMP TABLE custom_menu (LIKE public.custom_menu INCLUDING ALL);
        CREATE TEMP TABLE custom_menu_setting (LIKE public.custom_menu_setting INCLUDING ALL);
        CREATE TEMP TABLE custom_menu_role (LIKE public.custom_menu_role INCLUDING ALL);
        CREATE TEMP TABLE mst_common_document (LIKE public.mst_common_document INCLUDING ALL);
        CREATE TEMP TABLE mst_report_document (LIKE public.mst_report_document INCLUDING ALL);
        CREATE TEMP TABLE mst_image_document (LIKE public.mst_image_document INCLUDING ALL);
        CREATE TEMP TABLE mst_common_document_role (LIKE public.mst_common_document_role INCLUDING ALL);
        CREATE TEMP TABLE mst_report_document_role (LIKE public.mst_report_document_role INCLUDING ALL);
        CREATE TEMP TABLE mst_image_document_role (LIKE public.mst_image_document_role INCLUDING ALL);
        CREATE TEMP TABLE common_document_irfd_role (LIKE public.common_document_irfd_role INCLUDING ALL);
        CREATE TEMP TABLE mst_label_common_document (LIKE public.mst_label_common_document INCLUDING ALL);
        CREATE TEMP TABLE common_document_label_role (LIKE public.common_document_label_role INCLUDING ALL);
        CREATE TEMP TABLE common_document_label (LIKE public.common_document_label INCLUDING ALL);
        CREATE TEMP TABLE document_lock (LIKE public.document_lock INCLUDING ALL);
        CREATE TEMP TABLE log_library_download (LIKE public.log_library_download INCLUDING ALL);
        CREATE TEMP SEQUENCE library_http_log_seq;
        ALTER TABLE pg_temp.log_library_download ALTER COLUMN log_id SET DEFAULT nextval('pg_temp.library_http_log_seq');
        CREATE TEMP TABLE rep_top (LIKE public.rep_top INCLUDING ALL);
        CREATE TEMP TABLE def_cluster (def_sheet_id integer,cluster_id integer,cluster_name text,cluster_type text);
        CREATE TEMP TABLE def_reference (def_sheet_id integer,reference_type text,reference_name text,reference_value text,diplay_number integer);
        CREATE TEMP TABLE def_cluster_role (def_sheet_id integer,cluster_id integer,group_id integer);
        CREATE TEMP TABLE def_cluster_refer (def_sheet_id integer,cluster_id integer,group_id integer);
        CREATE TEMP SEQUENCE mst_terminal_term_id_seq;
        CREATE TEMP SEQUENCE conmas_operation_history_seq;`);
      assert.equal(
        (
          await connection.query(
            "SELECT 'mst_terminal_term_id_seq'::regclass::oid='pg_temp.mst_terminal_term_id_seq'::regclass::oid AS private",
          )
        ).rows[0].private,
        true,
      );
      assert.equal(
        (
          await connection.query(
            "SELECT 'conmas_operation_history_seq'::regclass::oid='pg_temp.conmas_operation_history_seq'::regclass::oid AS private",
          )
        ).rows[0].private,
        true,
      );
      await connection.query(
        `INSERT INTO pg_temp.mst_user (user_id,user_name,password,use_start_time,use_end_time,sys_update_time)
        VALUES ($1,$2,$3,NULL,NULL,now())`,
        [
          'designer-fixture',
          'Designer <fixture>',
          legacyPassword('designer-fixture', 'fixture-password', process.env.CONMAS_LEGACY_KEY!),
        ],
      );
      await connection.query(`INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value,com_index) VALUES
        (1,'LOG_SETTING','OPERATION','1',0),(2,'TERMINAL_SETTING','APPROVE_MODE','0',0),
        (3,'ACCOUNT_LOCK_SETTING','ACCOUNT_LOCKOUT_ENABLE','1',0),(4,'ACCOUNT_LOCK_SETTING','ACCOUNT_LOCKOUT_FAILCOUNT','2',0),
        (5,'ACCOUNT_LOCK_SETTING','ACCOUNT_LOCKOUT_DURATION','60',0),(6,'ACCOUNT_LOCK_SETTING','RESPONSE_TYPE','0',0),
        (7,'IPAD_SETTING','AUTO_CUSTOM_MASTER_UPDATING','0',0)`);
      await connection.query(
        "INSERT INTO pg_temp.common_data_version (data_id,data_version) VALUES ('CustomMenu','fixture-version'),('CustomMaster','fixture-master-version'),('CustomMasterlabel','fixture-label-version')",
      );
      await connection.query(
        "INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (30,'LIBRARY','BASE_FOLDER',$1)",
        [libraryDirectory],
      );
      await connection.query(
        "INSERT INTO pg_temp.mst_group_affiation (group_id,user_id) VALUES (123,'designer-fixture')",
      );
      const definition =
        '<conmas><top><defTopId>1</defTopId><publicStatus>1</publicStatus><thumbnail/><backgroundImage/><locked>0</locked><readOnly>0</readOnly><labels/><sheets/></top></conmas>';
      await connection.query(
        `INSERT INTO pg_temp.def_top (def_top_id,def_top_org,def_top_name,xml_data,public_status,thumbnail_file,background_image_file,designer_version,designer_display_version)
        VALUES (1,1,'HTTP fixture',$1,1,$2,$3,'7.2.3','7.2.30000')`,
        [definition, Buffer.from('thumbnail'), Buffer.from('background')],
      );
      await connection.query(`INSERT INTO pg_temp.def_role VALUES (1,123,1,1,1);
        INSERT INTO pg_temp.mst_group (group_id,deleted) VALUES (123,0);
        INSERT INTO pg_temp.def_current VALUES (1,1);
        UPDATE pg_temp.def_top SET report_type=2,deleted=0,mobile_save=0`);
      server = createApp(db).listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server!.once('listening', resolve));
      const address = server.address();
      assert(address && typeof address !== 'string');
      const origin = `http://127.0.0.1:${address.port}`,
        endpoint = `${origin}/ConMasWeb/Rests/ConMasIReporter.aspx`;
      const request = async (
        command: string,
        fields: Record<string, string> = {},
        cookie = '',
        headers: Record<string, string> = {},
      ) => {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { ...(cookie ? { cookie } : {}), ...headers },
          body: new URLSearchParams({ command, ...fields }),
          redirect: 'manual',
        });
        const text = await response.text();
        assert.match(response.headers.get('content-type') ?? '', /^text\/xml; charset=utf-8$/);
        return {
          response,
          xml: parser.parse(text).conmas,
          text,
          cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '',
        };
      };
      const fields = {
        user: 'designer-fixture',
        password: 'fixture-password',
        client: 'Designer',
        terminalId: 'designer-physical-fixture',
        version: '999.9.9999',
        authenticationType: '0',
        appName: 'ConMasDesigner',
      };
      assert.equal((await request('GetAuthenticationType')).xml.authenticationType, '0');
      assert.equal((await request('DoesNotExist')).xml.error.code, '1');
      assert.equal((await request('GetUserInfo')).xml.error.code, '5');
      assert.equal((await request('GetUser')).xml.error.code, '5');
      assert.equal((await request('GetCalendarList')).xml.error.code, '5');
      assert.equal((await request('GetDesignerInstallerUrl')).xml.error.code, '5');
      for (const command of [
        'GetMessageImage',
        'GetMasterImage',
        'IdentifyApprover',
        'GetCustomMenuSettings',
        'GetCustomMultiMenuSettings',
        'GetLocalReferenceList',
        'GetLocalReference',
        'UnlockDocument',
        'ApprovalTerminal',
        'RemoveTerminal',
      ])
        assert.equal((await request(command)).xml.error.code, '5');
      assert.equal((await request('GetDefinitionData', { topId: '1' })).xml.error.code, '5');
      assert.equal((await request('Login', { ...fields, terminalId: '' })).xml.error.code, '2');
      assert.equal((await request('Login', { ...fields, version: '1.0.0' })).xml.loginResult.code, '2');
      assert.equal((await request('Login', { ...fields, password: 'wrong' })).xml.loginResult.code, '1');
      assert.equal((await request('Login', { ...fields, password: 'wrong' })).xml.loginResult.code, '1');
      assert.equal((await request('Login', fields)).xml.loginResult.code, '5');
      await connection.query('DELETE FROM pg_temp.user_lock');
      const pending = await request('Login', fields);
      assert.equal(pending.xml.loginResult.code, '3');
      assert(pending.cookie);
      assert.match(pending.response.headers.get('set-cookie') ?? '', /Path=\/ConMasWeb/);
      assert.doesNotMatch(pending.response.headers.get('set-cookie') ?? '', /Expires=|Max-Age=/);
      assert.equal((await request('GetLicense', {}, pending.cookie)).xml.error.code, '3');
      for (const command of [
        'GetDefinitionList',
        'GetDefinitionData',
        'GetDefinitionDetail',
        'UnlockDefinition',
        'GetDefinitionExcel',
        'GetBackgroundImage',
        'GetSheetBackgroundImage',
        'RegistDefinition',
        'GetVoiceGrammar',
        'GetVoiceCommonGrammar',
        'GetCalendarList',
        'GetUser',
        'GetMessageImage',
        'GetMasterImage',
        'IdentifyApprover',
        'GetCustomMenuSettings',
        'GetCustomMultiMenuSettings',
        'GetLocalReferenceList',
        'GetLocalReference',
        'UnlockDocument',
      ]) {
        assert.equal((await request(command, { topId: '1' }, pending.cookie)).xml.error.code, '3');
      }
      const forged = await request('RegistTerminal', {}, pending.cookie, { origin: 'https://other.example' });
      assert.equal(forged.response.status, 403);
      const generalLibrary = `${origin}/ConMasWeb/Rests/generalprocess.ASPX?target=Library`;
      for (const process of ['DocumentList', 'DocumentDownload']) {
        const missingSession = await fetch(`${generalLibrary}&process=${process}`);
        assert.equal(missingSession.status, 200);
        assert.equal(parser.parse(await missingSession.text()).conmas.error.code, '5');
        const wrongMethod = await fetch(`${generalLibrary}&process=${process}`, {
          method: 'PUT',
          headers: { cookie: pending.cookie },
        });
        assert.equal(parser.parse(await wrongMethod.text()).conmas.error.code, '4');
      }
      const noReader = await fetch(`${generalLibrary}&process=DocumentList`, { headers: { cookie: pending.cookie } });
      assert.equal(parser.parse(await noReader.text()).conmas.error.code, '3');
      await connection.query('UPDATE pg_temp.mst_group SET role_library_read=1 WHERE group_id=123');
      const unapprovedList = await fetch(`${generalLibrary}&process=DocumentList`, {
        headers: { cookie: pending.cookie },
      });
      assert.equal(parser.parse(await unapprovedList.text()).conmas.documents, '');
      const deletionGet = await fetch(`${generalLibrary}&process=DocumentDeletion`, {
        headers: { cookie: pending.cookie },
      });
      assert.equal(parser.parse(await deletionGet.text()).conmas.error.code, '4');
      const missingReport = await fetch(
        `${origin}/ConMasWeb/Rests/GeneralProcess.aspx?target=InputReport&process=TopDetailInquiry&repTopId=99&items=repTopName`,
        { headers: { cookie: pending.cookie } },
      );
      assert.equal(parser.parse(await missingReport.text()).conmas.error.code, '8');
      assert.equal((await connection.query('SELECT count(*)::int AS n FROM pg_temp.mst_terminal')).rows[0].n, 0);
      assert.equal(
        (await request('RegistTerminal', { comment: 'Sent by Designer' }, pending.cookie)).xml.error.code,
        '0',
      );
      assert.equal((await request('RegistTerminal', { comment: 'Retry' }, pending.cookie)).xml.error.code, '0');
      assert.equal((await connection.query('SELECT count(*)::int AS n FROM pg_temp.mst_terminal')).rows[0].n, 1);
      assert.equal((await request('GetUserInfo', {}, pending.cookie)).xml.userInfo.terminalState, '4');
      assert.equal(
        (await request('ApprovalTerminal', { terminalId: 'not-the-session-device' }, pending.cookie)).xml.error.code,
        '0',
      );
      assert.equal((await request('GetUserInfo', {}, pending.cookie)).xml.userInfo.terminalState, '0');
      assert.equal(
        (await request('GetDesignerInstallerUrl', { appLanguage: 'EN' }, pending.cookie)).xml.url,
        `${origin}/ConMasWeb/ConMasDesigner.en.bin`,
      );
      const general = `${origin}/ConMasWeb/Rests/generalprocess.ASPX?target=System&process=LicenseStatusInquiry&item=ConMasIoTGateway`;
      assert.equal(parser.parse(await (await fetch(general)).text()).conmas.error.code, '5');
      assert.equal(
        parser.parse(await (await fetch(general, { headers: { cookie: pending.cookie } })).text()).conmas.error.code,
        '3',
      );
      await connection.query('UPDATE pg_temp.mst_group SET role_mst_read=1');
      assert.equal(
        parser.parse(await (await fetch(general, { headers: { cookie: pending.cookie } })).text()).conmas.license
          .conMasIoTGateway,
        String(clientIoTLicenseStatus()),
      );
      assert.equal(
        parser.parse(await (await fetch(general, { method: 'DELETE', headers: { cookie: pending.cookie } })).text())
          .conmas.error.code,
        '4',
      );
      await connection.query('UPDATE pg_temp.mst_group SET role_mst_read=0,role_mst_system_read=1,deleted=1');
      const inquiry = await fetch(general.split('?')[0], {
        method: 'POST',
        headers: { cookie: pending.cookie },
        body: new URLSearchParams({ target: 'System', process: 'LicenseStatusInquiry', item: 'ConMasIoTGateway' }),
      });
      assert.equal(inquiry.status, 200);
      assert.equal(
        parser.parse(await inquiry.text()).conmas.license.conMasIoTGateway,
        String(clientIoTLicenseStatus()),
      );
      await connection.query('UPDATE pg_temp.mst_group SET role_mst_system_read=0,deleted=0');
      assert.equal((await request('GetUserInfo', {}, pending.cookie)).xml.userInfo.group, '123');
      await connection.query(
        "UPDATE pg_temp.mst_terminal SET approver='fixture-approver',term_name='Fixture terminal'",
      );
      const login = await request('Login', { ...fields, version: '99.0.0' });
      assert.equal(login.xml.loginResult.code, '0');
      assert(login.cookie);
      assert.equal(login.xml.loginResult.serverVersion, clientConfiguration().serverVersion);
      assert.equal(login.xml.loginResult.menuVersion, 'fixture-version');
      assert.deepEqual(login.xml.iPadSetting.customMaster, {
        isAutoUpdating: '0',
        lastUpdateLabel: 'fixture-label-version',
        lastUpdateMaster: 'fixture-master-version',
      });
      await connection.query(
        "UPDATE pg_temp.mst_common SET com_value='1' WHERE com_key='IPAD_SETTING' AND com_name='AUTO_CUSTOM_MASTER_UPDATING'",
      );
      assert.equal((await request('Login', fields)).xml.iPadSetting.customMaster.isAutoUpdating, '1');
      await connection.query(
        "UPDATE pg_temp.mst_common SET com_value='0' WHERE com_key='IPAD_SETTING' AND com_name='AUTO_CUSTOM_MASTER_UPDATING'",
      );
      assert.equal((await request('GetUserInfo', {}, login.cookie)).xml.userInfo.userName, 'Designer <fixture>');
      for (const [appLanguage, suffix] of [
        ['', ''],
        ['EN', '.en'],
        ['CN', '.cn'],
        ['en', ''],
      ])
        assert.equal(
          (await request('GetDesignerInstallerUrl', { appLanguage }, login.cookie)).xml.url,
          `${origin}/ConMasWeb/ConMasDesigner${suffix}.bin`,
        );
      const userList = await request('GetUser', { type: 'xml', withImprint: 'false' }, login.cookie);
      assert.equal(userList.response.status, 200);
      assert.equal(userList.xml.user.userId, 'designer-fixture');
      assert(!Object.hasOwn(userList.xml.user, 'approvalSign'));
      assert(!Object.hasOwn(userList.xml.user, 'password'));
      const userCsv = await fetch(`${origin}/ConMasWeb/Rests/getuser.ASPX?type=csv&encoding=65001`, {
        headers: { cookie: login.cookie },
      });
      assert.equal(userCsv.status, 200);
      assert.equal(userCsv.headers.get('content-type'), 'text/plain; charset=utf-8');
      assert((await userCsv.text()).startsWith('"designer-fixture","Designer <fixture>"'));
      const registeredId = (await connection.query('SELECT term_id FROM pg_temp.mst_terminal')).rows[0].term_id;
      await connection.query('INSERT INTO pg_temp.custom_master_synching_terminal (term_id) VALUES ($1)', [
        registeredId,
      ]);
      const calendar = await request(
        'GetCalendarList',
        { year: '2026', month: '11', publicStatus: '-1' },
        login.cookie,
      );
      assert.equal(calendar.response.status, 200);
      assert.equal(calendar.xml.tasks, '');
      assert.equal(calendar.xml.holidays, '');
      assert.equal((await connection.query('SELECT * FROM pg_temp.custom_master_synching_terminal')).rowCount, 0);
      assert.equal(
        (await request('GetCalendarList', { year: '2026', month: 'bad', publicStatus: '-1' }, login.cookie)).xml.error
          .code,
        '2',
      );
      assert.equal(
        (await request('GetCalendarList', { year: '2026', month: '13', publicStatus: '-1' }, login.cookie)).xml.error
          .code,
        '-1',
      );
      const calendarDirect = await fetch(
        `${origin}/ConMasWeb/Rests/getcalendarlist.ASPX?year=2026&month=11&publicStatus=-1`,
        { headers: { cookie: login.cookie } },
      );
      assert.equal(calendarDirect.status, 200);
      assert.equal(parser.parse(await calendarDirect.text()).conmas.tasks, '');
      await connection.query("UPDATE pg_temp.mst_user SET identification_code='1234'");
      assert.equal(
        (await request('IdentifyApprover', { identificationCode: '1234' }, login.cookie)).xml.error.code,
        '0',
      );
      assert.equal(
        (await request('IdentifyApprover', { identificationCode: 'wrong' }, login.cookie)).xml.error.code,
        '2',
      );
      assert.equal((await request('GetMessageImage', { messageId: '1' }, login.cookie)).xml.error.code, '8');
      assert.equal(
        (await request('GetMasterImage', { recordId: '1', fieldNo: 'bad' }, login.cookie)).xml.error.code,
        '2',
      );
      await connection.query(
        "INSERT INTO pg_temp.mst_message (message_id,image_file,image_file_name) VALUES (1,'message-image','notice.png'); INSERT INTO pg_temp.mst_custom_default_record (record_id,master_id,field1001) VALUES (1,1,'master-image')",
      );
      for (const [command, params, expected, filename] of [
        ['GetMessageImage', { messageId: '1' }, 'message-image', 'notice.png'],
        ['GetMasterImage', { recordId: '1', fieldNo: '1001' }, 'master-image', 'image_1_1001'],
      ] as const) {
        for (const url of [endpoint, `${origin}/ConMasWeb/Rests/${command.toLowerCase()}.ASPX`]) {
          const binary = await fetch(url, {
            method: 'POST',
            headers: { cookie: login.cookie },
            body: new URLSearchParams({ command, ...params }),
          });
          assert.equal(binary.status, 200);
          assert.equal(binary.headers.get('content-type'), 'image');
          assert.equal(binary.headers.get('content-disposition'), `attachment; filename=${filename}`);
          assert.equal(await binary.text(), expected);
        }
      }
      const missingMaster = await fetch(`${origin}/ConMasWeb/Rests/GetMasterImage.aspx?recordId=99&fieldNo=1001`, {
        headers: { cookie: login.cookie },
      });
      assert.equal(missingMaster.status, 200);
      assert.equal(missingMaster.headers.get('content-disposition'), 'attachment; filename=empty');
      assert.equal((await missingMaster.arrayBuffer()).byteLength, 0);
      for (const command of ['GetCustomMenuSettings', 'GetCustomMultiMenuSettings']) {
        const menu = await fetch(`${origin}/ConMasWeb/Rests/${command}.aspx`, { headers: { cookie: login.cookie } });
        assert.equal(menu.status, 200);
        assert.equal(menu.headers.get('content-type'), 'application/octet-stream');
        assert.equal(menu.headers.get('content-disposition'), 'attachment; filename=customMenu.zip');
        const zip = Buffer.from(await menu.arrayBuffer());
        assert.equal(zip.readUInt32LE(0), 0x04034b50);
        assert(zip.includes(Buffer.from('fixture-version')));
      }
      await connection.query(
        "INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (90,'LIBRARY','FILE_LOCATION','1'); INSERT INTO pg_temp.mst_common_document (document_id,document_name,document_name_org,document_save_kbn,document_type,document_file,content_type) VALUES (1,'HTTP library','library.pdf',0,'PDF','library-data','application/pdf')",
      );
      assert.equal(
        (await request('GetLocalReferenceList', {}, login.cookie)).xml.localFiles.localFile.displayName,
        'HTTP library',
      );
      for (const url of [endpoint, `${origin}/ConMasWeb/Rests/getlocalreference.ASPX`]) {
        const document = await fetch(url, {
          method: 'POST',
          headers: { cookie: login.cookie },
          body: new URLSearchParams({ command: 'GetLocalReference', localFileId: '1' }),
        });
        assert.equal(document.status, 200);
        assert.equal(document.headers.get('content-type'), 'application/pdf');
        assert.equal(document.headers.get('content-disposition'), 'attachment; filename=library.pdf');
        assert.equal(await document.text(), 'library-data');
      }
      const absentDocument = await fetch(`${origin}/ConMasWeb/Rests/GetLocalReference.aspx?localFileId=99`, {
        headers: { cookie: login.cookie },
      });
      assert.equal(absentDocument.status, 200);
      assert.equal(absentDocument.headers.get('content-type'), 'application');
      assert.equal(absentDocument.headers.get('content-disposition'), 'attachment; filename=empty');
      assert.equal((await absentDocument.arrayBuffer()).byteLength, 0);
      assert.equal((await connection.query('SELECT * FROM pg_temp.log_library_download')).rowCount, 2);
      const apiList = await fetch(`${generalLibrary}&process=DocumentList`, { headers: { cookie: login.cookie } });
      assert.equal(apiList.status, 200);
      assert.equal(parser.parse(await apiList.text()).conmas.documents.document.documentId, '1');
      await connection.query(
        "UPDATE pg_temp.mst_common_document SET document_name_org='日本 !.pdf' WHERE document_id=1",
      );
      const apiDownload = await fetch(`${generalLibrary}&process=DocumentDownload`, {
        method: 'POST',
        headers: { cookie: login.cookie },
        body: new URLSearchParams({ documentType: '0', documentId: '1' }),
      });
      assert.equal(apiDownload.status, 200);
      assert.equal(apiDownload.headers.get('content-disposition'), 'attachment; filename=%E6%97%A5%E6%9C%AC%20%21.pdf');
      assert.equal(apiDownload.headers.get('content-type'), 'application/pdf');
      assert.equal(await apiDownload.text(), 'library-data');
      assert.equal((await connection.query('SELECT * FROM pg_temp.log_library_download')).rowCount, 2);
      await connection.query(
        "INSERT INTO pg_temp.document_lock (document_id,user_id,sys_regist_term) VALUES (1,'other','99')",
      );
      const unlocked = await request('UnlockDocument', { documentId: '1,99' }, login.cookie);
      assert.equal(unlocked.xml.error.code, '0');
      assert.equal(unlocked.xml.results.result.documentId, '1');
      assert.equal((await connection.query('SELECT * FROM pg_temp.document_lock')).rowCount, 0);
      await connection.query(
        'INSERT INTO pg_temp.rep_top (rep_top_id,def_top_id) VALUES (3,1); INSERT INTO pg_temp.rep_role (rep_top_id,group_id,role_rep_read) VALUES (3,123,1)',
      );
      const topDetail = await fetch(
        `${origin}/ConMasWeb/Rests/GeneralProcess.aspx?target=InputReport&process=TopDetailInquiry`,
        {
          method: 'POST',
          headers: { cookie: login.cookie },
          body: new URLSearchParams({ repTopId: '3', items: 'repTopId,defTopId' }),
        },
      );
      assert.equal(topDetail.status, 200);
      assert.equal(parser.parse(await topDetail.text()).conmas.top.repTopId, '3');
      for (const url of [endpoint, `${origin}/ConMasWeb/Rests/pickoutreporttopdata.ASPX`]) {
        const response = await fetch(url, {
          method: 'POST',
          headers: { cookie: pending.cookie },
          body: new URLSearchParams({ command: 'PickOutReportTopData', repTopId: '3', items: 'repTopId,defTopId' }),
        });
        assert.equal(response.status, 200);
        assert.equal(parser.parse(await response.text()).conmas.top.repTopId, '3');
      }
      const pickoutMethod = await fetch(`${origin}/ConMasWeb/Rests/PickOutReportTopData.aspx`, {
        method: 'DELETE',
        headers: { cookie: pending.cookie },
      });
      assert.equal(parser.parse(await pickoutMethod.text()).conmas.error.code, '4');
      assert.equal((await request('PickOutReportTopData', { repTopId: '3', items: 'repTopName' })).xml.error.code, '5');
      await connection.query('UPDATE pg_temp.mst_terminal SET approver=NULL');
      const downloadListUrl = `${origin}/ConMasWeb/Rests/downloadreportlist.ASPX`;
      assert.equal(parser.parse(await (await fetch(downloadListUrl)).text()).conmas.error.code, '5');
      const listMethod = await fetch(downloadListUrl, { method: 'DELETE', headers: { cookie: pending.cookie } });
      assert.equal(parser.parse(await listMethod.text()).conmas.error.code, '4');
      assert.match(
        await (await fetch(downloadListUrl, { headers: { cookie: pending.cookie } })).text(),
        /Auto-Download has been disabled/,
      );
      await connection.query(`INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (91,'SCHEDULE_SETTING','AUTO_DOWNLOAD','1'),(92,'SCHEDULE_SETTING','AUTO_DOWNLOAD_RANGE_TYPE','All');
        UPDATE pg_temp.rep_top SET public_status=2,edit_refer_status=0,deleted=0,xml_data='<conmas><top/></conmas>' WHERE rep_top_id=3;
        INSERT INTO pg_temp.rep_schedule (schedule_id,rep_top_id,auto_download) VALUES (1,3,1);
        INSERT INTO pg_temp.rep_schedule_user (schedule_id,user_id) VALUES (1,'designer-fixture')`);
      for (const url of [endpoint, downloadListUrl]) {
        const response = await fetch(url, {
          method: 'POST',
          headers: { cookie: pending.cookie },
          body: new URLSearchParams({ command: 'DownloadReportList' }),
        });
        assert.equal(response.status, 200);
        assert.equal(parser.parse(await response.text()).conmas.reports.report.repTopId, '3');
      }
      assert.equal(
        parser.parse(
          await (
            await fetch(`${origin}/ConMasWeb/Rests/GeneralProcess.aspx?target=Schedule&process=ReportListForDownload`, {
              headers: { cookie: pending.cookie },
            })
          ).text(),
        ).conmas.reports.report.repTopId,
        '3',
      );
      assert.equal(
        (await request('PickOutReportTopData', { repTopId: '3', items: 'repTopId,defTopId' }, pending.cookie)).xml.top
          .repTopId,
        '3',
      );
      assert.equal((await request('UnlockReport', { topId: '1' }, pending.cookie)).xml.error.code, '3');
      await connection.query("UPDATE pg_temp.mst_terminal SET approver='fixture-approver'");
      assert.equal((await request('UnlockReport', { topId: '1' })).xml.error.code, '5');
      assert.equal((await request('UnlockReport', { topId: 'bad' }, login.cookie)).xml.error.code, '-1');
      await connection.query(
        "INSERT INTO pg_temp.rep_lock (rep_top_id,user_id,sys_regist_term) VALUES (1,'designer-fixture','99'),(2,'other',$1),(3,'other','100'),(4,'designer-fixture',$1)",
        [String(registeredId)],
      );
      for (const [url, topId] of [
        [endpoint, '1'],
        [`${origin}/ConMasWeb/Rests/unlockreport.ASPX`, '2'],
      ]) {
        const response = await fetch(url!, {
          method: 'POST',
          headers: { cookie: login.cookie },
          body: new URLSearchParams({ command: 'UnlockReport', topId: topId! }),
        });
        assert.equal(response.status, 200);
        assert.equal(parser.parse(await response.text()).conmas.error.code, '0');
      }
      assert.equal((await connection.query('SELECT * FROM pg_temp.rep_lock')).rowCount, 2);
      await connection.query('DELETE FROM pg_temp.rep_lock');
      await connection.query('DELETE FROM pg_temp.rep_schedule_user; DELETE FROM pg_temp.rep_schedule');
      const invalidDetail = await fetch(
        `${origin}/ConMasWeb/Rests/GeneralProcess.aspx?target=InputReport&process=TopDetailInquiry&repTopId=3&items=repTopId`,
        { headers: { cookie: login.cookie } },
      );
      assert.equal(parser.parse(await invalidDetail.text()).conmas.error.code, '-1');
      await connection.query(
        'DELETE FROM pg_temp.rep_top WHERE rep_top_id=3; DELETE FROM pg_temp.rep_role WHERE rep_top_id=3',
      );
      await connection.query('UPDATE pg_temp.mst_group SET role_library_delete=1 WHERE group_id=123');
      const deletedDocument = await fetch(`${generalLibrary}&process=DocumentDeletion`, {
        method: 'POST',
        headers: { cookie: login.cookie },
        body: new URLSearchParams({ documentType: '0', documentId: '1' }),
      });
      assert.equal(deletedDocument.status, 200);
      assert.equal(parser.parse(await deletedDocument.text()).conmas.error.code, '0');
      assert.equal((await connection.query('SELECT * FROM pg_temp.mst_common_document')).rowCount, 0);
      assert.equal((await request('GetVoiceGrammar', { defTopId: '1' })).xml.error.code, '5');
      const noVoice = await request('GetVoiceGrammar', { defTopId: '1' }, login.cookie);
      assert.equal(noVoice.response.status, 200);
      assert.equal(noVoice.xml.error.code, '8');
      assert.equal((await request('GetVoiceGrammar', { defTopId: 'bad' }, login.cookie)).xml.error.code, '2');
      assert.equal(
        (await request('GetVoiceGrammar', { defTopId: '1' }, login.cookie, { origin: 'https://other.example' }))
          .response.status,
        403,
      );
      const common = await request('GetVoiceCommonGrammar', {}, login.cookie);
      assert.equal(common.response.status, 200);
      assert.equal(common.xml.grammar.common, '');
      await connection.query('INSERT INTO pg_temp.def_grammar (def_top_id,xml_data) VALUES (1,$1)', [
        '<grammar><moveClusterWords><cluster><sheetNo>0</sheetNo><clusterId>1</clusterId><answerBack>Ready &amp; waiting</answerBack></cluster></moveClusterWords></grammar>',
      ]);
      const voice = await request('GetVoiceGrammar', { defTopId: '1' }, login.cookie);
      assert.equal(voice.response.status, 200);
      assert.equal(voice.xml.grammar.moveClusterWords.cluster.answerBack, 'Ready & waiting');
      const voiceDirect = await fetch(`${origin}/ConMasWeb/Rests/getvoicegrammar.ASPX?defTopId=1`, {
        headers: { cookie: login.cookie },
      });
      assert.equal(voiceDirect.status, 200);
      assert.equal(parser.parse(await voiceDirect.text()).conmas.grammar.moveClusterWords.cluster.sheetNo, '0');
      const license = await request('GetLicense', {}, login.cookie);
      assert.equal(license.xml.license, parser.parse(readLicenseXml()).ConMas.license);
      assert.doesNotThrow(() => legacyDecrypt(license.xml.license, process.env.CONMAS_LICENSE_KEY!));
      const list = await request(
        'GetDefinitionList',
        { labelId: '-9', itemTargetLabel: 'false', sortId: '2', sortType: 'desc' },
        login.cookie,
      );
      assert.equal(list.xml.items.item.itemId, '1');
      assert.equal(list.xml.items.item.name, 'HTTP fixture');
      for (const topId of ['', '1.5', '2147483648', '1 OR 1=1']) {
        assert.equal((await request('GetDefinitionData', { topId }, login.cookie)).xml.error.code, '2');
      }
      assert.equal(
        (await request('GetDefinitionData', { topId: '1', designerVersion: '7.2.2' }, login.cookie)).xml.error.code,
        '19001',
      );
      assert.equal(
        (await request('GetDefinitionDetail', { topId: '1', urlSchemeMode: '1' }, login.cookie)).response.status,
        501,
      );
      assert.equal(
        (await request('GetDefinitionList', { updateTimeFrom: '2026/11/07' }, login.cookie)).response.status,
        200,
      );
      const detail = await request('GetDefinitionDetail', { topId: '1' }, login.cookie);
      assert.equal(detail.xml.detailInfo.topName, 'HTTP fixture');
      assert.equal(detail.xml.detailInfo.readOnly, '0');
      const received = await request('GetDefinitionData', { topId: '1' }, login.cookie);
      assert.equal(received.xml.top.thumbnail, Buffer.from('thumbnail').toString('base64'));
      assert.equal(received.xml.top.backgroundImage, Buffer.from('background').toString('base64'));
      assert.equal(received.xml.top.readOnly, '0');
      assert.equal(received.xml.top.locked, '0');
      const terminalId = String((await connection.query('SELECT term_id FROM pg_temp.mst_terminal')).rows[0].term_id);
      assert.equal(
        (await connection.query('SELECT sys_regist_term FROM pg_temp.def_lock')).rows[0].sys_regist_term,
        terminalId,
      );
      assert.equal((await request('UnlockDefinition', { topId: '1' }, login.cookie)).xml.error.code, '0');
      assert.equal((await connection.query('SELECT count(*)::int AS n FROM pg_temp.def_lock')).rows[0].n, 0);
      await connection.query('UPDATE pg_temp.def_role SET role_def_read=0,role_def_update=0');
      await connection.query('UPDATE pg_temp.def_role SET role_rep_create=0');
      assert.equal(
        (await request('GetDefinitionList', { labelId: '-9', itemTargetLabel: 'false' }, login.cookie)).xml.items,
        '',
      );
      assert.equal((await request('GetDefinitionDetail', { topId: '1' }, login.cookie)).xml.error.code, '3');
      assert.equal((await request('GetDefinitionData', { topId: '1' }, login.cookie)).xml.top.readOnly, '1');
      assert.equal((await request('RegistDefinition', {}, login.cookie)).xml.error.code, '-1');
      assert.equal((await connection.query('SELECT xml_data FROM pg_temp.def_top')).rows[0].xml_data, definition);
      await connection.query("UPDATE pg_temp.def_top SET def_file=$1,def_file_type='xlsx'", [
        Buffer.from('excel bytes'),
      ]);
      await connection.query('INSERT INTO pg_temp.def_sheet VALUES (1,10,0,$1)', [Buffer.from('sheet bytes')]);
      for (const [command, contentType, filename, expected] of [
        ['GetDefinitionExcel', 'application/vnd.ms-excel', 'excel.xlsx', 'excel bytes'],
        ['GetBackgroundImage', 'application/pdf', 'background.pdf', 'background'],
        ['GetSheetBackgroundImage', 'image/png', 'background.png', 'sheet bytes'],
      ]) {
        const response = await fetch(`${origin}/ConMasWeb/Rests/${command}.aspx?topId=1&sheetNo=0`, {
          headers: { cookie: login.cookie },
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), contentType);
        assert.equal(response.headers.get('content-disposition'), `attachment; filename=${filename}`);
        assert.equal(await response.text(), expected);
        // No extra role/Designer-mode gate exists in these legacy binary endpoints, even after role removal above.
        assert.equal((await request(command, { topId: 'invalid' }, login.cookie)).xml.error.code, '-1');
      }
      assert.equal(
        (await request('GetDefinitionExcel', { topId: '1', repTopId: '2', copyReportMode: '1' }, login.cookie)).response
          .status,
        501,
      );
      const manager = await fetch(`${origin}/ConMasManager/System/Index`, {
        headers: { cookie: login.cookie },
        redirect: 'manual',
      });
      assert.equal(manager.headers.get('location'), '/ConMasManager/Account/LogOn');
      const direct = await fetch(`${origin}/ConMasWeb/Rests/getuserinfo.ASPX`, { headers: { cookie: login.cookie } });
      assert.equal(parser.parse(await direct.text()).conmas.userInfo.group, '123');
      const removed = await fetch(`${origin}/ConMasWeb/Rests/removeterminal.ASPX`, {
        method: 'POST',
        headers: { cookie: login.cookie },
        body: new URLSearchParams({ terminalId: 'not-the-session-device' }),
      });
      assert.equal(removed.status, 200);
      assert.equal(parser.parse(await removed.text()).conmas.error.code, '0');
      assert.equal((await request('GetLicense', {}, login.cookie)).xml.error.code, '3');
      assert.equal((await request('RemoveTerminal', {}, login.cookie)).xml.error.code, '8');
      assert.equal((await request('Logout', {}, login.cookie)).xml.error.code, '0');
      assert.equal((await request('GetUserInfo', {}, login.cookie)).xml.error.code, '5');
      await request('Logout', {}, pending.cookie);
      assert.equal(
        (
          await connection.query(
            "SELECT count(*)::int AS n FROM pg_temp.conmas_operation_log WHERE app_type='Designer' AND operation_content='LoginSuccess'",
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (
          await connection.query(
            "SELECT count(*)::int AS n FROM pg_temp.conmas_operation_log WHERE operation_content='Logout'",
          )
        ).rows[0].n,
        2,
      );
    } finally {
      if (server)
        await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
      connection.release();
      await pool.end();
      await rm(libraryDirectory, { recursive: true, force: true });
    }
  },
);
