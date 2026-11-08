import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import {
  affiliationImportRows,
  importAffiliationRows,
  validateAffiliationFields,
} from '../../../../src/models/manager/system/data-affiliation-import.js';

test('membership imports preserve field order and legacy action/numeric validation', () => {
  assert.deepEqual(
    affiliationImportRows(
      '<conmas><groupAffiliation><userId>u</userId><groupId>4</groupId><action>A</action></groupAffiliation></conmas>',
      'xml',
    ),
    [['A', '4', 'u']],
  );
  assert.equal(validateAffiliationFields(['A', '4', 'u']), null);
  assert.equal(validateAffiliationFields(['D', '4', 'u']), null);
  assert.equal(validateAffiliationFields(['U', '4', 'u'])?.code, '11020');
  assert.match(validateAffiliationFields(['U', '', 'u'])?.remark ?? '', /groupId/);
  assert.equal(validateAffiliationFields(['A', '-1', 'u'])?.code, '11030');
  assert.equal(validateAffiliationFields(['A', '2147483648', 'u'])?.code, '11030');
  assert.equal(validateAffiliationFields(['A', '4', '{ignore}'])?.code, '11020');
  assert.equal(validateAffiliationFields(['A', '4'])?.code, '10010');
});

test('membership key mode validates the whole file before any writes', async () => {
  let connects = 0;
  const db = {
    query: async (_text: string, values: string[]) =>
      values[0] === 'API_MODE'
        ? { rows: [{ com_value: '1' }] }
        : { rows: values[0] === 'valid' ? [{ group_id: 4 }] : [] },
    connect: async () => {
      connects++;
      throw new Error('No writes expected');
    },
  } as unknown as pg.Pool;
  await assert.rejects(
    importAffiliationRows(
      db,
      [
        ['A', 'valid', 'u'],
        ['A', 'missing', 'u'],
      ],
      'actor',
      'host',
    ),
    /Group key not found/,
  );
  assert.equal(connects, 0);
});

test(
  'membership import logs changes and rolls back membership when its log write fails',
  { skip: !process.env.DATABASE_URL },
  async () => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const user = 'CODEX_AFF_' + randomUUID(),
      key = 'CODEX_GROUP_' + randomUUID();
    let group: number | undefined;
    const wrapper = (failLog = false) =>
      ({
        query: async (text: string, values: unknown[]) => {
          if (values[0] === 'API_MODE' || values[0] === 'LOG_SETTING') return { rows: [{ com_value: '1' }] };
          return pool.query(text, values);
        },
        connect: async () => {
          const client = await pool.connect();
          return {
            query: async (text: string, values?: unknown[]) => {
              if (failLog && text.startsWith('INSERT INTO conmas_user_account_operation_log'))
                throw new Error('Simulated log failure');
              return client.query(text, values);
            },
            release: () => client.release(),
          };
        },
      }) as unknown as pg.Pool;
    try {
      await pool.query('INSERT INTO mst_user (user_id,user_name) VALUES ($1,$2)', [
        user,
        'isolated affiliation import',
      ]);
      group = Number(
        (
          await pool.query(
            "INSERT INTO mst_group (group_id,group_name,system_key) VALUES (nextval('mst_group_group_id_seq'),$1,$2) RETURNING group_id",
            ['isolated affiliation import', key],
          )
        ).rows[0].group_id,
      );
      const failed = await importAffiliationRows(wrapper(true), [['A', key, user]], 'actor', 'test-host');
      assert.equal(failed[0].code, '10020');
      assert.equal(
        (await pool.query('SELECT group_id FROM mst_group_affiation WHERE group_id=$1 AND user_id=$2', [group, user]))
          .rowCount,
        0,
      );
      const added = await importAffiliationRows(wrapper(), [['A', key, user]], 'actor', 'test-host');
      assert.equal(added[0].code, '0');
      const membership = (
        await pool.query(
          'SELECT sys_regist_user,sys_regist_term FROM mst_group_affiation WHERE group_id=$1 AND user_id=$2',
          [group, user],
        )
      ).rows[0];
      assert.equal(membership.sys_regist_user, 'actor');
      assert.equal(membership.sys_regist_term, 'WEBAPI/test-host');
      const removed = await importAffiliationRows(
        wrapper(),
        [
          ['D', key, user],
          ['D', key, user],
        ],
        'actor',
        'test-host',
      );
      assert.deepEqual(
        removed.map((r) => r.code),
        ['0', '0'],
      );
      const logs = (
        await pool.query(
          'SELECT operation_type,operation_content,app_type,update_user_id,client_ip_address FROM conmas_user_account_operation_log WHERE user_id=$1',
          [user],
        )
      ).rows;
      assert.equal(logs.length, 2);
      for (const row of logs) {
        assert.equal(row.operation_type, 'Update');
        assert.equal(row.operation_content, 'UpdatetUserGroup');
        assert.equal(row.app_type, 'Manager');
        assert.equal(row.update_user_id, 'actor');
        assert.equal(row.client_ip_address, 'test-host');
      }
    } finally {
      await pool.query('DELETE FROM conmas_user_account_operation_log WHERE user_id=$1', [user]);
      if (group !== undefined) {
        await pool.query('DELETE FROM mst_group_affiation WHERE group_id=$1 AND user_id=$2', [group, user]);
        await pool.query('DELETE FROM mst_group WHERE group_id=$1 AND system_key=$2', [group, key]);
      }
      await pool.query('DELETE FROM mst_user WHERE user_id=$1 AND user_name=$2', [user, 'isolated affiliation import']);
      await pool.end();
    }
  },
);
