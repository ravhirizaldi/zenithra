import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { XMLParser } from 'fast-xml-parser';
import {
  getDefinitionData,
  getDefinitionDetail,
  getDefinitionList,
  unlockDefinition,
  query,
} from '../../../src/models/client-definitions.js';
import { clientConfiguration } from '../../../src/config/client.js';

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: false });
const actor = { userId: 'designer-test', terminalId: "designer's terminal" };
const definition = `<conmas origin="keep"><top><defTopId>1</defTopId><publicStatus>1</publicStatus><thumbnail/><backgroundImage/><definitionFile><type>Excel</type><name>test.xlsx</name><value/></definitionFile><locked>0</locked><readOnly>0</readOnly><labels old="remove"><label><name>stale</name></label></labels><editMail old="remove">stale</editMail><calculateMode>9</calculateMode><reportCopyType>2</reportCopyType><unknown> retain &amp; escape </unknown><sheets><sheet><defSheetId>10</defSheetId><sheetNo>0</sheetNo><thumbnail>sheet image remains</thumbnail><backgroundImage>sheet background remains</backgroundImage><references old="remove"/><clusters><cluster custom="keep"><clusterId>1</clusterId><management><authority><groupId>stale</groupId></authority><mail><apply>keep</apply></mail></management></cluster><cluster><clusterId>2</clusterId><userCustomMaster><masterTableId>7</masterTableId></userCustomMaster></cluster></clusters></sheet></sheets></top></conmas>`;

async function fixture(run: (db: pg.Pool, client: pg.PoolClient) => Promise<void>): Promise<void> {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const db = { connect: async () => ({ query: client.query.bind(client), release: () => {} }) } as unknown as pg.Pool;
  try {
    await client.query(`CREATE TEMP TABLE def_top (LIKE public.def_top INCLUDING ALL);
      CREATE TEMP TABLE def_lock (LIKE public.def_lock INCLUDING ALL);
      CREATE TEMP TABLE def_role (def_top_id integer,group_id integer,role_def_read integer,role_def_update integer,role_rep_create integer);
      CREATE TEMP TABLE mst_group (group_id integer,deleted integer);
      CREATE TEMP TABLE def_current (def_top_id integer,def_top_org integer);
      CREATE TEMP TABLE def_label_role (mst_label_id integer,group_id integer);
      CREATE TEMP TABLE mst_group_affiation (user_id text,group_id integer);
      CREATE TEMP TABLE mst_common (com_key text,com_name text,com_value text,com_index integer);
      CREATE TEMP TABLE mst_label_def (mst_label_id integer,label_name text,label_name_path text,label_icon_id integer,diplay_number integer,upper_label_id integer,label_remarks text,label_id_path text,sys_regist_time timestamp,sys_update_time timestamp);
      CREATE TEMP TABLE def_label (def_top_id integer,mst_label_id integer);
      CREATE TEMP TABLE def_sheet (def_top_id integer,def_sheet_id integer,def_sheet_no integer);
      CREATE TEMP TABLE def_cluster (def_sheet_id integer,cluster_id integer,cluster_name text,cluster_type text);
      CREATE TEMP TABLE def_reference (def_sheet_id integer,reference_type text,reference_name text,reference_value text,diplay_number integer);
      CREATE TEMP TABLE def_cluster_role (def_sheet_id integer,cluster_id integer,group_id integer);
      CREATE TEMP TABLE def_cluster_refer (def_sheet_id integer,cluster_id integer,group_id integer);
      CREATE TEMP TABLE mst_custom_table (master_id integer,master_key text);
      CREATE TEMP TABLE custom_table_delete (master_id integer);`);
    // Explicit IDs and minimal private auxiliary tables never allocate a public sequence value.
    await client.query(
      `INSERT INTO pg_temp.def_top (def_top_id,def_top_org,def_top_name,xml_data,public_status,def_file,thumbnail_file,background_image_file,edit_mail,calculate_mode,auto_numbering_rev_no,designer_version,designer_display_version)
      VALUES (1,1,'Test definition',$1,1,$2,$3,$4,'mail-setting',3,1,'7.2.3','7.2.30000')`,
      [definition, Buffer.from('excel bytes'), Buffer.from('thumbnail bytes'), Buffer.from('background bytes')],
    );
    await client.query(`INSERT INTO pg_temp.def_role VALUES (1,4,1,0,1),(1,5,1,1,0);
      INSERT INTO pg_temp.mst_group VALUES (4,0),(5,0),(6,1);
      INSERT INTO pg_temp.def_current VALUES (1,1);
      INSERT INTO pg_temp.mst_group_affiation VALUES ('designer-test',4),('designer-test',5);
      INSERT INTO pg_temp.mst_label_def (mst_label_id,label_name,label_name_path,label_icon_id,diplay_number,label_id_path) VALUES (8,'Child','Parent',2,1,'8');
      INSERT INTO pg_temp.def_label VALUES (1,8);
      INSERT INTO pg_temp.def_sheet VALUES (1,10,0);
      INSERT INTO pg_temp.def_cluster VALUES (10,1,'Approval','Approve'),(10,2,'Master','SelectMaster');
      INSERT INTO pg_temp.def_reference VALUES (10,'0','Reference','value & text',1);
      INSERT INTO pg_temp.def_cluster_role VALUES (10,1,4);
      INSERT INTO pg_temp.def_cluster_refer VALUES (10,1,5);
      INSERT INTO pg_temp.mst_custom_table VALUES (7,'master-key');`);
    await run(db, client);
  } finally {
    client.release(true);
    await pool.end();
  }
}

test('installed SQL binds only actual parameters, preserving literals, comments and casts', async () => {
  const calls: { text: string; values: unknown[] }[] = [];
  const client = {
    query: async (text: string, values: unknown[]) => {
      calls.push({ text, values });
      return { rows: [] };
    },
  } as unknown as pg.PoolClient;
  const sql = 'SELECT \':unused\',"colon:unused",:id::int,:id -- :unused\n/* :unused */ WHERE user_id=:user';
  await query(client, sql, { unused: 'never bound', id: 1, user: "' OR 1=1 --" });
  assert.equal(
    calls[0].text,
    'SELECT \':unused\',"colon:unused",$1::int,$1 -- :unused\n/* :unused */ WHERE user_id=$2',
  );
  assert.deepEqual(calls[0].values, [1, "' OR 1=1 --"]);
  await assert.rejects(query(client, 'SELECT :missing', {}), /Missing client query parameter/);
});

test('definition models reject invalid IDs and anonymous contexts before connecting', async () => {
  const db = {
    connect: () => {
      throw new Error('Unexpected connection');
    },
  } as unknown as pg.Pool;
  for (const id of [NaN, Infinity, 1.5, 2147483648, -2147483649]) {
    await assert.rejects(getDefinitionData(db, actor, id), /Invalid definition request/);
    await assert.rejects(getDefinitionDetail(db, actor, id), /Invalid definition request/);
    await assert.rejects(unlockDefinition(db, actor, id), /Invalid definition request/);
  }
  await assert.rejects(unlockDefinition(db, { userId: '', terminalId: 'term' }, 1), /Invalid definition request/);
  await assert.rejects(getDefinitionData(db, { userId: 'user', terminalId: '' }, 1), /Invalid definition request/);
  await assert.rejects(getDefinitionList(db, { userId: '', terminalId: 'term' }, {}), /Invalid definition request/);
  for (const name of ['urlSchemeMode']) {
    await assert.rejects(getDefinitionList(db, actor, { [name]: '1' }), /list request mode is not implemented/);
  }
});

test('unlock is parameterized, releases the owned scope and rolls back errors', async () => {
  const calls: { text: string; values?: unknown[] }[] = [];
  let fail = false,
    released = 0;
  const db = {
    connect: async () => ({
      query: async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        if (fail && text.startsWith('DELETE')) throw new Error('write failed');
        return { rows: [] };
      },
      release: () => {
        released++;
      },
    }),
  } as unknown as pg.Pool;
  assert.deepEqual(parser.parse(await unlockDefinition(db, actor, 1)), {
    conmas: { error: { code: '0', remarks: '' } },
  });
  assert.equal(calls[1].text, 'DELETE FROM def_lock WHERE def_top_id=$1 AND (user_id=$2 OR sys_regist_term=$3)');
  assert.deepEqual(calls[1].values, [1, actor.userId, actor.terminalId]);
  assert.equal(calls[2].text, 'COMMIT');
  fail = true;
  calls.length = 0;
  await assert.rejects(unlockDefinition(db, actor, 1), /write failed/);
  assert.equal(calls.at(-1)?.text, 'ROLLBACK');
  assert.equal(released, 2);
});

test(
  'Designer receive reconstructs binaries, labels, references, authority and custom-master keys without rewriting saved XML',
  { skip: !process.env.DATABASE_URL },
  async () =>
    fixture(async (db, client) => {
      const xml = parser.parse(await getDefinitionData(db, actor, 1)),
        top = xml.conmas.top;
      assert.equal(xml.conmas['@_origin'], 'keep');
      assert.equal(top.unknown, ' retain & escape ');
      assert.equal(top.definitionFile.value, Buffer.from('excel bytes').toString('base64'));
      assert.equal(top.thumbnail, Buffer.from('thumbnail bytes').toString('base64'));
      assert.equal(top.backgroundImage, Buffer.from('background bytes').toString('base64'));
      assert.deepEqual(top.labels, { label: { labelId: '8', name: 'Parent/Child', iconId: '2' } });
      const sheet = top.sheets.sheet,
        clusters = sheet.clusters.cluster;
      assert.equal(sheet.thumbnail, 'sheet image remains');
      assert.equal(sheet.backgroundImage, 'sheet background remains');
      assert.deepEqual(sheet.references, { reference: { type: '0', name: 'Reference', value: 'value & text' } });
      assert.equal(clusters[0]['@_custom'], 'keep');
      assert.deepEqual(clusters[0].management.authority.groupId, [
        { '#text': '4', '@_roleType': '0' },
        { '#text': '5', '@_roleType': '1' },
      ]);
      assert.equal(clusters[0].management.mail.apply, 'keep');
      assert.equal(clusters[1].userCustomMaster.masterKey, 'master-key');
      assert.deepEqual(top.editMail, ['mail-setting', '']);
      assert.deepEqual(top.calculateMode, ['3', '0']);
      assert.equal(top.autoNumberingSequenceHasCreated, '1');
      assert.equal(top.readOnly, '0');
      assert.equal(top.locked, '0');
      const lock = (await client.query('SELECT * FROM pg_temp.def_lock WHERE def_top_id=1')).rows[0];
      assert.equal(lock.user_id, actor.userId);
      assert.equal(lock.sys_regist_term, actor.terminalId);
      assert.equal(lock.sys_update_user, actor.userId);
      assert.equal(
        (await client.query('SELECT xml_data FROM pg_temp.def_top WHERE def_top_id=1')).rows[0].xml_data,
        definition,
      );
    }),
);

test(
  'Designer receive keeps read-only, competing locks, owned-terminal release and pending-approval lock rules',
  { skip: !process.env.DATABASE_URL },
  async () =>
    fixture(async (db, client) => {
      await client.query(
        "INSERT INTO pg_temp.def_lock (def_top_id,user_id,sys_regist_term) VALUES (1,'other','other-terminal')",
      );
      let top = parser.parse(await getDefinitionData(db, actor, 1)).conmas.top;
      assert.equal(top.locked, '1');
      assert.equal(top.readOnly, '0');
      assert.equal((await client.query('SELECT user_id FROM pg_temp.def_lock')).rows[0].user_id, 'other');
      await unlockDefinition(db, actor, 1);
      assert.equal((await client.query('SELECT user_id FROM pg_temp.def_lock')).rows[0].user_id, 'other');
      await client.query('UPDATE pg_temp.def_lock SET sys_regist_term=$1', [actor.terminalId]);
      top = parser.parse(await getDefinitionData(db, actor, 1)).conmas.top;
      assert.equal(top.locked, '0');
      assert.equal((await client.query('SELECT user_id FROM pg_temp.def_lock')).rows[0].user_id, actor.userId);
      await unlockDefinition(db, actor, 1);
      await client.query('UPDATE pg_temp.def_role SET role_def_update=0');
      top = parser.parse(await getDefinitionData(db, actor, 1)).conmas.top;
      assert.equal(top.readOnly, '1');
      assert.equal(top.locked, '0');
      assert.equal((await client.query('SELECT * FROM pg_temp.def_lock')).rowCount, 0);
      await client.query('UPDATE pg_temp.def_role SET role_def_read=0');
      // GetDefinition's source checks update permission only; detail's explicit read rejection is tested separately.
      assert.equal(parser.parse(await getDefinitionData(db, actor, 1)).conmas.top.readOnly, '1');
      await client.query(`UPDATE pg_temp.def_role SET role_def_update=1;
    INSERT INTO pg_temp.mst_common VALUES ('DEFINITION_SETTING','APPROVE_MODE','1',0);
    UPDATE pg_temp.def_top SET def_approve_status=2;`);
      top = parser.parse(await getDefinitionData(db, actor, 1)).conmas.top;
      assert.equal(top.locked, '2');
      assert.equal(top.readOnly, '1');
      assert.equal((await client.query('SELECT * FROM pg_temp.def_lock')).rowCount, 0);
    }),
);

test(
  'Designer versions, deleted custom masters and missing/corrupt binaries cannot fabricate successful receives',
  { skip: !process.env.DATABASE_URL },
  async () =>
    fixture(async (db, client) => {
      for (const version of ['7.2.2', '7.2', 'invalid']) {
        assert.deepEqual(parser.parse(await getDefinitionData(db, actor, 1, version)), {
          conmas: { error: { code: '19001', remarks: { remark: '7.2.30000' } } },
        });
      }
      assert.equal((await client.query('SELECT * FROM pg_temp.def_lock')).rowCount, 0);
      await client.query('INSERT INTO pg_temp.custom_table_delete VALUES (7)');
      const top = parser.parse(await getDefinitionData(db, actor, 1, '7.3.0')).conmas.top;
      assert.equal(top.sheets.sheet.clusters.cluster[1].userCustomMaster.masterKey, undefined);
      await unlockDefinition(db, actor, 1);
      await assert.rejects(getDefinitionData(db, actor, 99), /Definition not found/);
      await client.query('UPDATE pg_temp.def_top SET thumbnail_file=NULL');
      await assert.rejects(getDefinitionData(db, actor, 1), /image binary is unavailable/);
      await assert.rejects(getDefinitionData(db, actor, 1, '7.2.2'), /image binary is unavailable/);
      assert.equal((await client.query('SELECT * FROM pg_temp.def_lock')).rowCount, 0);
      await client.query('UPDATE pg_temp.def_top SET thumbnail_file=$1,xml_data=$2', [
        Buffer.alloc(0),
        definition.replace('<defSheetId>10</defSheetId>', '<defSheetId/>'),
      ]);
      await assert.rejects(getDefinitionData(db, actor, 1), /Invalid definition integer: defSheetId/);
      await client.query('UPDATE pg_temp.def_top SET xml_data=$1', [definition.replace('<locked>0</locked>', '')]);
      await assert.rejects(getDefinitionData(db, actor, 1), /Missing definition element: locked/);
      assert.equal((await client.query('SELECT * FROM pg_temp.def_lock')).rowCount, 0);
      await client.query('UPDATE pg_temp.def_top SET xml_data=$1', ['<!DOCTYPE conmas><conmas/>']);
      await assert.rejects(getDefinitionData(db, actor, 1), /Invalid definition XML/);
    }),
);

test(
  'Designer detail returns the source envelope, thumbnail, roles, approval clusters and remand comment',
  { skip: !process.env.DATABASE_URL },
  async () =>
    fixture(async (db, client) => {
      assert.deepEqual(parser.parse(await getDefinitionDetail(db, actor, 99)), { conmas: '' });
      await client.query(`INSERT INTO pg_temp.mst_common VALUES ('DEFINITION_SETTING','APPROVE_MODE','1',0);
    UPDATE pg_temp.def_top SET def_approve_status=3,def_approver_comment='try again';
    INSERT INTO pg_temp.def_lock (def_top_id,user_id,sys_regist_term) VALUES (1,'other','other-terminal');`);
      const detail = parser.parse(await getDefinitionDetail(db, actor, 1)).conmas.detailInfo;
      assert.equal(detail.topId, '1');
      assert.equal(detail.topName, 'Test definition');
      assert.equal(detail.thumbnail, Buffer.from('thumbnail bytes').toString('base64'));
      assert.equal(detail.thumbnail_file, undefined);
      assert.equal(detail.readOnly, '0');
      assert.equal(detail.locked, '1');
      assert.equal(detail.labels.label.name, 'Child');
      assert.equal(detail.clusters.cluster.length, 2);
      assert.equal(detail.approval.cluster.name, 'Approval');
      assert.equal(detail.remandComment, 'try again');
      assert.equal(detail.reportCopyType, '2');
      await client.query('UPDATE pg_temp.def_role SET role_def_update=0');
      assert.equal(parser.parse(await getDefinitionDetail(db, actor, 1)).conmas.detailInfo.readOnly, '1');
      await client.query('UPDATE pg_temp.def_role SET role_def_read=0');
      assert.deepEqual(parser.parse(await getDefinitionDetail(db, actor, 1)), {
        conmas: { error: { code: '3', remarks: '' } },
      });
    }),
);

test(
  'Designer receive uses the source culture-sensitive date strings and refuses unported date locales',
  { skip: !process.env.DATABASE_URL },
  async () =>
    fixture(async (db, client) => {
      await client.query("UPDATE pg_temp.def_top SET use_start_date=TIMESTAMP '2026-11-07 13:04:05'");
      assert.equal(parser.parse(await getDefinitionData(db, actor, 1)).conmas.top.useStartTime, '11/7/2026 1:04:05 PM');
      await unlockDefinition(db, actor, 1);
      assert.equal(
        parser.parse(await getDefinitionData(db, { ...actor, cultureName: 'ja-JP' }, 1)).conmas.top.useStartTime,
        '2026/11/07 13:04:05',
      );
      await unlockDefinition(db, actor, 1);
      await assert.rejects(
        getDefinitionData(db, { ...actor, cultureName: 'fr-FR' }, 1),
        /date culture is not implemented/,
      );
      assert.equal((await client.query('SELECT * FROM pg_temp.def_lock')).rowCount, 0);
    }),
);

const listItems = (text: string): Record<string, string>[] => {
  const items = parser.parse(text).conmas.items.item;
  return !items ? [] : Array.isArray(items) ? items : [items];
};
async function listFixture(client: pg.PoolClient): Promise<void> {
  await client.query(`UPDATE pg_temp.def_top SET report_type=2,deleted=0,mobile_save=0,sys_regist_time=TIMESTAMP '2026-11-07 01:00:00',sys_update_time=TIMESTAMP '2026-11-07 02:00:00';
    INSERT INTO pg_temp.def_top (def_top_id,def_top_org,def_top_name,public_status,report_type,deleted,mobile_save,sys_regist_time,sys_update_time)
      VALUES (2,2,'Unlabelled',2,1,0,0,TIMESTAMP '2026-11-07',TIMESTAMP '2026-11-07'),
        (3,3,'No membership',2,2,0,0,TIMESTAMP '2026-11-07',TIMESTAMP '2026-11-07'),
        (4,4,'Deleted group',2,2,0,0,TIMESTAMP '2026-11-07',TIMESTAMP '2026-11-07'),
        (5,1,'Older revision',1,2,0,0,TIMESTAMP '2026-11-06',TIMESTAMP '2026-11-06');
    INSERT INTO pg_temp.def_current VALUES (2,2),(3,3),(4,4);
    INSERT INTO pg_temp.def_role VALUES (2,4,0,0,1),(3,9,1,1,1),(4,6,1,1,1),(5,4,1,0,0);
    INSERT INTO pg_temp.mst_group_affiation VALUES ('designer-test',6);
    INSERT INTO pg_temp.mst_label_def (mst_label_id,label_name,label_icon_id,diplay_number,label_id_path) VALUES (9,'Alpha',1,2,'9');`);
}

test(
  'Designer library lists source labels/current definitions, filters group permissions, and supports history/name/ID searches',
  { skip: !process.env.DATABASE_URL },
  async () =>
    fixture(async (db, client) => {
      await listFixture(client);
      let items = listItems(
        await getDefinitionList(db, actor, { labelId: '-1', publicStatus: '-1', sortId: '2', sortType: 'desc' }),
      );
      assert.deepEqual(
        items.map((item) => item.itemId),
        ['8', '9', '2'],
      );
      assert.equal(items[2].designerVersion, clientConfiguration().designerVersion);
      assert.equal(items[2].designerDisplayVersion, clientConfiguration().designerDisplayVersion);
      assert.equal(items[0].designerVersion, undefined);
      assert.equal(items[0].labelTreeOrder, undefined);
      items = listItems(await getDefinitionList(db, actor, { labelId: '8', publicStatus: '1' }));
      assert.deepEqual(
        items.map((item) => item.itemId),
        ['1'],
      );
      items = listItems(
        await getDefinitionList(db, actor, { labelId: '-9', itemTargetLabel: 'false', publicStatus: '-1' }),
      );
      assert.deepEqual(items.map((item) => item.itemId).sort(), ['1', '2']);
      items = listItems(
        await getDefinitionList(db, actor, {
          labelId: '-1',
          publicStatus: '-1',
          topId: '1',
          sortId: '2',
          sortType: 'desc',
        }),
      );
      assert.deepEqual(
        items.map((item) => item.itemId),
        ['5'],
      );
      items = listItems(
        await getDefinitionList(db, actor, { labelId: '-9', itemTargetLabel: 'false', history: 'true' }),
      );
      assert.deepEqual(items.map((item) => item.itemId).sort(), ['1', '2', '5']);
      items = listItems(
        await getDefinitionList(db, actor, {
          labelId: '-9',
          itemTargetLabel: 'false',
          word: 'Ｔｅｓｔ　definition',
          wordTargetName: 'true',
        }),
      );
      assert.deepEqual(
        items.map((item) => item.itemId),
        ['1'],
      );
      items = listItems(
        await getDefinitionList(db, actor, {
          labelId: '-9',
          itemTargetLabel: 'false',
          word: '5',
          wordTargetId: 'true',
        }),
      );
      assert.deepEqual(
        items.map((item) => item.itemId),
        ['1'],
      );
      assert.deepEqual(
        listItems(
          await getDefinitionList(db, actor, {
            labelId: '-9',
            itemTargetLabel: 'false',
            word: "' OR 1=1 --",
            wordTargetName: 'true',
          }),
        ),
        [],
      );
      await client.query(
        "UPDATE pg_temp.def_top SET top_remarks1='first',top_remarks2='second',system_key1='key' WHERE def_top_id=1",
      );
      items = listItems(
        await getDefinitionList(db, actor, {
          labelId: '-9',
          itemTargetLabel: 'false',
          word: 'first second',
          wordTargetRemarks: 'true',
        }),
      );
      assert.deepEqual(
        items.map((item) => item.itemId),
        ['1'],
      );
      items = listItems(
        await getDefinitionList(db, actor, { labelId: '-9', itemTargetLabel: 'false', systemKey1: 'key' }),
      );
      assert.deepEqual(
        items.map((item) => item.itemId),
        ['1'],
      );
      assert.deepEqual(
        listItems(
          await getDefinitionList(db, actor, { labelId: '-9', itemTargetLabel: 'false', systemKey1: "' OR 1=1 --" }),
        ),
        [],
      );
      assert.deepEqual(listItems(await getDefinitionList(db, actor, { wordTargetValue: 'true' })), []);
      await assert.rejects(getDefinitionList(db, actor, { sortId: 'invalid' }), /Invalid definition list sort/);
      await assert.rejects(
        getDefinitionList(db, actor, {
          labelId: '-9',
          itemTargetLabel: 'false',
          word: '1',
          wordTargetId: 'true',
          wordTargetName: 'true',
        }),
      );
    }),
);

test(
  'Designer label hidden mode, label role restrictions, label sorting and approval filters retain source branches',
  { skip: !process.env.DATABASE_URL },
  async () =>
    fixture(async (db, client) => {
      await listFixture(client);
      await client.query("INSERT INTO pg_temp.mst_common VALUES ('LABEL_SETTING','MODE','1',0)");
      assert.deepEqual(
        listItems(await getDefinitionList(db, actor, {})).map((item) => item.itemId),
        ['8', '2'],
      );
      await client.query('INSERT INTO pg_temp.def_label_role VALUES (8,9)');
      assert.deepEqual(
        listItems(await getDefinitionList(db, actor, {})).map((item) => item.itemId),
        ['2'],
      );
      await client.query(
        "UPDATE pg_temp.mst_common SET com_value='0'; INSERT INTO pg_temp.mst_common VALUES ('LABEL_SETTING','SORT_TYPE','1',1)",
      );
      assert.deepEqual(
        listItems(await getDefinitionList(db, { ...actor, userId: 'conmasadmin' }, {})).map((item) => item.itemId),
        ['9', '8'],
      );
      let items = listItems(await getDefinitionList(db, actor, { sortId: '0', sortType: 'asc' }));
      assert.deepEqual(
        items.map((item) => item.itemId),
        ['9', '2'],
      );
      await client.query('DELETE FROM pg_temp.def_label_role');
      items = listItems(await getDefinitionList(db, actor, { sortId: '0', sortType: 'asc' }));
      assert.deepEqual(
        items.map((item) => item.itemId),
        ['9', '8', '2'],
      );
      await client.query(
        "UPDATE pg_temp.def_top SET def_approve_status=2,def_applicant='designer-test' WHERE def_top_id=1",
      );
      items = listItems(await getDefinitionList(db, actor, { labelId: '-9', publicStatus: '1', editStatus: '5' }));
      assert.deepEqual(
        items.map((item) => item.itemId),
        ['1'],
      );
      await client.query('UPDATE pg_temp.def_top SET def_approve_status=3 WHERE def_top_id=1');
      items = listItems(await getDefinitionList(db, actor, { labelId: '-9', publicStatus: '1', editStatus: '3' }));
      assert.deepEqual(
        items.map((item) => item.itemId),
        ['1'],
      );
    }),
);
