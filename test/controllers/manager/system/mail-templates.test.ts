import assert from 'node:assert/strict';
import { test } from 'node:test';
import { saveTemplate, templateModel } from '../../../../src/controllers/manager/system/mail-templates.js';
import type { MailDocument } from '../../../../src/controllers/manager/system/mail.js';

test('editing a template preserves other locales and clears a removed default', () => {
  const document: MailDocument = {
    mail: {
      '@_default': 'one',
      '@_version': 'preserve',
      untouched: { value: 'keep' },
      template: [
        {
          '@_id': 'one',
          '@_priority': 'Normal',
          name: [
            { '@_locale': 'ja-JP', '#text': 'original' },
            { '@_locale': 'en-US', '#text': 'old' },
          ],
          form: {
            subject: [{ '@_locale': 'en-US', '#text': 'subject' }],
            body: [{ '@_locale': 'en-US', '#text': 'body' }],
          },
          send: {},
          formQuery: { '@_type': 'query' },
        },
      ],
    },
  };
  saveTemplate(
    document,
    {
      id: 'one',
      name: 'updated',
      subject: 'subject',
      body: 'body',
      priority: 'High',
      defaultTemp: false,
      tos: [
        { type: 'direct', value: 'user@example.test' },
        { type: 'login_user', value: 'ignored' },
      ],
      ccs: [],
      bccs: [],
    },
    'en-US',
    false,
    'query',
  );
  assert.equal(document.mail['@_default'], '');
  assert.equal(document.mail['@_version'], 'preserve');
  assert.deepEqual(document.mail.untouched, { value: 'keep' });
  assert(Array.isArray(document.mail.template));
  assert.equal(document.mail.template[0].name[0]['#text'], 'original');
  const model = templateModel(document.mail.template[0], '');
  assert.equal(model.name, 'updated');
  assert.equal(model.priority, 'High');
  assert.deepEqual(model.tos, [
    { type: 'direct', value: 'user@example.test' },
    { type: 'login_user', value: '' },
  ]);
});

test('creating a template preserves mail XML and writes localized defaults and addresses', () => {
  const document: MailDocument = { mail: { '@_version': 'preserve', untouched: 'keep', template: [] } };
  const id = saveTemplate(
    document,
    {
      name: '新規',
      subject: '件名',
      body: '本文',
      priority: 'Low',
      defaultTemp: true,
      tos: [
        { type: 'direct', value: 'to@example.test' },
        { type: 'applicant', value: '' },
        { type: 'direct', value: '' },
      ],
      ccs: [],
      bccs: [],
    },
    'ja-JP',
    true,
    'queryStandard',
  );
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(document.mail['@_default'], id);
  assert.equal(document.mail['@_version'], 'preserve');
  assert.equal(document.mail.untouched, 'keep');
  assert(Array.isArray(document.mail.template));
  const node = document.mail.template[0];
  assert.equal(node.formQuery['@_type'], 'queryStandard');
  assert.deepEqual(node.name, [{ '@_locale': 'ja-JP', '#text': '新規' }]);
  assert.deepEqual(node.send.to.address, [
    { '@_type': 'direct', '#text': 'to@example.test' },
    { '@_type': 'applicant', '#text': '' },
  ]);
  assert.equal(templateModel(node, id, 'ja-JP').subject, '件名');
});
