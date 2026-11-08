import assert from 'node:assert/strict';
import { test } from 'node:test';
import type pg from 'pg';
import {
  hasSystemPermission,
  hasSystemTabAccess,
  systemPermissionMap,
} from '../../../../src/middleware/manager/system/permissions.js';

type RoleRow = Record<string, string | number | null>;

function mockDb(row?: RoleRow) {
  const calls: { sql: string; values?: unknown[] }[] = [];
  const db = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      return { rows: row ? [row] : [] };
    },
  } as unknown as pg.Pool;
  return { db, calls };
}

test('permissions combine generic and scope-specific grants', async () => {
  const { db, calls } = mockDb({ role_mst_update: 1, role_mst_system_update: 1 });

  assert.equal(await hasSystemPermission(db, 'user-42', 'system', 'edit'), true);
  assert.match(calls[0].sql, /MAX\(grp\.role_mst_update\)/);
  assert.match(calls[0].sql, /MAX\(grp\.role_mst_system_update\)/);
  assert.match(calls[0].sql, /FROM mst_group_affiation WHERE user_id = \$1/);
  assert.deepEqual(calls[0].values, ['user-42']);
});

test('permissions deny unrelated scope bits and absent grants', async () => {
  const { db } = mockDb({ role_mst_user_read: 1, role_mst_system_read: 1 });

  assert.equal(await hasSystemPermission(db, 'user-42', 'system', 'delete'), false);
  assert.equal(await hasSystemPermission(db, 'user-42', 'group', 'read'), false);
  assert.equal(await hasSystemPermission(db, 'user-42', 'user', 'read'), true);

  const noGrants = mockDb({}).db;
  assert.equal(await hasSystemPermission(noGrants, 'user-42', 'data', 'read'), false);
  assert.equal(await hasSystemPermission(noGrants, 'conmasadmin', 'system', 'read'), false);
});

test('custom-table permissions match Common role checks only', async () => {
  const readOnly = mockDb({ role_custom_table_read: 1 });
  assert.equal(await hasSystemPermission(readOnly.db, 'user-42', 'customTable', 'read'), true);
  assert.equal(await hasSystemPermission(readOnly.db, 'user-42', 'customTable', 'edit'), false);
  assert.match(readOnly.calls[0].sql, /MAX\(grp\.role_custom_table_read\)/);
  assert.match(readOnly.calls[0].sql, /MAX\(grp\.role_custom_table_update\)/);

  const updateOnly = mockDb({ role_custom_table_update: 1 });
  assert.equal(await hasSystemPermission(updateOnly.db, 'user-42', 'customTable', 'read'), true);
  assert.equal(await hasSystemPermission(updateOnly.db, 'user-42', 'customTable', 'edit'), true);
  assert.equal(await hasSystemPermission(updateOnly.db, 'user-42', 'customTable', 'create'), false);
  assert.equal(await hasSystemPermission(updateOnly.db, 'user-42', 'customTable', 'delete'), false);

  const genericOnly = mockDb({ role_mst_read: 1, role_mst_update: 1, role_mst_create: 1, role_mst_delete: 1 }).db;
  assert.equal(await hasSystemPermission(genericOnly, 'user-42', 'customTable', 'read'), false);
  assert.equal(await hasSystemPermission(genericOnly, 'user-42', 'customTable', 'edit'), false);
  assert.equal(await hasSystemPermission(genericOnly, 'user-42', 'customTable', 'create'), false);
  assert.equal(await hasSystemPermission(genericOnly, 'user-42', 'customTable', 'delete'), false);
});

test('System tab access follows legacy read bits and rejects missing users', async () => {
  assert.equal(await hasSystemTabAccess(mockDb({ role_mst_data_read: 1 }).db, 'user-42'), true);
  assert.equal(await hasSystemTabAccess(mockDb({ role_mst_system_delete: 1 }).db, 'user-42'), false);

  const missing = mockDb({});
  assert.equal(await hasSystemPermission(missing.db, '', 'system', 'read'), false);
  assert.equal(await hasSystemTabAccess(missing.db, ''), false);
  assert.equal(missing.calls.length, 0);

  assert.equal(await hasSystemPermission(mockDb().db, 'unknown-user', 'system', 'read'), false);
});
test('permission map matches single-permission helpers after one role query', async () => {
  const roleRow = {
    role_mst_update: 1,
    role_mst_system_delete: 1,
    role_mst_user_create: 1,
    role_mst_terminal_read: 1,
    role_mst_data_read: 1,
    role_custom_table_update: 1,
  };
  const mapped = mockDb(roleRow);
  const permissions = await systemPermissionMap(mapped.db, 'user-42');
  assert.equal(mapped.calls.length, 1);

  for (const scope of ['system', 'data', 'user', 'group', 'terminal', 'customTable'] as const) {
    for (const action of ['read', 'edit', 'create', 'delete'] as const) {
      const helper = mockDb(roleRow).db;
      assert.equal(permissions[scope][action], await hasSystemPermission(helper, 'user-42', scope, action));
    }
  }

  assert.equal(permissions.systemTab, await hasSystemTabAccess(mockDb(roleRow).db, 'user-42'));
});
