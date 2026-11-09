import { text as pageText } from '../../../config/manager/system/resources.js';
import { constants, createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';
import { configuredPath } from '../../../controllers/manager/system/files.js';
import { safeUploadFileName } from '../../../controllers/manager/system/uploads.js';
import { importRowResult, importXmlRecords, parseImportCsv, type ImportResult } from './data-import.js';

type ReferenceKind = 'def' | 'rep';
const referenceFields = (kind: ReferenceKind) => [
  'action',
  kind === 'def' ? 'defTopId' : 'repTopId',
  'sheetNo',
  'referenceId',
  'referenceType',
  'referenceName',
  'referenceValue',
  'displayNumber',
];

export function referenceImportRows(text: string, format: string, kind: ReferenceKind): string[][] {
  if (format === 'csv') return parseImportCsv(text);
  if (format !== 'xml') throw new Error(pageText['Invalid format.']);
  return importXmlRecords(text, kind === 'def' ? 'definitionReference' : 'reportReference').map((row) =>
    referenceFields(kind).map((field) => String(row[field] ?? '')),
  );
}

function integerError(value: string, field: string, allowIgnore = false): ImportResult | undefined {
  if (!value) return importRowResult(11010, field);
  if (value === '{ignore}') return allowIgnore ? undefined : importRowResult(11020, field);
  if (!/^[+-]?\d+$/.test(value.trim()) || Number(value) < 0 || Number(value) > 2147483647)
    return importRowResult(11030, field);
  return undefined;
}

export async function importReferences(
  db: pg.Pool,
  rows: string[][],
  kind: ReferenceKind,
  actor: string,
  host: string,
): Promise<ImportResult[]> {
  const fields = referenceFields(kind),
    now = new Date(),
    results: ImportResult[] = [];
  for (const row of rows) {
    if (row.length !== fields.length) {
      results.push(importRowResult(10010));
      continue;
    }
    const [action, id, sheet, reference, type, name, value, display] = row;
    if (!action) {
      results.push(importRowResult(11010, 'action'));
      continue;
    }
    if (action !== 'U') {
      results.push(importRowResult(11020, 'action'));
      continue;
    }
    let error: ImportResult | undefined;
    for (let i = 1; i <= 3; i++) {
      error = integerError(row[i], fields[i]);
      if (error) break;
    }
    if (!error && (Number(reference) < 1 || Number(reference) > 10)) error = importRowResult(11020, 'referenceId');
    if (!error && !type) error = importRowResult(11010, 'referenceType');
    if (error) {
      results.push(error);
      continue;
    }
    const client = await db.connect();
    try {
      if (
        !(
          await client.query("SELECT 1 FROM mst_common WHERE com_key='REFERENCE_TYPE' AND com_value=$1", [
            type === '{ignore}' ? null : type,
          ])
        ).rowCount
      ) {
        results.push(importRowResult(11020, 'referenceType'));
        continue;
      }
      if (name === '{ignore}' || value === '{ignore}') {
        results.push(importRowResult(11020, name === '{ignore}' ? 'referenceName' : 'referenceValue'));
        continue;
      }
      error = integerError(display, 'displayNumber', true);
      if (error) {
        results.push(error);
        continue;
      }
      // Legacy validation allows ignore here, then int.Parse throws before the row transaction.
      if (display === '{ignore}') throw new Error(pageText['Invalid reference display number.']);
      await client.query('BEGIN');
      try {
        await client.query(
          `UPDATE ${kind}_reference r SET reference_type=$1,reference_name=$2,reference_value=$3,diplay_number=$4,document_id=NULL,sys_update_term=$5,sys_update_user=$6,sys_update_time=$7 FROM ${kind}_sheet s WHERE r.${kind}_sheet_id=s.${kind}_sheet_id AND s.${kind}_top_id=$8 AND s.${kind}_sheet_no=$9 AND r.reference_id=$10`,
          [
            type,
            name,
            value,
            Number(display),
            'WEBAPI/' + host,
            actor,
            now,
            Number(id),
            Number(sheet),
            Number(reference),
          ],
        );
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

export async function importReferenceFiles(
  db: pg.Pool,
  files: { originalname: string; buffer?: Buffer; path?: string; size?: number }[],
): Promise<ImportResult[]> {
  const location = (
    await db.query(
      "SELECT com_value FROM mst_common WHERE com_key='VIRTUAL_DIRECTORY' AND com_name='REFERENCE_PHYSICAL'",
    )
  ).rows[0]?.com_value;
  if (!location) throw new Error(pageText['Reference directory is unavailable.']);
  for (const file of files) {
    if (file.buffer?.length === 0 || file.size === 0) continue;
    const name = safeUploadFileName(file.originalname);
    if (!name || (!file.buffer && !file.path)) throw new Error(pageText['Reference file is unavailable.']);
    const handle = await open(
      join(configuredPath(location), name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    );
    try {
      await handle.writeFile(file.buffer ?? createReadStream(file.path!));
    } finally {
      await handle.close();
    }
  }
  return [{ code: '0', remark: '' }];
}
