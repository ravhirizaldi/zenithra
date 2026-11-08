import 'dotenv/config';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Script } from 'node:vm';
import { test } from 'node:test';
import pg from 'pg';
import { createApp } from '../../../helpers/app.js';

test(
  'Webhook transmission history maps layout, filters, paging, CSV, deletion and resend to isolated data',
  { skip: !process.env.DATABASE_URL || !process.env.CONMAS_TEST_PASSWORD },
  async () => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }),
      client = await pool.connect();
    let downloadLimit = 1;
    let encoding = '65001';
    let sent = 0;
    let fail = false;
    const requests: string[] = [];
    const captured: Array<{ method: string; authorization: string; contentType: string; body: string; url: string }> =
      [];
    const endpoint = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        sent++;
        requests.push(req.url || '');
        captured.push({
          method: req.method || '',
          authorization: req.headers.authorization || '',
          contentType: req.headers['content-type'] || '',
          body: Buffer.concat(chunks).toString(),
          url: req.url || '',
        });
        res.writeHead(fail ? 500 : 200);
        res.end('fixture');
      });
    }).listen(0, '127.0.0.1');
    const queries: string[] = [];
    const db = {
      query: (text: string, values?: unknown[]) => {
        if (
          text.includes('conmas_webhook_send_log') ||
          text.includes('conmas_webhook_send_history_seq') ||
          text.includes('FROM mst_webhook')
        ) {
          queries.push(text);
          return client.query(text, values);
        }
        if (values?.[0] === 'CSV_DOWNLOAD_SETTING')
          return Promise.resolve({ rows: [{ com_value: String(downloadLimit) }] });
        if (text.includes("com_key='ENCODING'")) return Promise.resolve({ rows: [{ com_value: encoding }] });
        if (text.includes("com_key='PAGE_SIZE'"))
          return Promise.resolve({ rows: [20, 50, 100, 200, 500].map((value) => ({ com_value: String(value) })) });
        return pool.query(text, values);
      },
      connect: async () => ({ query: client.query.bind(client), release: () => {} }),
    } as unknown as pg.Pool;
    let appServer: ReturnType<ReturnType<typeof createApp>['listen']> | undefined;
    try {
      await new Promise<void>((resolve) => endpoint.once('listening', resolve));
      const endpointAddress = endpoint.address();
      assert(endpointAddress && typeof endpointAddress !== 'string');
      const localUrl = `http://127.0.0.1:${endpointAddress.port}/hook`;
      await client.query(`CREATE TEMP TABLE conmas_webhook_send_log (LIKE public.conmas_webhook_send_log INCLUDING ALL);
      CREATE TEMP TABLE mst_webhook (LIKE public.mst_webhook INCLUDING ALL);CREATE TEMP TABLE user_lock (LIKE public.user_lock INCLUDING ALL);
      CREATE TEMP SEQUENCE conmas_webhook_send_history_seq;`);
      assert.equal(
        (
          await client.query(
            "SELECT 'conmas_webhook_send_history_seq'::regclass::oid='pg_temp.conmas_webhook_send_history_seq'::regclass::oid AS private",
          )
        ).rows[0].private,
        true,
      );
      await client.query(
        "INSERT INTO pg_temp.mst_webhook (webhook_id,webhook_to,webhook_name,webhook_url,webhook_request,retry_cnt) VALUES (1,'Other','Local fixture',$1,'GET',1)",
        [localUrl],
      );
      const general = JSON.stringify({
        url: localUrl,
        queryStrings: { fixture: 'general' },
        headers: {},
        body: { type: 'Raw', formValues: {}, rawContent: 'body <safe>', rawContentType: 'text/plain' },
      });
      await client.query(
        `INSERT INTO pg_temp.conmas_webhook_send_log (log_id,notification_type,webhook_id,webhook_name,paramcontent,inform_time,error_message) VALUES
      ('101','Apply','1','日本語 success',$1,'2030-01-02 12:00:00',NULL),('102','Complete','1','Failure <safe>',$2,'2030-01-03 13:00:00','failure'),('103','Apply','1','Older',$1,'2020-01-01',NULL)`,
        [JSON.stringify({ def_top_id: 'fixture' }), general],
      );
      appServer = createApp(db).listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => appServer!.once('listening', resolve));
      const address = appServer.address();
      assert(address && typeof address !== 'string');
      const root = `http://127.0.0.1:${address.port}/ConMasManager`;
      const login = await fetch(root + '/Account/LogOn', {
        method: 'POST',
        body: new URLSearchParams({ UserName: 'conmasadmin', Password: process.env.CONMAS_TEST_PASSWORD! }),
        redirect: 'manual',
      });
      const cookie = login.headers.get('set-cookie')?.split(';')[0];
      assert(cookie);
      const get = await fetch(root + '/System/WebhookSendLog', { headers: { cookie } });
      assert.equal(get.status, 200);
      const html = await get.text();
      assert.match(html, />Webhook Transmission history</);
      assert.match(html, /id="DetailSection"/);
      assert.match(html, /id="SearchLogLibraryBox"/);
      assert.match(html, /id="resultList"/);
      assert.match(html, /The maximum number to download once is 1\./);
      assert.match(html, /page_prev_d.png/);
      assert.match(html, /Name of webhook/);
      assert.match(html, /Failure &lt;safe&gt;/);
      assert.doesNotMatch(html, /<section class="PageSection"|class="DetailTopRight"/);
      assert.equal((html.match(/value="500"/g) || []).length, 2);
      for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) new Script(script[1]);
      const token = html.match(/name="__RequestVerificationToken" value="([^"]+)"/)?.[1];
      assert(token);
      const regularTest = new URLSearchParams({
        __RequestVerificationToken: token,
        webhook_id: '1',
        webhook_to: 'Other',
        webhook_name: 'Local fixture',
        webhook_url: localUrl,
        webhook_request: 'GET',
        retry_cnt: '1',
        act: 'testSend',
      });
      const regularResponse = await fetch(root + '/System/EditWebhookSetting', {
        method: 'POST',
        headers: { cookie },
        body: regularTest,
      });
      assert.equal(regularResponse.status, 200);
      assert.match(await regularResponse.text(), /Http Status Code : 200/);
      const generalTest = new URLSearchParams({
        __RequestVerificationToken: token,
        WebhookId: '-1',
        WebhookTo: 'General',
        Endpoint: localUrl,
        HttpMethod: 'POST',
        RetryCount: '0',
        act: 'testSend',
        'GeneralRequestItem.Authentication.Type': 'None',
        'GeneralRequestItem.Body.Type': 'Raw',
        'GeneralRequestItem.Body.Raw': 'test payload',
        'GeneralRequestItem.Body.RawContentType': 'text/plain',
      });
      const generalResponse = await fetch(root + '/System/EditWebhookSettingGeneral', {
        method: 'POST',
        headers: { cookie },
        body: generalTest,
      });
      assert.equal(generalResponse.status, 200);
      assert.match(await generalResponse.text(), /Http Status Code : 200/);
      assert.equal(sent, 2);
      assert.equal(captured.at(-1)?.body, 'test payload');
      assert.equal(captured.at(-1)?.contentType, 'text/plain');
      generalTest.set('GeneralRequestItem.Authentication.Type', 'BasicAuth');
      generalTest.set('GeneralRequestItem.AuthorizationHeader.Key', 'Authorization');
      generalTest.set(
        'GeneralRequestItem.AuthorizationHeader.Value',
        'Basic ' + Buffer.from('fixture:password').toString('base64'),
      );
      generalTest.set('GeneralRequestItem.Authentication.Username', 'fixture');
      generalTest.set('GeneralRequestItem.Authentication.Password', 'password');
      generalTest.set('GeneralRequestItem.Body.Type', 'XWwwFormURLEncoded');
      generalTest.set('GeneralRequestItem.Body.Items[0].Key', 'name');
      generalTest.set('GeneralRequestItem.Body.Items[0].Value', 'value & more');
      const testGeneral = async () => {
        const response = await fetch(root + '/System/EditWebhookSettingGeneral', {
          method: 'POST',
          headers: { cookie },
          body: generalTest,
        });
        assert.equal(response.status, 200);
        assert.match(await response.text(), /Http Status Code : 200/);
        return captured.at(-1)!;
      };
      let request = await testGeneral();
      assert.equal(request.authorization, 'Basic ' + Buffer.from('fixture:password').toString('base64'));
      assert.equal(new URLSearchParams(request.body).get('name'), 'value & more');
      assert.match(request.contentType, /application\/x-www-form-urlencoded/);
      generalTest.set('GeneralRequestItem.Authentication.Type', 'BearerToken');
      generalTest.set('GeneralRequestItem.Authentication.Token', 'fixture-token');
      generalTest.set('GeneralRequestItem.AuthorizationHeader.Value', 'Bearer fixture-token');
      generalTest.set('GeneralRequestItem.Body.Type', 'FormData');
      request = await testGeneral();
      assert.equal(request.authorization, 'Bearer fixture-token');
      assert.match(request.contentType, /multipart\/form-data; boundary=/);
      assert.match(request.body, /name="name"/);
      assert.match(request.body, /value & more/);
      generalTest.set('HttpMethod', 'GET');
      generalTest.set('Endpoint', localUrl + '?query=a%20b');
      generalTest.set('GeneralRequestItem.Body.Type', 'None');
      generalTest.set('GeneralRequestItem.Params[0].Key', 'query');
      generalTest.set('GeneralRequestItem.Params[0].Value', 'a b');
      request = await testGeneral();
      assert.equal(new URL(request.url, localUrl).searchParams.get('query'), 'a b');
      assert.equal(request.method, 'GET');
      assert.equal(request.body, '');
      generalTest.set('Endpoint', localUrl);
      generalTest.set('GeneralRequestItem.Body.Type', 'Raw');
      generalTest.delete('GeneralRequestItem.Params[0].Key');
      generalTest.delete('GeneralRequestItem.Params[0].Value');
      for (const method of ['PUT', 'DELETE']) {
        generalTest.set('HttpMethod', method);
        request = await testGeneral();
        assert.equal(request.method, method);
        assert.equal(request.body, 'test payload');
      }
      sent = 0;
      requests.length = 0;

      const body = new URLSearchParams({
        __RequestVerificationToken: token,
        ActionCommonType: 'SearchType',
        'WhereData.StatusSuccess': 'true',
        'WhereData.StatusFailure': 'false',
        'WhereData.NotificationTypeApply': 'true',
        'WhereData.SendTimeFrom': '2030/01/01',
        'WhereData.SendTimeTo': '2030/01/03',
        'WhereData.SendTimeToHour': '23:59:59',
      });
      const post = (data: URLSearchParams) =>
        fetch(root + '/System/WebhookSendLog', { method: 'POST', headers: { cookie }, body: data, redirect: 'manual' });
      const filtered = await post(body);
      assert.equal(filtered.status, 200);
      const filteredHtml = await filtered.text();
      assert.match(filteredHtml, /日本語 success/);
      assert.doesNotMatch(filteredHtml, /Failure &lt;safe&gt;|>Older</);
      body.set('ActionCommonType', 'PageType');
      body.set('PageData.PageSize', '200');
      body.append('PageData.PageSize', '200');
      body.set('PageData.PageIndex', '-1');
      assert.equal((await post(body)).status, 200);
      body.set('ActionCommonType', 'CsvType');
      body.delete('WhereData.SendTimeFrom');
      body.delete('WhereData.SendTimeTo');
      const csv = await post(body);
      assert.equal(csv.status, 200);
      const bytes = Buffer.from(await csv.arrayBuffer());
      assert.deepEqual(bytes.subarray(0, 3), Buffer.from([239, 187, 191]));
      assert.match(bytes.toString(), /"Send date and time","Status","Notification type","Name of webhook"/);
      assert.match(bytes.toString(), /def_top_id:fixture/);
      assert.match(bytes.toString(), /Truncated to 1 records/);
      downloadLimit = 0;
      const unlimited = await post(body);
      assert.equal(unlimited.status, 200);
      assert.match(await unlimited.text(), /Older/);
      assert.ok(
        !queries
          .filter((query) => query.startsWith('SELECT log_id'))
          .at(-1)
          ?.includes('LIMIT'),
      );
      encoding = '932';
      const shiftJis = await post(body);
      assert.equal(shiftJis.status, 200);
      assert.match(new TextDecoder('shift_jis').decode(await shiftJis.arrayBuffer()), /日本語 success/);
      encoding = '65001';
      const resend = new URLSearchParams({ __RequestVerificationToken: token, resendLogId: '101' });
      assert.equal((await post(resend)).status, 200);
      assert.equal(sent, 1);
      assert.ok(requests[0].includes('def_top_id=fixture'));
      await client.query("UPDATE pg_temp.mst_webhook SET webhook_request='POST' WHERE webhook_id=1");
      resend.set('resendLogId', '102');
      assert.equal((await post(resend)).status, 200);
      assert.equal(sent, 2);
      assert.ok(requests[1].includes('fixture=general'));
      fail = true;
      resend.set('resendLogId', '101');
      assert.equal((await post(resend)).status, 302);
      assert.ok(
        (
          await client.query(
            'SELECT 1 FROM pg_temp.conmas_webhook_send_log WHERE log_id NOT IN ($1,$2,$3) AND error_message IS NOT NULL',
            ['101', '102', '103'],
          )
        ).rowCount,
      );
      const deletion = new URLSearchParams({
        __RequestVerificationToken: 'bad',
        ActionCommonType: 'DeleteType',
        'SendLogList[0].IsSelect': 'true',
        'SendLogList[0].LogId': '103',
      });
      assert.equal((await post(deletion)).status, 403);
      deletion.set('__RequestVerificationToken', token);
      assert.equal((await post(deletion)).status, 200);
      assert.equal(
        (await client.query("SELECT 1 FROM pg_temp.conmas_webhook_send_log WHERE log_id='103'")).rowCount,
        0,
      );
    } finally {
      if (appServer)
        await new Promise<void>((resolve, reject) => appServer!.close((error) => (error ? reject(error) : resolve())));
      await new Promise<void>((resolve, reject) => endpoint.close((error) => (error ? reject(error) : resolve())));
      await client.query(
        'DROP TABLE IF EXISTS pg_temp.conmas_webhook_send_log,pg_temp.mst_webhook,pg_temp.user_lock;DROP SEQUENCE IF EXISTS pg_temp.conmas_webhook_send_history_seq',
      );
      client.release();
      await pool.end();
    }
  },
);
