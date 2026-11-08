import { base } from '../config/manager.js';
import { clientBase } from '../config/client.js';
import { apiBase } from '../config/api.js';

export interface ConsoleRequest {
  timestamp: string;
  requestId: string;
  method: string;
  path: string;
  parameters: Record<string, string>;
  clientPlatform?: string;
  status: number;
  completed: boolean;
  durationMs: number;
  resultCode?: number;
  rowResults?: { total: number; failed: number };
  uploadFiles: number;
  uploadBytes: number;
  transfer?: { committed: boolean };
  failure?: { type?: string; code?: string };
  reportSheet?: { sheetNo?: number; clusterId?: number; reason?: string };
}

const terminalWidth = () => Math.max(24, Math.min(process.stdout.columns || 104, 116));
export const consoleColour = () =>
  Boolean(process.stdout.isTTY && process.env.TERM !== 'dumb' && process.env.NO_COLOR === undefined);
const ansiEscape = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
const clean = (value: string) => value.replace(ansiEscape, '').replace(/[^\x20-\x7e]/g, '');
const fit = (value: string, width: number) => {
  const text = clean(value);
  return (text.length > width ? text.slice(0, Math.max(0, width - 1)) + '~' : text).padEnd(width);
};
const paint = (text: string, code: number, colour: boolean) => (colour ? `\x1b[${code}m${text}\x1b[0m` : text);
const border = (width: number, colour: boolean) => paint('+' + '-'.repeat(width - 2) + '+', 36, colour);
const row = (text: string, width: number, colour: boolean, code = 37) =>
  paint('| ', 36, colour) + paint(fit(text, width - 4), code, colour) + paint(' |', 36, colour);
const center = (text: string, width: number) =>
  ' '.repeat(Math.max(0, Math.floor((width - 4 - text.length) / 2))) + text;
const columns = (values: string[], width: number) =>
  width >= 80
    ? values.map((value, index) => fit(value, [8, 5, 4, 6, 7, width - 48, 8][index])).join(' ')
    : values.join(' ');

export function formatServerBanner(origin: string, width = terminalWidth(), colour = consoleColour()): string {
  const title = row(center('ZENITHRA SERVER', width), width, false);
  const lines = [
    border(width, colour),
    colour ? `\x1b[1;97;41m${title}\x1b[0m` : title,
    row(center('LOCAL DEVELOPMENT SERVER', width), width, colour, 95),
    border(width, colour),
    row('READY    Listening at ' + origin, width, colour, 32),
    row('MANAGER  ' + origin + base + '/Account/LogOn', width, colour, 36),
    row('CLIENT   ' + origin + clientBase, width, colour, 95),
    row('API      ' + origin + apiBase, width, colour, 93),
    row('RUNTIME  Node ' + process.versions.node + '  /  PID ' + process.pid, width, colour, 94),
    border(width, colour),
    row('LOGS     logs/requests-YYYY-MM-DD.jsonl  (UTC)', width, colour, 90),
    row('LIVE     OK / WARN / FAIL / ABORT / SAVED', width, colour, 97),
    border(width, colour),
    row(
      columns(['UTC', 'STATE', 'HTTP', 'METHOD', 'SURFACE', 'COMMAND / ROUTE', 'DURATION'], width),
      width,
      colour,
      90,
    ),
    border(width, colour),
    row(center('Credit: NaVhi', width), width, colour, 95),
    border(width, colour),
  ];
  return '\n' + lines.join('\n') + '\n';
}

export function consoleRequestState(entry: ConsoleRequest): 'OK' | 'WARN' | 'FAIL' | 'ABORT' | 'SAVED' {
  const failed = !entry.completed || entry.status >= 500 || Boolean(entry.failure) || (entry.resultCode ?? 0) < 0;
  const warning = entry.status >= 400 || (entry.resultCode ?? 0) !== 0 || Boolean(entry.rowResults?.failed);
  const saved =
    (entry.parameters.command === 'RegistReportFinish' || /\/RegistReportFinish\.aspx$/i.test(entry.path)) &&
    entry.transfer?.committed &&
    entry.resultCode === 0;
  return !entry.completed ? 'ABORT' : failed ? 'FAIL' : warning ? 'WARN' : saved ? 'SAVED' : 'OK';
}

export function formatConsoleRequest(entry: ConsoleRequest, width = terminalWidth(), colour = consoleColour()): string {
  const state = consoleRequestState(entry);
  const failed = state === 'FAIL' || state === 'ABORT',
    warning = state === 'WARN',
    saved = state === 'SAVED';
  // Keep asset noise out of the terminal; the JSONL still records every request.
  if (!failed && !warning && /\/ConMasManager\/(?:Content|Scripts)\//.test(entry.path)) return '';
  const tone = failed ? 31 : warning ? 33 : 32;
  const surface = entry.path.startsWith(clientBase + '/')
    ? 'CLIENT'
    : entry.path.startsWith(apiBase + '/')
      ? 'API'
      : 'MANAGER';
  // Never print query strings, arbitrary filenames, request bodies or error messages.
  const path = entry.path.split('?')[0];
  const action =
    /^\/(?:ConMasManager|ConMasWeb|ConMasAPI)\/([A-Za-z0-9_/-]+?)(?:\.aspx)?$/.exec(path)?.[1] ?? 'Request';
  const target =
    entry.parameters.command ||
    (entry.parameters.target && entry.parameters.process
      ? entry.parameters.target + '/' + entry.parameters.process
      : action);
  const time = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})/.exec(entry.timestamp)?.[1] ?? '--:--:--';
  const duration = Number.isFinite(entry.durationMs) ? Math.max(0, entry.durationMs).toFixed(0) + 'ms' : '-';
  const summary = columns([time, state, String(entry.status), entry.method, surface, target, duration], width);
  const lines: string[] = [];
  for (let offset = 0; offset < summary.length; offset += width - 4)
    lines.push(row(summary.slice(offset, offset + width - 4), width, colour, tone));
  const details: string[] = [];
  if (entry.resultCode !== undefined && (entry.resultCode !== 0 || saved)) details.push('XML ' + entry.resultCode);
  if (saved) details.push('COMMITTED');
  if (entry.uploadFiles) details.push(`${entry.uploadFiles} files / ${entry.uploadBytes} bytes`);
  if (entry.rowResults?.failed) details.push(`${entry.rowResults.failed}/${entry.rowResults.total} rows rejected`);
  if (failed || warning) {
    if (entry.failure) details.push([entry.failure.type, entry.failure.code].filter(Boolean).join(' '));
    if (entry.reportSheet?.sheetNo !== undefined) details.push('sheet ' + entry.reportSheet.sheetNo);
    if (entry.reportSheet?.clusterId !== undefined) details.push('cluster ' + entry.reportSheet.clusterId);
    if (entry.reportSheet?.reason) details.push(entry.reportSheet.reason);
    details.push('request ' + entry.requestId);
  }
  const detail = clean(details.join(' / '));
  for (let offset = 0; offset < detail.length; offset += width - 6)
    lines.push(row('  ' + detail.slice(offset, offset + width - 6), width, colour, 90));
  return lines.join('\n');
}

export function printConsoleRequest(entry: ConsoleRequest): void {
  const text = formatConsoleRequest(entry);
  if (text) console.log(text);
}

export function formatServerFailure(code?: string, colour = consoleColour()): string {
  const message =
    code === 'EADDRINUSE'
      ? 'Port already in use; the existing server was left running.'
      : 'Unable to listen' + (code && /^[A-Z0-9_]+$/.test(code) ? ` (${code})` : '') + '.';
  return paint('SERVER FAILED  ' + message, 31, colour);
}
