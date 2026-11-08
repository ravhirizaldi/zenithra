import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSystemLogWhere, type SystemLogFilters } from '../../../../src/controllers/manager/system/logs.js';

function filters(overrides: Partial<SystemLogFilters> = {}): SystemLogFilters {
  return {
    timeFrom: '2025/1/2',
    timeFromHour: '',
    timeTo: '01/03/2025',
    timeToHour: '23:30:00',
    operationTypeLogin: true,
    operationTypeLogout: true,
    appTypeTablet: true,
    appTypeApi: true,
    appTypeDesigner: true,
    appTypeManager: true,
    deviceTypeiPad: true,
    deviceTypeWindows: true,
    deviceTypeiRepoFreeDraw: true,
    operationTypeInsert: true,
    operationTypeUpdate: true,
    operationTypeDelete: true,
    userId: 'operator',
    userName: 'Ada',
    termId: '',
    physicalId: '',
    termName: '',
    appVersion: '',
    clientName: '',
    clientAddress: '',
    browserName: '',
    formName: '',
    ...overrides,
  };
}

test('operation log filters preserve inclusive bounds and legacy user-name gate', () => {
  const where = buildSystemLogWhere('operation', filters({ operationTypeLogin: true, operationTypeLogout: false }));
  assert.equal(
    where.sql,
    '1=1 AND log.operation_type = ANY($1::text[]) AND log.log_time >= $2::timestamp AND log.log_time <= $3::timestamp AND log.user_id ILIKE $4 AND log.user_name ILIKE $5',
  );
  assert.deepEqual(where.parameters, [['Login'], '2025-01-02 00:00:00', '2025-01-03 23:30:00', '%operator%', '%Ada%']);

  const withoutEndDate = buildSystemLogWhere('operation', filters({ timeTo: '', userName: 'Ada' }));
  assert.doesNotMatch(withoutEndDate.sql, /user_name/);
  assert.deepEqual(withoutEndDate.parameters, ['2025-01-02 00:00:00', '%operator%']);

  const blankUserName = buildSystemLogWhere('operation', filters({ userName: '' }));
  assert.equal(blankUserName.parameters[blankUserName.parameters.length - 1], '%%');
});

test('form log type selection uses parameterized legacy I/U/D filtering', () => {
  const where = buildSystemLogWhere(
    'inputReport',
    filters({
      timeFrom: '',
      timeTo: '',
      formName: "report%' OR 1=1 --",
      userId: '',
      operationTypeInsert: false,
      operationTypeUpdate: true,
      operationTypeDelete: false,
    }),
  );
  assert.equal(where.sql, '1=1 AND log.rep_top_name ILIKE $1 AND log.log_type = ANY($2::text[])');
  assert.deepEqual(where.parameters, ["%report%' OR 1=1 --%", ['U']]);
});
