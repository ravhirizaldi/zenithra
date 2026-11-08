import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Server } from 'node:http';
import pg from 'pg';
import express from 'express';
import session from 'express-session';
import { registerTasks } from '../../../../src/controllers/manager/system/tasks.js';
import { documentTaskList } from '../../../../src/models/manager/documents/tasks.js';
import { documentSettings } from '../../../../src/models/manager/documents/index.js';

test(
  'Common and System share task search without sharing permission or paging policy',
  { skip: !process.env.DATABASE_URL },
  async () => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const client = await pool.connect();
    const db = { query: client.query.bind(client) } as unknown as pg.Pool;
    let server: Server | undefined;
    try {
      for (const table of ['mst_common', 'mst_task', 'mst_group', 'mst_group_affiation'])
        await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
      await client.query(`SET search_path TO pg_temp;
      INSERT INTO mst_common (com_key,com_index,com_name,com_value) VALUES
      ('PAGE_SIZE',1,'1','1'),('PAGE_SIZE',2,'2','2'),('DEFAULT_PAGE_SIZE',0,'DEFAULT','2');
      INSERT INTO mst_group (group_id,group_name,role_mst_data_read) VALUES (10,'Fixture',1);
      INSERT INTO mst_group_affiation (group_id,user_id) VALUES (10,'fixture');
      INSERT INTO mst_task (task_id,task_name,task_remark,display_number) VALUES
      (1,'Same','remark',2),(2,'Same','remark',1),(3,'Same','remark',1),(4,'Nulls',NULL,NULL)`);
      const settings = await documentSettings(db);
      const app = express();
      app.use(express.urlencoded({ extended: false }));
      app.use(session({ secret: 'shared-task-fixture', resave: false, saveUninitialized: true }));
      app.use((req, _res, next) => {
        req.session.userId = 'fixture';
        next();
      });
      registerTasks(app, db, (res, data) => res.json(data.taskPage));
      app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).send('Fixture handler failed.');
      });
      server = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server!.once('listening', resolve));
      const address = server.address();
      assert(address && typeof address !== 'string');
      const url = `http://127.0.0.1:${address.port}/ConMasManager/System/TaskList`;
      const searches: Record<string, string>[] = [
        {},
        { searchName: 'Same', searchRemark: 'remark', pageSize: '1', pageIndex: '1' },
        { searchName: "' OR 1=1 --" },
        { searchName: '   ', searchRemark: '   ' },
      ];
      for (const fields of searches) {
        const response = await fetch(url, { method: 'POST', body: new URLSearchParams(fields) });
        assert.equal(response.status, 200);
        const system = await response.json();
        const common = await documentTaskList(db, fields, settings);
        for (const key of ['rows', 'total', 'pages', 'pageIndex', 'pageSize', 'searchName', 'searchRemark'] as const)
          assert.deepEqual(system[key], common[key]);
      }
      const common = await documentTaskList(db, {}, settings);
      assert.deepEqual(
        common.rows.map((row) => row.task_id),
        [4, 2],
      );
      assert.equal(common.rows[0].task_remark, '');
      assert.equal(common.rows[0].display_number, 0);
      const invalidPage = await fetch(url + '?pageSize=-1');
      assert.equal(invalidPage.status, 200);
      assert.equal((await invalidPage.json()).pageSize, 2);
      await assert.rejects(documentTaskList(db, { pageSize: '-1' }, settings));
      const deniedDelete = await fetch(url, { method: 'POST', body: new URLSearchParams({ chkFiles: '1' }) });
      assert.equal(deniedDelete.status, 403);
      assert.equal((await client.query('SELECT COUNT(*) FROM mst_task')).rows[0].count, '4');
      await client.query('UPDATE mst_group SET role_mst_data_read=0 WHERE group_id=10');
      assert.equal((await fetch(url)).status, 403);
      assert.equal((await documentTaskList(db, {}, settings)).total, 4);
    } finally {
      if (server)
        await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
      client.release();
      await pool.end();
    }
  },
);
