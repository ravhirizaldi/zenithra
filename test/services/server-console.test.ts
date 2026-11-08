import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  consoleColour,
  formatConsoleRequest,
  formatServerBanner,
  formatServerFailure,
  type ConsoleRequest,
} from '../../src/services/server-console.js';

const ansiEscape = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const strip = (text: string) => text.replace(ansiEscape, '');
const request: ConsoleRequest = {
  timestamp: '2026-11-08T09:30:12.000Z',
  requestId: '00000000-0000-4000-8000-000000000001',
  method: 'POST',
  path: '/ConMasWeb/Rests/ConMasIReporter.aspx',
  parameters: { command: 'GetUserInfo' },
  status: 200,
  completed: true,
  durationMs: 12.3,
  uploadFiles: 0,
  uploadBytes: 0,
};

test('startup and live request panels stay aligned with and without colour', () => {
  for (const width of [40, 80, 104, 116])
    for (const colour of [false, true]) {
      const banner = formatServerBanner('http://127.0.0.1:3000', width, colour);
      assert(banner.includes('Credit: Ravhi Rizaldi'));
      assert(!banner.includes('NaVhi'));
      assert.equal(banner.includes('\x1b[1;97;41m'), colour);
      const output = formatConsoleRequest(request, width, colour);
      for (const line of strip(banner + '\n' + output)
        .split('\n')
        .filter(Boolean))
        assert.equal(line.length, width, line);
      assert.equal(output.includes('\x1b['), colour);
    }
  const banner = formatServerBanner('http://127.0.0.1:3000', 104, false);
  assert(banner.includes('/ConMasManager/Account/LogOn'));
  assert(banner.includes('ZENITHRA SERVER'));
  assert(banner.includes('logs/requests-YYYY-MM-DD.jsonl'));
});

test('XML failures, aborted responses and committed saves get distinct states', () => {
  const warn = formatConsoleRequest({ ...request, resultCode: 3 }, 104, true);
  assert(warn.includes('\x1b[33m'));
  assert.match(strip(warn), /WARN.*200/);
  assert(warn.includes('XML 3'));
  assert(warn.includes(request.requestId));
  const failure = formatConsoleRequest({ ...request, failure: { type: 'Error', code: '42703' } }, 104, true);
  assert(failure.includes('\x1b[31m'));
  assert(failure.includes('FAIL'));
  assert(failure.includes('42703'));
  assert(formatConsoleRequest({ ...request, completed: false }).includes('ABORT'));
  const saved = {
    ...request,
    parameters: { command: 'RegistReportFinish' },
    transfer: { committed: true },
    resultCode: 0,
  };
  assert(formatConsoleRequest(saved).includes('SAVED'));
  assert(formatConsoleRequest(saved).includes('COMMITTED'));
  assert(
    formatConsoleRequest({ ...saved, path: '/ConMasWeb/Rests/RegistReportFinish.aspx', parameters: {} }).includes(
      'SAVED',
    ),
  );
  assert(!formatConsoleRequest({ ...request, transfer: { committed: true } }).includes('SAVED'));
  assert(!formatConsoleRequest({ ...saved, resultCode: -1 }).includes('SAVED'));
  const details = formatConsoleRequest(
    {
      ...request,
      resultCode: 2,
      uploadFiles: 3,
      uploadBytes: 2048,
      reportSheet: { sheetNo: 5, clusterId: 8, reason: 'invalid_cluster_file' },
    },
    80,
    false,
  );
  assert(details.includes('3 files / 2048 bytes'));
  assert(details.includes('sheet 5'));
  assert(details.includes('cluster 8'));
  for (const line of details.split('\n')) assert.equal(line.length, 80);
});

test('terminal logs exclude sensitive payloads, raw query strings and asset filenames', () => {
  const output = formatConsoleRequest(
    {
      ...request,
      path: '/ConMasWeb/Rests/ConMasIReporter.aspx?password=private-password',
      parameters: { command: 'Login', password: 'private-password', userId: 'private-user' },
      ...{ body: 'private-body', session: 'private-session', error: new Error('private-error') },
    },
    104,
    false,
  );
  assert(!output.includes('private-'));
  assert(!output.includes('\x1b'));
  assert.equal(formatConsoleRequest({ ...request, path: '/ConMasManager/Content/private-file.png' }), '');
  const rejectedAsset = formatConsoleRequest({
    ...request,
    status: 404,
    parameters: {},
    path: '/ConMasManager/Content/private-file.png',
  });
  assert(rejectedAsset.includes('WARN'));
  assert(!rejectedAsset.includes('private-file'));
  const hostile = formatConsoleRequest(
    { ...request, parameters: { command: '\x1b[31mLogin\nFORGED\r\x07' } },
    104,
    false,
  );
  assert(!hostile.includes('\x1b'));
  assert.equal(hostile.split('\n').length, 1);
  assert(!formatServerFailure('private-error\n').includes('private-error'));
  assert(formatServerFailure('EADDRINUSE', false).includes('left running'));
});

test('NO_COLOR disables ANSI output', () => {
  const previous = process.env.NO_COLOR;
  try {
    process.env.NO_COLOR = '1';
    assert.equal(consoleColour(), false);
  } finally {
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
});
