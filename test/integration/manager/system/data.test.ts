import assert from 'node:assert/strict';
import test from 'node:test';
import type pg from 'pg';
import { unlockUserTables } from '../../../../src/controllers/manager/system/data.js';

test('unlockUserTables deletes locks owned by current user and terminal', async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
    },
    release: () => {},
  };
  const db = {
    connect: async () => client,
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
    },
  } as unknown as pg.Pool;

  await unlockUserTables(db, 'manager-1', 'server-a');

  assert.deepEqual(calls, [
    { sql: 'BEGIN', values: undefined },
    {
      sql: 'DELETE FROM rep_lock WHERE user_id=$1 AND sys_regist_user=$1 AND sys_regist_term=$2',
      values: ['manager-1', 'server-a'],
    },
    { sql: 'COMMIT', values: undefined },
    {
      sql: 'DELETE FROM document_lock WHERE user_id=$1 AND sys_regist_user=$1 AND sys_regist_term=$2',
      values: ['manager-1', 'server-a'],
    },
  ]);
});

test('unlockUserTables still deletes document locks after report-lock rollback', async () => {
  const calls: string[] = [];
  const client = {
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.startsWith('DELETE FROM rep_lock')) throw new Error('lock unavailable');
    },
    release: () => {},
  };
  const db = {
    connect: async () => client,
    query: async (sql: string) => {
      calls.push(sql);
    },
  } as unknown as pg.Pool;

  await unlockUserTables(db, 'manager-1', 'server-a');

  assert.deepEqual(calls, [
    'BEGIN',
    'DELETE FROM rep_lock WHERE user_id=$1 AND sys_regist_user=$1 AND sys_regist_term=$2',
    'ROLLBACK',
    'DELETE FROM document_lock WHERE user_id=$1 AND sys_regist_user=$1 AND sys_regist_term=$2',
  ]);
});
