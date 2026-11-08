import type { Request, Response } from 'express';
import type pg from 'pg';
import { clientParameter } from './client-account.js';
import { clientError, clientElement } from '../services/client-xml.js';
import { clientIoTLicenseStatus } from '../shared/license-counts.js';
import {
  getClientApiDocumentList,
  getClientApiDocumentDownload,
  deleteClientApiDocument,
  registerClientApiDocument,
} from '../models/client-library-api.js';
import { getClientReportTopDetail } from '../models/client-report-api.js';
import { getClientDownloadReportList } from '../models/client-schedule.js';
import { requestFailure } from '../middleware/request-log.js';

export async function generalApiAction(
  db: pg.Pool,
  userId: string | undefined,
  req: Request,
  res: Response,
): Promise<void> {
  const target = clientParameter(req, 'target'),
    process = clientParameter(req, 'process');
  const known =
    (target === 'System' && process === 'LicenseStatusInquiry') ||
    (target === 'InputReport' && ['DownloadMergedPdf', 'TopDetailInquiry'].includes(process)) ||
    (target === 'Library' &&
      ['DocumentDeletion', 'DocumentDownload', 'DocumentList', 'DocumentRegistration'].includes(process)) ||
    (target === 'Schedule' && process === 'ReportListForDownload');
  if (!known) {
    res.send(clientError(1, "'target' or 'process' is not found."));
    return;
  }
  const library = target === 'Library';
  const report = target === 'InputReport' && process === 'TopDetailInquiry';
  const schedule = target === 'Schedule';
  if (!userId) {
    res.send(clientError(5, 'no session.'));
    return;
  }
  if (target !== 'System' && !library && !report && !schedule) {
    res.status(501).send(clientError(-1, `The ${target}/${process} API has not been migrated.`));
    return;
  }
  try {
    const write = library && ['DocumentDeletion', 'DocumentRegistration'].includes(process);
    if (write ? req.method !== 'POST' : !['GET', 'POST'].includes(req.method)) {
      res.send(
        clientError(
          4,
          `Invalid HTTP request method '${req.method}'. It must be ${write ? "'POST'" : "either 'GET' or 'POST'"}.`,
        ),
      );
      return;
    }
    if (report) {
      res.send(
        await getClientReportTopDetail(db, userId, clientParameter(req, 'repTopId'), clientParameter(req, 'items')),
      );
      return;
    }
    // Node fixes the legacy reflection constructor mismatch; direct and generic clients share the working contract.
    if (schedule) {
      res.send(await getClientDownloadReportList(db, userId));
      return;
    }
    if (library) {
      const names = [
        'documentType',
        'documentId',
        'documentName',
        'labelPath',
        'scopeOfLabel',
        'scopeOfExpiration',
        'storageMode',
        'mobileSave',
        'userFirstCreated',
        'dateFirstCreatedFrom',
        'dateFirstCreatedTo',
        'userLastModified',
        'dateLastModifiedFrom',
        'dateLastModifiedTo',
        'limitOfList',
        'skipOver',
        'downloadType',
        'documentUrl',
        'iconType',
        'manualDownload',
        'lifeTime',
        'expire',
        'useInOtherApp',
        'labelIcon',
        'definitionId',
        'reportId',
        'groupId',
      ];
      const params = Object.fromEntries(
        names.map((name) => [
          name,
          req.query[name] === undefined && req.body?.[name] === undefined ? undefined : clientParameter(req, name),
        ]),
      );
      const result =
        process === 'DocumentList'
          ? await getClientApiDocumentList(db, userId, params)
          : process === 'DocumentRegistration'
            ? await registerClientApiDocument(db, userId, params, req.file, req.ip)
            : process === 'DocumentDeletion'
              ? await deleteClientApiDocument(db, userId, params)
              : await getClientApiDocumentDownload(db, userId, params);
      if (typeof result === 'string') res.send(result);
      else {
        const filename = encodeURIComponent(result.filename).replace(
          /[!'()*]/g,
          (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
        );
        res.setHeader('Content-Type', result.contentType);
        res.set('Content-Disposition', `attachment; filename=${filename}`).end(result.data);
      }
      return;
    }
    const item = clientParameter(req, 'item');
    if (!item) {
      res.send(clientError(2, "'item' is required."));
      return;
    }
    if (item !== 'ConMasIoTGateway') {
      res.send(clientError(2, `Invalid value '${item}' specified for 'item'. It must be 'ConMasIoTGateway'.`));
      return;
    }
    if (userId !== 'conmasadmin') {
      const roles = (
        await db.query(
          `SELECT role_mst_read,role_mst_system_read FROM mst_group g
        WHERE EXISTS (SELECT 1 FROM mst_group_affiation a WHERE a.group_id=g.group_id AND a.user_id=$1)`,
          [userId],
        )
      ).rows;
      if (!roles.some((row) => Number(row.role_mst_read) === 1 || Number(row.role_mst_system_read) === 1)) {
        res.send(clientError(3, 'Unauthorized to refer system settings.'));
        return;
      }
    }
    res.send(`<conmas><license>${clientElement('conMasIoTGateway', clientIoTLicenseStatus())}</license></conmas>`);
  } catch (error) {
    requestFailure(res, error);
    res.send(clientError(-1, 'server error.'));
  }
}

export async function clientGeneralAction(db: pg.Pool, req: Request, res: Response): Promise<void> {
  return generalApiAction(db, req.session.clientAccount?.userId, req, res);
}
