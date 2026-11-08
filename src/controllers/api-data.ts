import { readFile } from 'node:fs/promises';
import type { Request, Response } from 'express';
import type pg from 'pg';
import { apiConfiguration } from '../config/api.js';
import { clientParameter } from './client-account.js';
import { apiDataLists, getApiData } from '../models/api-data.js';
import { clientElement, clientError } from '../services/client-xml.js';
import { encodeExport } from '../models/manager/system/data-export.js';
import {
  commonImportRows,
  decodeImport,
  importCommonRows,
  importMeIdRows,
  meIdImportRows,
} from '../models/manager/system/data-import.js';
import { affiliationImportRows, importAffiliationRows } from '../models/manager/system/data-affiliation-import.js';
import { importRoles } from '../models/manager/system/data-role-import.js';
import {
  importReferenceFiles,
  importReferences,
  referenceImportRows,
} from '../models/manager/system/data-reference-import.js';
import { importLabelLinks, labelLinkImportRows } from '../models/manager/system/data-label-import.js';
import { importLabelMasters, labelMasterImportRows } from '../models/manager/system/data-label-master-import.js';
import { importSelectionItems } from '../models/manager/system/data-selection-import.js';
import { getClientMasterList, getClientCustomMasterLabels, getClientMasterRecords } from '../models/client-masters.js';
import { getClientMasterImage } from '../models/client-files.js';
import { requestFailure } from '../middleware/request-log.js';

export const apiDataImports = [
  'RegistCommon',
  'RegistUserMeId',
  'RegistGroupAffiliation',
  'RegistDefinitionRole',
  'RegistReportRole',
  'RegistDefinitionReference',
  'RegistReportReference',
  'RegistDefinitionLabel',
  'RegistReportLabelDefinition',
  'RegistReportLabel',
  'RegistDefinitionLabelMaster',
  'RegistReportLabelMaster',
  'UpdateSelectItem',
  'RegistReference',
] as const;

export async function apiDataAction(db: pg.Pool, handler: string, req: Request, res: Response): Promise<boolean> {
  if (['GetMasterRecordList', 'GetMasterList', 'GetCustomMasterLabel', 'GetMasterImage'].includes(handler)) {
    try {
      const account = req.session.apiAccount!;
      const params = Object.fromEntries(
        [
          'masterType',
          'masterId',
          'masterKey',
          'defTopId',
          'repTopId',
          'recordId',
          'recordKey',
          'fieldNo',
          'fieldSearch',
          'startNo',
          'max',
          'recordVersion',
          'isColumn',
          'isDeleteTran',
          'lastDownloadTime',
          'ignoreExpire',
        ]
          .filter((name) => req.query[name] !== undefined || req.body?.[name] !== undefined)
          .map((name) => [name, clientParameter(req, name)]),
      );
      if (handler === 'GetMasterImage') {
        const file = await getClientMasterImage(db, params.recordId ?? '', params.fieldNo ?? '', account.userId, null);
        if (typeof file === 'string') res.send(file);
        else {
          res.setHeader('Content-Type', 'image');
          res.set('Content-Disposition', `attachment; filename=${file.filename}`).end(file.data);
        }
      } else
        res.send(
          handler === 'GetCustomMasterLabel'
            ? await getClientCustomMasterLabels(db)
            : handler === 'GetMasterList'
              ? await getClientMasterList(db, account.userId, '', params)
              : await getClientMasterRecords(
                  db,
                  { userId: account.userId, termType: 'API', termId: account.address },
                  params,
                ),
        );
    } catch (error) {
      requestFailure(res, error);
      res.removeHeader('Content-Disposition');
      res.type('text/xml').send(clientError(-1, 'server error.'));
    }
    return true;
  }
  const list = Object.hasOwn(apiDataLists, handler),
    importing = apiDataImports.some((name) => name === handler);
  if (!list && !importing) return false;
  const parameter = (name: string) => clientParameter(req, name);
  if (handler === 'RegistReference') {
    const files = Array.isArray(req.files) ? req.files : Object.values(req.files ?? {}).flat();
    await importReferenceFiles(db, files);
    res.send(clientError(0));
    return true;
  }
  if (
    handler === 'RegistReportLabelMaster' &&
    (
      await db.query(
        "SELECT com_value FROM mst_common WHERE com_key='API_MODE' AND com_name='MST_LABEL_REP_KEY_MODE' AND coalesce(com_locale,'')='' ORDER BY com_index LIMIT 1",
      )
    ).rows[0]?.com_value === '1'
  ) {
    res.status(501).send(clientError(-1, 'API report label system-key import has not been migrated.'));
    return true;
  }
  const format = parameter('type');
  if (
    (format !== 'xml' && format !== 'csv') ||
    (importing && (!req.file || (handler === 'RegistUserMeId' && !req.file.size)))
  ) {
    res.send(clientError(2));
    return true;
  }
  if (
    ['GetDefinitionLabelMaster', 'GetReportLabelMaster'].includes(handler) &&
    (Object.hasOwn(req.query, 'useAuth') || Object.hasOwn(req.body ?? {}, 'useAuth')) &&
    !['0', '1'].includes(parameter('useAuth'))
  ) {
    res.send(clientError(2));
    return true;
  }
  const roleOptions = Object.fromEntries(
    ['defRoleMode', 'repRoleMode', 'defRoleModeTarget', 'repRoleModeTarget'].map((name) => [name, parameter(name)]),
  );
  if (handler === 'RegistDefinitionRole') {
    for (const name of ['defRoleModeTarget', 'repRoleModeTarget']) {
      if (roleOptions[name] && roleOptions[name].split(',').some((value) => !['A', 'U', 'D', 'M'].includes(value))) {
        res.send(clientError(2, `Invalid Parameter (${name})`));
        return true;
      }
    }
  }
  let encoding = parameter('encoding').trim();
  if (format === 'csv') {
    if (!['932', '65001'].includes(encoding)) {
      if (encoding && /^\+?\d+$/.test(encoding) && Number(encoding) <= 65535) {
        res.status(501).send(clientError(-1, 'This API CSV encoding has not been migrated.'));
        return true;
      }
      encoding =
        (
          await db.query(`SELECT com_value FROM mst_common WHERE com_key='ENCODING' AND com_locale=$1`, [
            apiConfiguration().culture,
          ])
        ).rows[0]?.com_value ?? '';
    }
    if (!['932', '65001'].includes(encoding)) {
      res.status(501).send(clientError(-1, 'This API CSV encoding has not been migrated.'));
      return true;
    }
  }
  if (list) {
    const options = Object.fromEntries(
      ['withAdmin', 'withImprint', 'userId', 'deleted', 'useAuth'].map((name) => [name, parameter(name)]),
    );
    const body = await getApiData(
      db,
      handler as keyof typeof apiDataLists,
      format,
      options,
      req.session.apiAccount?.userId,
    );
    res
      .set(
        'Content-Type',
        format === 'xml'
          ? 'text/xml; charset=utf-8'
          : `text/plain; charset=${encoding === '932' ? 'shift_jis' : 'utf-8'}`,
      )
      .send(encodeExport(body, format, encoding));
    return true;
  }
  const text = decodeImport(req.file!.buffer ?? (await readFile(req.file!.path)), format, encoding);
  const user = req.session.apiAccount!.userId,
    host = req.ip ?? '';
  const kind =
    handler === 'RegistDefinitionLabel'
      ? 'definition'
      : handler === 'RegistReportLabelDefinition'
        ? 'reportDefinition'
        : 'report';
  const results =
    handler === 'RegistCommon'
      ? await importCommonRows(db, commonImportRows(text, format), user, host)
      : handler === 'RegistUserMeId'
        ? await importMeIdRows(db, meIdImportRows(text, format), user, host)
        : handler === 'RegistGroupAffiliation'
          ? await importAffiliationRows(db, affiliationImportRows(text, format), user, host, 'Api')
          : handler === 'RegistDefinitionRole' || handler === 'RegistReportRole'
            ? await importRoles(
                db,
                text,
                format,
                handler === 'RegistDefinitionRole' ? 'definition' : 'report',
                user,
                host,
                roleOptions,
              )
            : handler === 'RegistDefinitionReference' || handler === 'RegistReportReference'
              ? await importReferences(
                  db,
                  referenceImportRows(text, format, handler === 'RegistDefinitionReference' ? 'def' : 'rep'),
                  handler === 'RegistDefinitionReference' ? 'def' : 'rep',
                  user,
                  host,
                )
              : handler === 'RegistDefinitionLabelMaster' || handler === 'RegistReportLabelMaster'
                ? await importLabelMasters(
                    db,
                    labelMasterImportRows(text, format, handler === 'RegistDefinitionLabelMaster' ? 'def' : 'rep'),
                    handler === 'RegistDefinitionLabelMaster' ? 'def' : 'rep',
                    user,
                    host,
                  )
                : handler === 'UpdateSelectItem'
                  ? await importSelectionItems(db, text, format, user, host, parameter('force'))
                  : await importLabelLinks(db, labelLinkImportRows(text, format, kind), kind, user, host);
  res.send(
    `<conmas><results>${results.map((row) => `<result>${clientElement('code', row.code)}${clientElement('remark', row.remark)}</result>`).join('')}</results></conmas>`,
  );
  return true;
}
