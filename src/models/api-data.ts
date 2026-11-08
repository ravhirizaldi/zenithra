import type pg from 'pg';
import { readFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { clientSettingsDirectory } from '../shared/license-counts.js';
import { exportStatement, serializeExportRows } from './manager/system/data-export.js';
import { configuredPath } from '../controllers/manager/system/files.js';

export const apiDataLists = {
  GetCommon: ['CommonBiz', 'common'],
  GetUser: ['UserBiz', 'user'],
  GetGroup: ['GroupBiz', 'group'],
  GetGroupAffiliation: ['GroupAffiliationBiz', 'groupAffiliation'],
  GetTerminal: ['TerminalBiz', 'terminal'],
  GetUserMeId: ['MeIdBiz', 'user'],
  GetDefinitionRole: ['DefinitionRoleBiz', 'defRole'],
  GetReportRole: ['ReportRoleBiz', 'repRole'],
  GetDefinitionReference: ['DefinitionReferenceBiz', 'definitionReference'],
  GetReportReference: ['ReportReferenceBiz', 'reportReference'],
  GetReportLabelDefinition: ['ReportLabelDefinitionBiz', 'reportLabelDefinition'],
  GetDefinitionLabelMaster: ['DefinitionLabelMasterBiz', 'definitionLabelMaster'],
  GetReportLabelMaster: ['ReportLabelMasterBiz', 'reportLabelMaster'],
  GetReference: ['ReferenceBiz', 'references'],
} as const;

export async function getApiData(
  db: Pick<pg.Pool, 'query'>,
  handler: keyof typeof apiDataLists,
  format: 'xml' | 'csv',
  options: Record<string, string>,
  userId?: string,
): Promise<string> {
  if (handler === 'GetReference') {
    const settings = Object.fromEntries(
      (
        await db.query(
          "SELECT com_name,com_value FROM mst_common WHERE com_key='VIRTUAL_DIRECTORY' AND com_name IN ('REFERENCE_PHYSICAL','REFERENCE_VIRTUAL')",
        )
      ).rows.map((row) => [row.com_name, row.com_value]),
    );
    if (typeof settings.REFERENCE_PHYSICAL !== 'string' || typeof settings.REFERENCE_VIRTUAL !== 'string')
      throw new Error('API reference settings are unavailable.');
    const rows: Record<string, unknown>[] = [];
    const directory = settings.REFERENCE_PHYSICAL ? configuredPath(settings.REFERENCE_PHYSICAL) : '';
    if (directory) {
      const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
        throw error;
      });
      for (const entry of entries) {
        // Do not expose linked files outside the configured upload directory.
        if (!entry.isFile()) continue;
        const info = await stat(join(directory, entry.name)),
          date = info.mtime;
        const pad = (value: number) => String(value).padStart(2, '0');
        rows.push({
          fileName: entry.name,
          url: `${settings.REFERENCE_VIRTUAL.replace(/\/+$/, '')}/${entry.name}`,
          size: info.size,
          uploadTime: `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
        });
      }
    }
    return format === 'xml'
      ? serializeExportRows(-1, format, 'references', rows)
      : rows
          .map(
            (row) =>
              Object.values(row)
                .map((value) => `"${String(value).replaceAll('"', '""')}"`)
                .join(',') + '\r\n',
          )
          .join('');
  }
  const command = ['GetUser', 'GetGroup', 'GetGroupAffiliation', 'GetTerminal', 'GetUserMeId'].indexOf(handler);
  if (command >= 0) {
    const statement = exportStatement(command, format, {
      ...options,
      withAdmin: options.withAdmin?.trim(),
      withImprint: options.withImprint?.trim(),
      deleted: options.deleted?.trim(),
    });
    return serializeExportRows(command, format, statement.tag, (await db.query(statement.text, statement.values)).rows);
  }
  const settings = clientSettingsDirectory();
  if (!settings) throw new Error('API settings are unavailable.');
  const [file, tag] = apiDataLists[handler];
  const xml = readFileSync(join(settings, file + '.xml'), 'utf8');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('Invalid API queries.');
  const label = handler === 'GetDefinitionLabelMaster' ? 'def' : handler === 'GetReportLabelMaster' ? 'rep' : undefined;
  const auth = label && options.useAuth === '1';
  if (auth && !userId) throw new Error('API label identity is unavailable.');
  const query = new XMLParser().parse(xml)?.query?.baseQuery?.[
    (format === 'xml' ? 'getXml' : 'getCsv') + (auth ? 'Auth' : '')
  ];
  if (typeof query !== 'string' || !/^\s*(?:SELECT|WITH)\b/i.test(query)) throw new Error('Invalid API query.');
  const rows = (await db.query(auth ? query.replace(/:user_id\b/g, '$1') : query, auth ? [userId] : [])).rows;
  if (label && rows.length) {
    const roles = (await db.query(`SELECT mst_label_id,group_id FROM ${label}_label_role`)).rows;
    for (const row of rows) {
      const groups = roles
        .filter((role) => String(role.mst_label_id) === String(format === 'xml' ? row.labelId : row.mst_label_id))
        .map((role) => role.group_id)
        .join(';');
      if (format === 'xml') row.labelRoleGroup = groups;
      else row.csv = `${row.csv ?? ''},"${String(row.auto_delete ?? '').replaceAll('"', '""')}","${groups}"`;
    }
  }
  return serializeExportRows(-1, format, tag, rows);
}
