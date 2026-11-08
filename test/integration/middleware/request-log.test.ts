import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request } from 'node:http';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import express from 'express';
import session from 'express-session';
import multer from 'multer';
import { requestFailure, requestLog } from '../../../src/middleware/request-log.js';
import { clientError } from '../../../src/services/client-xml.js';
import { ReportUnsupported } from '../../../src/models/client-reports.js';
import { createApp } from '../../../src/app.js';
import { formatConsoleRequest } from '../../../src/services/server-console.js';

test('every completed/aborted request logs safe metadata, XML codes and multipart counts without credentials or content', async () => {
  const directory = await mkdtemp('/tmp/opencode/conmas-request-log-');
  const app = express();
  const consoleLines: string[] = [];
  app.use(
    requestLog(directory, (entry) => {
      consoleLines.push(formatConsoleRequest(entry, 104, false));
      throw new Error('private-console-failure');
    }),
  );
  app.use(express.urlencoded({ extended: false, limit: '1kb' }));
  app.use(session({ secret: 'private-test-secret', resave: false, saveUninitialized: false }));
  app.post('/ConMasWeb/Rests/ConMasIReporter.aspx', (req, res) => {
    req.session.clientAccount = {
      userId: 'private-user',
      userName: 'private-name',
      client: 'iPad',
      physicalId: 'private-device',
      platform: 'Windows',
      version: '1',
      address: '',
      sessionId: req.sessionID,
    };
    res
      .type('text/xml')
      .send('<conmas><loginResult><code>0</code><remark>private-response</remark></loginResult></conmas>');
  });
  app.post('/ConMasWeb/Rests/RegistReportSheet.aspx', multer().any(), (_req, res) => {
    res.locals.reportSheet = {
      sheetNo: 3,
      defSheetId: 229,
      clusters: 3,
      reason: 'invalid_cluster_file',
      clusterId: 10,
      field: 'cluster_10_sound',
      value: 'private-value',
    };
    res.type('text/xml').send(clientError(2, 'private-upload-error'));
  });
  app.get('/ConMasWeb/Rests/GetSheetBinaries.aspx', (_req, res) =>
    res.type('application/zip').send(Buffer.from('private-binary')),
  );
  app.get('/ConMasWeb/Rests/GeneralProcess.aspx', (_req, res) => {
    requestFailure(
      res,
      Object.assign(new Error('private-password in SQL private-document'), { code: '42703', detail: 'private-detail' }),
    );
    res.type('text/xml').send(clientError(-1));
  });
  app.get('/ConMasWeb/Rests/RegistReportTop.aspx', (_req, res) => {
    requestFailure(res, new ReportUnsupported('private-document', 'report_table_pin', 171));
    res.status(501).type('text/xml').send(clientError(-1));
  });
  app.get('/ConMasManager/Content/test.css', (_req, res) => res.type('css').send('private-style'));
  app.get('/', (_req, res) => res.redirect('/ConMasManager/Account/LogOn'));
  app.get('/waiting', (_req, res) => res.flushHeaders());
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    requestFailure(res, error);
    res.status(413).end();
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const address = server.address();
    assert(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const login = await fetch(
      origin + '/ConMasWeb/Rests/ConMasIReporter.aspx?password=private-query&token=private-token',
      {
        method: 'POST',
        headers: { authorization: 'Bearer private-auth' },
        body: new URLSearchParams({
          command: 'Login',
          client: 'iPad',
          platform: 'Windows',
          password: 'private-password',
          user: 'private-user',
          terminalId: 'private-device',
        }),
      },
    );
    const requestId = login.headers.get('x-request-id'),
      cookie = login.headers.get('set-cookie')!;
    await login.text();
    const body = new FormData();
    body.set('command', 'RegistReportSheet');
    body.set('sheetNo', '1');
    body.append('private-file-field', new Blob(['private-upload']), 'private-filename.xml');
    body.append('cluster_10_displayValue', new Blob(['private-preview']), 'private-preview.jpg');
    await (
      await fetch(origin + '/ConMasWeb/Rests/RegistReportSheet.aspx', { method: 'POST', headers: { cookie }, body })
    ).text();
    await (
      await fetch(
        origin +
          '/ConMasWeb/Rests/GetSheetBinaries.aspx?topId=2&sheetNo=1&masterId=-100&recordId=11&fieldNo=1&masterType=0&isColumn=true&startNo=0&max=50&masterKey=private-key&recordKey=private-record&fieldSearch=private-search&word=private-search',
        { headers: { cookie } },
      )
    ).arrayBuffer();
    await (await fetch(origin + '/ConMasWeb/Rests/GeneralProcess.aspx?target=Library&process=DocumentList')).text();
    await (await fetch(origin + '/ConMasWeb/Rests/RegistReportTop.aspx')).text();
    await (await fetch(origin + '/ConMasManager/Content/test.css')).text();
    await (await fetch(origin, { redirect: 'manual' })).text();
    const oversized = await fetch(origin + '/ConMasWeb/Rests/ConMasIReporter.aspx?command=Login', {
      method: 'POST',
      body: new URLSearchParams({ password: 'private-overflow'.repeat(200) }),
    });
    assert.equal(oversized.status, 413);
    await oversized.text();
    await new Promise<void>((resolve, reject) => {
      const aborted = request(origin + '/waiting', (response) => {
        response.destroy();
        resolve();
      });
      aborted.on('error', reject);
      aborted.end();
    });
    let contents = '',
      filename = '';
    for (let attempt = 0; attempt < 100; attempt++) {
      filename = (await readdir(directory)).find((name) => name.endsWith('.jsonl')) ?? '';
      contents = filename ? await readFile(join(directory, filename), 'utf8') : '';
      if (contents.trim().split('\n').length === 9) break;
      await setTimeout(20);
    }
    const entries = contents
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(entries.length, 9);
    assert.equal(new Set(entries.map((entry) => entry.requestId)).size, 9);
    const first = entries.find((entry) => entry.requestId === requestId);
    assert.deepEqual(first.parameters, { command: 'Login', client: 'iPad', platform: 'Windows' });
    assert.equal(first.resultCode, 0);
    assert.equal(first.completed, true);
    assert.equal(first.status, 200);
    assert.equal(first.clientPlatform, 'Windows');
    assert(first.durationMs >= 0);
    assert.match(first.session, /^[a-f0-9]{16}$/);
    const upload = entries.find((entry) => entry.parameters.command === 'RegistReportSheet');
    assert.equal(upload.resultCode, 2);
    assert.equal(upload.uploadFiles, 2);
    assert.equal(upload.uploadBytes, Buffer.byteLength('private-uploadprivate-preview'));
    assert.deepEqual(upload.uploadParts, [
      { field: 'other', bytes: Buffer.byteLength('private-upload') },
      { field: 'cluster_10_displayValue', bytes: Buffer.byteLength('private-preview') },
    ]);
    assert.deepEqual(upload.reportSheet, {
      sheetNo: 3,
      defSheetId: 229,
      clusters: 3,
      reason: 'invalid_cluster_file',
      clusterId: 10,
      field: 'cluster_10_sound',
    });
    assert.equal(upload.session, first.session);
    const binary = entries.find((entry) => entry.parameters.topId === '2');
    assert.deepEqual(binary.parameters, {
      topId: '2',
      sheetNo: '1',
      masterId: '-100',
      recordId: '11',
      fieldNo: '1',
      masterType: '0',
      startNo: '0',
      max: '50',
      isColumn: 'true',
    });
    assert.equal(binary.resultCode, undefined);
    assert.equal(Number(binary.responseBytes), Buffer.byteLength('private-binary'));
    assert.deepEqual(entries.find((entry) => entry.parameters.target === 'Library').failure, {
      type: 'Error',
      code: '42703',
    });
    assert.deepEqual(entries.find((entry) => entry.status === 501).failure, {
      type: 'ReportUnsupported',
      code: 'report_table_pin',
      definitionId: 171,
    });
    assert.equal(entries.find((entry) => entry.status === 413).parameters.command, 'Login');
    assert.equal(entries.find((entry) => entry.path === '/waiting').completed, false);
    assert(!contents.includes('private-'));
    assert(!contents.includes('ASP.NET_SessionId'));
    assert(!contents.includes('connect.sid'));
    assert(consoleLines.some((line) => line.includes('XML 2')));
    assert(consoleLines.some((line) => line.includes('ABORT')));
    assert(!consoleLines.join('\n').includes('private-'));
    assert.equal((await stat(join(directory, filename))).mode & 0o777, 0o600);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('native parsing failures before the client router retain text/xml errors, never Manager plain text', async () => {
  const app = createApp(null, false),
    server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const address = server.address();
    assert(address && typeof address !== 'string');
    for (const path of ['/ConMasWeb/Rests/ConMasIReporter.aspx', '/ConMasAPI/Rests/APIExecute.aspx']) {
      const response: Response = await fetch(`http://127.0.0.1:${address.port}${path}?command=Login`, {
        method: 'POST',
        body: new URLSearchParams({ password: 'private-overflow'.repeat(100000) }),
      });
      assert.equal(response.status, 503);
      assert.match(response.headers.get('content-type')!, /^text\/xml/);
      assert(response.headers.get('x-request-id'));
      assert.match(await response.text(), /<conmas><error><code>-1<\/code>/);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
