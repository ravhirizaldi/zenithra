import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mailModel, updateMail, validateMail } from '../../../../src/controllers/manager/system/mail.js';

test('mail settings preserve the SMTP password and query definitions when no replacement is supplied', () => {
  const document = {
    mail: {
      managerRoot: '',
      smtp: { server: 'old', port: '587', user: 'user', pass: 'existing', ssl: 'false' },
      notification: {},
      signature: '',
      formQuery: { existing: 'keep' },
      oauth: { provider: 'google', user: 'old-user' },
    },
  };
  const result = updateMail(document, {
    'mailBase.server': 'new',
    'mailBase.port': '587',
    'mailBase.user': 'user',
    'mailBase.ssl': 'true',
    'mailBase.notification_def_apply': 'true',
  });
  assert(result.mail.smtp);
  assert.equal(result.mail.smtp.pass, 'existing');
  assert.deepEqual(result.mail.formQuery, { existing: 'keep' });
  assert.equal(result.mail.oauth, undefined);
  assert.equal(mailModel(result).notification_def_apply, true);
  assert.equal(mailModel(result).ssl, true);
});

test('mail validation retains SMTP port and OAuth requirements from C#', () => {
  const smtp = { 'mailBase.server': 'mail.example.test', 'mailBase.user': 'user', 'mailBase.port': '465' };
  assert.match(validateMail(smtp), /465/);
  assert.equal(validateMail({ ...smtp, 'mailBase.port': '587' }), '');
  const oauth = {
    'mailBase.UseOAuth': 'true',
    'mailBase.OAuthProvider': 'microsoft',
    'mailBase.OAuthClientId': 'id',
    'mailBase.OAuthClientSecret': 'secret',
  };
  assert.notEqual(validateMail(oauth), '');
  assert.equal(validateMail({ ...oauth, 'mailBase.OAuthTenantId': 'tenant' }), '');
});
