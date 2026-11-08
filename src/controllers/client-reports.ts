import type { Request, Response } from 'express';
import type pg from 'pg';
import { clientParameter } from './client-account.js';
import { clientTerminal } from '../models/client-account.js';
import {
  getReportDownload,
  getReportFreeDraw,
  reportDownloadSheet,
  reportDownloadTop,
  reportSheetBinaries,
  ReportUnsupported,
  type ReportDownload,
} from '../models/client-reports.js';
import { clientError } from '../services/client-xml.js';
import {
  beginReportUpload,
  cleanupReportUpload,
  finishReportUpload,
  stageReportSheet,
  stageReportFreeDrawInfo,
  stageReportFreeDraw,
  type ReportUpload,
  type ReportSheetDiagnostic,
} from '../models/client-report-upload.js';
import { requestFailure } from '../middleware/request-log.js';

declare module 'express-session' {
  interface SessionData {
    clientReportDownload?: ReportDownload;
    clientReportUpload?: ReportUpload;
  }
}

export async function clientReportAction(db: pg.Pool, command: string, req: Request, res: Response): Promise<boolean> {
  if (
    ![
      'MakeReportFromDefinitionTop',
      'GetReportDataTop',
      'MakeReportFromDefinitionSheet',
      'GetReportDataSheet',
      'GetSheetBinaries',
      'GetFreeDrawSheetInfo',
      'GetReportFreeDrawSheet',
      'RegistReportTop',
      'RegistReportSheet',
      'RegistReportFinish',
      'RegistFreeDrawSheetInfo',
      'RegistReportFreeDrawSheet',
    ].includes(command)
  )
    return false;
  const account = req.session.clientAccount;
  if (!account) {
    res.send(clientError(5, 'no session.'));
    return true;
  }
  const terminal = await clientTerminal(db, account);
  if (terminal.code !== 0) {
    res.send(clientError(3));
    return true;
  }
  const actor = { ...account, terminalId: String(terminal.id) },
    parameter = (name: string) => clientParameter(req, name);
  try {
    if (command.startsWith('Regist')) {
      if (req.method !== 'POST') {
        res.set('Allow', 'POST').status(405).send(clientError(2));
        return true;
      }
      const files = Array.isArray(req.files) ? req.files : Object.values(req.files ?? {}).flat();
      if (command === 'RegistReportTop') {
        const result = await beginReportUpload(db, actor, files);
        if (typeof result === 'string') res.send(result);
        else {
          await cleanupReportUpload(req.session.clientReportUpload);
          req.session.clientReportUpload = result;
          res.send(clientError(0));
        }
      } else {
        const upload = req.session.clientReportUpload;
        if (!upload) {
          res.send(clientError(2));
          return true;
        }
        const diagnostic: ReportSheetDiagnostic = {};
        if (command === 'RegistReportSheet') res.locals.reportSheet = diagnostic;
        const result =
          command === 'RegistReportSheet'
            ? await stageReportSheet(db, actor, upload, files, diagnostic)
            : command === 'RegistFreeDrawSheetInfo'
              ? await stageReportFreeDrawInfo(upload, files)
              : command === 'RegistReportFreeDrawSheet'
                ? await stageReportFreeDraw(upload, files, parameter('fdSheetNo'), parameter('isDelete'))
                : await finishReportUpload(db, actor, upload, parameter('unlock') !== '0');
        if (upload.result) await cleanupReportUpload(upload).catch(() => {});
        res.send(result);
      }
    } else if (command === 'MakeReportFromDefinitionTop' || command === 'GetReportDataTop') {
      delete req.session.clientReportDownload;
      const names = [
        'topId',
        'systemKey1',
        'systemKey2',
        'systemKey3',
        'systemKey4',
        'systemKey5',
        'copy',
        'copyReportMode',
      ];
      const result = await getReportDownload(
        db,
        actor,
        Object.fromEntries(names.map((name) => [name, parameter(name)])),
        command === 'MakeReportFromDefinitionTop',
      );
      if (typeof result === 'string') res.send(result);
      else {
        req.session.clientReportDownload = result;
        res.send(reportDownloadTop(result, parameter('backgroundImage').toLowerCase() !== 'false'));
      }
    } else if (['MakeReportFromDefinitionSheet', 'GetReportDataSheet'].includes(command)) {
      res.send(
        reportDownloadSheet(
          req.session.clientReportDownload,
          parameter('topId'),
          parameter('sheetNo'),
          command === 'MakeReportFromDefinitionSheet',
          parameter('backgroundImage').toLowerCase() !== 'false',
        ),
      );
    } else if (command === 'GetSheetBinaries') {
      const result = await reportSheetBinaries(
        db,
        actor,
        req.session.clientReportDownload,
        parameter('topId'),
        parameter('sheetNo'),
      );
      if (typeof result === 'string') res.send(result);
      else {
        res.type('application/zip').attachment('sheet_' + parameter('sheetNo') + '.zip');
        res.send(result);
      }
    } else {
      const result = await getReportFreeDraw(
        db,
        actor,
        parameter('repTopId'),
        command === 'GetReportFreeDrawSheet' ? parameter('fdSheetNo') : undefined,
        parameter('fileType'),
      );
      if (typeof result === 'string') res.send(result);
      else res.type('application/octet-stream').send(result);
    }
  } catch (error) {
    if (!(error instanceof ReportUnsupported)) throw error;
    requestFailure(res, error);
    res.status(501).send(clientError(-1, error.message));
  }
  return true;
}
