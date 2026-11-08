import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type pg from 'pg';
import { listCommonSettings } from '../../../../src/models/manager/system/common.js';
import { listUsers } from '../../../../src/models/manager/system/users.js';

test('relocated user list keeps escaped filters, invalid group fallback and bounded paging', async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const replies = [[{ com_value: '10' }], [{ total: '21' }], [{ user_id: 'fixture' }], []];
  const database = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      return { rows: replies.shift()! };
    },
  } as unknown as pg.Pool;
  const result = await listUsers(database, {
    searchId: 'abc%_',
    searchName: 'fixture',
    searchGroupId: 'invalid',
    pageIndex: '999999',
    pageSize: '15',
  });
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[1].values, ['conmasadmin', '%abc\\%\\_%', '%fixture%', '-1']);
  assert.deepEqual(calls[2].values, [...calls[1].values!, 20, 200000]);
  assert.match(calls[2].sql, /ORDER BY user_id LIMIT \$5 OFFSET \$6/);
  assert.deepEqual(result.users, [{ user_id: 'fixture' }]);
  assert.equal(result.userCount, 21);
  assert.equal(result.userFilters.pages, 2);
});

test('relocated common list keeps trimmed escaped filters, page fallback and response shape', async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const replies = [[{ total: '51' }], [{ com_key: 'fixture', com_name: 'name', com_locale: 'en' }]];
  const database = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      return { rows: replies.shift()! };
    },
  } as unknown as pg.Pool;
  const result = await listCommonSettings(database, { key: '  key%  ', name: ' name_ ', page: '-1' });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].values, ['%key\\%%', '%name\\_%']);
  assert.deepEqual(calls[1].values, ['%key\\%%', '%name\\_%', 0]);
  assert.deepEqual(result, {
    columns: ['Key', 'Name', 'Locale'],
    rows: [['fixture', 'name', 'en']],
    total: 51,
    page: 1,
    pages: 2,
    key: 'key%',
    name: 'name_',
  });
});
