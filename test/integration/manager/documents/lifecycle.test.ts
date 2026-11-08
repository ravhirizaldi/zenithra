import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import express from 'express';
import session from 'express-session';
import type { Server } from 'node:http';
import { documentDelete } from '../../../../src/models/manager/documents/lifecycle.js';
import { registerDocumentController } from '../../../../src/controllers/manager/documents/index.js';
import { legacyPassword } from '../../../../src/shared/legacy-auth.js';

test(
  'Documents deletion, revision recovery, automatic labels and permanent-delete rollback use private tables only',
  { skip: !process.env.DATABASE_URL },
  async () => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const client = await pool.connect();
    let server: Server | undefined;
    const db = {
      query: client.query.bind(client),
      connect: async () => ({ query: client.query.bind(client), release() {} }),
    } as unknown as pg.Pool;
    try {
      for (const table of [
        'rep_top',
        'rep_current',
        'rep_role',
        'rep_lock',
        'rep_label',
        'mst_label_rep',
        'mst_user',
        'mst_group',
        'mst_group_affiation',
        'mst_common',
        'mst_task',
        'rep_sheet',
        'rep_cluster',
        'rep_cluster_role',
        'rep_top_option',
      ])
        await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
      await client.query(`ALTER TABLE pg_temp.rep_current ADD FOREIGN KEY (rep_top_id) REFERENCES pg_temp.rep_top(rep_top_id) ON DELETE CASCADE;
        ALTER TABLE pg_temp.rep_role ADD FOREIGN KEY (rep_top_id) REFERENCES pg_temp.rep_top(rep_top_id) ON DELETE CASCADE;
        ALTER TABLE pg_temp.rep_lock ADD FOREIGN KEY (rep_top_id) REFERENCES pg_temp.rep_top(rep_top_id) ON DELETE RESTRICT;
        ALTER TABLE pg_temp.rep_label ADD FOREIGN KEY (rep_top_id) REFERENCES pg_temp.rep_top(rep_top_id) ON DELETE CASCADE;
        ALTER TABLE pg_temp.rep_label ADD FOREIGN KEY (mst_label_id) REFERENCES pg_temp.mst_label_rep(mst_label_id) ON DELETE CASCADE;
        ALTER TABLE pg_temp.mst_label_rep ADD FOREIGN KEY (upper_label_id) REFERENCES pg_temp.mst_label_rep(mst_label_id) ON DELETE CASCADE;
        ALTER TABLE pg_temp.rep_sheet ADD FOREIGN KEY (rep_top_id) REFERENCES pg_temp.rep_top(rep_top_id) ON DELETE CASCADE;
        ALTER TABLE pg_temp.rep_top_option ADD FOREIGN KEY (rep_top_id) REFERENCES pg_temp.rep_top(rep_top_id) ON DELETE CASCADE`);
      await client.query(
        "INSERT INTO pg_temp.mst_user (user_id,user_name) VALUES ('fixture','Fixture user'); INSERT INTO pg_temp.mst_group_affiation (group_id,user_id) VALUES (10,'fixture'); INSERT INTO pg_temp.mst_group (group_id,role_rep_read_manager,role_rep_update_manager,role_rep_delete_manager) VALUES (10,1,1,1)",
      );
      await client.query(
        `INSERT INTO pg_temp.rep_top (rep_top_id,rep_top_org,rev_no,rep_top_name,deleted,public_status,report_type,edit_refer_status,xml_data,def_file,sys_regist_user,sys_regist_time)
        VALUES (101,101,1,'First',0,2,1,0,$1,$2,'original',TIMESTAMP '2026-01-01'),
        (102,101,2,'Second',0,2,1,0,$1,$2,'original',TIMESTAMP '2026-01-01'),
        (103,101,3,'Trash',1,2,1,0,$1,$2,'original',TIMESTAMP '2026-01-01'),
        (201,201,1,'Unrelated',0,2,1,0,$1,$2,'original',TIMESTAMP '2026-01-01'),
        (301,301,1,'Other trash',1,2,1,0,$1,$2,'original',TIMESTAMP '2026-01-01')`,
        ['<conmas><top/></conmas>', Buffer.from('fixture binary')],
      );
      await client.query(
        'INSERT INTO pg_temp.rep_role (rep_top_id,group_id,role_rep_read,role_rep_delete) SELECT rep_top_id,10,1,1 FROM pg_temp.rep_top; INSERT INTO pg_temp.rep_current (rep_top_org,rep_top_id) VALUES (101,102),(201,201),(301,301)',
      );
      await client.query(
        "INSERT INTO pg_temp.mst_label_rep (mst_label_id,upper_label_id,label_name,label_name_path,auto_delete,auto_creation) VALUES (1,NULL,'Parent','Parent',1,0),(2,1,'Leaf','Parent/Leaf',1,0),(3,NULL,'Automatic','Automatic',1,1),(4,NULL,'Manual','Manual',0,0),(5,NULL,'Shared','Shared',1,0); INSERT INTO pg_temp.rep_label (rep_top_id,mst_label_id) VALUES (102,2),(102,3),(102,4),(102,5),(201,5)",
      );
      const top = async (id: number) =>
        (await client.query('SELECT * FROM pg_temp.rep_top WHERE rep_top_id=$1', [id])).rows[0];
      const current = async (org: number) =>
        (await client.query('SELECT rep_top_id FROM pg_temp.rep_current WHERE rep_top_org=$1', [org])).rows[0]
          ?.rep_top_id;
      const unrelated = await top(201),
        original = await top(102);
      await documentDelete(db, '102', 'DELETE_REPORT', 'REV', 'fixture');
      const deleted = await top(102);
      assert.equal(Number(deleted.deleted), 1);
      assert.equal(deleted.sys_update_user, 'fixture');
      assert.equal(deleted.sys_update_user_name, 'Fixture user');
      for (const field of ['xml_data', 'def_file', 'sys_regist_user', 'sys_regist_time'])
        assert.deepEqual(deleted[field], original[field]);
      assert.equal(await current(101), 101);
      assert.deepEqual(
        (await client.query('SELECT mst_label_id FROM pg_temp.mst_label_rep ORDER BY mst_label_id')).rows.map(
          (row) => row.mst_label_id,
        ),
        [3, 4, 5],
      );
      await documentDelete(db, '102', 'DELETE_RETURN_REPORT', '', 'fixture');
      assert.equal(Number((await top(102)).deleted), 0);
      assert.equal(await current(101), 102);
      for (const input of ['', '0', '101,999', '101); DROP TABLE rep_top'])
        await assert.rejects(documentDelete(db, input, 'DELETE_REPORT', 'REV', 'fixture'));
      await assert.rejects(documentDelete(db, '101', 'DELETE_REPORT', 'invalid', 'fixture'));
      await assert.rejects(documentDelete(db, '101', 'DELETE_RETURN_REPORT', '', 'fixture'));
      await client.query('UPDATE pg_temp.rep_role SET role_rep_delete=0 WHERE rep_top_id=101');
      await assert.rejects(documentDelete(db, '102', 'DELETE_REPORT', 'ALL', 'fixture'));
      await client.query('UPDATE pg_temp.rep_role SET role_rep_delete=1 WHERE rep_top_id=101');
      await client.query("INSERT INTO pg_temp.rep_lock (rep_top_id,user_id) VALUES (103,'other')");
      await assert.rejects(documentDelete(db, '102', 'DELETE_REPORT', 'ALL', 'fixture'));
      assert.equal(Number((await top(102)).deleted), 0);
      await client.query(
        "DELETE FROM pg_temp.rep_lock WHERE rep_top_id=103; INSERT INTO pg_temp.rep_lock (rep_top_id,user_id) VALUES (102,'fixture')",
      );
      await client.query(
        "INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (1,'LABEL_SETTING','LABEL_AUTO_DELETE_MODE','0')",
      );
      await documentDelete(db, '102', 'DELETE_REPORT', 'ALL', 'fixture');
      assert.equal(
        (await client.query('SELECT count(*) FROM pg_temp.rep_top WHERE rep_top_org=101 AND deleted=1')).rows[0].count,
        '3',
      );
      assert.equal((await client.query('SELECT count(*) FROM pg_temp.rep_lock')).rows[0].count, '0');
      assert.equal(await current(101), 102);
      await documentDelete(db, '101', 'DELETE_RETURN_REPORT', '', 'fixture');
      assert.equal(await current(101), 101);
      await documentDelete(db, '102', 'DELETE_RETURN_REPORT', '', 'fixture');
      assert.equal(await current(101), 102);
      await client.query(
        'CREATE TEMP TABLE document_delete_block (rep_top_id int REFERENCES pg_temp.rep_top(rep_top_id)); INSERT INTO pg_temp.document_delete_block VALUES (103); INSERT INTO pg_temp.rep_sheet (rep_sheet_id,rep_top_id) VALUES (103,103),(301,301); INSERT INTO pg_temp.rep_top_option (rep_top_id) VALUES (103),(301)',
      );
      const protectedTrash = await top(103);
      assert.deepEqual(await documentDelete(db, '103,301', 'DELETE_PHYSICAL', '', 'fixture'), ['103:Trash']);
      assert.deepEqual(await top(103), protectedTrash);
      assert.equal(await top(301), undefined);
      assert.equal(await current(301), undefined);
      assert.deepEqual(
        (await client.query('SELECT rep_top_id FROM pg_temp.rep_sheet ORDER BY rep_top_id')).rows.map(
          (row) => row.rep_top_id,
        ),
        [103],
      );
      assert.deepEqual(
        (await client.query('SELECT rep_top_id FROM pg_temp.rep_top_option ORDER BY rep_top_id')).rows.map(
          (row) => row.rep_top_id,
        ),
        [103],
      );
      await client.query('DELETE FROM pg_temp.document_delete_block');
      assert.deepEqual(await documentDelete(db, '103', 'DELETE_PHYSICAL', '', 'fixture'), []);
      assert.equal(await top(103), undefined);
      assert.equal(await current(101), 102);
      await client.query(
        "UPDATE pg_temp.mst_common SET com_value='1'; INSERT INTO pg_temp.mst_label_rep (mst_label_id,label_name,label_name_path,auto_delete,auto_creation) VALUES (10,'Rollback','Rollback',1,0); INSERT INTO pg_temp.rep_label (rep_top_id,mst_label_id) VALUES (102,10)",
      );
      const beforeFailure = await top(102);
      const failingDb = {
        connect: async () => ({
          query: async (sql: string, values?: unknown[]) => {
            const result = await client.query(sql, values);
            if (sql.startsWith('INSERT INTO rep_current')) throw new Error('Fixture failure');
            return result;
          },
          release() {},
        }),
      } as unknown as pg.Pool;
      await assert.rejects(documentDelete(failingDb, '102', 'DELETE_REPORT', 'REV', 'fixture'));
      assert.deepEqual(await top(102), beforeFailure);
      assert.equal(await current(101), 102);
      assert.equal(
        (await client.query('SELECT count(*) FROM pg_temp.mst_label_rep WHERE mst_label_id=10')).rows[0].count,
        '1',
      );
      assert.deepEqual(await top(201), unrelated);
      const app = express();
      app.set('views', 'src/views');
      app.set('view engine', 'ejs');
      app.use(express.urlencoded({ extended: false }));
      app.use(session({ secret: 'documents-lifecycle-fixture', resave: false, saveUninitialized: true }));
      app.use((req, _res, next) => {
        req.session.userId = 'fixture';
        req.session.csrfToken = 'fixture-token';
        next();
      });
      registerDocumentController(
        app,
        db,
        true,
        () => {
          throw new Error('Unexpected full-page render');
        },
        (_req, _res, next) => next(),
      );
      server = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server!.once('listening', resolve));
      const address = server.address();
      assert(address && typeof address !== 'string');
      const post = (Act: string, token = 'fixture-token') =>
        fetch(`http://127.0.0.1:${address.port}/ConMasManager/InputReport/IndexList`, {
          method: 'POST',
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
          body: new URLSearchParams({ Act, ChkRepTopID: '102', __RequestVerificationToken: token }),
        });
      assert.equal((await post('DELETE_REPORT', 'invalid')).status, 403);
      await client.query('UPDATE pg_temp.mst_group SET role_rep_delete_manager=0');
      assert.equal((await post('DELETE_REPORT')).status, 403);
      await client.query('UPDATE pg_temp.mst_group SET role_rep_delete_manager=1');
      const result = await post('DELETE_REPORT');
      assert.equal(result.status, 200);
      assert.match(await result.text(), /RepReportList/);
      assert.equal(Number((await top(102)).deleted), 1);
      assert.equal((await post('DELETE_RETURN_REPORT')).status, 200);
      assert.equal(Number((await top(102)).deleted), 0);
      await client.query(
        "INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (2,'IDENTIFICATION_SETTING','ENABLE_IDENTIFICATION','-1'),(3,'PAGE_SIZE','1','1'),(4,'PAGE_SIZE','2','2'); UPDATE pg_temp.rep_top SET use_identification=1 WHERE rep_top_id=102; UPDATE pg_temp.mst_user SET identification_code='private-code' WHERE user_id='fixture'",
      );
      let cookie = '';
      const request = async (path: string, fields: Record<string, string> = {}, ajax = true) => {
        const response = await fetch(`http://127.0.0.1:${address.port}/ConMasManager/${path}`, {
          method: 'POST',
          headers: { ...(ajax ? { 'X-Requested-With': 'XMLHttpRequest' } : {}), cookie },
          body: new URLSearchParams({ __RequestVerificationToken: 'fixture-token', ...fields }),
        });
        cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie;
        return response;
      };
      const required = () => request('InputReport/GetIdentificationRequired', { repTopIds: '102' });
      const identify = (identificationCode: string) => request('InputReport/Identification', { identificationCode });
      assert.deepEqual(await (await identify('private-code')).json(), { succeeded: false, state: '' });
      assert.deepEqual(await (await required()).json(), { required: true, state: '' });
      assert.deepEqual(await (await identify('bad-code')).json(), { succeeded: false, state: '' });
      assert.deepEqual(await (await identify('')).json(), { succeeded: false, state: '' });
      const identified = await (await identify('private-code')).json();
      assert.equal(identified.succeeded, true);
      assert.match(identified.state, /^[a-f0-9]{32}$/);
      assert.equal(
        (
          await request('InputReport/GetIdentificationRequired', {
            repTopIds: '102',
            __RequestVerificationToken: 'invalid',
          })
        ).status,
        403,
      );
      assert.equal((await request('InputReport/GetIdentificationRequired', { repTopIds: '201' }, false)).status, 500);
      await client.query("UPDATE pg_temp.mst_common SET com_value='0' WHERE com_key='IDENTIFICATION_SETTING'");
      const bypass = await (await required()).json();
      assert.equal(bypass.required, false);
      assert.match(bypass.state, /^[a-f0-9]{32}$/);
      await client.query("UPDATE pg_temp.mst_common SET com_value='1' WHERE com_key='IDENTIFICATION_SETTING'");
      assert.deepEqual(await (await required()).json(), { required: true, state: '' });
      for (const repTopIds of ['', '-1', '102,999', '102); DELETE FROM rep_top'])
        assert.equal((await request('InputReport/GetIdentificationRequired', { repTopIds })).status, 400);
      assert.deepEqual(await (await identify('private-code')).json(), { succeeded: false, state: '' });
      await client.query('UPDATE pg_temp.rep_role SET role_rep_read=0,role_rep_update=0 WHERE rep_top_id=102');
      assert.equal((await required()).status, 400);
      await client.query('UPDATE pg_temp.rep_role SET role_rep_read=1 WHERE rep_top_id=102');
      await client.query(
        "INSERT INTO pg_temp.mst_common (com_id,com_key,com_name,com_value) VALUES (5,'PASSWORD_ENCRYPTION','PASSWORD_ENCRYPTION','1')",
      );
      const oldKey = process.env.CONMAS_LEGACY_KEY;
      try {
        process.env.CONMAS_LEGACY_KEY = 'identification-fixture';
        await client.query("UPDATE pg_temp.mst_user SET identification_code=$1 WHERE user_id='fixture'", [
          legacyPassword('fixture', 'private-code', process.env.CONMAS_LEGACY_KEY),
        ]);
        await required();
        assert.equal((await (await identify('private-code')).json()).succeeded, true);
      } finally {
        if (oldKey === undefined) delete process.env.CONMAS_LEGACY_KEY;
        else process.env.CONMAS_LEGACY_KEY = oldKey;
      }
      await client.query(
        "INSERT INTO pg_temp.mst_task (task_id,task_name,task_remark,display_number) VALUES (1,'First','ordinary',0),(2,$1,$2,0),(3,'Third','ordinary',1)",
        ["Second 'quoted' <task>", 'Remark "quoted" </script>'],
      );
      const tasks = await request('Common/TaskList', { pageSize: '1' });
      assert.equal(tasks.status, 200);
      const firstPage = await tasks.text();
      assert.match(firstPage, /height:324px/);
      assert.match(firstPage, /value="1" onclick="fConMasSelectTask/);
      assert.doesNotMatch(firstPage, /value="2" onclick="fConMasSelectTask/);
      const nextPage = await (await request('Common/TaskList', { pageSize: '1', pageIndex: '1' })).text();
      assert.match(nextPage, /Second &#39;quoted&#39; &lt;task&gt;/);
      assert.match(nextPage, /Remark &#34;quoted&#34; &lt;\/script&gt;/);
      const search = await (await request('Common/TaskList', { searchName: 'Third', searchRemark: 'ordinary' })).text();
      assert.match(search, /value="3" onclick="fConMasSelectTask/);
      assert.doesNotMatch(search, /value="1" onclick="fConMasSelectTask/);
      assert.equal((await request('Common/TaskList', { pageIndex: '-1' })).status, 400);
      assert.equal((await request('Common/TaskList', { pageSize: '-1' })).status, 400);
      assert.equal((await request('Common/TaskList', { __RequestVerificationToken: 'invalid' })).status, 403);
      assert.equal((await client.query('SELECT COUNT(*) FROM pg_temp.mst_task')).rows[0].count, '3');
      assert.deepEqual(await top(201), unrelated);
    } finally {
      if (server)
        await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
      client.release();
      await pool.end();
    }
  },
);
