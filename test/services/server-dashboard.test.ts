import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { setTimeout } from 'node:timers/promises';
import blessed from 'blessed';
import {
  createDashboard,
  createServerConsole,
  dashboardEntryMatches,
  supportsDashboard,
} from '../../src/services/server-dashboard.js';
import type { ConsoleRequest } from '../../src/services/server-console.js';

const entry: ConsoleRequest = {
  timestamp: '2026-11-08T10:00:00.000Z',
  requestId: '00000000-0000-4000-8000-000000000001',
  method: 'POST',
  path: '/ConMasWeb/Rests/ConMasIReporter.aspx',
  parameters: { command: 'GetUserInfo' },
  status: 200,
  completed: true,
  durationMs: 14,
  uploadFiles: 0,
  uploadBytes: 0,
};
const ansiEscape = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
const plain = (text: string) => text.replace(ansiEscape, '');

test('dashboard tabs include all native clients and filter errors by protocol outcomes', () => {
  assert(dashboardEntryMatches(entry, 'All', false));
  assert(!dashboardEntryMatches(entry, 'All', true));
  assert(dashboardEntryMatches(entry, 'Client', false));
  const windows = { ...entry, clientPlatform: 'Windows' };
  for (const platform of ['Windows', 'Editor', 'Designer', 'Android', 'iPad']) {
    assert(dashboardEntryMatches({ ...entry, clientPlatform: platform }, 'Client', false));
  }
  assert(!dashboardEntryMatches({ ...entry, path: '/ConMasWebOther' }, 'Client', false));
  assert(!dashboardEntryMatches({ ...windows, path: '/ConMasAPI/Rests/APIExecute.aspx' }, 'Client', false));
  assert(dashboardEntryMatches({ ...entry, path: '/ConMasAPI/Rests/APIExecute.aspx' }, 'API Request', false));
  assert(dashboardEntryMatches({ ...entry, path: '/ConMasManager/System/Index' }, 'Manager', false));
  assert(!dashboardEntryMatches(entry, 'Manager', false));
  for (const rejected of [
    { resultCode: 3 },
    { resultCode: -1 },
    { status: 404 },
    { status: 503 },
    { completed: false },
    { failure: { type: 'Error' } },
    { rowResults: { total: 2, failed: 1 } },
  ]) {
    assert(dashboardEntryMatches({ ...windows, ...rejected }, 'Client', true));
  }
  assert(
    !dashboardEntryMatches(
      { ...windows, parameters: { command: 'RegistReportFinish' }, resultCode: 0, transfer: { committed: true } },
      'All',
      true,
    ),
  );
  assert(dashboardEntryMatches('error', 'All', true));
  assert(dashboardEntryMatches('warn', 'All', true));
  assert(!dashboardEntryMatches('info', 'All', true));
  assert(!dashboardEntryMatches('error', 'API Request', true));
});

test('dashboard keeps its header fixed and credit in the footer while requests scroll and resize', async () => {
  const events = ['SIGINT', 'SIGTERM', 'SIGQUIT', 'exit', 'uncaughtException'] as const;
  const listeners = events.map((event) => process.listenerCount(event));
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 104, rows: 28 });
  output.resume();
  const screen = blessed.screen({ input, output, terminal: 'xterm-256color', smartCSR: true, fullUnicode: false });
  let destroyed = false;
  screen.on('destroy', () => {
    destroyed = true;
  });
  let stops = 0;
  const dashboard = createDashboard('http://127.0.0.1:3000', screen, () => {
    stops++;
  });
  const logs = screen.children[1] as blessed.Widgets.BoxElement;
  const controls = screen.children[2].children as blessed.Widgets.ButtonElement[];
  const capture = () => plain(screen.screenshot(0, output.columns, 0, output.rows));
  try {
    let text = capture();
    assert(text.includes('ZENITHRA SERVER'));
    assert(text.includes('Credit: Ravhi Rizaldi'));
    assert(!text.includes('NaVhi'));
    assert(text.includes('Waiting for requests'));
    assert(text.includes('ANIMATION ON'));
    const header = text.split('\n').slice(0, 3).join('\n');
    for (let i = 0; i < 600; i++)
      dashboard.request({ ...entry, parameters: { command: 'GetReportDataSheet', sheetNo: String(i) } });
    dashboard.request({
      ...entry,
      parameters: { command: 'RegistReportFinish' },
      transfer: { committed: true },
      resultCode: 0,
    });
    await setTimeout(220);
    text = capture();
    assert.equal(text.split('\n').slice(0, 3).join('\n'), header);
    assert.match(text, /REQUESTS\s+601/);
    assert.match(text, /SAVED\s+1/);
    assert(text.includes('COMMITTED'));
    assert(logs.getContent().split('\n').length <= 501);
    const latest = logs.getScroll();
    logs.emit('wheelup');
    assert(logs.getScroll() < latest);
    assert(capture().includes('READING HISTORY'));
    controls[2].emit('click');
    assert(capture().includes('LIVE FOLLOW'));
    controls[0].emit('click');
    assert(capture().includes('READING HISTORY'));
    controls[1].emit('click');
    assert(capture().includes('READING HISTORY'));
    controls[3].emit('click');
    assert(capture().includes('ANIMATION OFF'));
    controls[3].emit('click');
    assert(capture().includes('ANIMATION ON'));
    logs.emit('mousedown', { x: Number(logs.aleft) + Number(logs.width) - 3, y: Number(logs.atop) + 2 });
    assert(capture().includes('READING HISTORY'));
    screen.emit('mouseup', { x: Number(logs.aleft), y: Number(logs.atop) });
    screen.emit('key pageup', '', { name: 'pageup', full: 'pageup' });
    assert(capture().includes('READING HISTORY'));
    dashboard.request(entry);
    assert(capture().includes('READING HISTORY'));
    screen.emit('key end', '', { name: 'end', full: 'end' });
    assert(capture().includes('LIVE FOLLOW'));
    screen.emit('key a', 'a', { name: 'a', full: 'a' });
    assert(capture().includes('ANIMATION OFF'));
    output.columns = 60;
    output.rows = 18;
    output.emit('resize');
    text = capture();
    assert(text.includes('Credit: Ravhi Rizaldi'));
    assert(text.includes('LIVE REQUESTS'));
    for (const line of text.split('\n')) assert(line.length <= 60, line);
    output.columns = 120;
    output.rows = 35;
    output.emit('resize');
    assert(capture().includes('GetUserInfo'));
    dashboard.notice('error');
    await setTimeout(220);
    assert(capture().includes('raw details withheld'));
  } finally {
    dashboard.stop();
    dashboard.stop();
    input.destroy();
    output.destroy();
  }
  assert.equal(destroyed, true);
  assert.equal(stops, 1);
  assert.deepEqual(
    events.map((event) => process.listenerCount(event)),
    listeners,
  );
});

test('NO_COLOR uses the credited plain banner and logs without alternate-screen controls', () => {
  const previous = process.env.NO_COLOR,
    log = console.log;
  const lines: string[] = [];
  const terminal = createServerConsole();
  try {
    process.env.NO_COLOR = '1';
    console.log = (text: string) => {
      lines.push(text);
    };
    assert.equal(supportsDashboard(), false);
    terminal.start('http://127.0.0.1:3000');
    terminal.request(entry);
    terminal.stop();
    assert(lines.join('\n').includes('Credit: Ravhi Rizaldi'));
    assert(lines.join('\n').includes('GetUserInfo'));
    assert(!lines.join('\n').includes('\x1b'));
  } finally {
    console.log = log;
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
    terminal.stop();
  }
});

test('clickable tabs default to All and combine with keyboard-only errors status without discarding history', async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 104, rows: 28 });
  output.resume();
  const screen = blessed.screen({ input, output, terminal: 'xterm-256color' });
  const dashboard = createDashboard('http://127.0.0.1:3000', screen);
  const logs = screen.children[1] as blessed.Widgets.BoxElement;
  const filters = screen.children[3].children as blessed.Widgets.BoxElement[];
  try {
    assert(filters[2].getContent().includes('Client (Editor and Designer)'));
    assert(filters[3].getContent().includes('API Request'));
    assert.equal(filters[4].type, 'box');
    assert(filters[4].getContent().includes('OFF'));
    dashboard.request({ ...entry, clientPlatform: 'Windows', parameters: { command: 'WindowsOK' } });
    dashboard.request({ ...entry, clientPlatform: 'Windows', parameters: { command: 'WindowsBad' }, resultCode: 3 });
    dashboard.request({ ...entry, clientPlatform: 'Designer', parameters: { command: 'DesignerOnly' } });
    dashboard.request({ ...entry, path: '/ConMasAPI/Rests/APIExecute.aspx', parameters: { command: 'ApiOnly' } });
    dashboard.request({ ...entry, path: '/ConMasManager/System/Index', parameters: {} });
    await setTimeout(220);
    for (const action of ['WindowsOK', 'WindowsBad', 'DesignerOnly', 'ApiOnly', 'System/Index'])
      assert(logs.getContent().includes(action));
    filters[2].emit('click');
    assert(logs.getContent().includes('WindowsOK'));
    assert(logs.getContent().includes('DesignerOnly'));
    assert(!logs.getContent().includes('ApiOnly'));
    filters[4].emit('click');
    assert(logs.getContent().includes('WindowsOK'));
    assert(filters[4].getContent().includes('OFF'));
    screen.emit('key e', 'e', { name: 'e', full: 'e' });
    assert(logs.getContent().includes('WindowsBad'));
    assert(!logs.getContent().includes('WindowsOK'));
    assert(!logs.getContent().includes('DesignerOnly'));
    assert(filters[4].getContent().includes('ON'));
    filters[3].emit('click');
    assert(logs.getContent().includes('No matching activity'));
    screen.emit('key e', 'e', { name: 'e', full: 'e' });
    assert(logs.getContent().includes('ApiOnly'));
    filters[1].emit('click');
    assert(logs.getContent().includes('System/Index'));
    assert(!logs.getContent().includes('WindowsOK'));
    screen.emit('key 1', '1', { name: '1', full: '1' });
    assert(logs.getContent().includes('WindowsOK'));
    assert(logs.getContent().includes('DesignerOnly'));
    assert.match(plain(screen.screenshot(0, 104, 0, 28)), /REQUESTS\s+5/);
    output.columns = 60;
    output.rows = 18;
    output.emit('resize');
    assert(plain(screen.screenshot(0, 60, 0, 18)).includes('3 Client'));
  } finally {
    dashboard.stop();
    input.destroy();
    output.destroy();
  }
});

test('expanded banner uses ASCII artwork, real traffic and committed-save feedback with a motion toggle', async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 120, rows: 40 });
  output.resume();
  const screen = blessed.screen({ input, output, terminal: 'xterm-256color' });
  const dashboard = createDashboard('http://127.0.0.1:3000', screen);
  const header = screen.children[0] as blessed.Widgets.BoxElement;
  const capture = () => plain(header.getContent());
  try {
    assert.equal(Number(header.height), 15);
    assert(capture().includes('####'));
    assert(capture().includes('ZENITHRA SERVER'));
    assert.match(
      header.getContent().split('\n')[0],
      new RegExp(`${String.fromCharCode(27)}\\[41m.*${String.fromCharCode(27)}\\[1;97mZENITHRA SERVER`),
    );
    assert(capture().includes('SERVER INFORMATION'));
    assert(capture().includes('REQUEST ACTIVITY'));
    assert(!capture().includes('CONNECTIONS'));
    assert(!capture().includes('LOCAL OPERATIONS'));
    assert(!capture().includes('LIVE SCAN'));
    assert(capture().includes('WAITING FOR FIRST REQUEST'));
    assert.match(capture(), /REQ\/S \(5s\)\s+0\.0/);
    assert(!capture().includes('Credit:'));
    assert((screen.children[2] as blessed.Widgets.BoxElement).getContent().includes('Credit: Ravhi Rizaldi'));
    assert.match(capture(), /^[\x20-\x7e\n]*$/);
    dashboard.request({
      ...entry,
      parameters: { command: 'RegistReportFinish' },
      resultCode: 0,
      transfer: { committed: true },
    });
    await setTimeout(220);
    assert(capture().includes('SAVED / COMMITTED'));
    assert.match(capture(), /REQ\/S \(5s\)\s+0\.2/);
    const metrics = capture()
      .split('\n')
      .filter((line) => /\|\s+(REQUESTS|SAVED|WARN|FAIL)\s+\d+\s*$/.test(line));
    assert.equal(metrics.length, 4);
    assert.equal(new Set(metrics.map((line) => line.trimEnd().length)).size, 1);
    assert.equal(header.style.border.fg, 'green');
    screen.emit('key a', 'a', { name: 'a', full: 'a' });
    assert(capture().includes('ONLINE -'));
    assert.equal(header.style.border.fg, 'cyan');
    output.columns = 60;
    output.rows = 18;
    output.emit('resize');
    assert.equal(Number(header.height), 8);
    assert(capture().includes('ZENITHRA SERVER'));
  } finally {
    dashboard.stop();
    input.destroy();
    output.destroy();
  }
});

test('each coloured tab pulses only on its own request hits and animation can be disabled', async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 120, rows: 30 });
  output.resume();
  const screen = blessed.screen({ input, output, terminal: 'xterm-256color' });
  const dashboard = createDashboard('http://127.0.0.1:3000', screen);
  const tabs = screen.children[3].children.slice(0, 4) as blessed.Widgets.ButtonElement[];
  try {
    assert.equal(new Set(tabs.map((tab) => (tab.style.bg === 'black' ? tab.style.fg : tab.style.bg))).size, 4);
    for (const [path, index] of [
      ['/ConMasManager/System/Index', 1],
      ['/ConMasWeb/Rests/Login.aspx', 2],
      ['/ConMasAPI/Rests/APIExecute.aspx', 3],
    ] as const) {
      dashboard.request({ ...entry, path });
      await setTimeout(220);
      assert(tabs[0].getContent().includes('*'));
      assert(tabs[index].getContent().includes('*'));
      for (let other = 1; other < tabs.length; other++)
        if (other !== index) assert(!tabs[other].getContent().includes('*'));
      await setTimeout(1050);
      assert(tabs.every((tab) => !tab.getContent().includes('*')));
    }
    dashboard.request(entry);
    await setTimeout(220);
    screen.emit('key a', 'a', { name: 'a', full: 'a' });
    assert(tabs.every((tab) => !tab.getContent().includes('*')));
  } finally {
    dashboard.stop();
    input.destroy();
    output.destroy();
  }
});

test('a dashboard rendering failure releases the terminal instead of failing a request', async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 26 });
  output.resume();
  const screen = blessed.screen({ input, output, terminal: 'xterm-256color' });
  let stops = 0;
  const dashboard = createDashboard('http://127.0.0.1:3000', screen, () => {
    stops++;
  });
  try {
    screen.render = () => {
      throw new Error('private-render-error');
    };
    assert.doesNotThrow(() => dashboard.request(entry));
    await setTimeout(220);
    assert.equal(stops, 1);
  } finally {
    dashboard.stop();
    input.destroy();
    output.destroy();
  }
});
