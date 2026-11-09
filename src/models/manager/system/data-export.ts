import { text as pageText } from '../../../config/manager/system/resources.js';
import type pg from 'pg';
import { XMLBuilder } from 'fast-xml-parser';
import { createRequire } from 'node:module';
import { legacyDataExportQueries } from './legacy-data-export-queries.js';

export const dataOutputNames = [
  'OutputUser',
  'OutputGroup',
  'OutputGroupAffiliation',
  'OutputTerminal',
  'OutputUserMeId',
] as const;
export function exportStatement(command: number, format: string, options: Record<string, unknown>) {
  if (!Number.isInteger(command) || command < 0 || command > 4 || !['xml', 'csv'].includes(format))
    throw new Error(pageText['Invalid export parameters.']);
  const values: unknown[] = [];
  const parameter = (value: unknown) => {
    values.push(value);
    return '$' + values.length;
  };
  if (command === 4)
    return {
      text: `SELECT user_id AS "userId", COALESCE(meid_upn,'') AS "meidUpn", COALESCE(meid_oid,'') AS "meidOid" FROM mst_user WHERE user_id <> $1 ORDER BY user_id`,
      values: ['conmasadmin'],
      tag: 'user',
    };
  const source = legacyDataExportQueries[command];
  let text: string = source.queries[format === 'xml' ? 'getXml' : 'getCsv'];
  let filter = '';
  if (command === 0) {
    if (String(options.withAdmin).toLowerCase() === 'false') filter += ' AND user_id <> ' + parameter('conmasadmin');
    if (typeof options.userId === 'string' && options.userId) filter += ' AND user_id = ' + parameter(options.userId);
    if (String(options.withImprint).toLowerCase() === 'false') {
      text = source.queries[format === 'xml' ? 'getXmlNoSign' : 'getCsvNoSign'];
    }
  }
  if (
    command === 3 &&
    typeof options.deleted === 'string' &&
    /^[+-]?\d+$/.test(options.deleted) &&
    Number(options.deleted) >= -2147483648 &&
    Number(options.deleted) <= 2147483647
  )
    filter = ' AND deleted = ' + parameter(Number(options.deleted));
  return { text: text.replace('{0}', filter), values, tag: source.tag };
}
export function serializeExportRows(
  command: number,
  format: string,
  tag: string,
  rows: Record<string, unknown>[],
): string {
  if (format === 'csv') {
    return rows
      .map((row) =>
        command === 4
          ? ['userId', 'meidUpn', 'meidOid'].map((key) => '"' + String(row[key] ?? '') + '"').join(',')
          : String(Object.values(row)[0] ?? ''),
      )
      .map((line) => line + '\r\n')
      .join('');
  }
  const data = rows.map((row) =>
    Object.fromEntries(
      Object.entries(row)
        .filter(([, value]) => value !== null && value !== undefined)
        .map(([key, value]) => [key, Buffer.isBuffer(value) ? value.toString('base64') : value]),
    ),
  );
  return new XMLBuilder({ format: true, indentBy: '  ', suppressEmptyNode: true })
    .build({ conmas: { [tag]: data } })
    .trimEnd()
    .replace(/\/>/g, ' />')
    .replace(/\r?\n/g, '\r\n');
}
export function encodeExport(text: string, format: string, encoding: string): Buffer {
  if (format === 'xml' || encoding === '65001') return Buffer.from(text, 'utf8');
  if (encoding !== '932') throw new Error(pageText['Invalid export encoding.']);
  const appRequire = createRequire(import.meta.url);
  const expressRequire = createRequire(appRequire.resolve('express'));
  const bodyParserRequire = createRequire(expressRequire.resolve('body-parser'));
  const iconv = bodyParserRequire('iconv-lite') as { encode(text: string, encoding: string): Buffer };
  return iconv.encode(text, 'shift_jis');
}
export async function systemDataExport(
  db: pg.Pool,
  command: number,
  format: string,
  encoding: string,
  options: Record<string, unknown>,
): Promise<Buffer> {
  const statement = exportStatement(command, format, options);
  const rows = (await db.query(statement.text, statement.values)).rows;
  return encodeExport(serializeExportRows(command, format, statement.tag, rows), format, encoding);
}

export const dataExportLabels = {
  OutputUser: 'Get user information',
  OutputGroup: 'Get group information',
  OutputGroupAffiliation: 'Get group affiliation',
  OutputTerminal: 'Get device information',
  OutputUserMeId: 'Retrieving Microsoft Entra ID User Collaboration Information',
  TargetToOutput: 'Acquisition target',
  FileFormat: 'File format',
  ConMasResource_Encoding: 'Encoding',
  DataOutput: 'Data Export',
};
