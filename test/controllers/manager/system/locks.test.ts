import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLockQuery, buildUnlockQuery } from '../../../../src/controllers/manager/system/locks.js';

test('lock listing filters retain source scope and bind all user criteria', () => {
  const query = buildLockQuery(
    {
      defRepType: 'rep',
      lockDateFrom: '2026-01-02',
      lockDateTo: '2026-01-03',
      lockUser: "u%' OR 1=1 --",
      reportName: 'form_%',
      reportPublicStatus: '2',
    },
    'fixture-user',
  );

  assert.match(query.from, /FROM rep_top top INNER JOIN rep_lock lok/);
  assert.match(query.where, /role_rep_read > 0/);
  assert.match(query.where, /lok\.sys_regist_time >= \$2::date/);
  assert.match(query.where, /lok\.sys_regist_time <= \$3::date \+ time '23:59:59'/);
  assert.deepEqual(query.values, ['fixture-user', '2026-01-02', '2026-01-03', "%u%' OR 1=1 --%", '%form_%%', '2']);
  assert.doesNotMatch(`${query.from} ${query.where}`, /u%' OR 1=1|form_%/);
});

test('lock removal statement targets only a validated lock table and bound IDs', () => {
  const query = buildUnlockQuery('def', [12, 34]);
  assert.equal(query.text, 'DELETE FROM def_lock WHERE def_top_id = ANY($1::integer[])');
  assert.deepEqual(query.values, [[12, 34]]);
  assert.throws(() => buildUnlockQuery('rep; DROP TABLE rep_lock', [12]), /Invalid lock target/);
});
