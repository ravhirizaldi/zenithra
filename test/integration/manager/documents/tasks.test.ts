import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Script } from 'node:vm';
import type { Server } from 'node:http';
import pg from 'pg';
import express from 'express';
import session from 'express-session';
import { documentRegistTask, documentTaskState } from '../../../../src/models/manager/documents/tasks.js';
import { registerDocumentController } from '../../../../src/controllers/manager/documents/index.js';

test(
  'Documents task dialog, workers, validation, conflict confirmation and atomic persistence use private tables/sequence',
  { skip: !process.env.DATABASE_URL },
  async () => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const client = await pool.connect();
    const db = {
      query: client.query.bind(client),
      connect: async () => ({ query: client.query.bind(client), release() {} }),
    } as unknown as pg.Pool;
    let server: Server | undefined;
    try {
      for (const table of [
        'mst_common',
        'mst_group',
        'mst_group_affiation',
        'mst_user',
        'mst_task',
        'mst_direct',
        'rep_top',
        'rep_role',
        'rep_schedule',
        'rep_schedule_user',
        'rep_schedule_group',
      ])
        await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
      await client.query(`CREATE TEMP SEQUENCE task_fixture_seq;
        ALTER TABLE pg_temp.rep_schedule ALTER COLUMN schedule_id SET DEFAULT nextval('pg_temp.task_fixture_seq');
        ALTER TABLE pg_temp.rep_schedule_user ALTER COLUMN schedule_id DROP DEFAULT;
        ALTER TABLE pg_temp.rep_schedule ADD FOREIGN KEY (rep_top_id) REFERENCES pg_temp.rep_top(rep_top_id);
        ALTER TABLE pg_temp.rep_schedule_user ADD FOREIGN KEY (schedule_id) REFERENCES pg_temp.rep_schedule(schedule_id) ON DELETE CASCADE;
        ALTER TABLE pg_temp.rep_schedule_group ADD FOREIGN KEY (schedule_id) REFERENCES pg_temp.rep_schedule(schedule_id) ON DELETE CASCADE;
        ALTER TABLE pg_temp.rep_schedule_user ADD FOREIGN KEY (user_id) REFERENCES pg_temp.mst_user(user_id);
        ALTER TABLE pg_temp.rep_schedule_group ADD FOREIGN KEY (group_id) REFERENCES pg_temp.mst_group(group_id);
        SET search_path TO pg_temp`);
      await client.query(`INSERT INTO mst_user (user_id,user_name) VALUES ('fixture','Fixture'),('other','Other'),('conmasadmin','Administrator');
        INSERT INTO mst_user (user_id,user_name,use_end_time) VALUES ('expired','Expired',TIMESTAMP '2000-01-01');
        INSERT INTO mst_group (group_id,group_name,role_rep_read_manager,role_schedule_create) VALUES (10,'Group A',1,1),(20,'Group B',1,0);
        INSERT INTO mst_group_affiation (group_id,user_id) VALUES (10,'fixture'),(20,'other'),(10,'expired');
        INSERT INTO mst_task (task_id,task_name,task_remark) VALUES (1,'Task','Task remark');
        INSERT INTO rep_top (rep_top_id,rep_top_name,deleted,public_status,edit_refer_status) VALUES (1,'First',0,2,0),(2,'Second',0,2,1),(3,'Done',0,2,2),(4,'Unrelated',0,2,0);
        INSERT INTO rep_role (rep_top_id,group_id,role_rep_read) VALUES (1,10,1),(2,10,1),(3,10,1),(4,20,1)`);
      const input: Record<string, string | string[]> = {
        'SchData.task_id': '1',
        'SchData.task_name': 'Task',
        'SchData.task_remark': 'Task remark',
        'SchData.start_date': '2026/11/08',
        'SchData.end_date': '2026/11/08',
        'SchData.FromTime': '09:00',
        'SchData.ToTime': '10:00',
        SelectUsers: ['fixture'],
        SelectRepTask: '1,2',
        'SchData.auto_download': ['true', 'false'],
        'SchData.input_type': 'true',
      };
      for (let i = 1; i <= 10; i++) {
        input['SchData.comment_label' + i] = 'Label ' + i;
        input['SchData.' + (i === 1 ? 'order_comment' : i === 2 ? 'work_comment' : 'comment_value' + i)] = 'Value ' + i;
      }
      const save = (changes: Record<string, string | string[]> = {}) =>
        documentRegistTask(db, documentTaskState({ ...input, ...changes }), 'fixture');
      const count = async () => Number((await client.query('SELECT COUNT(*) FROM rep_schedule')).rows[0].count);
      const invalid: Record<string, string | string[]>[] = [
        { 'SchData.task_name': '' },
        { 'SchData.FromTime': '24:00' },
        { 'SchData.end_date': '2026/11/07' },
        { 'SchData.start_date': '2026/02/30' },
        { 'SchData.end_date': '', 'SchData.ToTime': '10:00' },
        { SelectUsers: [] },
        { SelectUsers: ['fixture'], SelectGroups: ['10'] },
        { SelectUsers: ['expired'] },
        { SelectUsers: ['conmasadmin'] },
        { SelectRepTask: '1,4' },
        { SelectRepTask: '3' },
        { SelectRepTask: '1); DELETE FROM rep_top' },
        { 'SchData.task_id': '99' },
      ];
      for (const changes of invalid) {
        await assert.rejects(save(changes));
        assert.equal(await count(), 0);
      }
      await client.query('UPDATE mst_group SET role_schedule_create=0 WHERE group_id=10');
      await assert.rejects(save());
      assert.equal(await count(), 0);
      await client.query('UPDATE mst_group SET role_schedule_create=1 WHERE group_id=10');
      const failedDb = {
        connect: async () => ({
          query: async (sql: string, values?: unknown[]) => {
            const result = await client.query(sql, values);
            if (sql.startsWith('INSERT INTO rep_schedule_user')) throw new Error('Fixture failure');
            return result;
          },
          release() {},
        }),
      } as unknown as pg.Pool;
      await assert.rejects(documentRegistTask(failedDb, documentTaskState(input), 'fixture'));
      assert.equal(await count(), 0);
      assert.equal(await save(), true);
      assert.equal(await count(), 2);
      const saved = (await client.query('SELECT * FROM rep_schedule ORDER BY rep_top_id')).rows;
      for (const row of saved) {
        assert.equal(row.sys_regist_user, 'fixture');
        assert.equal(row.sys_update_user, 'fixture');
        assert.equal(row.start_time, '09:00');
        assert.equal(row.end_time, '10:00');
        assert.equal(row.task_id, 1);
        assert.equal(row.task_name, 'Task');
        assert.equal(row.task_remark, 'Task remark');
        assert.equal(row.auto_download, '1');
        assert.equal(row.input_type, '1');
        assert.equal(row.report_type, '0');
        assert.equal(row.start_type, '0');
        assert.equal(row.finish_status, null);
        for (let i = 1; i <= 10; i++) {
          assert.equal(row['comment_label' + i], 'Label ' + i);
          assert.equal(row[i === 1 ? 'order_comment' : i === 2 ? 'work_comment' : 'comment_value' + i], 'Value ' + i);
        }
      }
      assert.equal((await client.query('SELECT COUNT(*) FROM rep_schedule_user')).rows[0].count, '2');
      await assert.rejects(save());
      assert.equal(await count(), 2);
      const nextDay = { 'SchData.start_date': '2026/11/09', 'SchData.end_date': '2026/11/09' };
      assert.equal(await save(nextDay), false);
      assert.equal(await count(), 2);
      assert.equal(await save({ ...nextDay, RegistTackClosed: '2' }), true);
      assert.equal(await count(), 4);
      await assert.rejects(save({ SelectUsers: [], SelectGroups: ['10'], ...nextDay }));
      assert.equal(await count(), 4);
      await client.query('DELETE FROM rep_schedule');
      assert.equal(await save({ SelectUsers: [], SelectGroups: ['10'] }), true);
      assert.equal((await client.query('SELECT COUNT(*) FROM rep_schedule_group')).rows[0].count, '2');
      await assert.rejects(save({ SelectUsers: [], SelectGroups: ['20'] }));
      await assert.rejects(save(nextDay));
      await client.query('DELETE FROM rep_schedule');
      await client.query(
        "INSERT INTO mst_common (com_id,com_key,com_name,com_value) VALUES (1,'WEBHOOK','WEBHOOK_VALID_ENABLE','1')",
      );
      await assert.rejects(save());
      assert.equal(await count(), 0);
      await client.query(
        "UPDATE mst_common SET com_value='0'; INSERT INTO mst_direct (key,xml_data) VALUES ('Setting','fixture-config')",
      );
      await assert.rejects(save());
      assert.equal(await count(), 0);
      await client.query("DELETE FROM mst_direct WHERE key='Setting'");
      const app = express();
      app.set('views', 'src/views');
      app.set('view engine', 'ejs');
      app.use(express.urlencoded({ extended: false }));
      app.use(session({ secret: 'documents-task-fixture', resave: false, saveUninitialized: true }));
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
          throw new Error('Unexpected page render');
        },
        (_req, _res, next) => next(),
      );
      app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).send('Fixture handler failed.');
      });
      server = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server!.once('listening', resolve));
      const address = server.address();
      assert(address && typeof address !== 'string');
      const url = `http://127.0.0.1:${address.port}/ConMasManager/Common/RegistTask`;
      let cookie = '';
      const request = async (fields?: Record<string, string | string[]>, query = '') => {
        const body = new URLSearchParams();
        if (fields)
          for (const [key, raw] of Object.entries({ __RequestVerificationToken: 'fixture-token', ...fields }))
            for (const value of Array.isArray(raw) ? raw : [raw]) body.append(key, value);
        const response = await fetch(url + query, {
          method: fields ? 'POST' : 'GET',
          headers: { cookie, 'X-Requested-With': 'XMLHttpRequest' },
          body: fields ? body : undefined,
        });
        cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie;
        return response;
      };
      const initial = await request();
      assert.equal(initial.status, 200);
      const html = await initial.text();
      assert.match(html, /id="taskRegistForm"/);
      assert.match(html, /class="workingUser selectedGroupUser"/);
      assert.match(html, /height:174px/);
      assert.match(html, /height:86px/);
      for (let i = 1; i <= 10; i++) assert.match(html, new RegExp('name="SchData.comment_label' + i + '"'));
      assert.doesNotMatch(html, /@Model|@IRResource|@CommonRegistTaskModel/);
      const script = html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/)?.[1];
      assert(script);
      new Script(script);
      assert.match(html, /<option value="fixture" selected="selected">Fixture<\/option>/);
      assert.doesNotMatch(html, /<option value="expired"|<option value="conmasadmin"/);
      assert.equal((await request({ ...input, SchAction: 'Submit', __RequestVerificationToken: 'bad' })).status, 403);
      assert.equal((await request({ ...input, SchAction: 'Delete' })).status, 501);
      assert.equal((await request(undefined, '?requestKbn=3')).status, 501);
      assert.equal((await request({ ...input, 'SchData.report_type': 'true', SchAction: 'Submit' })).status, 501);
      const searched = await request({
        SchAction: 'UserSearch',
        UserSearch: '',
        SelectUsers: ['fixture'],
        SchGroupId: '10',
      });
      assert.match(await searched.text(), /<option value="other">Other<\/option>/);
      const grouped = await request({
        SchAction: 'GroupSelect',
        UserSearch: 'ignored',
        SelectUsers: ['fixture'],
        SchGroupId: '10',
      });
      assert.doesNotMatch(await grouped.text(), /<option value="other">Other<\/option>/);
      const accepted = await request({ ...input, SchAction: 'Submit' });
      assert.equal(accepted.status, 200);
      assert.equal(await count(), 2);
      assert.match(accepted.url, /year=2026&month=11&day=08/);
      const confirmation = await request({ ...input, ...nextDay, SchAction: 'Submit' });
      const confirmHtml = await confirmation.text();
      assert.equal(confirmation.status, 200);
      assert.match(confirmHtml, /name="RegistTackClosed" type="hidden" value="2"/);
      assert.match(confirmHtml, /if \('2' == '2'\)/);
      assert.equal(await count(), 2);
      assert.equal((await request({ ...input, ...nextDay, SchAction: 'Submit', RegistTackClosed: '2' })).status, 200);
      assert.equal(await count(), 4);
      assert.equal((await client.query('SELECT COUNT(*) FROM rep_schedule WHERE rep_top_id=4')).rows[0].count, '0');
      await client.query('UPDATE mst_group SET role_schedule_create=0 WHERE group_id=10');
      assert.equal((await request()).status, 403);
    } finally {
      if (server)
        await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
      client.release();
      await pool.end();
    }
  },
);
