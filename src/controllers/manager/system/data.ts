import { text as pageText } from '../../../config/manager/system/resources.js';
import {
  affiliationImportRows,
  importAffiliationRows,
} from '../../../models/manager/system/data-affiliation-import.js';
import { importRoles } from '../../../models/manager/system/data-role-import.js';
import { importLabelMasters, labelMasterImportRows } from '../../../models/manager/system/data-label-master-import.js';
import {
  importLabelLinks,
  labelLinkCommands,
  labelLinkImportRows,
} from '../../../models/manager/system/data-label-import.js';
import {
  importReferenceFiles,
  importReferences,
  referenceImportRows,
} from '../../../models/manager/system/data-reference-import.js';
import { readFile } from 'node:fs/promises';
import { importSelectionItems } from '../../../models/manager/system/data-selection-import.js';
import {
  commonImportRows,
  meIdImportRows,
  decodeImport,
  importCommonRows,
  importMeIdRows,
  type ImportResult,
} from '../../../models/manager/system/data-import.js';
import { dataImportCommands, dataImportLabels } from '../../../config/manager/system/legacy-data-import-options.js';
import { currentMailLocale } from './mail.js';
import { licenseStatus } from '../../../shared/license-counts.js';
import { dataOutputNames, dataExportLabels, systemDataExport } from '../../../models/manager/system/data-export.js';
import { hostname } from 'node:os';
import type { Express, Request, Response } from 'express';
import type pg from 'pg';
import { hasSystemPermission } from '../../../middleware/manager/system/permissions.js';

const root = '/ConMasManager/System';

type Render = (res: Response, data: Record<string, unknown>) => unknown;

function showBlocked(res: Response, render: Render, section: string, title: string, message: string, status = 503) {
  return render(res.status(status), {
    active: 'System',
    section,
    login: false,
    title,
    userName: res.locals.userName,
    systemDataPage: { mode: 'blocked', message },
  });
}

function userId(req: Request): string {
  return req.session?.userId ?? '';
}

export async function unlockUserTables(db: pg.Pool, id: string, term: string): Promise<void> {
  try {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      try {
        await client.query('DELETE FROM rep_lock WHERE user_id=$1 AND sys_regist_user=$1 AND sys_regist_term=$2', [
          id,
          term,
        ]);
        await client.query('COMMIT');
      } catch {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* preserve legacy best-effort unlock */
        }
      }
    } finally {
      client.release();
    }
    await db.query('DELETE FROM document_lock WHERE user_id=$1 AND sys_regist_user=$1 AND sys_regist_term=$2', [
      id,
      term,
    ]);
  } catch {
    // The legacy helper swallows unlock failures.
  }
}

export function registerSystemData(app: Express, db: pg.Pool, render: Render): void {
  const inputAccess = async (req: Request, res: Response) => {
    const actor = userId(req);
    if (
      licenseStatus().freeDrawOnly ||
      !(await hasSystemPermission(db, actor, 'system', 'create')) ||
      !(await hasSystemPermission(db, actor, 'system', 'edit'))
    ) {
      showBlocked(res, render, 'DataInput', dataImportLabels.dataInput, 'Role authority is insufficient.', 403);
      return false;
    }
    return true;
  };
  const inputPage = async (req: Request, res: Response, error = '', results: ImportResult[] = []) => {
    const locale = await currentMailLocale(db, req);
    const defaults = (
      await db.query(
        'SELECT com_key,com_value,com_locale,com_name FROM mst_common WHERE com_key=ANY($1::text[]) ORDER BY com_index',
        [['DEFAULT_DATA_INPUT_TYPE', 'DEFAULT_FILE_TYPE', 'ENCODING', 'ENCODING_TYPE']],
      )
    ).rows;
    const value = (key: string) => defaults.find((row) => row.com_key === key)?.com_value ?? '';
    const encoding =
      defaults.find((row) => row.com_key === 'ENCODING' && row.com_locale === locale)?.com_value ?? '65001';
    return render(res, {
      active: 'System',
      section: 'DataInput',
      login: false,
      title: dataImportLabels.dataInput,
      systemDataPage: {
        mode: 'input',
        commands: dataImportCommands,
        labels: dataImportLabels,
        command: value('DEFAULT_DATA_INPUT_TYPE'),
        format: value('DEFAULT_FILE_TYPE'),
        encoding,
        encodings: defaults.filter((row) => row.com_key === 'ENCODING_TYPE'),
        error,
        results,
      },
    });
  };
  app.get(`${root}/DataInput`, async (req, res) => {
    if (!(await inputAccess(req, res))) return;
    return inputPage(req, res);
  });
  app.post(`${root}/DataInput`, async (req, res) => {
    if (!(await inputAccess(req, res))) return;
    if (!req.file?.size) return inputPage(req, res, dataImportLabels.DataInputNoFileMessage);
    const command = typeof req.body.DataInputType === 'string' ? req.body.DataInputType : '';
    if (!command) return inputPage(req, res, dataImportLabels.DataInputNoInputTypeMessage);
    const format = typeof req.body.type === 'string' ? req.body.type : '';
    if (!format) return inputPage(req, res, dataImportLabels.DataInputNoFileTypeMessage);
    if (!dataImportCommands.some((option) => option.value === command))
      return inputPage(req, res.status(400), dataImportLabels.serverError);
    if (command === 'RegistReference') {
      const files = Array.isArray(req.files) ? req.files : Object.values(req.files ?? {}).flat();
      try {
        return inputPage(req, res, '', await importReferenceFiles(db, files));
      } catch {
        return inputPage(req, res, dataImportLabels.serverError);
      }
    }
    if (
      ![
        'RegistCommon',
        'RegistUserMeId',
        'RegistGroupAffiliation',
        'RegistDefinitionRole',
        'RegistReportRole',
        'RegistDefenitionLabelMaster',
        'RegistReportLabelMaster',
        'RegistDefenitionReference',
        'RegistReportReference',
        'UpdateSelectItem',
      ].includes(command) &&
      !Object.hasOwn(labelLinkCommands, command)
    )
      return inputPage(req, res.status(501), dataImportLabels.serverError);
    if (!['csv', 'xml'].includes(format)) return inputPage(req, res, '', [{ code: '2', remark: '' }]);
    try {
      const text = decodeImport(
        req.file.buffer ?? (await readFile(req.file.path)),
        format,
        typeof req.body.encoding === 'string' ? req.body.encoding : '65001',
      );
      const roleOptions: Record<string, string> = {};
      for (const key of ['defRoleMode', 'repRoleMode', 'defRoleModeTarget', 'repRoleModeTarget']) {
        roleOptions[key] = [req.query[key], req.body[key]]
          .flat()
          .filter((value) => typeof value === 'string')
          .join(',');
      }
      const results =
        command === 'RegistCommon'
          ? await importCommonRows(db, commonImportRows(text, format), userId(req), req.ip ?? '')
          : command === 'UpdateSelectItem'
            ? await importSelectionItems(
                db,
                text,
                format,
                userId(req),
                req.ip ?? '',
                [req.query.force, req.body.force]
                  .flat()
                  .filter((value) => typeof value === 'string')
                  .join(','),
              )
            : command === 'RegistUserMeId'
              ? await importMeIdRows(db, meIdImportRows(text, format), userId(req), req.ip ?? '')
              : command === 'RegistDefenitionReference' || command === 'RegistReportReference'
                ? await importReferences(
                    db,
                    referenceImportRows(text, format, command === 'RegistDefenitionReference' ? 'def' : 'rep'),
                    command === 'RegistDefenitionReference' ? 'def' : 'rep',
                    userId(req),
                    req.ip ?? '',
                  )
                : command === 'RegistDefenitionLabelMaster' || command === 'RegistReportLabelMaster'
                  ? await importLabelMasters(
                      db,
                      labelMasterImportRows(text, format, command === 'RegistDefenitionLabelMaster' ? 'def' : 'rep'),
                      command === 'RegistDefenitionLabelMaster' ? 'def' : 'rep',
                      userId(req),
                      req.ip ?? '',
                    )
                  : Object.hasOwn(labelLinkCommands, command)
                    ? await importLabelLinks(
                        db,
                        labelLinkImportRows(text, format, labelLinkCommands[command as keyof typeof labelLinkCommands]),
                        labelLinkCommands[command as keyof typeof labelLinkCommands],
                        userId(req),
                        req.ip ?? '',
                      )
                    : command === 'RegistDefinitionRole' || command === 'RegistReportRole'
                      ? await importRoles(
                          db,
                          text,
                          format,
                          command === 'RegistDefinitionRole' ? 'definition' : 'report',
                          userId(req),
                          req.ip ?? '',
                          roleOptions,
                        )
                      : await importAffiliationRows(db, affiliationImportRows(text, format), userId(req), req.ip ?? '');
      return inputPage(
        req,
        res,
        '',
        results.length ? results : [{ code: '-', remark: dataImportLabels.DataInputNothingMessage }],
      );
    } catch {
      return inputPage(req, res, dataImportLabels.serverError);
    }
  });

  const outputAccess = async (req: Request, res: Response): Promise<boolean> => {
    try {
      if (licenseStatus().freeDrawOnly || !(await hasSystemPermission(db, userId(req), 'system', 'read'))) {
        showBlocked(res, render, 'DataOutput', dataExportLabels.DataOutput, 'Role authority is insufficient.', 403);
        return false;
      }
      return true;
    } catch {
      showBlocked(res, render, 'DataOutput', dataExportLabels.DataOutput, 'License information is unavailable.', 503);
      return false;
    }
  };
  const outputPage = (res: Response, command: number, fragment = false) => {
    const page = { mode: 'output', command, fragment, labels: dataExportLabels, outputTypes: dataOutputNames };
    return fragment
      ? res.render('manager/system/data', {
          base: '/ConMasManager',
          csrfToken: res.locals.csrfToken ?? '',
          systemDataPage: page,
        })
      : render(res, {
          active: 'System',
          section: 'DataOutput',
          login: false,
          title: dataExportLabels.DataOutput,
          systemDataPage: page,
        });
  };
  app.get(`${root}/DataOutput`, async (req, res) => {
    if (!(await outputAccess(req, res))) return;
    return outputPage(res, 0);
  });
  app.post(`${root}/DataOutput`, async (req, res) => {
    if (!(await outputAccess(req, res))) return;
    const command =
      typeof req.body?.DataOutputType === 'string' && /^[0-4]$/.test(req.body.DataOutputType)
        ? Number(req.body.DataOutputType)
        : -1;
    const format = typeof req.body?.type === 'string' ? req.body.type : '';
    const encoding = typeof req.body?.encoding === 'string' ? req.body.encoding : '';
    if (command < 0 || !['xml', 'csv'].includes(format) || (format === 'csv' && !['932', '65001'].includes(encoding)))
      return res.status(400).send(pageText['System error.']);
    try {
      const bytes = await systemDataExport(db, command, format, encoding, req.body);
      res.attachment(dataOutputNames[command] + '.' + format);
      return res.type(format).send(bytes);
    } catch {
      return showBlocked(res, render, 'DataOutput', dataExportLabels.DataOutput, 'System error.', 500);
    }
  });
  app.get(`${root}/DataOutputView`, async (req, res) => {
    if (!(await outputAccess(req, res))) return;
    const command =
      typeof req.query.command === 'string' && /^[0-4]$/.test(req.query.command) ? Number(req.query.command) : -1;
    if (req.get('X-Requested-With') !== 'XMLHttpRequest' || command < 0)
      return res.status(500).send(pageText['System error.']);
    return outputPage(res, command, true);
  });

  app.get(`${root}/unLockTable`, async (req, res) => {
    await unlockUserTables(db, userId(req), hostname());
    return res.status(200).end();
  });
}
