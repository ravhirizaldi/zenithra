import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { createReportAutoLabels, updateReportAutoLabels } from '../../../src/models/client-report-labels.js';
import { children, must, replace, root, type XmlNode } from '../../../src/models/client-definition-xml.js';

const actor = { userId: 'label/editor', userName: 'Label/Editor', terminalId: 'fixture-host' };
const now = new Date(2026, 10, 8, 9, 10, 11);
const top = () =>
  root(`<top><repTopId>1</repTopId><defTopId>100</defTopId><defTopName>Form/name</defTopName><repTopName>Old</repTopName>
  <remarksValue1>North/West</remarksValue1><registTime>2025/02/03 04:05:06</registTime><sheets><sheet><sheetNo>3</sheetNo><clusters>
  <cluster><clusterId>0</clusterId><type>KeyboardText</type><value>raw/path</value><displayValue>display/path</displayValue></cluster>
  <cluster><clusterId>1</clusterId><type>Image</type><value>binary-secret</value></cluster></clusters></sheet></sheets></top>`);

test(
  'automatic report labels preserve source hierarchy, update gates, audit/roles and transactional cleanup',
  { skip: !process.env.DATABASE_URL },
  async (t) => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }),
      db = await pool.connect();
    try {
      for (const table of ['mst_label_rep', 'def_rep_label', 'rep_label_role', 'rep_label', 'rep_top', 'mst_common'])
        await db.query(`CREATE TEMP TABLE ${table}(LIKE public.${table} INCLUDING ALL)`);
      await db.query(`SET search_path TO pg_temp;
      CREATE TEMP SEQUENCE mst_label_def_mst_label_id_seq START 1000;
      ALTER TABLE rep_label_role ADD FOREIGN KEY(mst_label_id) REFERENCES mst_label_rep(mst_label_id) ON DELETE CASCADE;
      ALTER TABLE rep_label ADD FOREIGN KEY(mst_label_id) REFERENCES mst_label_rep(mst_label_id) ON DELETE CASCADE;
      INSERT INTO rep_top(rep_top_id,deleted) VALUES(1,0),(2,0),(3,1);`);
      const template = async (rule: string, settings = { slash: 0, bottom: 0, update: 1, remove: 1 }) => {
        await db.query(
          `INSERT INTO mst_label_rep(mst_label_id,label_name,label_id_path,label_name_path,auto_creation,auto_label_name,
        report_update_type,auto_slash_hierarchy,bottom_layer,auto_delete,label_icon_id,diplay_number,label_remarks)
        VALUES(101,'Template','101','Template',1,$1,$2,$3,$4,$5,7,9,'Fixture remarks')`,
          [rule, settings.update, settings.slash, settings.bottom, settings.remove],
        );
        await db.query(
          'INSERT INTO def_rep_label(def_top_id,mst_label_id) VALUES(100,101); INSERT INTO rep_label_role(mst_label_id,group_id) VALUES(101,20)',
        );
      };
      const paths = async (id = 1) =>
        (
          await db.query(
            `SELECT m.label_name_path FROM mst_label_rep m JOIN rep_label l USING(mst_label_id) WHERE l.rep_top_id=$1 ORDER BY m.label_name_path`,
            [id],
          )
        ).rows.map((row) => row.label_name_path);
      const transaction = async (run: () => Promise<void>) => {
        await db.query('BEGIN');
        try {
          await run();
          await db.query('COMMIT');
        } catch (error) {
          await db.query('ROLLBACK');
          throw error;
        }
      };
      const create = (data: XmlNode) => transaction(() => createReportAutoLabels(db, data, actor, now));
      const update = (previous: XmlNode, data: XmlNode, moveOnly = false) =>
        transaction(() => updateReportAutoLabels(db, previous, data, actor, now, moveOnly));
      const clean = async () => {
        await db.query(
          'DELETE FROM rep_label; DELETE FROM rep_label_role; DELETE FROM def_rep_label; DELETE FROM mst_label_rep; DELETE FROM mst_common',
        );
      };

      await t.test('unattached templates do nothing and cannot consume the private sequence', async () => {
        await template('{report:repTopName}');
        await db.query('DELETE FROM def_rep_label');
        await create(top());
        assert.deepEqual(await paths(), []);
        assert.equal(
          (await db.query('SELECT is_called FROM pg_temp.mst_label_def_mst_label_id_seq')).rows[0].is_called,
          false,
        );
        await clean();
      });
      await t.test(
        'substitution, escaped slashes, parent paths and copied roles use the source actor/registration date',
        async () => {
          await template(
            '{report:defTopName}/{regist:yyyy}{regist:MM}{regist:dd}{regist:HH}{regist:mm}{regist:ss}/{regist:User}/{regist:UserName}/{report:remarksValue1}',
            { slash: 1, bottom: 0, update: 1, remove: 1 },
          );
          await db.query(
            "INSERT INTO mst_label_rep(mst_label_id,label_name,label_id_path,label_name_path,auto_creation) VALUES(99,'Parent','99','Parent',0); UPDATE mst_label_rep SET upper_label_id=99 WHERE mst_label_id=101",
          );
          await create(top());
          const rows = (await db.query('SELECT * FROM mst_label_rep WHERE mst_label_id>=1000 ORDER BY mst_label_id'))
            .rows;
          assert.deepEqual(
            rows.map((row) => row.label_name),
            ['Form/name', '20250203040506', actor.userId, actor.userName, 'North/West'],
          );
          assert.equal(rows[0].label_name_path, 'Parent/Form/name');
          assert.equal(Number(rows[0].upper_label_id), 99);
          assert.equal(rows[0].label_icon_id, 7);
          assert.equal(rows[0].label_remarks, 'Fixture remarks');
          for (const row of rows) {
            assert.equal(row.sys_regist_user, actor.userId);
            assert.equal(row.sys_regist_term, actor.terminalId);
            assert.equal(row.sys_regist_time.getTime(), now.getTime());
            assert.equal(
              (await db.query('SELECT group_id FROM rep_label_role WHERE mst_label_id=$1', [row.mst_label_id])).rows[0]
                .group_id,
              20,
            );
          }
          const before = await db.query('SELECT * FROM rep_label ORDER BY mst_label_id');
          await create(top());
          assert.deepEqual((await db.query('SELECT * FROM rep_label ORDER BY mst_label_id')).rows, before.rows);
          await clean();
        },
      );
      await t.test(
        'cluster zero uses actual sparse sheetNo, distinguishes raw/display and excludes binary/status types',
        async () => {
          await template('{clusterValue_3_0}/{clusterDisplayValue_3_0}/{clusterValue_3_1}/ignored');
          await create(top());
          assert.deepEqual(await paths(), ['raw', 'raw/path', 'raw/path/display', 'raw/path/display/path']);
          assert.equal(
            (await db.query("SELECT 1 FROM mst_label_rep WHERE label_name IN ('binary-secret','ignored')")).rowCount,
            0,
          );
          await clean();
        },
      );
      await t.test('bottom-only linking retains empty/trailing-part quirks and missing-cluster stops', async () => {
        await template('First/Second/', { slash: 0, bottom: 1, update: 1, remove: 1 });
        await create(top());
        assert.deepEqual(await paths(), []);
        assert.equal((await db.query('SELECT 1 FROM mst_label_rep WHERE auto_creation=0')).rowCount, 2);
        await db.query("UPDATE mst_label_rep SET auto_label_name='First/Second' WHERE mst_label_id=101");
        await create(top());
        assert.deepEqual(await paths(), ['First/Second']);
        await db.query(
          "UPDATE mst_label_rep SET auto_label_name='Missing/{clusterValue_1_0}/Never' WHERE mst_label_id=101",
        );
        await create(top());
        assert.deepEqual(await paths(), ['First/Second']);
        await clean();
      });
      await t.test(
        'changed name/remarks remove old links and empty paths, keep shared/manual/template data and untouched audits',
        async () => {
          await template('Area/{report:repTopName}');
          await create(top());
          const area = (await db.query("SELECT * FROM mst_label_rep WHERE label_name_path='Area'")).rows[0];
          await db.query(
            "INSERT INTO mst_label_rep(mst_label_id,label_name,label_id_path,label_name_path,auto_creation) VALUES(98,'Manual','98','Manual',0)",
          );
          await db.query('INSERT INTO rep_label(rep_top_id,mst_label_id) VALUES(1,98),(2,$1)', [area.mst_label_id]);
          const previous = top(),
            next = top();
          replace(next, 'repTopName', 'New');
          await update(previous, next);
          assert.deepEqual(await paths(), ['Area', 'Area/New', 'Manual']);
          assert.deepEqual(await paths(2), ['Area']);
          assert.equal((await db.query("SELECT 1 FROM mst_label_rep WHERE label_name_path='Area/Old'")).rowCount, 0);
          assert.equal((await db.query('SELECT 1 FROM rep_label_role WHERE mst_label_id=101')).rowCount, 1);
          assert.equal(
            (
              await db.query('SELECT sys_regist_time FROM mst_label_rep WHERE mst_label_id=$1', [area.mst_label_id])
            ).rows[0].sys_regist_time.getTime(),
            area.sys_regist_time.getTime(),
          );
          const saved = (await db.query('SELECT * FROM rep_label ORDER BY rep_top_id,mst_label_id')).rows;
          await update(next, next);
          assert.deepEqual((await db.query('SELECT * FROM rep_label ORDER BY rep_top_id,mst_label_id')).rows, saved);
          await clean();
        },
      );
      await t.test(
        'update type zero keeps links; cleanup mode zero keeps old labels but moves report links',
        async () => {
          await template('{report:repTopName}', { slash: 0, bottom: 0, update: 0, remove: 1 });
          await create(top());
          const next = top();
          replace(next, 'repTopName', 'New');
          await update(top(), next);
          assert.deepEqual(await paths(), ['Old']);
          await db.query(
            "UPDATE mst_label_rep SET report_update_type=1 WHERE mst_label_id=101; INSERT INTO mst_common(com_id,com_key,com_name,com_value) VALUES(1,'LABEL_SETTING','LABEL_AUTO_DELETE_MODE','0')",
          );
          await update(top(), next);
          assert.deepEqual(await paths(), ['New']);
          assert.equal((await db.query("SELECT 1 FROM mst_label_rep WHERE label_name='Old'")).rowCount, 1);
          await clean();
        },
      );
      await t.test(
        'native move-only cleanup retains labels linked to deleted revisions; Manager cleanup does not',
        async () => {
          await template('{report:repTopName}');
          await create(top());
          await db.query(
            "INSERT INTO rep_label(rep_top_id,mst_label_id) SELECT 3,mst_label_id FROM mst_label_rep WHERE label_name='Old'",
          );
          const next = top();
          replace(next, 'repTopName', 'New');
          await update(top(), next, true);
          assert.deepEqual(await paths(3), ['Old']);
          await create(top());
          await update(top(), next);
          assert.deepEqual(await paths(3), []);
          await clean();
        },
      );
      await t.test(
        'cluster changes regenerate other update templates, while unreferenced changes leave links/audits alone',
        async () => {
          await template('Name/{report:repTopName}');
          await db.query(
            "INSERT INTO mst_label_rep(mst_label_id,label_name,label_id_path,label_name_path,auto_creation,auto_label_name,report_update_type) VALUES(102,'Cluster template','102','Cluster template',1,'Cluster/{clusterValue_3_0}',1); INSERT INTO def_rep_label(def_top_id,mst_label_id) VALUES(100,102)",
          );
          await create(top());
          const unrelated = top(),
            before = (await db.query('SELECT * FROM rep_label ORDER BY mst_label_id')).rows;
          replace(unrelated, 'remarksValue10', 'unreferenced');
          await update(top(), unrelated);
          assert.deepEqual((await db.query('SELECT * FROM rep_label ORDER BY mst_label_id')).rows, before);
          const changed = top();
          const cluster = children(must(children(must(changed, 'sheets'), 'sheet')[0], 'clusters'), 'cluster')[0];
          replace(cluster, 'value', 'changed');
          await update(top(), changed);
          assert((await paths()).includes('Cluster/changed'));
          assert((await paths()).includes('Name/Old'));
          await clean();
        },
      );
      await t.test(
        'missing registration date falls back to save time and failures restore labels/roles/links together',
        async () => {
          await template('{regist:yyyy}{regist:MM}{regist:dd}/{report:repTopName}');
          const data = top();
          replace(data, 'registTime', 'invalid');
          await create(data);
          assert.deepEqual(await paths(), ['20261108', '20261108/Old']);
          const before = (await db.query('SELECT * FROM rep_label ORDER BY mst_label_id')).rows;
          const next = top();
          replace(next, 'registTime', 'invalid');
          replace(next, 'repTopName', 'New');
          await assert.rejects(
            transaction(async () => {
              await updateReportAutoLabels(db, data, next, actor, now);
              throw new Error('Fixture subsequent failure.');
            }),
            /Fixture subsequent/,
          );
          assert.deepEqual((await db.query('SELECT * FROM rep_label ORDER BY mst_label_id')).rows, before);
          assert.equal((await db.query("SELECT 1 FROM mst_label_rep WHERE label_name='New'")).rowCount, 0);
          await clean();
        },
      );
    } finally {
      db.release();
      await pool.end();
    }
  },
);
