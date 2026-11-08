import assert from 'node:assert/strict';
import { test } from 'node:test';
import { XMLParser } from 'fast-xml-parser';
import { legacyDecrypt } from '../../../../src/shared/legacy-auth.js';
import {
  buildBim360CredentialXml,
  buildBoxCredentialXml,
  validateBoxCredentialInput,
  validateGoogleCredentialJson,
} from '../../../../src/controllers/manager/system/cloud-credentials.js';

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: false });

test('Google upload validation matches the legacy JSON boundary without contacting Google', () => {
  assert.equal(validateGoogleCredentialJson('{"type":"service_account"}'), '');
  assert.match(validateGoogleCredentialJson('{bad'), /File fraud/);
  assert.match(validateGoogleCredentialJson('bad}'), /File fraud/);
  assert.equal(validateGoogleCredentialJson('[1,2]'), 'JSON format error (Violation of binding characters {}, [])');
  assert.match(validateGoogleCredentialJson('{bad json}'), /File fraud\(Illegal part: , Injustice: 1\)/);
});

test('Box and BIM360 linkage XML encrypts client secrets and retains selected projects', () => {
  const boxSecret = 'box-secret-value';
  const box = parser.parse(buildBoxCredentialXml('box-client', boxSecret, 'enterprise-7')).conmas.credential;
  assert.equal(box.clientId, 'box-client');
  assert.equal(box.enterpriseId, 'enterprise-7');
  assert.notEqual(box.clientSecret, boxSecret);
  assert.equal(legacyDecrypt(box.clientSecret, 'box4ireporter'), boxSecret);

  const bimSecret = 'bim-secret-value';
  const bim = parser.parse(
    buildBim360CredentialXml('bim-client', bimSecret, 'hub-3', ['project-1', 'project-2']),
  ).conmas;
  assert.equal(bim.credential.clientId, 'bim-client');
  assert.notEqual(bim.credential.clientSecret, bimSecret);
  assert.equal(legacyDecrypt(bim.credential.clientSecret, 'bim3604ireporter'), bimSecret);
  assert.deepEqual(
    bim.hub.projects.project.map((project: { projectId: string }) => project.projectId),
    ['project-1', 'project-2'],
  );
});

test('Box required-field validation rejects incomplete credentials', () => {
  assert.equal(validateBoxCredentialInput('', 'secret', 'enterprise'), 'Please enter Client ID.');
  assert.equal(validateBoxCredentialInput('id', '', 'enterprise'), 'Please enter Client Secret.');
  assert.equal(validateBoxCredentialInput('id', 'secret', ''), 'Please enter Enterprise ID.');
  assert.equal(validateBoxCredentialInput('id', 'secret', 'enterprise'), '');
});
