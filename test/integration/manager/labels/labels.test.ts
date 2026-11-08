import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Script } from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import ejs from 'ejs';
import pg from 'pg';
import { createApp } from '../../../helpers/app.js';
import { menus } from '../../../../src/config/manager.js';
import {
  autoLabelLocale,
  deleteLabel,
  flattenLabels,
  labelInput,
  labelMode,
  labelModes,
  labelPermissions,
  labelRows,
  labelTree,
  saveLabel,
  validateLabel,
  type LabelRecord,
} from '../../../../src/models/manager/labels/index.js';

const enabled = { skip: !process.env.DATABASE_URL };
const record = (name: string, parent: number | null = null): LabelRecord => ({
  mst_label_id: 0,
  upper_label_id: parent,
  label_name: name,
  label_name_path: '',
  label_id_path: '',
  label_icon_id: 1,
  diplay_number: 99,
  label_remarks: '',
  auto_delete: 0,
});

async function fixture(run: (db: pg.Pool, client: pg.PoolClient) => Promise<void>) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }),
    client = await pool.connect();
  const db = {
    query: client.query.bind(client),
    connect: async () => ({ query: client.query.bind(client), release() {} }),
  } as unknown as pg.Pool;
  try {
    for (const sequence of new Set(Object.values(labelModes).map((mode) => mode.sequence))) {
      await client.query(`CREATE TEMP SEQUENCE ${sequence} START 100`);
      assert.equal(
        (await client.query('SELECT $1::regclass::oid=$2::regclass::oid AS private', [sequence, 'pg_temp.' + sequence]))
          .rows[0].private,
        true,
      );
    }
    for (const { table, role } of Object.values(labelModes)) {
      await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL);
        CREATE TEMP TABLE ${role} (LIKE public.${role} INCLUDING ALL);
        ALTER TABLE pg_temp.${table} ADD FOREIGN KEY (upper_label_id) REFERENCES pg_temp.${table}(mst_label_id) ON DELETE CASCADE;
        ALTER TABLE pg_temp.${role} ADD FOREIGN KEY (mst_label_id) REFERENCES pg_temp.${table}(mst_label_id) ON DELETE CASCADE`);
    }
    for (const table of [
      'mst_group',
      'mst_group_affiation',
      'common_data_version',
      'mst_common',
      'rep_lock',
      'document_lock',
      'user_lock',
    ])
      await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    await client.query(`INSERT INTO pg_temp.mst_group (group_id,group_name,group_id_path,group_name_path,
      role_label_read_manager,role_label_create_manager,role_label_update_manager,role_label_delete_manager)
      VALUES (10,'A','10','A',1,1,1,1),(20,'B','20','B',0,0,0,0),(30,'C','30','C',0,0,0,0),(-999,'Excluded','-999','Excluded',0,0,0,0);
      INSERT INTO pg_temp.mst_group_affiation (user_id,group_id) VALUES ('conmasadmin',10),('fixture',10),('denied',20);
      INSERT INTO pg_temp.common_data_version (data_id,data_version) VALUES ('CustomMaster','before'),('CustomMasterlabel','before');
      INSERT INTO pg_temp.mst_common (com_key,com_name,com_index,com_value) VALUES
      ('LABEL_SETTING','PAGE_SIZE',0,'2'),('CONMAS_FUNCTION','LABEL_MANAGER_LIST_DISPLAY',0,'1'),('DEFAULT_PAGE_SIZE','DEFAULT',0,'1')`);
    await run(db, client);
  } finally {
    client.release();
    await pool.end();
  }
}

test('Manager menu default actions omit Index, preserving original nondefault actions and mode parameters', () => {
  assert.deepEqual(
    menus.map(([, route]) => route),
    [
      'DefReport',
      'InputReport',
      'DataOutput',
      'AutoGenerate',
      'Label',
      'Library?mode=ComLIb',
      'Schedule/CalendarView',
      'CustomMaster?mode=ComMas',
      'CustomMenu',
      'Binder',
      'System',
    ],
  );
});

test('label inputs retain MVC checkbox precedence, int32 validation and automatic-token conversion', () => {
  const input = labelInput(
    {
      'mst_label.label_name': 'A',
      'mst_label.IsAutoDelete': ['true', 'false'],
      'mst_label.IsAutoCreation': ['true', 'false'],
      'mst_label.auto_label_name': '{clusterValue_2_15}',
    },
    'Rep',
  );
  assert.equal(input.auto_delete, 1);
  assert.equal(input.auto_creation, 1);
  assert.equal(input.upper_label_id, null);
  assert.equal(labelMode('8'), 'ImageLib');
  assert.equal(labelMode('DefRep'), 'Rep');
  assert.throws(() => labelMode('bad'));
  assert.throws(() => labelMode('toString'));
  assert.throws(() => labelMode('constructor'));
  const localized =
    '{Name of form}/{Name of Document}/{Document remarks 10}/{Year of issue}/{Issuer ID}/{clusterDisplayValue_3_7}';
  const stored =
    '{report:defTopName}/{report:repTopName}/{report:remarksValue10}/{regist:yyyy}/{regist:User}/{clusterDisplayValue_3_7}';
  assert.equal(autoLabelLocale(localized), stored);
  assert.equal(autoLabelLocale(stored, true), localized);
  validateLabel(input, 'Rep');
  for (const rule of [
    '',
    ';',
    '/prefix',
    'suffix/',
    '{clusterValue_1}',
    '{clusterValue_2147483648_1}',
    '{clusterDisplayValue_1_no}',
  ]) {
    assert.throws(() => validateLabel({ ...input, auto_label_name: rule }, 'Rep'));
  }
  assert.throws(() => labelInput({ 'mst_label.diplay_number': '1.5' }, 'Def'));
});

test('all sixteen Labels permission combinations use refer as the union without a System or admin bypass', async () => {
  for (let bits = 0; bits < 16; bits++) {
    const row = Object.fromEntries(
      ['read', 'create', 'edit', 'delete'].map((action, index) => [action, String((bits >> index) & 1)]),
    );
    const db = { query: async () => ({ rows: [row] }) } as unknown as pg.Pool;
    const permissions = await labelPermissions(db, 'conmasadmin');
    assert.equal(permissions.refer, bits !== 0);
    for (const action of ['read', 'create', 'edit', 'delete'] as const)
      assert.equal(permissions[action], row[action] === '1');
  }
});

test(
  'all seven label modes persist create/edit/delete, roles, original audits and master versions in private tables',
  enabled,
  async () =>
    fixture(async (db, client) => {
      for (const mode of Object.keys(labelModes) as (keyof typeof labelModes)[]) {
        const item = record(mode),
          id = await saveLabel(db, mode, item, 'fixture', { roles: { '10': true, '20': false } });
        const { table, role } = labelModes[mode];
        assert.equal(
          (await client.query(`SELECT sys_regist_user FROM ${table} WHERE mst_label_id=$1`, [id])).rows[0]
            .sys_regist_user,
          'fixture',
        );
        await client.query(`UPDATE ${table} SET label_back_color='bg',label_fore_color='fg' WHERE mst_label_id=$1`, [
          id,
        ]);
        await saveLabel(db, mode, { ...item, label_name: 'Edited' }, 'another', { edit: true, noRoles: true });
        assert.deepEqual(
          (
            await client.query(
              `SELECT label_name,label_back_color,label_fore_color,sys_regist_user,sys_update_user FROM ${table} WHERE mst_label_id=$1`,
              [id],
            )
          ).rows[0],
          {
            label_name: 'Edited',
            label_back_color: 'bg',
            label_fore_color: 'fg',
            sys_regist_user: 'fixture',
            sys_update_user: 'another',
          },
        );
        assert.equal((await client.query(`SELECT 1 FROM ${role}`)).rowCount, 0);
        await deleteLabel(db, mode, id);
        assert.equal((await client.query(`SELECT 1 FROM ${table}`)).rowCount, 0);
      }
      assert(
        (await client.query('SELECT data_version FROM common_data_version')).rows.every((row) =>
          /^\d{14}_[\da-f-]{36}$/.test(row.data_version),
        ),
      );
    }),
);

test(
  'hierarchy quick insertion, descendant moves, cascade deletion and role rollback preserve unrelated labels',
  enabled,
  async () =>
    fixture(async (db, client) => {
      const root = record('Root'),
        other = record('Other');
      await saveLabel(db, 'Def', root, 'fixture');
      await saveLabel(db, 'Def', other, 'fixture');
      const child = record('Child');
      await saveLabel(db, 'Def', child, 'fixture', { quick: '1', base: root.mst_label_id });
      const sibling = record('Sibling');
      await saveLabel(db, 'Def', sibling, 'fixture', { quick: '0', base: child.mst_label_id });
      const first = record('First');
      await saveLabel(db, 'Def', first, 'fixture', { quick: '1', base: root.mst_label_id });
      assert.deepEqual(
        (
          await client.query(
            'SELECT label_name,diplay_number FROM mst_label_def WHERE upper_label_id=$1 ORDER BY diplay_number',
            [root.mst_label_id],
          )
        ).rows,
        [
          { label_name: 'First', diplay_number: 0 },
          { label_name: 'Child', diplay_number: 1 },
          { label_name: 'Sibling', diplay_number: 2 },
        ],
      );
      const grand = record('Grand/child', child.mst_label_id);
      await saveLabel(db, 'Def', grand, 'fixture');
      await assert.rejects(
        saveLabel(db, 'Def', { ...root, upper_label_id: grand.mst_label_id }, 'fixture', { edit: true }),
      );
      const moved = { ...child, label_name: 'Moved_百分%\u{1f4c1}', upper_label_id: other.mst_label_id };
      await saveLabel(db, 'Def', moved, 'fixture', { edit: true, roles: { '10': true } });
      assert.equal(
        (await client.query('SELECT label_name_path FROM mst_label_def WHERE mst_label_id=$1', [grand.mst_label_id]))
          .rows[0].label_name_path,
        'Other/Moved_百分%\u{1f4c1}/Grand/child',
      );
      await saveLabel(db, 'Def', { ...moved, label_name: 'Moved again' }, 'fixture', {
        edit: true,
        roles: { '10': true },
      });
      assert.equal(
        (await client.query('SELECT label_name_path FROM mst_label_def WHERE mst_label_id=$1', [grand.mst_label_id]))
          .rows[0].label_name_path,
        'Other/Moved again/Grand/child',
      );
      await assert.rejects(
        saveLabel(db, 'Def', { ...other, label_name: 'Rollback' }, 'fixture', {
          edit: true,
          roles: { '10': true, bad: true },
        }),
      );
      assert.equal(
        (await client.query('SELECT label_name FROM mst_label_def WHERE mst_label_id=$1', [other.mst_label_id])).rows[0]
          .label_name,
        'Other',
      );
      await deleteLabel(db, 'Def', other.mst_label_id);
      assert.deepEqual((await client.query('SELECT label_name FROM mst_label_def ORDER BY label_name')).rows, [
        { label_name: 'First' },
        { label_name: 'Root' },
        { label_name: 'Sibling' },
      ]);
      assert.equal((await client.query('SELECT 1 FROM def_label_role')).rowCount, 0);
    }),
);

test('definition copy creates only missing report ancestors and copies roles only to new labels', enabled, async () =>
  fixture(async (db, client) => {
    const root = record('Root');
    await saveLabel(db, 'Def', root, 'fixture', { roles: { '10': true }, copy: true });
    const child = record('Child', root.mst_label_id);
    await saveLabel(db, 'Def', child, 'fixture', { roles: { '20': true }, copy: true });
    const grand = record('Grand', child.mst_label_id);
    await saveLabel(db, 'Def', grand, 'fixture', { copy: true });
    assert.deepEqual(
      (await client.query('SELECT label_name_path FROM mst_label_rep ORDER BY label_id_path')).rows.map(
        (row) => row.label_name_path,
      ),
      ['Root', 'Root/Child', 'Root/Child/Grand'],
    );
    assert.deepEqual(
      (
        await client.query(
          'SELECT l.label_name,r.group_id FROM rep_label_role r JOIN mst_label_rep l USING(mst_label_id) ORDER BY l.label_name',
        )
      ).rows,
      [
        { label_name: 'Child', group_id: 20 },
        { label_name: 'Root', group_id: 10 },
      ],
    );
    assert.equal(
      (await client.query('SELECT last_value FROM pg_temp.mst_label_def_mst_label_id_seq')).rows[0].last_value,
      '105',
    );
  }),
);

test(
  'label permissions have no admin bypass, hide inaccessible ancestors, and separate automatic and binder labels',
  enabled,
  async () =>
    fixture(async (db, client) => {
      assert.equal((await labelPermissions(db, 'fixture')).refer, true);
      assert.equal((await labelPermissions(db, 'denied')).refer, false);
      await client.query("DELETE FROM mst_group_affiation WHERE user_id='conmasadmin'");
      assert.equal((await labelPermissions(db, 'conmasadmin')).refer, false);
      const root = record('Root');
      await saveLabel(db, 'Rep', root, 'fixture', { roles: { '20': true } });
      await saveLabel(db, 'Rep', record('Child', root.mst_label_id), 'fixture');
      const automatic = { ...record('Auto'), auto_creation: 1, auto_label_name: '{regist:yyyy}' };
      await saveLabel(db, 'Rep', automatic, 'fixture');
      assert.equal((await labelRows(db, 'Rep', 'fixture')).length, 0);
      assert.equal((await labelRows(db, 'Rep', 'conmasadmin')).length, 2);
      assert.equal((await labelRows(db, 'Rep', 'fixture', '', true)).length, 1);
      await client.query('UPDATE mst_label_rep SET binder_rep_id=42 WHERE mst_label_id=$1', [root.mst_label_id]);
      assert.equal((await labelRows(db, 'Rep', 'conmasadmin', '', false, true)).length, 0);
      await assert.rejects(saveLabel(db, 'Rep', { ...root, label_name: 'Renamed' }, 'fixture', { edit: true }));
      assert.deepEqual(
        flattenLabels(labelTree(await labelRows(db, 'Rep', 'conmasadmin', 'child'), false)).map(
          (row) => row.label_name,
        ),
        ['Child'],
      );
    }),
);

test('automatic report labels retain naming tokens, update-only fields and numeric false flags', enabled, async () =>
  fixture(async (db, client) => {
    const item = {
      ...record('Auto'),
      auto_creation: 1,
      auto_label_name: '{regist:yyyy}/{clusterValue_2_15}',
      auto_delete: 1,
      bottom_layer: 1,
      auto_slash_hierarchy: 1,
      report_update_type: 1,
    };
    await saveLabel(db, 'Rep', item, 'fixture');
    await saveLabel(
      db,
      'Rep',
      {
        ...item,
        auto_creation: 0,
        auto_delete: 0,
        bottom_layer: 0,
        auto_slash_hierarchy: 0,
        report_update_type: 0,
        system_key: 'key',
      },
      'fixture',
      { edit: true },
    );
    const stored = (await labelRows(db, 'Rep', 'fixture', '', true))[0];
    assert.equal(stored.auto_creation, 1);
    assert.equal(stored.auto_delete, 0);
    assert.equal(stored.bottom_layer, 0);
    assert.equal(stored.auto_slash_hierarchy, 0);
    assert.equal(stored.report_update_type, 0);
    assert.equal(stored.system_key, 'key');
    assert.equal(stored.auto_label_name, item.auto_label_name);
    assert.equal((await labelRows(db, 'Rep', 'fixture')).length, 0);
    assert.equal((await labelRows(db, 'Rep', 'fixture', '', true)).length, 1);
    await client.query(
      "INSERT INTO mst_common (com_key,com_name,com_index,com_value) VALUES ('LABEL_SETTING','SORT_TYPE',0,'1')",
    );
    assert.equal(
      flattenLabels(
        labelTree(
          [
            { ...record('Z'), mst_label_id: 1 },
            { ...record('A'), mst_label_id: 2 },
          ],
          true,
        ),
      )[0].label_name,
      'A',
    );
  }),
);

test(
  'master-version failures are best effort; installed label triggers keep private audit history',
  enabled,
  async () =>
    fixture(async (db, client) => {
      await client.query("ALTER TABLE pg_temp.common_data_version ADD CHECK (data_version='before')");
      const master = record('Master');
      await saveLabel(db, 'ComMas', master, 'fixture');
      assert.equal((await client.query('SELECT 1 FROM mst_label_common_custom_table')).rowCount, 1);
      for (const suffix of ['def', 'rep']) {
        await client.query(`CREATE TEMP TABLE log_mst_label_${suffix} (LIKE public.log_mst_label_${suffix} INCLUDING ALL);
      CREATE TEMP SEQUENCE log_mst_label_${suffix}_seq;
      CREATE TRIGGER fixture_label_audit AFTER INSERT OR UPDATE OR DELETE ON pg_temp.mst_label_${suffix}
        FOR EACH ROW EXECUTE FUNCTION public.func_mst_label_${suffix}_trigger()`);
      }
      await client.query(`CREATE TEMP TABLE mst_logsetting (table_name text,log_type text,log_mode integer,image_data integer,binary_data integer,other_data integer);
    INSERT INTO pg_temp.mst_logsetting SELECT t,o,1,0,0,0 FROM unnest(ARRAY['mst_label_def','mst_label_rep']) t CROSS JOIN unnest(ARRAY['INSERT','UPDATE','DELETE']) o`);
      const label = record('Audited');
      await saveLabel(db, 'Def', label, 'fixture', { copy: true });
      await saveLabel(db, 'Def', { ...label, label_name: 'Updated' }, 'fixture', { edit: true });
      await deleteLabel(db, 'Def', label.mst_label_id);
      assert.deepEqual(
        (await client.query('SELECT log_type FROM log_mst_label_def ORDER BY log_id')).rows.map((row) => row.log_type),
        ['I', 'U', 'D'],
      );
      assert.deepEqual(
        (await client.query('SELECT log_type FROM log_mst_label_rep ORDER BY log_id')).rows.map((row) => row.log_type),
        ['I'],
      );
    }),
);

test('FreeDrawOnly Label sidebar keeps common and image libraries and hides form/report/master branches', async () => {
  const html = await ejs.renderFile('src/views/manager/labels/index.ejs', {
    base: '/ConMasManager',
    csrfToken: 'fixture',
    view: 'index',
    mode: 'ComLIb',
    freeDrawOnly: true,
    source: {},
    error: '',
  });
  assert.match(html, /id="ComLIbLabelLink"/);
  assert.match(html, /id="ImageLibLabelLink"/);
  for (const mode of ['Def', 'Rep', 'RepLIb', 'ComMas', 'RepMas']) assert(!html.includes(`id="${mode}LabelLink"`));
});

test(
  'authenticated Labels flow renders legacy controls, tree paging, role drafts, validation and CSRF without public writes',
  { skip: !process.env.DATABASE_URL || !process.env.CONMAS_TEST_PASSWORD || !process.env.CONMAS_LEGACY_KEY },
  async () =>
    fixture(async (db, client) => {
      const server = createApp(db).listen(0, '127.0.0.1');
      try {
        await new Promise<void>((resolve) => server.once('listening', resolve));
        const address = server.address();
        assert(address && typeof address !== 'string');
        const root = `http://127.0.0.1:${address.port}/ConMasManager`;
        assert.equal((await fetch(root + '/Label', { redirect: 'manual' })).status, 302);
        const login = await fetch(root + '/Account/LogOn', {
          method: 'POST',
          body: new URLSearchParams({ UserName: 'conmasadmin', Password: process.env.CONMAS_TEST_PASSWORD! }),
          redirect: 'manual',
        });
        assert.equal(login.headers.get('location'), '/ConMasManager/');
        const cookie = login.headers.get('set-cookie')?.split(';')[0];
        assert(cookie);
        const headers = { cookie, 'X-Requested-With': 'XMLHttpRequest' };
        const page = await fetch(root + '/Label', { headers });
        assert.equal(page.status, 200);
        const html = await page.text();
        assert.match(html, /href="\/ConMasManager\/Label"/);
        assert.match(html, /href="\/ConMasManager\/System"/);
        assert.doesNotMatch(html, /preview\.css/);
        const csrf = html.match(/name="__RequestVerificationToken" value="([^"]+)"/)?.[1];
        assert(csrf);
        const post = (path: string, fields: Record<string, string>, token = csrf) =>
          fetch(root + path, {
            method: 'POST',
            headers,
            redirect: 'manual',
            body: new URLSearchParams({ __RequestVerificationToken: token, ...fields }),
          });
        const scripts = (text: string) => {
          for (const match of text.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) new Script(match[1]);
        };
        assert.equal((await fetch(root + '/Label/Index', { headers })).status, 200);
        for (const path of ['/System?mode=license', '/System/Index?mode=license']) {
          assert.equal(
            (await fetch(root + path, { headers, redirect: 'manual' })).headers.get('location'),
            '/ConMasManager/System/DetailsLicense',
          );
        }
        assert.equal(await (await fetch(root + '/Label/Create?mode=Def', { headers: { cookie } })).text(), '');
        for (const mode of Object.keys(labelModes)) {
          const list = await fetch(root + '/Label/IndexList?mode=' + mode, { headers });
          assert.equal(list.status, 200);
          const listBody = await list.text();
          scripts(listBody);
          assert.match(listBody, /LabelManagerListView\?reportMode=\w+&amp;LabelPageIndex=1/);
          assert.doesNotMatch(listBody, /name="(?:LabelPageIndex|SearchNameLabelView)"/);
          const form = await fetch(root + '/Label/Create?mode=' + mode, { headers });
          assert.equal(form.status, 200);
          const body = await form.text();
          scripts(body);
          assert.match(body, /id="LabelEditSection"/);
          assert.match(body, /id="GruopRoleTable"/);
        }
        const autoForm = await (await fetch(root + '/Label/Create?mode=Rep&act=autoCreate', { headers })).text();
        assert.match(autoForm, /id="mst_label_auto_label_name"/);
        scripts(autoForm);
        const autoSave = await post('/Label/Create', {
          mode: 'Rep',
          ActionCommonType: 'SaveType',
          IsRoleNone: 'true',
          'mst_label.label_name': 'Automatic',
          'mst_label.IsAutoCreation': 'true',
          'mst_label.auto_label_name': '{Year of issue}/{clusterValue_2_15}',
          'mst_label.label_icon_id': '1',
        });
        assert.match(await autoSave.text(), /value="success"/);
        assert.equal(
          (await client.query('SELECT auto_label_name FROM mst_label_rep')).rows[0].auto_label_name,
          '{regist:yyyy}/{clusterValue_2_15}',
        );
        const quick = await post('/Label/IndexList', {
          mode: 'ComLIb',
          LabelAct: 'LABEL_MANAGEMENT_ADD',
          LabelCreateMode: '1',
          LabelSelectID: '',
          'mst_label.label_name': 'Quick',
          'mst_label.label_icon_id': '1',
        });
        assert.equal(quick.status, 302);
        const quickId = (await client.query('SELECT mst_label_id FROM mst_label_common_document')).rows[0].mst_label_id;
        assert.equal((await post(`/Label/Delete?mode=ComLIb&id=${quickId}`, {})).status, 302);
        assert.equal((await client.query('SELECT 1 FROM mst_label_common_document')).rowCount, 0);
        for (const [table, key] of [
          ['rep_lock', 'rep_top_id'],
          ['document_lock', 'document_id'],
        ]) {
          await client.query(
            `INSERT INTO pg_temp.${table} (${key},user_id,sys_regist_user,sys_regist_term) VALUES
          (1,'conmasadmin','conmasadmin',$1),(2,'other','conmasadmin',$1),
          (3,'conmasadmin','other',$1),(4,'conmasadmin','conmasadmin','other-host')`,
            [hostname()],
          );
        }
        assert.equal((await post('/Label/unLockTable', {})).status, 200);
        for (const [table, key] of [
          ['rep_lock', 'rep_top_id'],
          ['document_lock', 'document_id'],
        ]) {
          assert.deepEqual((await client.query(`SELECT ${key} AS id FROM pg_temp.${table} ORDER BY ${key}`)).rows, [
            { id: 2 },
            { id: 3 },
            { id: 4 },
          ]);
        }
        await fetch(root + '/Label/Create?mode=Def', { headers });
        const fields = {
          mode: 'Def',
          ActionCommonType: 'PageType',
          IsRoleNone: 'false',
          'mst_label.label_name': 'Created <&',
          'mst_label.diplay_number': '4',
          'mst_label.label_icon_id': '2',
          'PageData.PageSize': '1',
          'PageData.PageIndex': '1',
          'mst_label.GroupRolePages[0].group_id': '10',
          'mst_label.GroupRolePages[0].IsReferRole': 'false',
        };
        const paged = await post('/Label/Create', fields);
        assert.equal(paged.status, 200);
        assert.match(await paged.text(), /value="20"/);
        const saved = await post('/Label/Create', {
          ...fields,
          ActionCommonType: 'SaveType',
          'mst_label.GroupRolePages[0].group_id': '20',
          'mst_label.GroupRolePages[0].IsReferRole': 'true',
        });
        assert.equal(saved.status, 200);
        assert.match(await saved.text(), /id="result"[^>]*value="success"/);
        const item = (await client.query('SELECT * FROM mst_label_def')).rows[0];
        assert.deepEqual((await client.query('SELECT group_id FROM def_label_role ORDER BY group_id')).rows, [
          { group_id: 20 },
          { group_id: 30 },
        ]);
        const edit = await fetch(root + `/Label/Edit?mode=Def&id=${item.mst_label_id}`, { headers });
        assert.equal(edit.status, 200);
        scripts(await edit.text());
        assert.equal(
          (
            await post(
              '/Label/Edit',
              { ...fields, ActionCommonType: 'SaveType', 'mst_label.mst_label_id': String(item.mst_label_id) },
              'bad',
            )
          ).status,
          403,
        );
        const invalid = await post('/Label/Edit', {
          ...fields,
          ActionCommonType: 'SaveType',
          'mst_label.mst_label_id': String(item.mst_label_id),
          'mst_label.diplay_number': '-1',
        });
        assert.match(await invalid.text(), /Display sequence is invalid/);
        const edited = await post('/Label/Edit', {
          ...fields,
          ActionCommonType: 'SaveType',
          'mst_label.mst_label_id': String(item.mst_label_id),
          'mst_label.label_name': 'Edited',
        });
        assert.match(edited.headers.get('location') ?? '', /Label\/Edit\?mode=Def&id=-1/);
        const empty = await (await fetch(root + '/Label/Edit?mode=Def&id=-1', { headers })).text();
        scripts(empty);
        assert.match(empty, /▼Label Edit/);
        for (let index = 0; index < 4; index++)
          await saveLabel(db, 'Def', record('Tree' + index, index ? item.mst_label_id : null), 'fixture');
        const tree = await post('/Common/LabelManagerListView?reportMode=Def', { LabelPageIndex: '2', isLink: 'true' });
        assert.equal(tree.status, 200);
        const treeBody = await tree.text();
        scripts(treeBody);
        assert.match(treeBody, /id="LabelMaster"/);
        assert.match(treeBody, /LabelPageIndex"[^>]*value="2"/);
        const select = await post('/Common/LabelSelectListView?reportMode=Def&InputType=button', {
          conmasSelectLabelId: String(item.mst_label_id),
        });
        const selectBody = await select.text();
        scripts(selectBody);
        assert.doesNotMatch(selectBody, /Edited/);
        const deleted = await post('/Label/Edit', {
          ...fields,
          act: 'DELETE_LABEL',
          'mst_label.mst_label_id': String(item.mst_label_id),
        });
        assert.equal(deleted.status, 302);
        assert.equal(
          (
            await client.query('SELECT 1 FROM mst_label_def WHERE mst_label_id=$1 OR upper_label_id=$1', [
              item.mst_label_id,
            ])
          ).rowCount,
          0,
        );
        await client.query(
          'UPDATE mst_group SET role_label_create_manager=0,role_label_update_manager=0,role_label_delete_manager=0 WHERE group_id=10',
        );
        assert.equal((await post('/Label/Create', { ...fields, ActionCommonType: 'SaveType' })).status, 403);
        assert.equal((await fetch(root + '/Label/Create?mode=Def', { headers })).status, 403);
        await client.query('UPDATE mst_group SET role_label_read_manager=0 WHERE group_id=10');
        assert.equal((await fetch(root + '/Label', { headers })).status, 403);
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }
    }),
);

test('Labels reuse original CSS and script bytes', async () => {
  for (const path of [
    'Content/ConMas/styles.css',
    'Content/ConMas/grid.css',
    'Content/ConMas/jquery.treeview.css',
    'Scripts/jquery.treeview.js',
    'Scripts/jquery.leanModal.min.js',
    'Scripts/jquery.unobtrusive-ajax.min.js',
    'Scripts/jquery.selection.js',
    'Scripts/conmas.paging.action.js',
  ]) {
    const hash = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');
    assert.equal(
      hash(await readFile('public/' + path)),
      hash(await readFile('/mnt/c/Users/DELL/CONMASSERVER/ConMasManager/' + path)),
      path,
    );
  }
});

test('Labels inventory maps every source action and dialog to registered handlers without starting an app or querying a database', async () => {
  const inventory = JSON.parse(await readFile('docs/label-route-coverage.json', 'utf8'));
  const hash = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');
  for (const [path, expected] of Object.entries(inventory.sourceHashes))
    assert.equal(hash(await readFile(inventory.sourceRoot + '/' + path)), expected, path);
  for (const [path, expected] of Object.entries(inventory.viewHashes))
    assert.equal(hash(await readFile(inventory.installedRoot + '/' + path)), expected, path);
  const source = await readFile(inventory.sourceRoot + '/Controllers/LabelController.cs', 'utf8');
  const candidates = [...source.matchAll(/public (?:ActionResult|void(?= unLockTable)) (\w+)\(/g)].map(
    (match) => match[1],
  );
  assert.equal(candidates.length, 10);
  const labels = inventory.actions.filter((action: { controller: string }) => action.controller === 'Label');
  assert.deepEqual(labels.map((action: { action: string }) => action.action).sort(), candidates.sort());
  assert.equal(inventory.actions.length, 12);
  const fail = () => {
    throw Error('Registration audit must not query or connect');
  };
  const app = createApp({ query: fail, connect: fail } as unknown as pg.Pool);
  const routes = app.router.stack.flatMap((layer) => {
    const route = layer.route as (NonNullable<typeof layer.route> & { methods: Record<string, boolean> }) | undefined;
    return route ? [route.path].flat().map((path) => ({ path, methods: route.methods })) : [];
  });
  for (const action of inventory.actions)
    for (const method of [action.method, ...(action.additionalMethods ?? [])]) {
      assert(
        routes.some(
          (route: { path: string; methods: Record<string, boolean> }) =>
            route.path === `/ConMasManager/${action.controller}/${action.action}` &&
            route.methods[method.toLowerCase()],
        ),
        `${method} ${action.controller}/${action.action}`,
      );
    }
  for (const path of [
    '/ConMasManager/System',
    '/ConMasManager/System/Index',
    inventory.canonicalEntry,
    inventory.compatibilityEntry,
  ])
    assert(routes.some((route: { path: string }) => route.path === path));
});
