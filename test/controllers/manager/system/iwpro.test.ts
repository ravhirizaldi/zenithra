import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildIwproAuthorizationUrl,
  buildIwproOrder,
  buildIwproUploadWhere,
  readIwproFilters,
} from '../../../../src/controllers/manager/system/iwpro.js';

test('IWpro authorization state returns the configured URLs without padding', () => {
  const authorization = buildIwproAuthorizationUrl(
    'client id',
    'https://auth.example.test/redirect',
    'https://manager.example.test/ConMasManager/System/IWproAuthCompleted',
    '00112233445566778899aabbccddeeff',
  );
  const state = authorization.searchParams.get('state');
  assert(state);
  assert.deepEqual(JSON.parse(Buffer.from(state, 'base64url').toString()), {
    redirectUrl: 'https://auth.example.test/redirect',
    completeUrl: 'https://manager.example.test/ConMasManager/System/IWproAuthCompleted',
  });
  assert.equal(authorization.searchParams.get('client_id'), 'client id');
  assert.equal(authorization.searchParams.get('nonce'), '00112233445566778899aabbccddeeff');
  assert.equal(authorization.searchParams.get('scope'), 'DXPF.ANY.USER SPF-ID.READ.USER');
});

test('IWpro upload filters default to all statuses and bind user values', () => {
  const defaults = readIwproFilters({}, true);
  assert.deepEqual([defaults.statusSuccess, defaults.statusRetrying, defaults.statusFailure], [true, true, true]);
  const filters = readIwproFilters({
    'WhereData.StatusSuccess': ['false', 'true'],
    'WhereData.StatusRetrying': 'false',
    'WhereData.StatusFailure': 'true',
    'WhereData.ExecTimeFrom': '2026-02-03',
    'WhereData.ExecTimeFromHour': '',
    'WhereData.ErrorMessage': "%' OR 1=1; DROP TABLE log_iwpro_upload; --",
  });
  const where = buildIwproUploadWhere(filters);
  assert.deepEqual(where.parameters, [
    '2026-02-03 00:00:00',
    [0, 2],
    "%\u0025' OR 1=1; DROP TABLE log_iwpro_upload; --%",
  ]);
  assert.match(where.sql, /log\.sys_update_time >= \$1::timestamp/);
  assert.match(where.sql, /log\.status = ANY\(\$2::numeric\[\]\)/);
  assert.match(where.sql, /convert_full2half\(log\.error_message\) ILIKE \$3/);
  assert.doesNotMatch(where.sql, /DROP TABLE/i);
});
test('IWpro log sorting rejects unrecognized column names', () => {
  assert.equal(
    buildIwproOrder({
      pageIndex: 0,
      pageSize: 20,
      sortColumn: 'sys_update_time; DROP TABLE log_iwpro_upload',
      sortDirection: 'DESC',
    }),
    'log.sys_update_time DESC, log.log_id',
  );
});
