import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { setTimeout } from 'node:timers/promises';
import pg from 'pg';
import { XMLParser } from 'fast-xml-parser';
import { createApp } from '../../../src/app.js';
import { clientElement } from '../../../src/services/client-xml.js';
import { legacyPassword } from '../../../src/shared/legacy-auth.js';
import { readLicenseFields } from '../../../src/shared/license-counts.js';
import { maxSystemUploadBytes } from '../../../src/middleware/manager/system/upload-body.js';
import {
  DefinitionUploadUnsupported,
  definitionQuotaExceeded,
  getDefinitionData,
  getDefinitionList,
  registerDefinition,
} from '../../../src/models/client-definitions.js';
import { nextDefinitionReset } from '../../../src/models/client-definition-numbering.js';
import { must, root } from '../../../src/models/client-definition-xml.js';
import { DefinitionTableError, saveDefinitionTables } from '../../../src/models/client-definition-tables.js';

const actor = { userId: 'upload-fixture', terminalId: '70' };
const parser = new XMLParser({ parseTagValue: false, ignoreAttributes: false, trimValues: false });
const code = (xml: string) => parser.parse(xml).conmas.error.code;
const remarks = Array.from(
  { length: 10 },
  (_, i) =>
    clientElement('remarksName' + (i + 1), 'Remark ' + (i + 1)) +
    clientElement('remarksValue' + (i + 1), 'Value ' + (i + 1)),
).join('');
const cluster = `<cluster extra="keep"><sheetNo>0</sheetNo><clusterId>1</clusterId><name>Cluster</name><type>Text</type><inputParameters>parameter &amp; value</inputParameters><left>0</left><right>1</right><top>0</top><bottom>1</bottom>${remarks}<management><authority><groupId roleType="0">5</groupId><groupId roleType="1">5</groupId><groupId roleType="0">5</groupId><groupId>999</groupId></authority><mail><apply>mail</apply></mail></management></cluster>`;
const sheet = `<sheet><defSheetId/><sheetNo>0</sheetNo><defSheetName>Sheet</defSheetName><autoSelectGen>1</autoSelectGen><thumbnail>${Buffer.from('sheet thumbnail').toString('base64')}</thumbnail><backgroundImage>${Buffer.from('sheet png').toString('base64')}</backgroundImage>${remarks}<references/><clusters>${cluster}</clusters></sheet>`;
const definition = `<conmas preserved="yes"><top><defTopId/><defTopName>Published fixture</defTopName><reportType>2</reportType><sheetCount>1</sheetCount><autoGen>0</autoGen><publicStatus>2</publicStatus><mobileSave>0</mobileSave><autoSelectGen>0</autoSelectGen><remarksEditable>1</remarksEditable><registTime/><registUser/><updateTime/><updateUser/><thumbnail>${Buffer.from('top thumbnail').toString('base64')}</thumbnail><backgroundImage>${Buffer.from('top pdf').toString('base64')}</backgroundImage><definitionFile><type>xlsx</type><name>file.xlsx</name><value>${Buffer.from('Excel bytes').toString('base64')}</value></definitionFile><locked>0</locked><readOnly>0</readOnly><labels/><useAutoNumbering>0</useAutoNumbering><autoNumbering/><unknown> keep &amp; retain </unknown>${remarks}<designerVersion>8.2.25101</designerVersion><designerDisplayVersion>8.2.25101</designerDisplayVersion><sheets>${sheet}</sheets></top></conmas>`;
const numbering =
  '<autoNumbering><startValue>2</startValue><increment>2</increment><digit>3</digit><zeroPadding>1</zeroPadding><numberingTiming>0</numberingTiming><part><partId>1</partId><type>autoNumber</type><value/></part></autoNumbering>';

async function fixture(run: (db: pg.Pool, client: pg.PoolClient) => Promise<void>): Promise<void> {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const db = {
    query: client.query.bind(client),
    connect: async () => ({ query: client.query.bind(client), release() {} }),
  } as unknown as pg.Pool;
  try {
    const tables = [
      'def_top',
      'def_current',
      'def_lock',
      'def_sheet',
      'def_cluster',
      'def_reference',
      'def_cluster_role',
      'def_cluster_refer',
      'def_role',
      'def_label',
      'def_rep_label',
      'def_report_document',
      'def_report_custom_table',
      'def_external_output',
      'def_external_output_folder',
      'def_top_option',
      'mst_group',
      'mst_group_affiation',
      'mst_common',
      'mst_user',
      'mst_terminal',
      'user_lock',
      'common_data_version',
      'conmas_operation_log',
      'binder_def',
      'binder_def_src',
      'binder_def_dest',
      'binder_def_mapping_cluster',
      'binder_def_mapping_table',
      'def_label_role',
      'mst_label_def',
      'mst_custom_table',
      'custom_table_delete',
      'def_grammar',
      'def_auto_numbering_reset_setting',
      'log_auto_numbering',
      'mst_report_table',
      'rep_top',
      'rep_current',
    ];
    await client.query(
      tables.map((name) => `CREATE TEMP TABLE ${name} (LIKE public.${name} INCLUDING ALL);`).join('\n'),
    );
    await client.query(`ALTER TABLE pg_temp.def_top ADD COLUMN IF NOT EXISTS cooperation_table numeric;
      ALTER TABLE pg_temp.def_external_output_folder ADD COLUMN IF NOT EXISTS optional_setting text;
      ALTER TABLE pg_temp.def_sheet ADD FOREIGN KEY (def_top_id) REFERENCES pg_temp.def_top ON DELETE CASCADE;
      ALTER TABLE pg_temp.def_cluster ADD FOREIGN KEY (def_sheet_id) REFERENCES pg_temp.def_sheet ON DELETE CASCADE;
      ALTER TABLE pg_temp.def_reference ADD FOREIGN KEY (def_sheet_id) REFERENCES pg_temp.def_sheet ON DELETE CASCADE;
      ALTER TABLE pg_temp.def_cluster_role ADD FOREIGN KEY (def_sheet_id,cluster_id) REFERENCES pg_temp.def_cluster ON DELETE CASCADE;
      ALTER TABLE pg_temp.def_cluster_refer ADD FOREIGN KEY (def_sheet_id,cluster_id) REFERENCES pg_temp.def_cluster ON DELETE CASCADE;
      CREATE TEMP SEQUENCE def_top_def_top_id_seq START 100;
      CREATE TEMP SEQUENCE def_sheet_def_sheet_id_seq START 200;
      CREATE TEMP SEQUENCE conmas_operation_history_seq;
      CREATE TEMP SEQUENCE log_auto_numbering_seq;`);
    for (const name of [
      'def_top_def_top_id_seq',
      'def_sheet_def_sheet_id_seq',
      'conmas_operation_history_seq',
      'log_auto_numbering_seq',
    ])
      assert.equal(
        (await client.query('SELECT $1::regclass::oid=$2::regclass::oid AS private', [name, 'pg_temp.' + name])).rows[0]
          .private,
        true,
      );
    await client.query(`INSERT INTO pg_temp.mst_group (group_id,group_name,deleted,role_def_create,role_def_read,role_def_update,role_def_delete,role_rep_create,role_rep_read,role_rep_update,role_rep_delete,role_def_approve)
      VALUES (5,'Upload group',0,1,1,1,1,1,1,1,1,0),(-999,'Administrator',0,1,1,1,1,1,1,1,1,1);`);
    await client.query('INSERT INTO pg_temp.mst_group_affiation (group_id,user_id) VALUES (5,$1)', [actor.userId]);
    await client.query('INSERT INTO pg_temp.mst_user (user_id,user_name,password) VALUES ($1,$2,$3)', [
      actor.userId,
      'Uploader',
      legacyPassword(actor.userId, 'upload-password', process.env.CONMAS_LEGACY_KEY!),
    ]);
    await client.query(
      "INSERT INTO pg_temp.mst_terminal (term_id,term_type,physical_id,approver,term_name,deleted) VALUES (70,'Designer','upload-physical','approved','Upload terminal',0)",
    );
    await run(db, client);
  } finally {
    client.release(true);
    await pool.end();
  }
}
const enabled = {
  skip: !process.env.DATABASE_URL || !process.env.CONMAS_LEGACY_KEY || !process.env.CONMAS_LICENSE_KEY,
};

test('upload validates XML, int32 values, base64 and unsupported dependencies without fabricating success', async () => {
  assert.equal(definitionQuotaExceeded(undefined, 999999), false);
  assert.equal(definitionQuotaExceeded('2', 1), false);
  assert.equal(definitionQuotaExceeded('2', 2), true);
  assert.equal(definitionQuotaExceeded('0', 0), true);
  assert.equal(definitionQuotaExceeded('invalid', 0), false);
  assert.equal(definitionQuotaExceeded('2147483648', 0), false);
  const db = {
    connect: () => {
      throw new Error('Unexpected connection');
    },
  } as unknown as pg.Pool;
  await assert.rejects(registerDefinition(db, { ...actor, userId: '' }, definition), /Invalid definition request/);
  await assert.rejects(registerDefinition(db, actor, '<!DOCTYPE x><conmas/>'), /Invalid definition XML/);
  await assert.rejects(
    registerDefinition(db, actor, definition.replace('<defTopId/>', '<defTopId>1 OR 1=1</defTopId>')),
    /Invalid definition ID/,
  );
  await assert.rejects(registerDefinition(db, actor, definition, '1'), DefinitionUploadUnsupported);
  assert.equal(
    code(
      await registerDefinition(db, actor, definition.replace('<locked>', '<workReportType>4</workReportType><locked>')),
    ),
    '2',
  );
  assert.equal(
    code(
      await registerDefinition(db, actor, definition.replace('<locked>', '<workReportType>1</workReportType><locked>')),
    ),
    '2',
  );
  const table = '<tables><table><no>1</no></table></tables>';
  assert.equal(
    code(
      await registerDefinition(
        db,
        actor,
        definition.replace('<locked>', table + '<locked>').replace('<type>Text', '<type>DrawingImage'),
      ),
    ),
    '1011',
  );
  assert.equal(
    code(
      await registerDefinition(
        db,
        actor,
        definition
          .replace('<type>Text', '<type>DrawingImage')
          .replaceAll('<remarksValue1>Value 1', '<remarksValue1>{ir_detail}'),
      ),
    ),
    '1012',
  );
  assert.equal(
    code(
      await registerDefinition(
        db,
        actor,
        definition
          .replace('<locked>', table + '<locked>')
          .replaceAll('<remarksValue1>Value 1', '<remarksValue1>{ir_detail}')
          .replaceAll('<remarksValue2>Value 2', '<remarksValue2>1'),
      ),
    ),
    '1021',
  );
  for (const type of [2, 3]) {
    const workTable = definition.replace(
      '<locked>',
      `<workReportType>${type}</workReportType><workReportTableNo>1</workReportTableNo>${table}<locked>`,
    );
    assert.equal(code(await registerDefinition(db, actor, workTable)), '3011');
    assert.equal(
      code(
        await registerDefinition(
          db,
          actor,
          workTable.replace('</no>', '</no><columns><column><type>Date</type></column></columns>'),
        ),
      ),
      type === 2 ? '3021' : '3022',
    );
  }
});

test(
  'Published creation persists binaries, sheets, clusters, role defaults and references, then lists/receives them',
  enabled,
  async () =>
    fixture(async (db, client) => {
      assert.equal(code(await registerDefinition(db, actor, definition)), '0');
      const top = (await client.query('SELECT * FROM pg_temp.def_top')).rows[0],
        saved = parser.parse(top.xml_data).conmas.top;
      assert.equal(top.def_top_id, 100);
      assert.equal(top.def_top_org, 100);
      assert.equal(top.rev_no, 1);
      assert.equal(top.public_status, '2');
      assert.equal(top.def_file.toString(), 'Excel bytes');
      assert.equal(top.background_image_file.toString(), 'top pdf');
      assert.equal(top.thumbnail_file.toString(), 'top thumbnail');
      assert.equal(top.designer_version, '8.2.25101');
      assert.equal(top.cooperation_table, '0');
      assert.equal(saved.unknown, ' keep & retain ');
      assert.equal(saved.thumbnail, '');
      assert.equal(saved.definitionFile.value, '');
      assert.equal(saved.sheets.sheet.defSheetId, '200');
      assert.equal(saved.designerVersion, undefined);
      assert.equal(saved.registUser, actor.userId);
      const sh = (await client.query('SELECT * FROM pg_temp.def_sheet')).rows[0];
      assert.equal(sh.background_image_file.toString(), 'sheet png');
      assert.equal(sh.thumbnail_file.toString(), 'sheet thumbnail');
      assert.equal(
        (await client.query('SELECT * FROM pg_temp.def_cluster')).rows[0].input_parameter,
        'parameter & value',
      );
      assert.equal((await client.query('SELECT * FROM pg_temp.def_cluster_role')).rowCount, 1);
      assert.equal((await client.query('SELECT * FROM pg_temp.def_cluster_refer')).rowCount, 1);
      assert.equal((await client.query('SELECT * FROM pg_temp.def_reference')).rowCount, 10);
      assert.equal(
        (await client.query('SELECT role_def_update FROM pg_temp.def_role WHERE group_id=5')).rows[0].role_def_update,
        '1',
      );
      assert.equal((await client.query('SELECT * FROM pg_temp.def_current')).rows[0].def_top_id, 100);
      assert.equal(
        parser.parse(await getDefinitionList(db, actor, { labelId: '-9', itemTargetLabel: 'false' })).conmas.items.item
          .itemId,
        '100',
      );
      const received = parser.parse(await getDefinitionData(db, actor, 100)).conmas.top;
      assert.equal(received.defTopId, '100');
      assert.equal(Buffer.from(received.definitionFile.value, 'base64').toString(), 'Excel bytes');
      assert.equal(received.locked, '0');
      assert.equal(received.readOnly, '0');
    }),
);

test(
  'voice grammar create/replace/revision keeps audit metadata and absent grammar does not delete it',
  enabled,
  async () =>
    fixture(async (db, client) => {
      const draft = definition.replace('<publicStatus>2', '<publicStatus>1');
      const voice = draft.replace(
        '</conmas>',
        '<grammar custom="keep"><move><voice>next &amp; back</voice></move></grammar></conmas>',
      );
      assert.equal(code(await registerDefinition(db, actor, voice)), '0');
      const first = (await client.query('SELECT * FROM pg_temp.def_grammar')).rows[0];
      assert.match(first.xml_data, /custom="keep"/);
      assert.equal(first.sys_regist_term, actor.terminalId);
      const update = voice
        .replace('<defTopId/>', '<defTopId>100</defTopId>')
        .replace('<defSheetId/>', '<defSheetId>200</defSheetId>');
      const lock = () =>
        client.query('INSERT INTO pg_temp.def_lock (def_top_id,user_id,sys_regist_term) VALUES (100,$1,$2)', [
          actor.userId,
          actor.terminalId,
        ]);
      await lock();
      assert.equal(code(await registerDefinition(db, actor, update.replace('next &amp; back', 'replacement'))), '0');
      const replaced = (await client.query('SELECT * FROM pg_temp.def_grammar')).rows[0];
      assert.deepEqual(replaced.sys_regist_time, first.sys_regist_time);
      assert.match(replaced.xml_data, /replacement/);
      await lock();
      assert.equal(code(await registerDefinition(db, actor, update.replace(/<grammar.*<\/grammar>/, ''))), '0');
      assert.equal(
        (await client.query('SELECT xml_data FROM pg_temp.def_grammar')).rows[0].xml_data,
        replaced.xml_data,
      );
      await lock();
      assert.equal(
        code(await registerDefinition(db, actor, update.replace('<publicStatus>1', '<publicStatus>2'))),
        '0',
      );
      await lock();
      assert.equal(
        code(await registerDefinition(db, actor, update.replace('<publicStatus>1', '<publicStatus>2'))),
        '0',
      );
      assert.equal((await client.query('SELECT * FROM pg_temp.def_grammar')).rowCount, 2);
      assert.equal(parser.parse(await getDefinitionData(db, actor, 101)).conmas.grammar.move.voice, 'next & back');
    }),
);

test(
  'numbering creates private sequences/rules/logs, reuses unchanged rules and revises changed rules atomically',
  enabled,
  async () =>
    fixture(async (db, client) => {
      const numbered = definition
        .replace('<useAutoNumbering>0', '<useAutoNumbering>1')
        .replace('<autoNumbering/>', numbering);
      assert.equal(code(await registerDefinition(db, actor, numbered)), '0');
      assert.equal(
        (
          await client.query(
            "SELECT 'rep_auto_numbering_100_1'::regclass::oid='pg_temp.rep_auto_numbering_100_1'::regclass::oid AS private",
          )
        ).rows[0].private,
        true,
      );
      assert.equal(
        (await client.query("SELECT nextval('pg_temp.rep_auto_numbering_100_1') AS value")).rows[0].value,
        '2',
      );
      assert.equal(
        (await client.query('SELECT auto_numbering_rev_no FROM pg_temp.def_top')).rows[0].auto_numbering_rev_no,
        1,
      );
      assert.equal((await client.query('SELECT action FROM pg_temp.log_auto_numbering')).rows[0].action, 'CREATE_RULE');
      const saved = numbered
        .replace('<defTopId/>', '<defTopId>100</defTopId>')
        .replace('<defSheetId/>', '<defSheetId>200</defSheetId>');
      const lock = () =>
        client.query('INSERT INTO pg_temp.def_lock (def_top_id,user_id,sys_regist_term) VALUES (100,$1,$2)', [
          actor.userId,
          actor.terminalId,
        ]);
      await lock();
      assert.equal(code(await registerDefinition(db, actor, saved)), '0');
      assert.equal((await client.query('SELECT * FROM pg_temp.def_auto_numbering_reset_setting')).rowCount, 1);
      assert.equal(
        (await client.query("SELECT nextval('pg_temp.rep_auto_numbering_100_1') AS value")).rows[0].value,
        '4',
      );
      await lock();
      assert.equal(code(await registerDefinition(db, actor, saved.replace('<increment>2', '<increment>3'))), '0');
      assert.deepEqual(
        (await client.query('SELECT action FROM pg_temp.log_auto_numbering ORDER BY log_id')).rows.map(
          (row) => row.action,
        ),
        ['CREATE_RULE', 'UPDATE_RULE'],
      );
      assert.equal(
        (await client.query("SELECT nextval('pg_temp.rep_auto_numbering_100_2') AS value")).rows[0].value,
        '2',
      );
      await lock();
      await assert.rejects(registerDefinition(db, actor, saved.replace('<digit>3', '<digit>10')), /Invalid numbering/);
      assert.equal((await client.query('SELECT * FROM pg_temp.def_top')).rowCount, 3);
      assert.equal((await client.query('SELECT * FROM pg_temp.def_lock')).rowCount, 1);
      assert.equal(
        parser.parse(await getDefinitionData(db, actor, 102)).conmas.top.autoNumberingSequenceHasCreated,
        '1',
      );
    }),
);

test('numbering reset calendars handle daily, Monday-based weekly and monthly last-day schedules', () => {
  const now = new Date(2026, 10, 7, 12),
    node = (reset: string) =>
      root(numbering.replace('</autoNumbering>', `<useReset>1</useReset><reset>${reset}</reset></autoNumbering>`));
  const base = '<startDate>2026/11/01</startDate><executeTime>13:45</executeTime>';
  assert.deepEqual(
    nextDefinitionReset(node(base + '<termType>1</termType><interval>2</interval>'), now),
    new Date(2026, 10, 7, 13, 45),
  );
  assert.deepEqual(
    nextDefinitionReset(node(base + '<termType>2</termType><interval>2</interval><week>1,5</week>'), now),
    new Date(2026, 10, 9, 13, 45),
  );
  assert.deepEqual(
    nextDefinitionReset(node(base + '<termType>3</termType><month>11,12</month><day>99</day>'), now),
    new Date(2026, 10, 30, 13, 45),
  );
  assert.throws(
    () =>
      nextDefinitionReset(
        node(base.replace('2026/11/01', '2026/02/30') + '<termType>1</termType><interval>2</interval>'),
        now,
      ),
    /reset date/,
  );
});

const cooperation = (xml: string, mode = 1) =>
  xml.replace('<locked>', `<cooperationTable>${mode}</cooperationTable><locked>`);
const savedDefinition = (xml: string) =>
  xml.replace('<defTopId/>', '<defTopId>100</defTopId>').replace('<defSheetId/>', '<defSheetId>200</defSheetId>');
const lockUpload = (client: pg.PoolClient) =>
  client.query('INSERT INTO pg_temp.def_lock (def_top_id,user_id,sys_regist_term) VALUES (100,$1,$2)', [
    actor.userId,
    actor.terminalId,
  ]);
const tableColumns = async (client: pg.PoolClient, name: string) =>
  (
    await client.query(
      'SELECT attname,format_type(atttypid,atttypmod) AS type FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum',
      ['pg_temp.' + name],
    )
  ).rows;
const metadata = async (client: pg.PoolClient, name: string) =>
  parser.parse(
    (await client.query('SELECT xml_data FROM pg_temp.mst_report_table WHERE report_file_name=$1', [name])).rows[0]
      .xml_data,
  );
const withClusters = (nodes: string) => definition.replace(cluster, nodes);
const typedCluster = (id: number, type: string, parameters = '') =>
  cluster
    .replace('<clusterId>1', `<clusterId>${id}`)
    .replace('<type>Text', `<type>${type}`)
    .replace('parameter &amp; value', parameters);

test(
  'cooperation tables persist typed columns and revision unions filter deleted/non-current reports without changing old data',
  enabled,
  async () =>
    fixture(async (db, client) => {
      const xml = cooperation(
        withClusters(
          typedCluster(1, 'Text') +
            typedCluster(2, 'Numeric') +
            typedCluster(3, 'Calculate', 'DataType=1;DateFormat=HHmmss') +
            typedCluster(4, 'CalendarDate') +
            typedCluster(5, 'FixedText'),
        ),
      );
      assert.equal(code(await registerDefinition(db, actor, xml)), '0');
      const columns = await tableColumns(client, 'report_100');
      assert.deepEqual(
        columns.slice(-4).map((row) => [row.attname, row.type]),
        [
          ['cluster_0_1_t', 'text'],
          ['cluster_0_2_n', 'numeric(19,10)'],
          ['cluster_0_3_i', 'interval'],
          ['cluster_0_4_d', 'timestamp without time zone'],
        ],
      );
      assert.equal((await metadata(client, '100.xml')).table['@_enableCalcDataType'], 'true');
      assert.equal((await metadata(client, 'view100.xml')).view.definitions.definition['@_defTopId'], '100');
      await client.query(`INSERT INTO pg_temp.rep_top (rep_top_id,deleted) VALUES (1,0),(2,1),(3,0);
    INSERT INTO pg_temp.rep_current (rep_top_id) VALUES (1),(2);
    INSERT INTO pg_temp.report_100 (rep_top_id,cluster_0_1_t,cluster_0_2_n) VALUES (1,'old',2),(2,'deleted',3),(3,'noncurrent',4)`);
      assert.deepEqual((await client.query('SELECT rep_top_id,cluster_0_1_t FROM pg_temp.view_report_100')).rows, [
        { rep_top_id: 1, cluster_0_1_t: 'old' },
      ]);
      await lockUpload(client);
      assert.equal(
        code(
          await registerDefinition(
            db,
            actor,
            savedDefinition(cooperation(withClusters(typedCluster(1, 'Numeric') + typedCluster(6, 'Text')))),
          ),
        ),
        '0',
      );
      assert.equal(
        (await client.query('SELECT cluster_0_2_n FROM pg_temp.report_100 WHERE rep_top_id=1')).rows[0].cluster_0_2_n,
        '2.0000000000',
      );
      const union = (await metadata(client, 'view100.xml')).view;
      assert.deepEqual(
        union.definitions.definition.map((node: Record<string, string>) => node['@_defTopId']),
        ['100', '101'],
      );
      await client.query(
        "INSERT INTO pg_temp.rep_top (rep_top_id,deleted) VALUES (4,0); INSERT INTO pg_temp.rep_current (rep_top_id) VALUES (4); INSERT INTO pg_temp.report_101 (rep_top_id,cluster_0_1_n,cluster_0_6_t) VALUES (4,9,'new')",
      );
      const rows = (
        await client.query(
          'SELECT rep_top_id,cluster_0_1_t,cluster_0_1_n,cluster_0_2_n,cluster_0_6_t FROM pg_temp.view_report_100 ORDER BY rep_top_id',
        )
      ).rows;
      assert.equal(rows.length, 2);
      assert.equal(rows[0].cluster_0_1_n, null);
      assert.equal(rows[0].cluster_0_6_t, null);
      assert.equal(rows[1].cluster_0_1_t, null);
      assert.equal(rows[1].cluster_0_2_n, null);
      assert.equal(
        (
          await client.query(
            "SELECT bool_and(relpersistence='t') AS private FROM pg_class WHERE oid=ANY(ARRAY['pg_temp.report_100'::regclass,'pg_temp.report_101'::regclass,'pg_temp.view_report_100'::regclass])",
          )
        ).rows[0].private,
        true,
      );
    }),
);

test(
  'cooperation draft replacement rebuilds tables, future Published replacement replaces its union entry, and errors roll back DDL/metadata/locks',
  enabled,
  async () =>
    fixture(async (db, client) => {
      const draft = cooperation(definition.replace('<publicStatus>2', '<publicStatus>1'));
      assert.equal(code(await registerDefinition(db, actor, draft)), '0');
      assert.equal((await client.query('SELECT * FROM pg_temp.mst_report_table')).rowCount, 1);
      await lockUpload(client);
      assert.equal(
        code(await registerDefinition(db, actor, savedDefinition(draft.replace('<type>Text', '<type>Numeric')))),
        '0',
      );
      assert.equal((await tableColumns(client, 'report_100')).at(-1)!.attname, 'cluster_0_1_n');
      await lockUpload(client);
      assert.equal(code(await registerDefinition(db, actor, savedDefinition(cooperation(definition)))), '0');
      await client.query('UPDATE pg_temp.def_top SET use_start_date=$1', [new Date(Date.now() + 86400000)]);
      await lockUpload(client);
      assert.equal(
        code(
          await registerDefinition(
            db,
            actor,
            savedDefinition(cooperation(definition.replace('<type>Text', '<type>Date'))),
          ),
        ),
        '0',
      );
      assert.equal((await metadata(client, 'view100.xml')).view.definitions.definition['@_defTopId'], '100');
      const before = (
        await client.query('SELECT report_file_name,xml_data FROM pg_temp.mst_report_table ORDER BY report_file_name')
      ).rows;
      await lockUpload(client);
      const failed = {
        connect: async () => ({
          release() {},
          query: (sql: string, params?: unknown[]) =>
            sql.startsWith('INSERT INTO mst_report_table')
              ? Promise.reject(new Error('fixture metadata failure'))
              : client.query(sql, params),
        }),
      } as unknown as pg.Pool;
      await assert.rejects(
        registerDefinition(failed, actor, savedDefinition(cooperation(definition))),
        /fixture metadata failure/,
      );
      assert.deepEqual(
        (await client.query('SELECT report_file_name,xml_data FROM pg_temp.mst_report_table ORDER BY report_file_name'))
          .rows,
        before,
      );
      assert.equal((await tableColumns(client, 'report_100')).at(-1)!.attname, 'cluster_0_1_d');
      assert.equal((await client.query('SELECT * FROM pg_temp.def_lock')).rowCount, 1);
    }),
);

test(
  'table and union limits return source codes and roll back generated objects; draft/selected paths preserve source generation conditions',
  enabled,
  async () =>
    fixture(async (db, client) => {
      assert.equal(
        code(
          await registerDefinition(db, actor, cooperation(definition.replace('<publicStatus>2', '<publicStatus>0'))),
        ),
        '0',
      );
      assert.equal((await client.query('SELECT * FROM pg_temp.mst_report_table')).rowCount, 0);
      const many = cooperation(
        withClusters(Array.from({ length: 1573 }, (_, i) => typedCluster(i + 1, 'Text')).join('')),
      );
      await client.query('BEGIN');
      await assert.rejects(
        saveDefinitionTables(client, must(root(many), 'top'), 101, 101, false),
        (error: unknown) => error instanceof DefinitionTableError && error.code === 12101,
      );
      await client.query('ROLLBACK');
      // More than 1572 union fields across revisions fails after table creation, testing transactional DDL removal.
      const fields = Array.from({ length: 1572 }, (_, i) => `<field>cluster_0_${i + 2}_T</field>`).join('');
      await client.query('INSERT INTO pg_temp.mst_report_table (report_file_name,xml_data) VALUES ($1,$2)', [
        'view100.xml',
        `<view><fields>${fields}</fields><definitions><definition defTopId="99">${fields}</definition></definitions></view>`,
      ]);
      await client.query('BEGIN');
      await assert.rejects(
        saveDefinitionTables(client, must(root(cooperation(definition)), 'top'), 101, 100, false),
        (error: unknown) => error instanceof DefinitionTableError && error.code === 12102,
      );
      await client.query('ROLLBACK');
      assert.equal((await client.query("SELECT to_regclass('pg_temp.report_101') AS object")).rows[0].object, null);
      assert.equal(
        (await client.query("SELECT 1 FROM pg_temp.mst_report_table WHERE report_file_name='101.xml'")).rowCount,
        0,
      );
    }),
);

test(
  'split cooperation honors 373/400/400/399 capacity and sticky lineage mode with qualified joins and typed nulls',
  enabled,
  async () =>
    fixture(async (db, client) => {
      await client.query(
        "INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (1,'COOPERATION_TABLE_SETTING','DIVIDE_TABLE_MODE','1')",
      );
      const xml = cooperation(
        withClusters(Array.from({ length: 374 }, (_, i) => typedCluster(i + 1, 'Numeric')).join('')),
      );
      assert.equal(code(await registerDefinition(db, actor, xml)), '0');
      assert.equal(
        (await tableColumns(client, 'report_100_s_1')).filter((row) => row.attname.startsWith('cluster_')).length,
        373,
      );
      assert.equal(
        (await tableColumns(client, 'report_100_s_2')).filter((row) => row.attname.startsWith('cluster_')).length,
        1,
      );
      const table = (await metadata(client, '100.xml')).table;
      assert.equal(table['@_tableDivideNumber'], '2');
      assert(!table['#text'].includes('OIDS'));
      const first = (await metadata(client, 'view100.xml')).view.definitions.definition;
      assert.equal(first['@_divideMode'], 'true');
      assert.equal(first.field[373]['@_divideTableNo'], '2');
      await client.query(`INSERT INTO pg_temp.rep_top (rep_top_id,deleted) VALUES (1,0); INSERT INTO pg_temp.rep_current (rep_top_id) VALUES (1);
    INSERT INTO pg_temp.report_100_s_1 (rep_top_id,cluster_0_1_n) VALUES (1,1); INSERT INTO pg_temp.report_100_s_2 (rep_top_id,cluster_0_374_n) VALUES (1,374);
    UPDATE pg_temp.mst_common SET com_value='0'`);
      assert.equal(
        (await client.query('SELECT cluster_0_374_n FROM pg_temp.view_report_100')).rows[0].cluster_0_374_n,
        '374.0000000000',
      );
      await lockUpload(client);
      assert.equal(code(await registerDefinition(db, actor, savedDefinition(cooperation(definition)))), '0');
      assert.equal((await metadata(client, '101.xml')).table['@_tableDivideNumber'], '1');
      assert.equal(
        (await client.query('SELECT cluster_0_374_n FROM pg_temp.view_report_100')).rows[0].cluster_0_374_n,
        '374.0000000000',
      );
    }),
);

test(
  'legacy detail tables persist header/detail/group columns and metadata; split mode returns source code 12103',
  enabled,
  async () =>
    fixture(async (db, client) => {
      const header = typedCluster(1, 'Calculate', 'DataType=1;DateFormat=yyyyMMdd')
        .replace('<remarksValue1>Value 1', '<remarksValue1>{ir_header}')
        .replace('<remarksValue3>Value 3', '<remarksValue3>2');
      const detail = typedCluster(2, 'Check', 'Group=7')
        .replace('<remarksValue1>Value 1', '<remarksValue1>{ir_detail}')
        .replace('<remarksValue2>Value 2', '<remarksValue2>3')
        .replace('<remarksValue3>Value 3', '<remarksValue3>1')
        .replace('<remarksValue4>Value 4', '<remarksValue4>1');
      const xml = cooperation(withClusters(header + detail));
      assert.equal(code(await registerDefinition(db, actor, xml)), '0');
      assert.deepEqual(
        (await tableColumns(client, 'report_100_3')).slice(-3).map((row) => row.attname),
        ['header_2_d', 'detail_1_t', 'group_7_t'],
      );
      assert.deepEqual((await metadata(client, 'view100_3.xml')).view.fields.field, [
        'detail_1_T',
        'group_7_T',
        'header_2_D',
      ]);
      await lockUpload(client);
      await client.query(
        "INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (1,'COOPERATION_TABLE_SETTING','DIVIDE_TABLE_MODE','1')",
      );
      assert.equal(code(await registerDefinition(db, actor, savedDefinition(xml))), '12103');
      assert.equal((await client.query('SELECT * FROM pg_temp.def_top')).rowCount, 1);
      assert.equal((await client.query('SELECT * FROM pg_temp.def_lock')).rowCount, 1);
    }),
);

test(
  'modern selected table columns exclude row-linked headers, use column keys/types/colNo and retain rep_row_name',
  enabled,
  async () =>
    fixture(async (db, client) => {
      const table =
        '<tables><table><no>7</no><cooperationTable>1</cooperationTable><columns><column><no>2</no><key>amount</key><type>Numeric</type></column><column><no>1</no><key>day</key><type>Date</type></column></columns><rows><row><no>1</no><name>row</name><clusters><cluster><sheetNo>0</sheetNo><clusterId>1</clusterId><columnKey>amount</columnKey></cluster></clusters></row></rows></table></tables>';
      const xml = cooperation(
        withClusters(typedCluster(1, 'Numeric') + typedCluster(2, 'Text'))
          .replaceAll('</inputParameters>', '</inputParameters><cooperationCluster>1</cooperationCluster>')
          .replace('<locked>', table + '<locked>'),
        2,
      );
      assert.equal(code(await registerDefinition(db, actor, xml)), '0');
      const columns = await tableColumns(client, 'report_100_7');
      assert(columns.some((row) => row.attname === 'rep_row_name'));
      assert(!columns.some((row) => row.attname === 'cluster_0_1_n'));
      assert.deepEqual(
        columns.slice(-3).map((row) => row.attname),
        ['cluster_0_2_t', 'cluster_amount_n', 'cluster_day_d'],
      );
      const view = (await metadata(client, 'view_report_100_7.xml')).view;
      assert.deepEqual(view.fields.field, ['cluster_0_2_T', 'cluster_day_D', 'cluster_amount_N']);
      assert.equal(view.definitions.definition.field[1]['@_colNo'], '2');
      await client.query(`INSERT INTO pg_temp.rep_top (rep_top_id,deleted) VALUES (1,0); INSERT INTO pg_temp.rep_current (rep_top_id) VALUES (1);
    INSERT INTO pg_temp.report_100_7 (rep_top_id,rep_row_no,rep_row_name,cluster_amount_n) VALUES (1,1,'Detail name',4)`);
      assert.equal(
        (await client.query('SELECT rep_row_name FROM pg_temp.view_report_100_7')).rows[0].rep_row_name,
        'Detail name',
      );
      await lockUpload(client);
      await assert.rejects(
        registerDefinition(db, actor, savedDefinition(xml.replace('<key>amount', '<key>x); DROP TABLE mst_user;--'))),
        /Invalid report table identifier/,
      );
      assert.equal((await client.query('SELECT * FROM pg_temp.def_top')).rowCount, 1);
      assert.equal((await client.query('SELECT * FROM pg_temp.def_lock')).rowCount, 1);
      await client.query(
        "INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (1,'COOPERATION_TABLE_SETTING','REGIST_IMMEDIATELY','0')",
      );
      await assert.rejects(registerDefinition(db, actor, savedDefinition(xml)), DefinitionUploadUnsupported);
    }),
);

test(
  'revision saves require an owned lock and update role, preserve old Published data/options/labels/references, and unlock after commit',
  enabled,
  async () =>
    fixture(async (db, client) => {
      assert.equal(code(await registerDefinition(db, actor, definition)), '0');
      const revision = definition
        .replace('<defTopId/>', '<defTopId>100</defTopId>')
        .replace('<defSheetId/>', '<defSheetId>200</defSheetId>')
        .replace('Published fixture', 'New revision');
      assert.equal(code(await registerDefinition(db, actor, revision)), '3');
      await client.query('INSERT INTO pg_temp.def_lock (def_top_id,user_id,sys_regist_term) VALUES (100,$1,$2)', [
        actor.userId,
        actor.terminalId,
      ]);
      await client.query(
        "UPDATE pg_temp.def_reference SET reference_value='preserved reference' WHERE reference_id=1;",
      );
      await client.query('INSERT INTO pg_temp.def_top_option (def_top_id,pdf_fontsize_deduction) VALUES (100,0.25)');
      await client.query('INSERT INTO pg_temp.def_label (def_top_id,mst_label_id) VALUES (100,45)');
      await client.query('UPDATE pg_temp.def_role SET role_def_update=0 WHERE group_id=5');
      assert.equal(code(await registerDefinition(db, actor, revision)), '3');
      await client.query('UPDATE pg_temp.def_role SET role_def_update=1 WHERE group_id=5');
      assert.equal(code(await registerDefinition(db, actor, revision)), '0');
      const tops = (await client.query('SELECT * FROM pg_temp.def_top ORDER BY def_top_id')).rows;
      assert.equal(tops.length, 2);
      assert.equal(tops[0].def_top_name, 'Published fixture');
      assert.equal(tops[1].def_top_name, 'New revision');
      assert.equal(tops[1].def_top_org, 100);
      assert.equal(tops[1].rev_no, 2);
      assert.equal((await client.query('SELECT * FROM pg_temp.def_current')).rows[0].def_top_id, 101);
      assert.equal(
        (await client.query('SELECT * FROM pg_temp.def_top_option WHERE def_top_id=101')).rows[0]
          .pdf_fontsize_deduction,
        0.25,
      );
      assert.equal(
        (await client.query('SELECT * FROM pg_temp.def_label WHERE def_top_id=101')).rows[0].mst_label_id,
        45,
      );
      assert.equal(
        (await client.query('SELECT * FROM pg_temp.def_reference WHERE def_sheet_id=201 AND reference_id=1')).rows[0]
          .reference_value,
        'preserved reference',
      );
      assert.equal((await client.query('SELECT * FROM pg_temp.def_lock')).rowCount, 0);
    }),
);

test(
  'draft replacement rolls back corrupt binaries or foreign sheet IDs, respects approval permission and leaves restored tables untouched',
  enabled,
  async () =>
    fixture(async (db, client) => {
      const draft = definition.replace('<publicStatus>2', '<publicStatus>1');
      assert.equal(code(await registerDefinition(db, actor, draft)), '0');
      await client.query('INSERT INTO pg_temp.def_lock (def_top_id,user_id,sys_regist_term) VALUES (100,$1,$2)', [
        actor.userId,
        actor.terminalId,
      ]);
      const update = draft
        .replace('<defTopId/>', '<defTopId>100</defTopId>')
        .replace('<defSheetId/>', '<defSheetId>200</defSheetId>')
        .replace('Published fixture', 'Updated draft');
      const before = (await client.query('SELECT xml_data FROM pg_temp.def_top')).rows[0].xml_data;
      await assert.rejects(
        registerDefinition(db, actor, update.replace(Buffer.from('Excel bytes').toString('base64'), 'invalid$')),
        /Invalid definition binary/,
      );
      await assert.rejects(
        registerDefinition(db, actor, update.replace('<defSheetId>200', '<defSheetId>2147483648')),
        /Invalid definition integer/,
      );
      await assert.rejects(
        registerDefinition(db, actor, update.replace('<defSheetId>200', '<defSheetId>999')),
        /does not belong/,
      );
      assert.equal((await client.query('SELECT xml_data FROM pg_temp.def_top')).rows[0].xml_data, before);
      assert.equal((await client.query('SELECT * FROM pg_temp.def_lock')).rowCount, 1);
      await client.query(
        "INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (1,'DEFINITION_SETTING','APPROVE_MODE','1')",
      );
      assert.equal(
        code(await registerDefinition(db, actor, update.replace('<publicStatus>1', '<publicStatus>2'))),
        '1003',
      );
      assert.equal(code(await registerDefinition(db, actor, update)), '0');
      assert.equal((await client.query('SELECT * FROM pg_temp.def_top')).rowCount, 1);
      assert.equal(
        (await client.query('SELECT def_top_name FROM pg_temp.def_top')).rows[0].def_top_name,
        'Updated draft',
      );
      assert.equal((await client.query('SELECT * FROM pg_temp.def_lock')).rowCount, 0);
    }),
);

test(
  'replacement adds/removes sheets with cascading clusters/roles/references and preserves registration/approval data',
  enabled,
  async () =>
    fixture(async (db, client) => {
      const draft = definition
        .replace('<publicStatus>2', '<publicStatus>1')
        .replace('<sheetCount>1', '<sheetCount>2')
        .replace('</sheets>', sheet.replace('<sheetNo>0', '<sheetNo>1') + '</sheets>');
      assert.equal(code(await registerDefinition(db, actor, draft)), '0');
      const before = (await client.query('SELECT sys_regist_time FROM pg_temp.def_top')).rows[0].sys_regist_time;
      await client.query("UPDATE pg_temp.def_top SET def_approve_status=3,def_approver_comment='preserved remand'");
      await client.query('INSERT INTO pg_temp.def_lock (def_top_id,user_id,sys_regist_term) VALUES (100,$1,$2)', [
        actor.userId,
        actor.terminalId,
      ]);
      const update = definition
        .replace('<publicStatus>2', '<publicStatus>1')
        .replace('<defTopId/>', '<defTopId>100</defTopId>');
      assert.equal(code(await registerDefinition(db, actor, update)), '0');
      const top = (await client.query('SELECT * FROM pg_temp.def_top')).rows[0];
      assert.deepEqual(top.sys_regist_time, before);
      assert.equal(top.def_approve_status, '3');
      assert.equal(top.def_approver_comment, 'preserved remand');
      assert.deepEqual(
        (await client.query('SELECT def_sheet_id FROM pg_temp.def_sheet')).rows.map((row) => row.def_sheet_id),
        [202],
      );
      for (const table of ['def_cluster', 'def_cluster_role', 'def_cluster_refer', 'def_reference']) {
        assert.equal(
          (await client.query(`SELECT 1 FROM pg_temp.${table} WHERE def_sheet_id IN (200,201)`)).rowCount,
          0,
        );
      }
      assert.equal((await client.query('SELECT * FROM pg_temp.def_reference WHERE def_sheet_id=202')).rowCount, 10);
    }),
);

test(
  'future Published replaces, draft revision retains Published current, and history allocates maximum revision plus one',
  enabled,
  async () =>
    fixture(async (db, client) => {
      assert.equal(code(await registerDefinition(db, actor, definition)), '0');
      const future = new Date(Date.now() + 86400000);
      await client.query('UPDATE pg_temp.def_top SET use_start_date=$1', [future]);
      const saved = definition
        .replace('<defTopId/>', '<defTopId>100</defTopId>')
        .replace('<defSheetId/>', '<defSheetId>200</defSheetId>');
      const lock = () =>
        client.query('INSERT INTO pg_temp.def_lock (def_top_id,user_id,sys_regist_term) VALUES (100,$1,$2)', [
          actor.userId,
          actor.terminalId,
        ]);
      await lock();
      assert.equal(code(await registerDefinition(db, actor, saved)), '0');
      assert.equal((await client.query('SELECT * FROM pg_temp.def_top')).rowCount, 1);
      assert.deepEqual(
        (await client.query('SELECT use_start_date FROM pg_temp.def_top')).rows[0].use_start_date,
        future,
      );
      await lock();
      assert.equal(code(await registerDefinition(db, actor, saved.replace('<publicStatus>2', '<publicStatus>1'))), '0');
      assert.deepEqual(
        (await client.query('SELECT def_top_id FROM pg_temp.def_current ORDER BY def_top_id')).rows.map(
          (row) => row.def_top_id,
        ),
        [100, 101],
      );
      await lock();
      assert.equal(code(await registerDefinition(db, actor, saved)), '0');
      assert.deepEqual(
        (await client.query('SELECT def_top_id FROM pg_temp.def_current')).rows.map((row) => row.def_top_id),
        [100],
      );
      await client.query('UPDATE pg_temp.def_top SET use_start_date=NULL');
      await lock();
      assert.equal(code(await registerDefinition(db, actor, saved)), '0');
      await lock();
      assert.equal(code(await registerDefinition(db, actor, saved)), '0');
      assert.deepEqual(
        (await client.query('SELECT rev_no FROM pg_temp.def_top ORDER BY def_top_id')).rows.map((row) => row.rev_no),
        [1, 2, 3, 4],
      );
      assert.deepEqual(
        (await client.query('SELECT def_top_id FROM pg_temp.def_current')).rows.map((row) => row.def_top_id),
        [103],
      );
    }),
);

test(
  'new uploads enforce creation permission and effective license quota; dependency rejection leaves rows/locks unchanged',
  enabled,
  async () =>
    fixture(async (db, client) => {
      await client.query('UPDATE pg_temp.mst_group SET role_def_create=0 WHERE group_id=5');
      assert.equal(code(await registerDefinition(db, actor, definition)), '3');
      assert.equal((await client.query('SELECT * FROM pg_temp.def_top')).rowCount, 0);
      await client.query('UPDATE pg_temp.mst_group SET role_def_create=1 WHERE group_id=5');
      const quotaText = readLicenseFields().get('Definition');
      if (quotaText !== undefined) {
        const quota = Number(quotaText);
        assert(Number.isInteger(quota));
        const limited = {
          connect: async () => ({
            release() {},
            query: (sql: string, values?: unknown[]) =>
              sql === 'SELECT COUNT(1) AS count FROM def_current'
                ? Promise.resolve({ rows: [{ count: String(quota) }] })
                : client.query(sql, values),
          }),
        } as unknown as pg.Pool;
        assert.equal(code(await registerDefinition(limited, actor, definition)), '11050');
        assert.equal((await client.query('SELECT * FROM pg_temp.def_top')).rowCount, 0);
      }
      await client.query(
        "INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (1,'OUTPUT_SETTING','TMP_XML','true')",
      );
      await assert.rejects(registerDefinition(db, actor, definition), DefinitionUploadUnsupported);
      assert.equal((await client.query('SELECT * FROM pg_temp.def_top')).rowCount, 0);
      await client.query("UPDATE pg_temp.mst_common SET com_value='invalid'");
      await assert.rejects(registerDefinition(db, actor, definition), /Invalid definition temporary-XML setting/);
      assert.equal((await client.query('SELECT * FROM pg_temp.def_top')).rowCount, 0);
      await client.query('DELETE FROM pg_temp.mst_common');
      assert.equal(code(await registerDefinition(db, actor, definition)), '0');
      await client.query('INSERT INTO pg_temp.def_lock (def_top_id,user_id,sys_regist_term) VALUES (100,$1,$2)', [
        actor.userId,
        actor.terminalId,
      ]);
      await client.query('INSERT INTO pg_temp.binder_def (binder_def_id,binder_type,warning_flg) VALUES (1,1,0)');
      await client.query('INSERT INTO pg_temp.binder_def_src (binder_def_id,def_top_org) VALUES (1,100)');
      assert.equal(
        code(await registerDefinition(db, actor, definition.replace('<defTopId/>', '<defTopId>100</defTopId>'))),
        '0',
      );
      assert.equal((await client.query('SELECT warning_flg FROM pg_temp.binder_def')).rows[0].warning_flg, '1');
      assert.equal((await client.query('SELECT * FROM pg_temp.def_top')).rowCount, 2);
      assert.equal((await client.query('SELECT * FROM pg_temp.def_lock')).rowCount, 0);
    }),
);

test(
  'enabled System role settings use installed group scope/default-report queries without an administrator bypass',
  enabled,
  async () =>
    fixture(async (db, client) => {
      await client.query(`INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES
    (1,'SYSTEM_ROLE_SETTING','ENABLE','1'),(2,'SYSTEM_ROLE_SETTING','DEF','1'),(3,'SYSTEM_ROLE_SETTING','REP','4'),
    (4,'SYSTEM_ROLE_SETTING','AUTO_TYPE','1'),(5,'SYSTEM_ROLE_SETTING','REP_DEFAULT','3');
    INSERT INTO pg_temp.mst_group (group_id,group_name,deleted,role_def_read,role_def_update,role_def_delete,role_rep_create,role_rep_read,role_rep_update,role_rep_delete)
      VALUES (6,'Other group',0,1,0,0,1,0,0,0)`);
      assert.equal(code(await registerDefinition(db, actor, definition)), '0');
      const own = (await client.query('SELECT * FROM pg_temp.def_role WHERE group_id=5')).rows[0];
      const other = (await client.query('SELECT * FROM pg_temp.def_role WHERE group_id=6')).rows[0];
      assert.equal(own.role_def_update, '1');
      assert.equal(other.role_def_update, '0');
      assert.equal(other.role_rep_create, '1');
      assert.equal(other.role_rep_read, '0');
      assert.equal((await client.query('SELECT role_create_mode FROM pg_temp.def_top')).rows[0].role_create_mode, '3');
      assert.equal(
        (await client.query('SELECT * FROM pg_temp.def_role WHERE group_id=-999')).rows[0].role_def_update,
        '1',
      );
    }),
);

test(
  'native multipart Published upload accepts WebClient file fields, query/form commands and first-file semantics, with XML failures and disk cleanup',
  enabled,
  async () =>
    fixture(async (db, client) => {
      const server = createApp(db).listen(0, '127.0.0.1');
      try {
        await new Promise<void>((resolve) => server.once('listening', resolve));
        const address = server.address();
        assert(address && typeof address !== 'string');
        const endpoint = `http://127.0.0.1:${address.port}/ConMasWeb/Rests/ConMasIReporter.aspx`;
        const login = await fetch(endpoint, {
          method: 'POST',
          body: new URLSearchParams({
            command: 'Login',
            user: actor.userId,
            password: 'upload-password',
            client: 'Designer',
            terminalId: 'upload-physical',
            version: '8.2.25101',
            authenticationType: '0',
          }),
        });
        assert.equal(parser.parse(await login.text()).conmas.loginResult.code, '0');
        const cookie = login.headers.get('set-cookie')!.split(';')[0];
        const filesBefore = new Set(
          (await readdir(tmpdir())).filter((name) => name.startsWith('conmas-client-upload-')),
        );
        const upload = (xml: string, commandInBody = false, other = '') => {
          const body = new FormData();
          if (commandInBody) body.set('command', 'RegistDefinition');
          body.append('file', new Blob([xml]), '../../definition.xml');
          if (other) body.append('other-name', new Blob([other]), 'ignored.xml');
          return fetch(endpoint + (commandInBody ? '' : '?command=RegistDefinition'), {
            method: 'POST',
            headers: { cookie },
            body,
          });
        };
        const anonymousBody = new FormData();
        anonymousBody.append('file', new Blob([definition]), 'definition.xml');
        assert.equal(
          code(
            await (await fetch(endpoint + '?command=RegistDefinition', { method: 'POST', body: anonymousBody })).text(),
          ),
          '5',
        );
        await client.query('UPDATE pg_temp.mst_terminal SET approver=NULL');
        assert.equal(code(await (await upload(definition)).text()), '3');
        assert.equal((await client.query('SELECT * FROM pg_temp.def_top')).rowCount, 0);
        await client.query("UPDATE pg_temp.mst_terminal SET approver='approved'");
        const response = await upload(definition, false, '<invalid/>');
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'text/xml; charset=utf-8');
        assert.equal(code(await response.text()), '0');
        assert.equal((await client.query('SELECT * FROM pg_temp.def_top')).rowCount, 1);
        const bad = await upload('<invalid/>', true);
        assert.equal(bad.status, 200);
        assert.equal(code(await bad.text()), '-1');
        const withTable = await upload(cooperation(definition));
        assert.equal(withTable.status, 200);
        assert.equal(code(await withTable.text()), '0');
        assert.equal(
          (await client.query("SELECT relpersistence FROM pg_class WHERE oid='pg_temp.report_101'::regclass")).rows[0]
            .relpersistence,
          't',
        );
        const unsupported = await upload(
          definition
            .replace('<locked>', '<cooperationTable>1</cooperationTable><locked>')
            .replace('<type>Text', '<type>DrawingImage'),
        );
        assert.equal(unsupported.status, 501);
        assert.equal(code(await unsupported.text()), '-1');
        const blocked = await fetch(endpoint + '?command=RegistDefinition', {
          method: 'POST',
          headers: { cookie, origin: 'https://other.example' },
          body: new FormData(),
        });
        assert.equal(blocked.status, 403);
        const oversized = await new Promise<{ status: number; xml: string }>((resolve, reject) => {
          const call = request(
            endpoint + '?command=RegistDefinition',
            {
              method: 'POST',
              headers: {
                cookie,
                'Content-Type': 'multipart/form-data; boundary=fixture',
                'Content-Length': String(maxSystemUploadBytes + 1),
              },
            },
            (response) => {
              let xml = '';
              response.setEncoding('utf8');
              response.on('data', (chunk) => {
                xml += chunk;
              });
              response.once('end', () => resolve({ status: response.statusCode!, xml }));
            },
          );
          call.on('error', reject);
          call.end();
        });
        assert.equal(oversized.status, 413);
        assert.equal(code(oversized.xml), '-1');
        const staged = async () =>
          (await readdir(tmpdir())).filter(
            (name) => name.startsWith('conmas-client-upload-') && !filesBefore.has(name),
          );
        for (let attempt = 0; attempt < 20 && (await staged()).length; attempt++) await setTimeout(10);
        assert.deepEqual(await staged(), []);
        const persisted = (await client.query('SELECT def_file FROM pg_temp.def_top')).rows[0];
        assert.equal(persisted.def_file.toString(), 'Excel bytes');
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }
    }),
);
