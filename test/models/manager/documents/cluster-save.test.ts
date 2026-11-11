import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentClusterChanges } from '../../../../src/models/manager/documents/cluster-save.js';
import { documentClusterInput } from '../../../../src/models/manager/documents/clusters.js';
import { root } from '../../../../src/models/client-definition-xml.js';

function fixture(
  cluster_type = 'KeyboardText',
  input_value = 'before',
  input_parameter = '',
  display_value = input_value,
  role = '1',
) {
  const row = {
    rep_sheet_id: 11,
    cluster_id: 1,
    cluster_role: role,
    cluster_type,
    input_value,
    display_value,
    input_parameter,
    verified: '0',
    comment_value: '',
    change_reason: '',
    ...documentClusterInput({ cluster_type, input_value, display_value, input_parameter, cluster_role: role }),
  };
  const sheet = root(
    `<sheet><clusters><cluster><clusterId>1</clusterId><type>${cluster_type}</type></cluster></clusters></sheet>`,
  );
  const data = {
    'rep_clusters[0].rep_sheet_id': '11',
    'rep_clusters[0].cluster_id': '1',
    'rep_clusters[0].cluster_role': role,
  };
  return { row, sheet, data };
}

test('sheet text/check/choice changes use server-owned identities, validation and display rules', () => {
  let f = fixture('KeyboardText', 'before', 'MaxLength=8;Prefix=[;Suffix=]');
  const run = (values: Record<string, unknown>, reason = false) =>
    documentClusterChanges({ ...f.data, ...values }, [f.row], f.sheet, reason);
  assert.equal(run({ 'rep_clusters[0].input_value': 'after\r\n' })[0].display, '[after\n]');
  assert.throws(() => run({ 'rep_clusters[0].input_value': 'too long input' }), /maximum length/);
  assert.throws(() => run({ 'rep_clusters[0].input_value': '1234567\r\n' }), /maximum length/);
  for (const fields of [
    { 'rep_clusters[0].cluster_id': '2' },
    { 'rep_clusters[0].rep_sheet_id': '12' },
    { 'rep_clusters[0].cluster_role': '0' },
    { 'rep_clusters[0].input_value': ['bad'] },
    { 'rep_clusters[0].Verified': ['true', 'bogus'] },
    { 'rep_clusters[0].cluster_type': 'Text' },
    { 'rep_clusters[99].input_value': 'bad' },
    { 'rep_clusters[0].input_check_value': 'true' },
  ])
    assert.throws(() => run({ 'rep_clusters[0].input_value': 'after', ...fields }));
  assert.throws(
    () => run({ 'rep_clusters[0].input_value': 'after', 'rep_clusters[0].Verified': 'true' }),
    /Invalid cluster/,
  );
  assert.throws(() => run({ 'rep_clusters[0].input_value': 'after' }, true), /reason/);
  assert.equal(
    run({ 'rep_clusters[0].input_value': 'after', 'rep_clusters[0].ChangeReason': 'correction' }, true)[0].reason,
    'correction',
  );
  assert.throws(() => run({ 'rep_clusters[0].ChangeReason': 'reason only' }, true), /without changing/);
  assert.equal(run({ 'rep_clusters[0].input_value': 'before' }).length, 0);
  f = fixture('Check', '');
  assert.equal(run({ 'rep_clusters[0].input_check_value': 'false' }).length, 0);
  const check = run({
    'rep_clusters[0].input_check_value': ['true', 'false'],
    'rep_clusters[0].comment_value': 'checked',
  })[0];
  assert.equal(check.value, 'true');
  assert.equal(check.display, 'true');
  assert.equal(check.comment, 'checked');
  const comment = run({
    'rep_clusters[0].comment_value': 'line one\r\nline two',
    'rep_clusters[0].ChangeReason': 'reason\r\nline',
  })[0];
  assert.equal(comment.comment, 'line one\r\nline two');
  assert.equal(comment.reason, 'reason\r\nline');
  f = fixture('Check', 'FALSE');
  assert.equal(run({ 'rep_clusters[0].input_check_value': 'false' }, true).length, 0);
  f = fixture('Action', '', 'ActionType=document;FinishMessage=Viewed');
  assert.equal(run({ 'rep_clusters[0].input_check_value': 'true' })[0].display, 'Viewed');
  f = fixture('Action', '', 'ActionType=url');
  assert.throws(() => run({ 'rep_clusters[0].input_check_value': 'true' }), /not been migrated/);
  f = fixture('Select', 'A', 'Items=A,B;Labels=Alpha,Beta;Display=Labels;UseKeyboard=1');
  assert.equal(run({ 'rep_clusters[0].input_value': 'B' })[0].display, 'Beta');
  assert.throws(() => run({ 'rep_clusters[0].input_value': 'tampered' }), /Invalid cluster/);
  assert.equal(
    run({ 'rep_clusters[0].IsKeyboardInput': 'true', 'rep_clusters[0].KeyboardValue': 'free choice' })[0].display,
    'free choice',
  );
  f = fixture('Select', 'retained non-option', 'Items=A,B;Labels=Alpha,Beta;Display=Labels');
  assert.deepEqual(run({}), []);
  assert.equal(run({ 'rep_clusters[0].input_value': 'B' })[0].display, 'Beta');
  assert.throws(
    () => run({ 'rep_clusters[0].IsKeyboardInput': 'true', 'rep_clusters[0].KeyboardValue': 'not enabled' }),
    /Invalid cluster/,
  );
  f = fixture('Select', 'A', 'Items=A,B,,C;Labels=Alpha,Comma;Display=Labels');
  assert.equal(run({ 'rep_clusters[0].input_value': 'B,C' })[0].display, ',');
  f = fixture('MultipleChoiceNumber', '1', 'Items=1,2;Labels=One,Two', 'One');
  const toggle = run({ 'rep_clusters[0].input_value': 'Two' })[0];
  assert.equal(toggle.value, '2');
  assert.equal(toggle.display, 'Two');
  assert.equal(run({ 'rep_clusters[0].input_value': 'One' }).length, 0);
  f = fixture('MultiSelect', 'A,B', 'Items=A,B;Labels=Alpha,Beta;Display=Labels;Punctuation=2');
  assert.equal(run({ 'rep_clusters[0].multi_input_value': ['B', 'A'] }).length, 0);
  assert.equal(run({ 'rep_clusters[0].multi_input_value': 'B' })[0].display, 'Beta');
  assert.equal(run({})[0].value, '');
  assert.throws(() => run({ 'rep_clusters[0].multi_input_value': ['A', 'A'] }), /Invalid cluster/);
});

test('hidden, read-only, unsupported and invalid formatted controls cannot be changed through the scalar save path', () => {
  for (const [type, role, parameters] of [
    ['KeyboardText', '2', ''],
    ['KeyboardText', '0', ''],
    ['Image', '1', ''],
    ['Approve', '1', ''],
    ['InputNumeric', '1', ''],
    ['Date', '1', ''],
    ['KeyboardText', '1', 'ShowPercent=1'],
  ]) {
    const f = fixture(type, 'before', parameters, 'before', role);
    assert.throws(() =>
      documentClusterChanges({ ...f.data, 'rep_clusters[0].input_value': 'after' }, [f.row], f.sheet, false),
    );
    assert.equal(documentClusterChanges(f.data, [f.row], f.sheet, false).length, 0);
    assert.equal(f.row.input_value, 'before');
  }
});

test('image changes require server identities, preserve scalar values and give clear precedence over upload', () => {
  for (const type of ['Image', 'DrawingImage', 'FreeText']) {
    const f = fixture(type, '1');
    const bytes = Buffer.from('validated-image-fixture');
    const run = (fields: Record<string, unknown>, uploads = new Map<string, Buffer>(), reason = false) =>
      documentClusterChanges({ ...f.data, ...fields }, [f.row], f.sheet, reason, 'en-US', uploads);
    assert.equal(run({ 'rep_clusters[0].IsImageClear': 'false' }).length, 0);
    assert.equal(run({}, new Map([['1', bytes]]))[0].image, bytes);
    const clear = run(
      { 'rep_clusters[0].IsImageClear': ['true', 'false'], 'rep_clusters[0].Verified': 'true' },
      new Map([['1', bytes]]),
    )[0];
    assert.equal(clear.image, null);
    assert.equal(clear.verified, true);
    assert.equal(clear.value, '1');
    assert.throws(() => run({ 'rep_clusters[0].input_value': 'forged' }), /Invalid cluster/);
    assert.throws(() => run({ 'rep_clusters[0].Verified': 'true' }), /Invalid cluster/);
    assert.throws(() => run({ 'rep_clusters[0].Verified': 'true' }, new Map([['1', bytes]])), /Invalid cluster/);
    assert.throws(() => run({}, new Map([['1', bytes]]), true), /reason/);
    assert.equal(
      run({ 'rep_clusters[0].ChangeReason': 'new photo' }, new Map([['1', bytes]]), true)[0].reason,
      'new photo',
    );
    assert.throws(
      () => documentClusterChanges({}, [f.row], f.sheet, false, 'en-US', new Map([['1', bytes]])),
      /Invalid cluster/,
    );
    assert.throws(() => run({ 'rep_clusters[0].IsImageClear': 'bogus' }), /Invalid cluster/);
    assert.throws(() => run({ 'rep_clusters[0].cluster_id': '2' }, new Map([['1', bytes]])));
  }
  for (const role of ['0', '2']) {
    const f = fixture('Image', '1', '', '1', role);
    assert.throws(() =>
      documentClusterChanges({ ...f.data, 'rep_clusters[0].IsImageClear': 'true' }, [f.row], f.sheet, false),
    );
  }
});

test('numeric/date/time sheet edits normalize only posted values and retain server identity, bounds and verification checks', () => {
  let f = fixture('InputNumeric', '1', 'Decimal=2;Comma=1;Maximum=2000');
  const run = (values: Record<string, unknown>, reason = false) =>
    documentClusterChanges({ ...f.data, ...values }, [f.row], f.sheet, reason);
  assert.deepEqual(run({}), []);
  const numeric = run({ 'rep_clusters[0].input_value': '1234.565' })[0];
  assert.equal(numeric.value, '1234.565');
  assert.equal(numeric.display, '1,234.57');
  assert.throws(() => run({ 'rep_clusters[0].input_value': '2001' }), /minimum or maximum/);
  assert.throws(
    () => run({ 'rep_clusters[0].input_value': '2', 'rep_clusters[0].Verified': 'true' }),
    /Invalid cluster/,
  );
  assert.throws(() => run({ 'rep_clusters[0].input_value': '2', 'rep_clusters[0].cluster_id': '99' }));
  f = fixture('CalendarDate', '2026/11/09 13:14:00', 'UseTime=1;DateFormat=yyyy/MM/dd HH:mm');
  assert.deepEqual(
    run({ 'rep_clusters[0].input_value_date': '2026/11/09', 'rep_clusters[0].input_value_time': '13:14:00' }, true),
    [],
  );
  assert.equal(run({ 'rep_clusters[0].input_value_date': '2026/11/10' })[0].value, '2026/11/10 13:14:00');
  assert.equal(run({ 'rep_clusters[0].input_value_time': '15:16:59' })[0].display, '2026/11/09 15:16');
  assert.throws(() => run({ 'rep_clusters[0].input_value_date': '' }), /Invalid cluster/);
  assert.equal(run({ 'rep_clusters[0].input_value_date': '', 'rep_clusters[0].input_value_time': '' })[0].value, '');
  assert.throws(() => run({ 'rep_clusters[0].input_value_time': '24:00' }));
  assert.throws(() => run({ 'rep_clusters[0].input_value_date': '2026/11/31' }));
  f = fixture('Time', '13:14:59', 'DateFormat=HH:mm');
  assert.deepEqual(run({ 'rep_clusters[0].input_value': '13:14:00' }, true), []);
  const time = run({ 'rep_clusters[0].input_value': '14:15:59' })[0];
  assert.equal(time.value, '14:15:00');
  assert.equal(time.display, '14:15');
  f = fixture('Date', '2026/11/09', 'DateFormat=yyyy/MM/dd');
  assert.equal(run({ 'rep_clusters[0].input_value': '11/10/2026' })[0].value, '2026/11/10');
  f = fixture('Calculate', '1', 'Decimal=2');
  assert.equal(run({ 'rep_clusters[0].input_value': '2.5' }, true)[0].display, '2.50');
  f = fixture('TimeCalculate', '3600000', 'TimeCalculateType=1;InputType=Formatted;DateFormat=HH:mm');
  assert.equal(run({ 'rep_clusters[0].input_value': '5400000' }, true)[0].display, '01:30');
});
