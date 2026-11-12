import type { Request, Response } from 'express';
import type pg from 'pg';
import { clientParameter } from './client-account.js';
import { clientTerminal } from '../models/client-account.js';
import { getClientCalendar, getClientUsers, identifyClientApprover } from '../models/client-catalog.js';
import { clientError } from '../services/client-xml.js';
import { getClientMenu } from '../models/client-menu.js';
import {
  getClientLocalReferenceList,
  getClientLocalReference,
  getClientDocumentInfo,
  getClientDocumentList,
  unlockClientDocuments,
} from '../models/client-library.js';
import { getClientMasterList, getClientCustomMasterLabels, getClientMasterRecords } from '../models/client-masters.js';
import { getClientDownloadReportList } from '../models/client-schedule.js';
import { getClientReportTopDetail, unlockClientReport } from '../models/client-report-api.js';
import { requestFailure } from '../middleware/request-log.js';

export async function clientCatalogAction(db: pg.Pool, command: string, req: Request, res: Response): Promise<boolean> {
  if (
    ![
      'GetCalendarList',
      'GetUser',
      'IdentifyApprover',
      'GetCustomMenuSettings',
      'GetCustomMultiMenuSettings',
      'GetLocalReferenceList',
      'GetLocalReference',
      'UnlockDocument',
      'DownloadReportList',
      'PickOutReportTopData',
      'UnlockReport',
      'GetMasterList',
      'GetCustomMasterLabel',
      'GetMasterRecordList',
      'GetDocumentInfo',
      'GetDocumentList',
    ].includes(command)
  )
    return false;
  const account = req.session.clientAccount;
  if (!account) {
    res.send(clientError(5, 'no session.'));
    return true;
  }
  try {
    if (command === 'DownloadReportList' || command === 'PickOutReportTopData') {
      if (!['GET', 'POST'].includes(req.method))
        res.send(clientError(4, `Invalid HTTP request method '${req.method}'. It must be either 'GET' or 'POST'.`));
      // Source ClientValidator never sets errorCode, so its client remarks do not reject the request.
      else
        res.send(
          command === 'DownloadReportList'
            ? await getClientDownloadReportList(db, account.userId)
            : await getClientReportTopDetail(
                db,
                account.userId,
                clientParameter(req, 'repTopId'),
                clientParameter(req, 'items'),
              ),
        );
      return true;
    }
    const terminal = await clientTerminal(db, account);
    // These pages clear this terminal's stale master-sync marker before CheckTerminal.
    if (['GetCalendarList', 'GetDocumentList'].includes(command) && terminal.id !== null)
      await db.query('DELETE FROM custom_master_synching_terminal WHERE term_id=$1', [terminal.id]);
    if (terminal.code !== 0) {
      res.send(clientError(3));
      return true;
    }
    const parameter = (name: string) => clientParameter(req, name);
    if (command === 'GetMasterRecordList') {
      const params = Object.fromEntries(
        [
          'masterType',
          'masterId',
          'masterKey',
          'defTopId',
          'repTopId',
          'recordId',
          'recordKey',
          'fieldSearch',
          'startNo',
          'max',
          'recordVersion',
          'isDeleteTran',
          'lastDownloadTime',
        ]
          .filter((name) => req.query[name] !== undefined || req.body?.[name] !== undefined)
          .map((name) => [name, parameter(name)]),
      );
      res.send(
        await getClientMasterRecords(
          db,
          { userId: account.userId, termType: account.client, termId: String(terminal.id ?? '') },
          params,
        ),
      );
      return true;
    }
    if (command === 'GetMasterList')
      res.send(
        await getClientMasterList(
          db,
          account.userId,
          account.physicalId,
          Object.fromEntries(
            [
              'masterType',
              'masterId',
              'masterKey',
              'defTopId',
              'repTopId',
              'isColumn',
              'isDeleteTran',
              'lastDownloadTime',
              'ignoreExpire',
            ].map((name) => [name, parameter(name)]),
          ),
        ),
      );
    else if (command === 'GetCustomMasterLabel') res.send(await getClientCustomMasterLabels(db));
    else if (command === 'GetDocumentInfo' || command === 'GetDocumentList')
      res.send(
        await (command === 'GetDocumentInfo' ? getClientDocumentInfo : getClientDocumentList)(
          db,
          account.userId,
          Object.fromEntries(
            [
              'documentId',
              'iconType',
              'libraryType',
              'labelId',
              'editStatus',
              'word',
              'wordTargetName',
              'wordTargetRemarks',
              'wordTargetLabelName',
            ].map((name) => [name, parameter(name)]),
          ),
        ),
      );
    else if (command === 'GetCalendarList')
      res.send(
        await getClientCalendar(db, account.userId, parameter('year'), parameter('month'), parameter('publicStatus')),
      );
    else if (command === 'IdentifyApprover')
      res.send(await identifyClientApprover(db, account.userId, parameter('identificationCode')));
    else if (command === 'GetCustomMenuSettings' || command === 'GetCustomMultiMenuSettings')
      res
        .type('application/octet-stream')
        .set('Content-Disposition', 'attachment; filename=customMenu.zip')
        .send(await getClientMenu(db, account.userId, command === 'GetCustomMultiMenuSettings'));
    else if (command === 'GetLocalReferenceList')
      res.send(await getClientLocalReferenceList(db, account.userId, parameter('libraryType')));
    else if (command === 'UnlockDocument') res.send(await unlockClientDocuments(db, parameter('documentId')));
    else if (command === 'UnlockReport')
      res.send(await unlockClientReport(db, account.userId, terminal.id!, parameter('topId')));
    else if (command === 'GetLocalReference') {
      const file = await getClientLocalReference(
        db,
        account.userId,
        terminal.id!,
        parameter('localFileId'),
        parameter('fileType'),
        parameter('previewMode'),
      );
      if (typeof file === 'string') res.send(file);
      else {
        res.setHeader('Content-Type', file.contentType);
        res.set('Content-Disposition', `attachment; filename=${file.filename}`).end(file.data);
      }
    } else {
      const result = await getClientUsers(db, {
        type: parameter('type'),
        withAdmin: parameter('withAdmin'),
        withImprint: parameter('withImprint'),
        userId: parameter('userId'),
        encoding: parameter('encoding'),
        cultureName: parameter('cultureName') || 'en-US',
      });
      if (result.encoding) res.set('Content-Type', `text/plain; charset=${result.encoding}`);
      res.send(result.data);
    }
  } catch (error) {
    requestFailure(res, error);
    res.type('text/xml').send(clientError(-1, 'server error.'));
  }
  return true;
}
