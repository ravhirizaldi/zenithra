import type { Request, Response } from 'express';
import type pg from 'pg';
import { clientParameter } from './client-account.js';
import { clientTerminal } from '../models/client-account.js';
import {
  getClientBackgroundPdf,
  getClientExcel,
  getClientSheetBackground,
  getClientMessageImage,
  getClientMasterImage,
} from '../models/client-files.js';
import { clientError } from '../services/client-xml.js';
import { requestFailure } from '../middleware/request-log.js';

export async function clientFileAction(db: pg.Pool, command: string, req: Request, res: Response): Promise<boolean> {
  if (
    ![
      'GetDefinitionExcel',
      'GetBackgroundImage',
      'GetSheetBackgroundImage',
      'GetMessageImage',
      'GetMasterImage',
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
  const topId = clientParameter(req, 'topId'),
    repTopId = clientParameter(req, 'repTopId');
  if (
    ['GetDefinitionExcel', 'GetBackgroundImage'].includes(command) &&
    clientParameter(req, 'copyReportMode') === '1' &&
    repTopId
  ) {
    res.status(501).send(clientError(-1, 'Session-staged report copy transfer has not been migrated.'));
    return true;
  }
  try {
    if (command === 'GetMessageImage' || command === 'GetMasterImage') {
      const file =
        command === 'GetMessageImage'
          ? await getClientMessageImage(db, clientParameter(req, 'messageId'))
          : await getClientMasterImage(
              db,
              clientParameter(req, 'recordId'),
              clientParameter(req, 'fieldNo'),
              account.userId,
              terminal.id,
            );
      if (typeof file === 'string') res.send(file);
      else {
        // Express normalizes the legacy nonstandard MIME value to false; keep the ASPX wire value.
        res.setHeader('Content-Type', 'image');
        res.set('Content-Disposition', `attachment; filename=${file.filename}`).end(file.data);
      }
      return true;
    }
    if (command === 'GetDefinitionExcel') {
      const file = await getClientExcel(db, topId, repTopId);
      res
        .set('Content-Type', 'application/vnd.ms-excel')
        .set('Content-Disposition', `attachment; filename=${file.filename}`)
        .send(file.data);
    } else {
      const sheet = command === 'GetSheetBackgroundImage';
      const data = sheet
        ? await getClientSheetBackground(db, topId, clientParameter(req, 'sheetNo'))
        : await getClientBackgroundPdf(db, topId, repTopId);
      res
        .set('Content-Type', sheet ? 'image/png' : 'application/pdf')
        .set('Content-Disposition', `attachment; filename=background.${sheet ? 'png' : 'pdf'}`)
        .send(data);
    }
  } catch (error) {
    requestFailure(res, error);
    res.removeHeader('Content-Disposition');
    res.type('text/xml').send(clientError(-1, 'server error.'));
  }
  return true;
}
