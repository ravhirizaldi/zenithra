import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildMbCloudWhere,
  mbCloudLogCsv,
  parseMbCloudSettingXml,
  readMbCloudFilters,
  serializeMbCloudSettingXml,
  validateMbCloudSettings,
} from '../../../../src/controllers/manager/system/mbcloud.js';

test('MbCloud settings preserve extra XML and stored password on edit', () => {
  const xml =
    '<conmas><url>https://cloud.example.test/a&amp;b</url><tenant>tenant</tenant><id>cloud-user</id><password>secret</password><extra>kept</extra></conmas>';
  const model = parseMbCloudSettingXml(xml);
  assert.equal(model.Url, 'https://cloud.example.test/a&b');
  assert.equal(model.RealtimeLinkageEnabled, '1');
  assert.equal(model.IsNew, false);
  assert.equal(Object.hasOwn(model, 'Password'), false);
  const updated = serializeMbCloudSettingXml(
    xml,
    {
      ...model,
      Url: 'https://cloud.example.test/updated',
      EndpointCreateDefReplication: 'https://cloud.example.test/snapshot',
      RealtimeLinkageEnabled: '0',
    },
    '',
  );
  const saved = parseMbCloudSettingXml(updated);
  assert.equal(saved.Url, 'https://cloud.example.test/updated');
  assert.equal(saved.RealtimeLinkageEnabled, '0');
  assert.match(updated, /<extra>kept<\/extra>/);
  assert.match(updated, /<password>secret<\/password>/);
});

test('MbCloud settings require source fields and new credentials only', () => {
  const blank = parseMbCloudSettingXml(null);
  assert.equal(validateMbCloudSettings(blank, ''), 'Please enter URI.');
  const configured = {
    ...blank,
    Url: 'https://cloud.example.test/import',
    EndpointCreateDefReplication: 'https://cloud.example.test/snapshot',
    Tenant: 'tenant',
    MbId: 'user',
    IsNew: false,
  };
  assert.equal(validateMbCloudSettings(configured, ''), '');
  assert.equal(
    validateMbCloudSettings({ ...configured, RealtimeLinkageEnabled: '2' }, ''),
    'Select Yes or No for Realtime data connection.',
  );
});

test('MbCloud log filters default to all statuses and bind dates and status values', () => {
  const filters = readMbCloudFilters({}, true);
  assert.deepEqual([filters.StatusSuccess, filters.StatusFailure, filters.StatusRetrying], [true, true, true]);
  assert.equal(buildMbCloudWhere(filters).sql, '1=1');
  const narrowed = readMbCloudFilters(
    {
      'WhereData.SendTimeFrom': '2026/11/07',
      'WhereData.SendTimeFromHour': '',
      'WhereData.StatusSuccess': 'false',
      'WhereData.StatusFailure': ['false', 'true'],
      'WhereData.StatusRetrying': 'false',
      'WhereData.RepTopId': '42',
    },
    false,
  );
  const where = buildMbCloudWhere(narrowed);
  assert.equal(where.error, '');
  assert.match(where.sql, /sys_update_time >= \$1::timestamp/);
  assert.match(where.sql, /status = ANY\(\$2::numeric\[\]\)/);
  assert.match(where.sql, /rep_top_id = \$3/);
  assert.deepEqual(where.parameters, ['2026-11-07 00:00:00', [1], 42]);
});

test('MbCloud filter rejects malformed dates and preserves legacy fullwidth search normalization', () => {
  const invalid = buildMbCloudWhere({ ...readMbCloudFilters({}, true), SendTimeFrom: '2026/02/30' });
  assert.equal(invalid.error, 'Enter a valid send date and time.');
  const where = buildMbCloudWhere({ ...readMbCloudFilters({}, true), IreporterUser: 'ＡＢＣ' });
  assert.deepEqual(where.parameters, ['%ABC%']);
});

test('MbCloud CSV escapes values and truncates beyond configured download limit', () => {
  const csv = mbCloudLogCsv(
    [
      {
        log_id: '1',
        status: 1,
        rep_top_id: 7,
        rep_top_name: 'Form, "one"',
        view_name: 'view_a',
        error_message: 'timeout',
        sys_update_time_display: '2026/11/07 12:30:00',
        sys_update_user: 'user',
        sys_update_user_name: 'Name',
      },
      {
        log_id: '2',
        status: 0,
        rep_top_id: 8,
        rep_top_name: 'Other',
        view_name: 'view_b',
        error_message: '',
        sys_update_time_display: '2026/11/07 12:31:00',
        sys_update_user: 'user',
        sys_update_user_name: 'Name',
      },
    ],
    1,
  );
  assert.ok(csv.startsWith('\uFEFF"Send date and time"'));
  assert.match(csv, /"Form, ""one"""/);
  assert.match(csv, /"Truncated to 1 records\."/);
});
