import assert from 'node:assert/strict';
import { test } from 'node:test';
import type pg from 'pg';
import {
  documentAllRequired,
  checkDocumentCompletionFeatures,
} from '../../../../src/models/manager/documents/completion.js';
import { must, root } from '../../../../src/models/client-definition-xml.js';

const cluster = (overrides: Partial<Parameters<typeof documentAllRequired>[0][number]> = {}) => ({
  rep_sheet_id: 1,
  cluster_type: 'Text',
  input_parameter: 'Required=true',
  input_value: '',
  verified: null,
  has_image: false,
  ...overrides,
});

test('completion requires ordinary values, actual image bytes and completed required approvals, with verification exemptions', () => {
  assert.equal(documentAllRequired([]), true);
  for (const type of ['Text', 'Numeric', 'Calculate', 'Date', 'AudioRecording']) {
    assert.equal(documentAllRequired([cluster({ cluster_type: type })]), false);
    assert.equal(documentAllRequired([cluster({ cluster_type: type, input_value: '0' })]), true);
    assert.equal(documentAllRequired([cluster({ cluster_type: type, input_value: ' ' })]), true);
    assert.equal(documentAllRequired([cluster({ cluster_type: type, verified: '1' })]), true);
  }
  for (const type of ['FixedText', 'Image', 'DrawingImage', 'FreeText', 'FreeDraw']) {
    assert.equal(documentAllRequired([cluster({ cluster_type: type, input_value: 'preview' })]), false);
    assert.equal(documentAllRequired([cluster({ cluster_type: type, has_image: true })]), true);
    assert.equal(documentAllRequired([cluster({ cluster_type: type, verified: '1' })]), true);
  }
  for (const value of [null, '', '1', '2', '3'])
    assert.equal(documentAllRequired([cluster({ cluster_type: 'Approve', input_value: value })]), false);
  assert.equal(documentAllRequired([cluster({ cluster_type: 'Approve', input_value: '4' })]), true);
  assert.equal(documentAllRequired([cluster({ cluster_type: 'Approve', input_parameter: null })]), true);
  assert.equal(documentAllRequired([cluster({ cluster_type: 'Approve', input_parameter: null })], true), false);
  assert.equal(
    documentAllRequired([cluster({ cluster_type: 'Approve', input_parameter: null, verified: '1' })], true),
    true,
  );
});

test('ordinary required detection preserves legacy substring/case rules rather than changing old forms', () => {
  for (const parameters of ['Required=true', 'Required=1', 'OtherRequired=true', 'Required=10'])
    assert.equal(documentAllRequired([cluster({ input_parameter: parameters })]), false);
  for (const parameters of ['Required=TRUE', 'required=true', '', null])
    assert.equal(documentAllRequired([cluster({ input_parameter: parameters })]), true);
});

test('checkbox completion is sheet/group scoped, includes optional peers and accepts verified peers', () => {
  const required = cluster({ cluster_type: 'Check', input_parameter: 'Group=A;Required=TRUE', input_value: 'false' });
  const peer = cluster({ cluster_type: 'Check', input_parameter: 'Group=A', input_value: 'TrUe' });
  assert.equal(documentAllRequired([required]), false);
  assert.equal(documentAllRequired([required, peer]), true);
  assert.equal(documentAllRequired([required, { ...peer, rep_sheet_id: 2 }]), false);
  assert.equal(documentAllRequired([required, { ...peer, input_parameter: 'Group=B' }]), false);
  assert.equal(documentAllRequired([required, { ...peer, input_value: '', verified: '1' }]), true);
  assert.equal(documentAllRequired([required, { ...peer, input_parameter: null }]), false);
  assert.equal(
    documentAllRequired([
      { ...required, input_parameter: 'Required=1' },
      { ...peer, input_parameter: 'Required=false' },
    ]),
    false,
  );
  assert.equal(documentAllRequired([{ ...required, input_parameter: 'Required=1', verified: '1' }]), true);
  assert.equal(
    documentAllRequired([{ ...required, input_parameter: 'Group=A;Group=B;Required=TRUE;Required=false' }, peer]),
    false,
  );
});

test('completion checks only completion events and refuses configured dependent pipelines', async () => {
  const top = (extra = '') =>
    must(root('<conmas><top><repTopId>1</repTopId><defTopId>1</defTopId><sheets/>' + extra + '</top></conmas>'), 'top');
  const db = (match = '', rows: Record<string, unknown>[] = []) =>
    ({
      query: async (sql: string) => ({
        rows: match && sql.includes(match) ? rows : [],
        rowCount: match && sql.includes(match) ? rows.length : 0,
      }),
    }) as unknown as pg.Pool;
  await checkDocumentCompletionFeatures(
    db(),
    1,
    top(
      '<editMail>retained</editMail><management><editDirect>retained</editDirect><editWebhook>retained</editWebhook></management>',
    ),
    '0',
    '',
  );
  await checkDocumentCompletionFeatures(db(), 1, top('<useAutoNumbering>1</useAutoNumbering>'), '0', '');
  await assert.rejects(checkDocumentCompletionFeatures(db('binder_rep_src', [{}]), 1, top(), '0', ''), /binder/);
  await assert.rejects(
    checkDocumentCompletionFeatures(
      db('OUTPUT_SETTING', [{ com_name: 'FINISH', com_value: 'true' }]),
      1,
      top(),
      '1',
      '',
    ),
    /output/,
  );
  await checkDocumentCompletionFeatures(
    db('OUTPUT_SETTING', [{ com_name: 'FINISH', com_value: 'true' }]),
    1,
    top(),
    '0',
    '',
  );
  await assert.rejects(checkDocumentCompletionFeatures(db(), 1, top(), '0', 'selected'), /mail/);
  await assert.rejects(
    checkDocumentCompletionFeatures(db('mst_mail', [{ xml_data: '<mail default="selected"/>' }]), 1, top(), '0', ''),
    /mail/,
  );
  await assert.rejects(
    checkDocumentCompletionFeatures(
      db(),
      1,
      top('<management><completeWebhook>1</completeWebhook></management>'),
      '0',
      '',
    ),
    /notification/,
  );
  await assert.rejects(
    checkDocumentCompletionFeatures(
      db('mst_direct', [{ xml_data: '<direct><defaultTemplateId>1</defaultTemplateId></direct>' }]),
      1,
      top(),
      '0',
      '',
    ),
    /notification/,
  );
  await assert.rejects(
    checkDocumentCompletionFeatures(db('data_output_layout', [{ auto_output_layout: '<layout/>' }]), 1, top(), '1', ''),
    /interface/,
  );
  await assert.rejects(
    checkDocumentCompletionFeatures(db('def_external_output', [{}]), 1, top(), '1', ''),
    /external_output/,
  );
  await assert.rejects(
    checkDocumentCompletionFeatures(
      db('data_output_layout', [
        {
          cooperation_view_output_layout:
            '<layout><top><views><view><mbcloud><enabled>1</enabled></mbcloud></view></views></top></layout>',
        },
      ]),
      1,
      top(),
      '0',
      '',
    ),
    /cloud_notification/,
  );
});
