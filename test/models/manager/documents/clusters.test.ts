import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  documentClusterInput,
  documentCheckUnchangedClusters,
} from '../../../../src/models/manager/documents/clusters.js';

const input = (cluster_type = 'Select', input_parameter = '', input_value = '', display_value = '') =>
  documentClusterInput({ cluster_type, input_parameter, input_value, display_value, cluster_role: '1' });

test('sheet selectors preserve source item/label, doubled-comma and keyboard rules', () => {
  assert.deepEqual(input('Select').options, []);
  assert.deepEqual(input('Select', 'Items=A,B,,C,;Labels=Alpha,Beta;Display=ItemsAndLabels').options, [
    { value: '', text: '' },
    { value: 'A', text: 'A - Alpha' },
    { value: 'B,C', text: 'B,C - Beta' },
  ]);
  assert.deepEqual(input('Select', 'Items=A=B,C;Items=unused;Labels=Alpha;Display=Labels').options, [
    { value: '', text: '' },
    { value: 'A', text: 'Alpha' },
  ]);
  assert.equal(input('Select', 'Items=A,B;Labels=Alpha,Beta;Display=Items').selectLabels, '');
  assert.deepEqual(input('MultiSelect', 'Items=A,B;Labels=Alpha,Beta;Display=Labels', 'A,B').options, [
    { value: 'A', text: 'Alpha' },
    { value: 'B', text: 'Beta' },
  ]);
  assert.deepEqual(input('MultiSelect', 'Items=A,B', 'A,B').multi_input_value, ['A', 'B']);
  assert.deepEqual(input('MultipleChoiceNumber', 'Items=1,2;Labels=One,Two;Display=Items', '2', 'Two').options, [
    { value: '', text: '' },
    { value: 'One', text: '1 - One' },
    { value: 'Two', text: '2 - Two' },
  ]);
  const toggle = input('MultipleChoiceNumber', 'Items=1,2;Labels=One,Two', '2', 'Two');
  assert.equal(toggle.selected, 'Two');
  assert.equal(toggle.selectItems, 'One,Two');
  assert.equal(toggle.selectLabels, '1,2');
  assert.equal(input('Select', 'Items=A,B;UseKeyboard=TRUE', 'A').isKeyboardInput, false);
  assert.equal(input('Select', 'Items=A,B;UseKeyboard=2', 'Other').keyboardValue, 'Other');
  for (const mode of ['TRUE', 'true', '1', '2'])
    assert.equal(input('Select', 'UseKeyboard=' + mode).isKeyboardEnable, true);
  for (const mode of ['0', 'false', '3', ' true '])
    assert.equal(input('Select', 'UseKeyboard=' + mode).isKeyboardEnable, false);
  assert.equal(input('Select', 'UseKeyboard=1;UseKeyboard=0').isKeyboardEnable, false);
  assert.equal(input('MultipleChoiceNumber', 'UseKeyboard=1', 'Other').isKeyboardEnable, false);
});

test('sheet datetime/check controls preserve source formats and restricted values stay out of derived controls', () => {
  const date = input('CalendarDate', 'UseTime=1', '2026/11/09 13:14:15');
  assert.equal(date.useTime, true);
  assert.equal(date.input_value_date, '2026/11/09');
  assert.equal(date.input_value_time, '13:14:15');
  assert.equal(input('Date', 'UseTime=1', '2026/02/30').input_value_date, '');
  assert.equal(input('Date', 'UseTime=true', '2026/11/09').useTime, false);
  assert.equal(input('Date', 'UseTime=0;UseTime=1', '2026/11/09').input_value_time, '00:00:00');
  for (const value of ['True', 'TRUE', 'true', '1']) assert.equal(input('Check', '', value).input_check_value, true);
  for (const value of ['False', '0', '', ' true ']) assert.equal(input('Check', '', value).input_check_value, false);
  const hidden = documentClusterInput({
    cluster_type: 'Select',
    input_parameter: 'Items=secret;UseKeyboard=1',
    input_value: 'secret',
    display_value: 'secret',
    cluster_role: '2',
  });
  assert.deepEqual(hidden.options, []);
  assert.equal(hidden.selected, '');
  assert.equal(hidden.selectItems, '');
  assert.equal(hidden.keyboardValue, '');
});

test('metadata-only sheet saves accept unchanged rendered values, not native-toggle substitutions, hidden edits or malformed posted shapes', () => {
  const row = (cluster_type: string, input_value: string, input_parameter = '', display_value = input_value) => ({
    cluster_type,
    input_value,
    input_parameter,
    display_value,
    cluster_role: '1',
    rep_sheet_id: 11,
    cluster_id: 4,
    verified: 0,
    ...input(cluster_type, input_parameter, input_value, display_value),
  });
  const rows = [
    row('MultipleChoiceNumber', '2', 'Items=1,2;Labels=One,Two', 'Two'),
    row('MultiSelect', 'A,B', 'Items=A,B'),
    row('Check', 'true'),
    row('CalendarDate', '2026/11/09 13:14:15', 'UseTime=1'),
    { ...row('KeyboardText', 'hidden'), cluster_role: '2' },
  ];
  const data = {
    'rep_clusters[0].cluster_id': '4',
    'rep_clusters[0].input_value': 'Two',
    'rep_clusters[1].multi_input_value': ['B', 'A'],
    'rep_clusters[2].input_check_value': ['true', 'false'],
    'rep_clusters[2].Verified': 'False',
    'rep_clusters[3].input_value_date': '2026/11/09',
    'rep_clusters[3].input_value_time': '13:14:15',
    'rep_clusters[4].cluster_role': '2',
    'rep_clusters[4].rep_sheet_id': '11',
  };
  assert.doesNotThrow(() => documentCheckUnchangedClusters(data, rows));
  for (const changed of [
    { 'rep_clusters[0].input_value': '2' },
    { 'rep_clusters[0].cluster_id': ['4', '999'] },
    { 'rep_clusters[1].multi_input_value': ['A', 'A', 'B'] },
    { 'rep_clusters[1].multi_input_value': { value: 'A,B' } },
    { 'rep_clusters[2].input_check_value': ['true', 'invalid'] },
    { 'rep_clusters[2].Verified': 'true' },
    { 'rep_clusters[3].input_value_time': '13:14:00' },
    { 'rep_clusters[4].input_value': 'hidden' },
    { 'rep_clusters[0].IsImageClear': 'true' },
    { 'rep_clusters[99].cluster_id': '4' },
  ])
    assert.throws(() => documentCheckUnchangedClusters({ ...data, ...changed }, rows), /Cluster editing/);
  assert.equal(rows[4].input_value, 'hidden');
});
