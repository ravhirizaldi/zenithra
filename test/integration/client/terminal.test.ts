import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { changeClientTerminal, clientTerminal, type ClientAccount } from '../../../src/models/client-account.js';

test(
  'native approval/removal target session identity, preserve source no-quota/no-deleted approval and removal code 8',
  { skip: !process.env.DATABASE_URL },
  async () => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const client = await pool.connect();
    const db = { query: client.query.bind(client) } as unknown as pg.Pool;
    const account: ClientAccount = {
      userId: 'fixture',
      userName: 'Fixture name',
      client: 'Designer',
      physicalId: 'device',
      version: '',
      platform: '',
      address: '',
      sessionId: '',
    };
    try {
      await client.query(`CREATE TEMP TABLE mst_terminal (LIKE public.mst_terminal INCLUDING ALL);
      INSERT INTO pg_temp.mst_terminal (term_id,physical_id,term_type,deleted,term_name) VALUES (1,'device','Designer',0,'Original name'),(2,'device','Designer',1,'Deleted name'),(3,'other-device','Designer',0,'Other device'),(4,'device','iPad',0,'Other type')`);
      assert.equal((await clientTerminal(db, account)).code, 4);
      assert.match(await changeClientTerminal(db, account, true), /<code>0<\/code>/);
      assert.equal((await clientTerminal(db, account)).code, 0);
      const rows = (
        await db.query(
          'SELECT term_id,deleted,approver,approver_name,term_name,sys_update_user,sys_update_term FROM mst_terminal ORDER BY term_id',
        )
      ).rows;
      assert.equal(rows[0].approver, 'fixture');
      assert.equal(rows[0].approver_name, 'Fixture name');
      assert.equal(rows[0].term_name, 'Original name');
      assert.equal(rows[0].sys_update_term, 'device');
      assert.equal(rows[1].approver, 'fixture');
      assert.equal(rows[1].deleted, '1');
      assert.equal(rows[2].approver, null);
      assert.equal(rows[3].approver, null);
      assert.match(await changeClientTerminal(db, account, false), /<code>0<\/code>/);
      assert.equal((await clientTerminal(db, account)).code, 3);
      assert.match(await changeClientTerminal(db, account, false), /<code>8<\/code>/);
      assert.match(await changeClientTerminal(db, { ...account, physicalId: "' OR 1=1--" }, true), /<code>0<\/code>/);
      assert.match(await changeClientTerminal(db, { ...account, physicalId: 'missing' }, false), /<code>8<\/code>/);
      await db.query('ALTER TABLE pg_temp.mst_terminal ADD CONSTRAINT reject_terminal CHECK (false) NOT VALID');
      await assert.rejects(changeClientTerminal(db, account, true));
      assert.equal((await db.query('SELECT approver FROM mst_terminal WHERE term_id=1')).rows[0].approver, 'fixture');
    } finally {
      client.release(true);
      await pool.end();
    }
  },
);
