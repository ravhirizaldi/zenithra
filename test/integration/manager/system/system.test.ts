import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { createApp } from '../../../helpers/app.js';
import { licenseStatus, readLicenseFields } from '../../../../src/shared/license-counts.js';

test(
  'System lists local groups, devices, and visible Common Master settings',
  { skip: !process.env.DATABASE_URL || !process.env.CONMAS_TEST_PASSWORD || !process.env.CONMAS_LEGACY_KEY },
  async () => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const server = createApp(pool).listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      assert(address && typeof address !== 'string');
      const root = `http://127.0.0.1:${address.port}/ConMasManager/System`;
      const login = await fetch(`${root}/../Account/LogOn`, {
        method: 'POST',
        body: new URLSearchParams({ UserName: 'conmasadmin', Password: process.env.CONMAS_TEST_PASSWORD! }),
        redirect: 'manual',
      });
      assert.equal(login.status, 302);
      const cookie = login.headers.get('set-cookie')?.split(';')[0];
      assert(cookie);
      const headers = { cookie };

      const groups = await fetch(`${root}/GroupList`, { headers });
      assert.equal(groups.status, 200);
      assert.match(await groups.text(), /Group Name/);

      const devices = await fetch(`${root}/TermList`, { headers });
      const devicesHtml = await devices.text();
      assert.equal(devices.status, 200);
      assert.match(devicesHtml, /id="term-list-form"/);
      assert.match(devicesHtml, /Device ID/);

      const common = await fetch(`${root}/ComList`, { headers });
      const commonHtml = await common.text();
      assert.equal(common.status, 200);
      assert.match(commonHtml, /DetailsCom\?id=/);
      assert.doesNotMatch(commonHtml, />CLOUD_SETTING</);
      assert.doesNotMatch(commonHtml, />PASSWORD_ENCRYPTION</);

      const filtered = await fetch(`${root}/ComList?com_key=__missing__`, { headers });
      assert.equal(filtered.status, 200);
      assert.doesNotMatch(await filtered.text(), /DetailsCom\?id=/);
      const mail = await fetch(`${root}/MailList`, { headers });
      assert.equal(mail.status, 200);
      const mailHtml = await mail.text();
      assert.match(mailHtml, /Details\?mode=mail&amp;act=edit/);
      assert.match(mailHtml, /Details\?mode=mail&amp;act=temp&amp;id=/);
      const mailEdit = await fetch(`${root}/Details?mode=mail&act=edit`, { headers });
      assert.equal(mailEdit.status, 200);
      assert.match(await mailEdit.text(), /mailBase.notification_def_apply/);
      const createTemplate = await fetch(`${root}/CreateMailTemplate?id=Apply`, { headers });
      assert.equal(createTemplate.status, 200);
      assert.match(await createTemplate.text(), /mailTemp.tos\[9\].type/);

      for (const path of ['DetailsLicense', 'UploadLicense']) {
        const license = await fetch(`${root}/${path}`, { headers });
        assert.equal(license.status, 200);
        const html = await license.text();
        assert.match(html, /Number of users/);
        assert.match(html, /Option license/);
        assert.doesNotMatch(
          html,
          /License information is unavailable|counts only|access is limited to license counts|require FreeDrawOnly license data/,
        );
        assert.equal(html.includes('/System/IrfdTemplateList'), licenseStatus().hasFreeDrawLicense);
        assert.equal(html.includes('Limitation of excel form creation'), readLicenseFields().get('Excel') === '0');
        if (path === 'UploadLicense') assert.match(html, /name="uploadLicenseFile"/);
        else assert.match(html, /id="conmasStrageContent"/);
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await pool.end();
    }
  },
);
