import { text as pageText } from '../../../config/manager/system/resources.js';
import type pg from 'pg';
import { importRowResult, importXmlRecords, parseImportCsv, type ImportResult } from './data-import.js';

export const labelLinkCommands = {
  RegistDefenitionLabel: 'definition',
  RegistReportLabelDefenition: 'reportDefinition',
  RegistReportLabel: 'report',
} as const;
type LabelLinkKind = (typeof labelLinkCommands)[keyof typeof labelLinkCommands];
const specs = {
  definition: { table: 'def_label', column: 'def_top_id', field: 'defTopId', tag: 'definitionLabel' },
  reportDefinition: { table: 'def_rep_label', column: 'def_top_id', field: 'defTopId', tag: 'reportLabelDefinition' },
  report: { table: 'rep_label', column: 'rep_top_id', field: 'repTopId', tag: 'reportLabel' },
};

export function labelLinkImportRows(text: string, format: string, kind: LabelLinkKind): string[][] {
  if (format === 'csv') return parseImportCsv(text);
  if (format !== 'xml') throw new Error(pageText['Invalid format.']);
  const spec = specs[kind];
  return importXmlRecords(text, spec.tag).map((row) =>
    ['action', spec.field, 'labelId'].map((field) => String(row[field] ?? '')),
  );
}

export async function importLabelLinks(
  db: pg.Pool,
  rows: string[][],
  kind: LabelLinkKind,
  actor: string,
  host: string,
): Promise<ImportResult[]> {
  const spec = specs[kind],
    now = new Date();
  const results: ImportResult[] = [];
  for (const row of rows) {
    if (row.length !== 3) {
      results.push(importRowResult(10010));
      continue;
    }
    const [action, id, label] = row;
    if (!['A', 'U', 'D', 'M'].includes(action)) {
      results.push(importRowResult(action ? 11020 : 11010, 'action'));
      continue;
    }
    if (action !== 'A' && action !== 'D') {
      // The report variants call CheckInt after rejecting U/M, so missing/ignore IDs override that error.
      const idOverrides = kind !== 'definition' && (!id || id === '{ignore}');
      results.push(importRowResult(idOverrides && !id ? 11010 : 11020, idOverrides ? spec.field : 'action'));
      continue;
    }
    let error: ImportResult | undefined;
    for (const [value, field] of [
      [id, spec.field],
      [label, 'labelId'],
    ]) {
      if (!value) error = importRowResult(11010, field);
      else if (value === '{ignore}') error = importRowResult(11020, field);
      else if (!/^[+-]?\d+$/.test(value.trim()) || Number(value) < 0 || Number(value) > 2147483647)
        error = importRowResult(11030, field);
      if (error) break;
    }
    if (error) {
      results.push(error);
      continue;
    }
    const client = await db.connect();
    try {
      if (
        kind === 'report' &&
        (await client.query('SELECT binder_rep_id FROM mst_label_rep WHERE mst_label_id=$1', [Number(label)])).rows[0]
          ?.binder_rep_id != null
      ) {
        results.push(importRowResult(11000, 'labelId'));
        continue;
      }
      await client.query('BEGIN');
      try {
        if (action === 'A')
          await client.query(
            `INSERT INTO ${spec.table} (${spec.column},mst_label_id,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time) VALUES ($1,$2,$3,$4,$5,$3,$4,$5)`,
            [Number(id), Number(label), 'WEBAPI/' + host, actor, now],
          );
        else await client.query(`DELETE FROM ${spec.table} WHERE ${spec.column}=$1`, [Number(id)]);
        await client.query('COMMIT');
        results.push(importRowResult(0));
      } catch {
        await client.query('ROLLBACK');
        results.push(importRowResult(10020));
      }
    } finally {
      client.release();
    }
  }
  return results;
}
