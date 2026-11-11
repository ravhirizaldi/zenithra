import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentOutputName, documentCsvLines } from '../../../../src/models/manager/documents/output.js';

test('report download names preserve source tokens, status text and prohibited-character/plus replacement', () => {
  const settings = {
    BASE_FOLDER: 'server-only-folder',
    BASE_FILE:
      '{date}_{dateTime}_{time}_{defTopId}_{defTopName}_{repTopId}_{repTopName}_{repTopOrg}_{repRevNo}_{publicStatus}_{editStatus}_{defTopOrg}_{defRevNo}_{remarks1}_{remarks10}',
    DATE_FORMAT: 'yyyyMMdd',
    DATETIME_FORMAT: 'yyyyMMddHHmmss',
    TIME_FORMAT: 'HHmmss',
  };
  const report = {
    def_top_id: 10,
    def_top_name: 'Form/name',
    rep_top_id: 20,
    rep_top_name: 'Report:\r\n<name>',
    rep_top_org: 19,
    rev_no: 3,
    public_status: 2,
    edit_refer_status: 4,
    def_top_org: 9,
    def_rev_no: 2,
    top_remarks1: 'a\tb',
    top_remarks10: '＋+',
  };
  const now = new Date(2026, 10, 11, 9, 8, 7);
  assert.equal(
    documentOutputName(settings, report, now, 'en-US'),
    '20261111_20261111090807_090807_10_Form_name_20_Report___name__19_3_Published_Completed_9_2_a_b_＋+',
  );
  assert.equal(
    documentOutputName(
      { ...settings, BASE_FILE: 'a＋+b', DOBLE_ESCAPE_EEQUENCE_STRING_RENAME: '1' },
      report,
      now,
      'en-US',
    ),
    'a__b',
  );
  assert.equal(documentOutputName({ BASE_FILE: '{repTopId}' }, report, now, 'en-US'), '{repTopId}');
  assert.equal(documentOutputName({}, report, now, 'en-US'), '');
  assert.equal(documentOutputName({ BASE_FILE: '../unsafe\u0000name' }, report, now, 'en-US'), '.._unsafe_name');
  assert.throws(() => documentOutputName({ ...settings, DATE_FORMAT: 'unsupported' }, report, now, 'en-US'));
});

test('standard report CSV preserves source values, display mode, omissions, media names and single/multiple-sheet columns', () => {
  const report = { rep_sheet_count: 1, no_need_to_fill_string: 'N/A' };
  const row = {
    rep_sheet_no: 3,
    cluster_id: 1,
    cluster_name: 'a"b',
    cluster_type: 'KeyboardText',
    input_value: 'input,\n"x"',
    display_value: 'Display',
    verified: '0',
  };
  assert.equal(documentCsvLines(report, [row], '', 'en-US', false).csv, '"1","a""b","input,\n""x"""\r\n');
  assert.equal(
    documentCsvLines({ ...report, rep_sheet_count: 2 }, [row], '3', 'en-US', false).csv,
    '"3","1","a""b","Display"\r\n',
  );
  assert.equal(documentCsvLines(report, [{ ...row, display_value: null }], '3', 'en-US', false).csv, '\r\n');
  for (const [cluster_type, input_value, expected] of [
    ['Check', 'false', 'N/A'],
    ['Approve', '0', '0'],
    ['Approve', '', 'N/A'],
    ['KeyboardText', '', 'N/A'],
  ] as const) {
    assert.equal(
      documentCsvLines(report, [{ ...row, cluster_type, input_value, verified: '1' }], '', 'en-US', false).csv,
      `"1","a""b","${expected}"\r\n`,
    );
  }
  const image = { ...row, cluster_type: 'Image', image_file: Buffer.from('private original bytes') };
  const audio = {
    ...row,
    cluster_id: 2,
    cluster_type: 'AudioRecording',
    recording_file: Buffer.from('private audio bytes'),
  };
  const files = documentCsvLines(report, [image, audio], '', 'en-US', true);
  assert.equal(files.csv, '"1","a""b","3_cluster_1.png"\r\n"2","a""b","3_cluster_2.m4a"\r\n');
  assert.deepEqual(files.entries, [
    { name: '3_cluster_1.png', data: image.image_file },
    { name: '3_cluster_2.m4a', data: audio.recording_file },
  ]);
  assert.equal(documentCsvLines(report, [image], '', 'en-US', false).entries.length, 0);
  assert.equal(
    documentCsvLines(report, [{ ...image, image_file: null, input_value: '', verified: '1' }], '', 'en-US', true).csv,
    '"1","a""b","N/A"\r\n"1","a""b","N/A"\r\n',
  );
  assert.throws(() => documentCsvLines(report, [{ ...audio, recording_file_extension: '../file' }], '', 'en-US', true));
});

test('standard CSV resolves current audit names and original date formats instead of stale stored cluster values', () => {
  const now = new Date(2026, 10, 11, 9, 8, 7);
  const report = {
    rep_sheet_count: 1,
    sys_regist_user: 'creator',
    current_regist_name: 'Current creator',
    sys_update_user: 'editor',
    current_update_name: 'Current editor',
    sys_regist_time: now,
    sys_update_time: now,
  };
  const row = { cluster_id: 1, cluster_name: 'Audit', cluster_type: 'Registration', input_value: 'stale' };
  for (const [input_parameter, value] of [
    ['', 'Current creator'],
    ['DisplayUserName=UserID', 'creator'],
    ['DisplayUserName=UserIDandName', 'creator:Current creator'],
  ])
    assert.equal(
      documentCsvLines(report, [{ ...row, input_parameter }], '', 'en-US', false).csv,
      `"1","Audit","${value}"\r\n`,
    );
  assert.equal(
    documentCsvLines(report, [{ ...row, cluster_type: 'LatestUpdate' }], '3', 'en-US', false).csv,
    '"1","Audit","Current editor"\r\n',
  );
  assert.equal(
    documentCsvLines(
      report,
      [{ ...row, cluster_type: 'RegistrationDate', input_parameter: 'DateFormat=yyyy/MM/dd HH:mm:ss' }],
      '3',
      'en-US',
      false,
    ).csv,
    '"1","Audit","2026/11/11 09:08:07"\r\n',
  );
});
