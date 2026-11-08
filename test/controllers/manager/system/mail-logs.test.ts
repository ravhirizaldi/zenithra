import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildMailLogWhere, type MailLogFilters } from '../../../../src/controllers/manager/system/mail-logs.js';

test('mail send log filters use inclusive date bounds and parameterized selected types', () => {
  const filters: MailLogFilters = {
    sendTimeFrom: '2025/1/2',
    sendTimeFromHour: '',
    sendTimeTo: '01/03/2025',
    sendTimeToHour: '23:30:00',
    statusSuccess: false,
    statusFailure: true,
    notificationTypeApply: true,
    notificationTypeRemand: false,
    notificationTypeApprove: false,
    notificationTypeEdit: false,
    notificationTypeComplete: false,
    notificationTypeChange: false,
    notificationTypeTerminal: false,
    notificationTypeTerminalApprove: false,
    notificationTypeDefApply: false,
    notificationTypeDefRemand: false,
    notificationTypeDefApprove: false,
  };
  const where = buildMailLogWhere(filters);
  assert.equal(
    where.sql,
    '1=1 AND send_time >= $1::timestamp AND send_time <= $2::timestamp AND error_message IS NOT NULL AND notification_type = ANY($3::text[])',
  );
  assert.deepEqual(where.parameters, ['2025-01-02 00:00:00', '2025-01-03 23:30:00', ['Apply']]);
});
