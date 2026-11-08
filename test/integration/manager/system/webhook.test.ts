import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Script } from 'node:vm';
import pg from 'pg';
import { createApp } from '../../../helpers/app.js';
import {
  parseWebhookParameters,
  serializeWebhookParameters,
  validateGeneralWebhook,
  validateWebhookSetting,
} from '../../../../src/controllers/manager/system/webhook.js';

test('classic webhook parameters round-trip through legacy XML', () => {
  const parameters = [
    { paramType: 'def_top_id', paramContent: '{def_top_id}' },
    { paramType: 'login_user_id', paramContent: 'user & {login_user_id}' },
  ];
  assert.deepEqual(parseWebhookParameters(serializeWebhookParameters(parameters)), parameters);
});

test('classic webhook validation matches required fields only', () => {
  const errors = validateWebhookSetting({
    webhook_to: 'Other',
    webhook_name: 'Notify',
    webhook_url: 'https://example.test/hook',
    webhook_request: 'POST',
    retry_cnt: 1,
    webhookParams: [
      { paramType: 'def_top_id', paramContent: '' },
      { paramType: 'def_top_id', paramContent: '{def_top_id}' },
    ],
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(
    validateWebhookSetting({
      webhook_to: 'Other',
      webhook_name: ' ',
      webhook_url: '',
      webhook_request: '',
      retry_cnt: 1,
      webhookParams: [],
    }),
    ['Webhook notification setting name is required.', 'Webhook URL is required.', 'Webhook request is required.'],
  );
});

test('general webhook validation allows empty optional rows and requires complete pairs', () => {
  const model = {
    WebhookTo: 'General',
    WebhookName: 'Custom endpoint',
    Endpoint: 'https://example.test/hook',
    HttpMethod: 'POST',
    RetryCount: 1,
    GeneralRequestItem: {
      Params: [{ Key: '', Value: '' }],
      Authentication: { Type: 'None', Username: '', Password: '', Token: '' },
      AuthorizationHeader: { Key: '', Value: '' },
      Headers: [{ Key: '', Value: '' }],
      Body: { Type: 'None', Items: [{ Key: '', Value: '' }], Raw: '', RawContentType: 'text/plain' },
    },
  };
  assert.deepEqual(validateGeneralWebhook(model), []);
  model.GeneralRequestItem.Params[0] = { Key: 'mode', Value: '' };
  assert.equal(
    validateGeneralWebhook(model).some((error) => error.includes('Params[0]')),
    true,
  );
});

test(
  'all five Webhook settings layouts use original panels, labels, icons and configured paging',
  { skip: !process.env.DATABASE_URL || !process.env.CONMAS_TEST_PASSWORD },
  async () => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }),
      client = await pool.connect();
    const db = {
      query: (text: string, values?: unknown[]) => {
        if (/\bmst_webhook\b|mst_webhook_id_seq/.test(text)) return client.query(text, values);
        if (text.includes("com_key='PAGE_SIZE'"))
          return Promise.resolve({ rows: [20, 50, 100, 200, 500].map((value) => ({ com_value: String(value) })) });
        return pool.query(text, values);
      },
      connect: async () => ({ query: client.query.bind(client), release: () => {} }),
    } as unknown as pg.Pool;
    let server: ReturnType<ReturnType<typeof createApp>['listen']> | undefined;
    try {
      await client.query(`CREATE TEMP TABLE mst_webhook (LIKE public.mst_webhook INCLUDING ALL);
      CREATE TEMP TABLE user_lock (LIKE public.user_lock INCLUDING ALL);
      CREATE TEMP SEQUENCE mst_webhook_id_seq START 100;`);
      assert.equal(
        (
          await client.query(
            "SELECT 'mst_webhook_id_seq'::regclass::oid='pg_temp.mst_webhook_id_seq'::regclass::oid AS private",
          )
        ).rows[0].private,
        true,
      );
      const parameters = serializeWebhookParameters([
        { paramType: 'def_top_id', paramContent: '{def_top_id}' },
        { paramType: 'rep_top_id', paramContent: '{rep_top_id}' },
        { paramType: 'login_user_id', paramContent: '{login_user_id}' },
      ]);
      await client.query(
        "INSERT INTO pg_temp.mst_webhook (webhook_id,webhook_to,webhook_name,webhook_url,webhook_request,webhook_paramtype,retry_cnt) VALUES (1,'Other','Fixture <safe>','https://example.invalid/hook','POST',$1,1),(2,'Nocoder','Link','https://example.invalid/link','POST',$1,1)",
        [parameters],
      );
      server = createApp(db).listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server!.once('listening', resolve));
      const address = server.address();
      assert(address && typeof address !== 'string');
      const root = `http://127.0.0.1:${address.port}/ConMasManager`;
      const login = await fetch(root + '/Account/LogOn', {
        method: 'POST',
        body: new URLSearchParams({ UserName: 'conmasadmin', Password: process.env.CONMAS_TEST_PASSWORD! }),
        redirect: 'manual',
      });
      const cookie = login.headers.get('set-cookie')?.split(';')[0];
      assert(cookie);
      const get = async (path: string) => {
        const response = await fetch(root + '/System/' + path, { headers: { cookie } });
        assert.equal(response.status, 200, path);
        const html = await response.text();
        assert.equal((html.match(/id="DetailTop"/g) || []).length, 1, path);
        assert.match(html, /id="infoTitle"/);
        assert.doesNotMatch(html, /<section class="PageSection"|class="DetailTop"|class="DetailTopRight"/);
        for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) new Script(script[1]);
        return html;
      };
      const list = await get('WebhookList');
      assert.match(list, />Webhook List</);
      assert.match(list, /Webhook notification address/);
      assert.match(list, /Setting name/);
      assert.match(list, /page_prev_d.png/);
      assert.match(list, /page_next_d.png/);
      assert.match(list, /Fixture &lt;safe&gt;/);
      assert.match(list, /i-Repo Link/);
      assert.match(list, /<option value="500"/);
      assert.doesNotMatch(list, /Rows per page/);
      const token = list.match(/name="__RequestVerificationToken" value="([^"]+)"/)?.[1];
      assert(token);
      const detail = await get('WebhookChat?id=1');
      assert.match(detail, /id="webhookSetting"/);
      assert.match(detail, /id="webhookNotification"/);
      assert.match(detail, /Application linkage setting/);
      assert.match(detail, /Without notification/);
      assert.equal((detail.match(/class="img_edit"/g) || []).length, 2);
      const regular = await get('EditWebhookSetting?id=1');
      assert.match(regular, /Application linkage settingEdit/);
      assert.match(regular, /Webhook notification setting name/);
      assert.match(regular, /FormsID/);
      assert.match(regular, /name="webhookParameter.parameters\[2\].paramType"/);
      assert.match(regular, /style="float:right;"/);
      assert.match(regular, /value="Confirm"/);
      const general = await get('EditWebhookSettingGeneral?id=-1');
      assert.match(general, /fontawesome-free-5.14.0-web\/css\/all.min.css/);
      assert.match(general, /fa-minus-square/);
      assert.match(general, /width:280px/);
      assert.match(general, /width:610px/);
      for (const field of ['Params', 'Headers', 'Body.Items'])
        assert.ok(general.includes(`name="GeneralRequestItem.${field}[0].Key"`));
      assert.match(general, /id="generalShowPassword"/);
      assert.match(general, /cols="78"/);
      const endpointScript = general
        .split('\n')
        .find((line) => line.startsWith("document.getElementById('Endpoint').addEventListener"));
      assert(endpointScript);
      const queryRows: Array<{ inputs: Array<{ value: string }>; querySelectorAll: () => Array<{ value: string }> }> =
        [];
      const container = {
        children: queryRows,
        replaceChildren: () => {
          queryRows.length = 0;
        },
        get lastElementChild() {
          return queryRows.at(-1);
        },
      };
      let onEndpointChange: ((event: { target: { value: string } }) => void) | undefined;
      new Script(endpointScript).runInNewContext({
        document: {
          getElementById: (id: string) =>
            id === 'Endpoint'
              ? {
                  addEventListener: (_event: string, handler: typeof onEndpointChange) => {
                    onEndpointChange = handler;
                  },
                }
              : container,
        },
        generalAddRow: () => {
          const inputs = [{ value: '' }, { value: '' }];
          queryRows.push({ inputs, querySelectorAll: () => inputs });
        },
      });
      const endpointEvent = { target: { value: 'https://example.invalid/hook?first=one&second=two=three' } };
      assert(onEndpointChange);
      onEndpointChange(endpointEvent);
      assert.equal(endpointEvent.target.value, 'https://example.invalid/hook?first=one&second=two=three');
      assert.deepEqual(
        queryRows.map((row) => row.inputs.map((input) => input.value)),
        [
          ['first', 'one'],
          ['second', 'two=three'],
        ],
      );
      const notification = await get('EditWebhookNotification?id=1');
      assert.match(notification, /Notification SettingsEdit/);
      assert.equal((notification.match(/type="radio"/g) || []).length, 24);
      assert.match(notification, /id="image-cancel_btn"/);
      const paging = new URLSearchParams({
        __RequestVerificationToken: token,
        'PageData.PageSize': '200',
        'PageData.PageIndex': '-1',
      });
      paging.append('PageData.PageSize', '200');
      const paged = await fetch(root + '/System/WebhookList', { method: 'POST', headers: { cookie }, body: paging });
      assert.equal(paged.status, 200);
      assert.equal(((await paged.text()).match(/value="200" selected/g) || []).length, 2);
      const form = new URLSearchParams({
        __RequestVerificationToken: token,
        WebhookId: '-1',
        WebhookTo: 'General',
        WebhookName: 'General fixture',
        Endpoint: 'https://example.invalid/general',
        HttpMethod: 'POST',
        RetryCount: '1',
        'GeneralRequestItem.Authentication.Type': 'None',
        'GeneralRequestItem.Body.Type': 'Raw',
        'GeneralRequestItem.Body.Raw': 'fixture & <body>',
        'GeneralRequestItem.Body.RawContentType': 'text/plain',
      });
      const saved = await fetch(root + '/System/EditWebhookSettingGeneral', {
        method: 'POST',
        headers: { cookie },
        body: form,
        redirect: 'manual',
      });
      assert.equal(saved.status, 302);
      const generalDetail = await get('WebhookChat?id=100');
      assert.match(generalDetail, /Endpoint \(URL\)/);
      assert.match(generalDetail, /HTTP Method/);
      assert.match(generalDetail, /fixture &amp; &lt;body&gt;/);
      assert.match(generalDetail, /white-space:pre-wrap/);
      const notice = new URLSearchParams({
        __RequestVerificationToken: token,
        webhook_id: '1',
        apply: 'true',
        complete: 'false',
      });
      const changed = await fetch(root + '/System/EditWebhookNotification', {
        method: 'POST',
        headers: { cookie },
        body: notice,
        redirect: 'manual',
      });
      assert.equal(changed.status, 302);
      assert.equal(
        (await client.query('SELECT apply FROM pg_temp.mst_webhook WHERE webhook_id=1')).rows[0].apply,
        true,
      );
      notice.set('__RequestVerificationToken', 'bad');
      assert.equal(
        (await fetch(root + '/System/EditWebhookNotification', { method: 'POST', headers: { cookie }, body: notice }))
          .status,
        403,
      );
      const regularForm = new URLSearchParams({
        __RequestVerificationToken: token,
        webhook_id: '-1',
        webhook_to: 'Other',
        webhook_name: 'Created fixture',
        webhook_url: 'https://example.invalid/new',
        webhook_request: 'POST',
        retry_cnt: '1',
      });
      const submitRegular = () =>
        fetch(root + '/System/EditWebhookSetting', {
          method: 'POST',
          headers: { cookie },
          body: regularForm,
          redirect: 'manual',
        });
      regularForm.set('act', 'addParam');
      const added = await submitRegular();
      assert.equal(added.status, 200);
      assert.match(await added.text(), /name="webhookParameter.parameters\[1\].paramType"/);
      regularForm.set('act', 'initParam');
      regularForm.set('webhook_to', 'Workflow');
      const workflow = await submitRegular();
      assert.equal(workflow.status, 200);
      assert.match(await workflow.text(), /name="webhookParameter.parameters\[2\].paramType"/);
      regularForm.set('act', '');
      regularForm.set('webhook_to', 'Other');
      const created = await submitRegular();
      assert.equal(created.status, 302);
      assert.equal(created.headers.get('location'), '/ConMasManager/System/WebhookChat?id=101');
      regularForm.set('webhook_id', '101');
      regularForm.set('webhook_name', 'Edited fixture');
      assert.equal((await submitRegular()).status, 302);
      assert.equal(
        (await client.query('SELECT webhook_name FROM pg_temp.mst_webhook WHERE webhook_id=101')).rows[0].webhook_name,
        'Edited fixture',
      );
      const remove = new URLSearchParams({
        __RequestVerificationToken: token,
        act: 'delete',
        'webhookList[0].IsSelect': 'true',
        'webhookList[0].webhookId': '101',
      });
      const removed = await fetch(root + '/System/WebhookList', { method: 'POST', headers: { cookie }, body: remove });
      assert.equal(removed.status, 200);
      assert.equal((await client.query('SELECT 1 FROM pg_temp.mst_webhook WHERE webhook_id=101')).rowCount, 0);
      const cancel = new URLSearchParams({
        __RequestVerificationToken: token,
        webhook_id: '1',
        isCanceled: 'true',
        apply: 'false',
      });
      assert.equal(
        (
          await fetch(root + '/System/EditWebhookNotification', {
            method: 'POST',
            headers: { cookie },
            body: cancel,
            redirect: 'manual',
          })
        ).status,
        302,
      );
      assert.equal(
        (await client.query('SELECT apply FROM pg_temp.mst_webhook WHERE webhook_id=1')).rows[0].apply,
        true,
      );
    } finally {
      if (server)
        await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
      await client.query(
        'DROP TABLE IF EXISTS pg_temp.mst_webhook,pg_temp.user_lock; DROP SEQUENCE IF EXISTS pg_temp.mst_webhook_id_seq',
      );
      client.release();
      await pool.end();
    }
  },
);
