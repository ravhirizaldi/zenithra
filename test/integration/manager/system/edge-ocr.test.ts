import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { createApp } from '../../../helpers/app.js';
import { edgeOcrLicense } from '../../../../src/shared/license-counts.js';
import { edgeOcrLabels as labels } from '../../../../src/config/manager/system/legacy-edge-ocr-labels.js';
import {
  saveEdgeCredential,
  updateEdgeSelection,
  validateEdgeCredential,
} from '../../../../src/controllers/manager/system/edge-ocr.js';

test('EdgeOCR follows ordered legacy expiry aliases without an expiry-date gate', () => {
  const fields = new Map([
    ['EdgeOCRTokenID', 'fixture-token'],
    ['EdgeOCRLimited', '2'],
    ['EdgeOCRExpire', '20301231'],
    ['i-RepoEdgeOCRLimited', '3'],
    ['i-RepoEdgeOCRLimitedExpire', '20200101'],
  ]);
  const license = edgeOcrLicense(fields);
  assert.equal(license.enabled, true);
  assert.equal(license.limit, 3);
  assert.equal(license.expires, '20200101');
  fields.set('EdgeOCRTokenID', '');
  assert.equal(edgeOcrLicense(fields).enabled, false);
});

test('EdgeOCR selection and credential validation preserve legacy terminal rules', () => {
  assert.deepEqual(updateEdgeSelection([1, 2], '1:false,3:true,2:FALSE'), [3]);
  assert.deepEqual(updateEdgeSelection([1], ''), [1]);
  const license = { enabled: true, token: 'fixture-token', limit: 2, expires: '20300101' };
  const eligible = new Map([[1, 'database-physical']]);
  const model = {
    edgeocr_token_id: 'fixture-token',
    edgeocr_certificate: 'fixture-certificate',
    terminals: [{ terminal_id: '1', physical_id: 'uploaded-physical' }],
  };
  assert.equal(validateEdgeCredential(model, license, eligible)?.terminals[0].physical_id, 'database-physical');
  assert.equal(model.terminals[0].physical_id, 'uploaded-physical');
  assert.equal(validateEdgeCredential({ ...model, edgeocr_token_id: 'wrong' }, license, eligible), null);
  assert.equal(validateEdgeCredential({ ...model, edgeocr_certificate: '' }, license, eligible), null);
  assert.equal(validateEdgeCredential({ ...model, terminals: [] }, license, eligible), null);
  assert.equal(
    validateEdgeCredential({ ...model, terminals: [{ terminal_id: '2', physical_id: 'x' }] }, license, eligible),
    null,
  );
  assert.equal(validateEdgeCredential(model, { ...license, limit: 0 }, eligible), null);
});

test(
  'EdgeOCR credential replacement is atomic in isolated temporary tables',
  { skip: !process.env.DATABASE_URL },
  async () => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const client = await pool.connect();
    const isolated = {
      connect: async () => ({ query: client.query.bind(client), release: () => {} }),
    } as unknown as pg.Pool;
    try {
      await client.query(
        'CREATE TEMP TABLE edgeocr_info (LIKE public.edgeocr_info INCLUDING ALL); CREATE TEMP TABLE edgeocr_use_terminals (LIKE public.edgeocr_use_terminals INCLUDING ALL)',
      );
      await saveEdgeCredential(
        isolated,
        {
          edgeocr_token_id: 'fixture',
          edgeocr_certificate: 'original',
          terminals: [{ terminal_id: '1', physical_id: 'one' }],
        },
        'actor',
      );
      await assert.rejects(
        saveEdgeCredential(
          isolated,
          {
            edgeocr_token_id: 'fixture',
            edgeocr_certificate: 'replacement',
            terminals: [
              { terminal_id: '2', physical_id: 'two' },
              { terminal_id: '2', physical_id: 'duplicate' },
            ],
          },
          'actor',
        ),
      );
      assert.equal(
        (await client.query('SELECT edgeocr_certificate FROM pg_temp.edgeocr_info')).rows[0].edgeocr_certificate,
        'original',
      );
      assert.deepEqual((await client.query('SELECT term_id FROM pg_temp.edgeocr_use_terminals')).rows, [
        { term_id: 1 },
      ]);
      await saveEdgeCredential(
        isolated,
        {
          edgeocr_token_id: 'fixture',
          edgeocr_certificate: 'replacement',
          terminals: [{ terminal_id: '2', physical_id: 'two' }],
        },
        'actor',
      );
      assert.deepEqual((await client.query('SELECT term_id FROM pg_temp.edgeocr_use_terminals')).rows, [
        { term_id: 2 },
      ]);
    } finally {
      await client.query('DROP TABLE IF EXISTS pg_temp.edgeocr_info,pg_temp.edgeocr_use_terminals');
      client.release();
      await pool.end();
    }
  },
);

test(
  'installed standard license displays the legacy EdgeOCR page and no-license message',
  { skip: !process.env.DATABASE_URL || !process.env.CONMAS_TEST_PASSWORD },
  async (t) => {
    if (edgeOcrLicense().enabled) {
      t.skip('Installed license has EdgeOCR; no-license acceptance requires an unlicensed fixture.');
      return;
    }
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const server = createApp(pool).listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      assert(address && typeof address !== 'string');
      const root = `http://127.0.0.1:${address.port}/ConMasManager`;
      const login: Response = await fetch(root + '/Account/LogOn', {
        method: 'POST',
        body: new URLSearchParams({ UserName: 'conmasadmin', Password: process.env.CONMAS_TEST_PASSWORD! }),
        redirect: 'manual',
      });
      const cookie = login.headers.get('set-cookie')?.split(';')[0];
      assert(cookie);
      const page: Response = await fetch(root + '/System/EdgeOCRCredentialSetting', { headers: { cookie } });
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.ok(html.includes(labels.EdgeOCRErrorMessageNoLicense));
      assert.ok(html.includes('id="SearchTerminalBox"'));
      assert.ok(html.includes('id="edgeOCRInfo"'));
      assert.ok(!html.includes('approved license-count source'));
      const token = html.match(/name="__RequestVerificationToken" value="([^"]+)"/)?.[1];
      assert(token);
      const form = new FormData();
      form.set('__RequestVerificationToken', token);
      form.set('act', 'IMPORT');
      form.set('file1', new Blob(['{}']), 'fixture.json');
      const response: Response = await fetch(root + '/System/EdgeOCRCredentialSetting', {
        method: 'POST',
        headers: { cookie },
        body: form,
        redirect: 'manual',
      });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), '/ConMasManager/System/EdgeOCRCredentialSetting');
      for (const path of ['ConfirmEdgeOCRCredentialSetting', 'ExportEdgeOCRCertificateFile']) {
        const denied: Response = await fetch(root + '/System/' + path, { headers: { cookie }, redirect: 'manual' });
        assert.equal(denied.status, 302);
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await pool.end();
    }
  },
);
