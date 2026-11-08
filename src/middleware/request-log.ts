import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Request, RequestHandler, Response } from 'express';
import { root } from '../config/manager.js';
import type { ConsoleRequest } from '../services/server-console.js';

const token = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(value) ? value : undefined;

export function requestFailure(res: Response, error: unknown): void {
  // Error messages, SQL details and stacks can contain passwords, uploaded values or internal paths.
  res.locals.requestFailure = {
    type: error instanceof Error ? (token(error.constructor.name) ?? 'Error') : 'UnknownError',
    code: error && typeof error === 'object' && 'code' in error ? token(error.code) : undefined,
    definitionId:
      error && typeof error === 'object' && 'definitionId' in error && Number.isSafeInteger(error.definitionId)
        ? error.definitionId
        : undefined,
  };
}

function parameters(req: Request): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of [
    'command',
    'client',
    'platform',
    'version',
    'target',
    'process',
    'type',
    'encoding',
    'fileType',
    'copy',
    'copyReportMode',
    'unlock',
    'isDelete',
    'topId',
    'defTopId',
    'repTopId',
    'sheetNo',
    'fdSheetNo',
    'labelId',
    'documentId',
    'definitionId',
    'reportId',
    'masterId',
    'recordId',
    'fieldNo',
    'masterType',
    'startNo',
    'max',
    'isColumn',
    'isDeleteTran',
    'ignoreExpire',
  ]) {
    const values = [req.query[name], req.body?.[name]].flat().filter((value) => value !== undefined);
    const value = values.length === 1 ? token(values[0]) : undefined;
    if (value && (!/(?:Id|No)$/.test(name) || /^-?\d{1,10}$/.test(value))) result[name] = value;
  }
  return result;
}

export function requestLog(
  directory = join(root, 'logs'),
  onRequest?: (entry: ConsoleRequest) => void,
): RequestHandler {
  let pending = Promise.resolve();
  let warned = false;
  return (req, res, next) => {
    const started = process.hrtime.bigint(),
      requestId = randomUUID();
    const path = req.originalUrl.split('?')[0].slice(0, 256);
    let resultCode: number | undefined,
      loginResults: number[] | undefined,
      rowResults: { total: number; failed: number; codes: Record<string, number> } | undefined,
      written = false;
    res.setHeader('X-Request-Id', requestId);
    const send = res.send;
    res.send = function (body) {
      // Inspect only the protocol envelope, never retain XML or binary response contents.
      if (typeof body === 'string') {
        const code = /^\s*(?:<\?xml[^>]*>\s*)?<conmas>\s*<(?:error|loginResult)>\s*<code>(-?\d{1,10})<\/code>/.exec(
          body.slice(0, 512),
        );
        if (code) resultCode = Number(code[1]);
        if (/^\s*(?:<\?xml[^>]*>\s*)?<conmas>\s*<loginResult>/.test(body.slice(0, 512))) {
          loginResults = [...body.matchAll(/<loginResult>\s*<code>(-?\d{1,10})<\/code>/g)].map((match) =>
            Number(match[1]),
          );
          resultCode = loginResults.find((code) => code !== 0) ?? loginResults[0];
        }
        if (/^\s*(?:<\?xml[^>]*>\s*)?<conmas>\s*<results>/.test(body.slice(0, 512))) {
          rowResults = { total: 0, failed: 0, codes: {} };
          for (const match of body.matchAll(/<result>\s*<code>(-?\d{1,10})<\/code>/g)) {
            rowResults.total++;
            if (Number(match[1]) !== 0) rowResults.failed++;
            rowResults.codes[match[1]] = (rowResults.codes[match[1]] ?? 0) + 1;
          }
        }
      }
      return send.call(this, body);
    };
    const write = () => {
      if (written) return;
      written = true;
      const timestamp = new Date().toISOString();
      const files = Array.isArray(req.files) ? req.files : Object.values(req.files ?? {}).flat();
      const upload = req.session?.clientReportUpload;
      const sheet = res.locals.reportSheet;
      const number = (value: unknown) => (typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined);
      const entry = {
        timestamp,
        requestId,
        method: req.method,
        path,
        parameters: parameters(req),
        status: res.statusCode,
        clientPlatform: token(req.session?.clientAccount?.platform),
        completed: res.writableFinished,
        resultCode,
        loginResults,
        rowResults,
        durationMs: Number(process.hrtime.bigint() - started) / 1e6,
        contentType: res.getHeader('Content-Type'),
        responseBytes: res.getHeader('Content-Length'),
        session: req.sessionID ? createHash('sha256').update(req.sessionID).digest('hex').slice(0, 16) : undefined,
        uploadFiles: files.length,
        uploadBytes: files.reduce((total, file) => total + file.size, 0),
        uploadParts: files.map((file) => ({
          field:
            /^(?:report|thumbnail|inputImage|pageOrder|pdfFile|irfdFile|(?:cluster|layer)_\d{1,10}_(?:value|displayValue|sound|image_\d{1,10}))$/.test(
              file.fieldname,
            )
              ? file.fieldname
              : 'other',
          bytes: file.size,
        })),
        reportSheet: sheet
          ? {
              sheetNo: number(sheet.sheetNo),
              defSheetId: number(sheet.defSheetId),
              clusters: number(sheet.clusters),
              reason: token(sheet.reason),
              clusterId: number(sheet.clusterId),
              field:
                typeof sheet.field === 'string' &&
                /^(?:cluster|layer)_\d{1,10}_(?:value|displayValue|sound|image_\d{1,10})$/.test(sheet.field)
                  ? sheet.field
                  : undefined,
            }
          : undefined,
        transfer: upload
          ? {
              sourceId: upload.sourceId,
              definition: upload.definition,
              sheets: Object.keys(upload.sheets).length,
              committed: Boolean(upload.result),
            }
          : undefined,
        failure: res.locals.requestFailure,
      };
      // Terminal output must never interrupt persistence or the durable diagnostic log.
      try {
        onRequest?.(entry);
      } catch {
        /* A closed console cannot invalidate a save. */
      }
      // Serialize appends without holding up responses; logging failure must not turn a committed upload into a failure.
      pending = pending
        .then(async () => {
          await mkdir(directory, { recursive: true, mode: 0o700 });
          await appendFile(join(directory, `requests-${timestamp.slice(0, 10)}.jsonl`), JSON.stringify(entry) + '\n', {
            mode: 0o600,
          });
          warned = false;
        })
        .catch(() => {
          if (!warned)
            console.error('Request logging failed: check the local logs directory permissions and disk space.');
          warned = true;
        });
    };
    res.once('finish', write);
    res.once('close', write);
    next();
  };
}
