import { text as pageText } from '../../../config/manager/system/resources.js';
import type pg from 'pg';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { createRequire } from 'node:module';
import { dataImportLabels } from '../../../config/manager/system/legacy-data-import-options.js';

export type ImportResult = { code: string; remark: string };
const commonFields = ['action', 'comId', 'comKey', 'comIndex', 'comName', 'comValue', 'comLocale'];
export function importRowResult(code: number, field = ''): ImportResult {
  const keys: Record<number, keyof typeof dataImportLabels> = {
    0: 'success',
    10010: 'recordErrorFormat',
    10020: 'recordErrorDb',
    10050: 'csvError',
    10060: 'dataNotFound',
    10070: 'exclusiveError',
    11000: 'fieldError',
    11010: 'fieldErrorNoValue',
    11020: 'fieldErrorInput',
    11030: 'fieldErrorNumeric',
  };
  const key = keys[code] ?? 'serverError';
  return { code: String(code), remark: dataImportLabels[key].replaceAll(':info', field) };
}
export function parseImportCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    field = '',
    quoted = false,
    closed = false;
  text = text.replace(/^\uFEFF/, '');
  for (let index = 0; index < text.length; index++) {
    const ch = text[index];
    if (quoted) {
      if (ch === '"' && text[index + 1] === '"') {
        field += '"';
        index++;
      } else if (ch === '"') {
        quoted = false;
        closed = true;
      } else field += ch;
    } else if (ch === '"' && field === '' && !closed) quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
      closed = false;
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[index + 1] === '\n') index++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      closed = false;
    } else {
      if (closed) throw new Error(pageText['Invalid CSV.']);
      field += ch;
    }
  }
  if (quoted) throw new Error(pageText['Invalid CSV.']);
  if (field || row.length || closed) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
export function decodeImport(buffer: Buffer, format: string, encoding: string): string {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer.subarray(2));
  const selected =
    format === 'xml'
      ? (buffer
          .subarray(0, 200)
          .toString('ascii')
          .match(/encoding\s*=\s*["']([^"']+)/i)?.[1] ?? 'utf-8')
      : encoding;
  if (['65001', 'utf-8', 'UTF-8'].includes(selected)) return buffer.toString('utf8').replace(/^\uFEFF/, '');
  const appRequire = createRequire(import.meta.url),
    expressRequire = createRequire(appRequire.resolve('express'));
  const iconv = createRequire(expressRequire.resolve('body-parser'))('iconv-lite') as {
    decode(data: Buffer, encoding: string): string;
  };
  return iconv.decode(buffer, selected === '932' ? 'shift_jis' : /^\d+$/.test(selected) ? 'cp' + selected : selected);
}
export function importXmlRecords(text: string, tag: string): Record<string, unknown>[] {
  if (/<!DOCTYPE/i.test(text) || XMLValidator.validate(text) !== true) throw new Error(pageText['Invalid XML.']);
  const parsed = new XMLParser({
    parseTagValue: false,
    trimValues: false,
    ignoreAttributes: true,
    processEntities: true,
  }).parse(text);
  const root = Object.entries(parsed).find(
    ([key, value]) => !key.startsWith('?') && value && typeof value === 'object',
  )?.[1] as Record<string, unknown> | undefined;
  const value = root?.[tag];
  const rows: unknown[] = value === undefined ? [] : Array.isArray(value) ? value : [value];
  return rows.map((row) => (row && typeof row === 'object' ? (row as Record<string, unknown>) : {}));
}
export function commonImportRows(text: string, format: string): string[][] {
  if (format === 'csv') return parseImportCsv(text);
  if (format !== 'xml') throw new Error(pageText['Invalid format.']);
  return importXmlRecords(text, 'common').map((record) => commonFields.map((field) => String(record?.[field] ?? '')));
}
export function meIdImportRows(text: string, format: string): string[][] {
  if (format === 'csv') return parseImportCsv(text);
  if (format !== 'xml') throw new Error(pageText['Invalid format.']);
  return importXmlRecords(text, 'user').map((record) =>
    ['userId', 'meidUpn', 'meidOid']
      .filter((field) => Object.hasOwn(record, field))
      .map((field) => String(record[field] ?? '')),
  );
}
export async function importMeIdRows(
  db: pg.Pool,
  rows: string[][],
  actor: string,
  host: string,
): Promise<ImportResult[]> {
  const results: ImportResult[] = [];
  const now = new Date();
  for (const fields of rows) {
    if (fields.length !== 3) {
      results.push(importRowResult(10010));
      continue;
    }
    if (!fields[0]) {
      results.push(importRowResult(11010, 'userId'));
      continue;
    }
    if (fields[0] === '{ignore}') {
      results.push(importRowResult(11020, 'userId'));
      continue;
    }
    const [userId, upn, oid] = fields.map((field) => field.trim());
    const values: unknown[] = ['WEBAPI/' + host, actor, now, userId, 'conmasadmin'];
    const set = ['sys_update_term=$1', 'sys_update_user=$2', 'sys_update_time=$3'];
    if (upn !== '{ignore}') {
      values.push(upn || null);
      set.push('meid_upn=$' + values.length);
    }
    if (oid !== '{ignore}') {
      values.push(oid || null);
      set.push('meid_oid=$' + values.length);
    }
    try {
      const updated = await db.query(
        'UPDATE mst_user SET ' + set.join(',') + ' WHERE user_id=$4 AND user_id<>$5',
        values,
      );
      results.push(updated.rowCount ? importRowResult(0) : importRowResult(10060, 'userId=' + userId));
    } catch {
      results.push(importRowResult(10020));
    }
  }
  return results;
}
export async function importCommonRows(
  db: pg.Pool,
  rows: string[][],
  actor: string,
  host: string,
): Promise<ImportResult[]> {
  const results: ImportResult[] = [];
  const int = (value: string) => /^[+-]?\d+$/.test(value.trim()) && Number(value) >= 0 && Number(value) <= 2147483647;
  for (const fields of rows) {
    if (fields.length !== 7) {
      results.push(importRowResult(10010));
      continue;
    }
    const [action, id, key, index, name, value, locale] = fields;
    if (!['A', 'U', 'D', 'M'].includes(action)) {
      results.push(importRowResult(action ? 11020 : 11010, 'action'));
      continue;
    }
    if (action === 'A' ? id !== '' : !int(id) || id === '') {
      results.push(importRowResult(action === 'A' || id === '{ignore}' ? 11020 : id ? 11030 : 11010, 'comId'));
      continue;
    }
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      // Serialize sequence alignment with concurrent inserts into this table.
      await client.query('LOCK TABLE mst_common IN SHARE ROW EXCLUSIVE MODE');
      const exists =
        action === 'A'
          ? false
          : Boolean((await client.query('SELECT com_id FROM mst_common WHERE com_id=$1', [Number(id)])).rowCount);
      const insert = action === 'A' || (action === 'M' && !exists);
      if (action !== 'D') {
        let error: ImportResult | undefined;
        for (let i = 2; i < 7; i++) {
          if (!fields[i]) {
            error = importRowResult(11010, commonFields[i]);
            break;
          }
          if (fields[i] === '{ignore}' && insert) {
            error = importRowResult(11020, commonFields[i]);
            break;
          }
          if (i === 3 && fields[i] !== '{ignore}' && !int(fields[i])) {
            error = importRowResult(11030, 'comIndex');
            break;
          }
        }
        if (!error) {
          try {
            if (locale === '{ignore}') throw new Error();
            new Intl.Locale(locale);
          } catch {
            error = importRowResult(11010, 'comLocale');
          }
        }
        if (error) {
          await client.query('ROLLBACK');
          results.push(error);
          continue;
        }
      }
      const columns = [
        key === '{ignore}' ? null : key,
        index === '{ignore}' ? 0 : Number(index),
        name === '{ignore}' ? null : name,
        value === '{ignore}' ? null : value,
        locale,
        'WEBAPI/' + host,
        actor,
      ];
      if (action === 'D') await client.query('DELETE FROM mst_common WHERE com_id=$1', [Number(id)]);
      else if (insert)
        await client.query(
          "INSERT INTO mst_common (com_id,com_key,com_index,com_name,com_value,com_locale,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time) VALUES (COALESCE($8::integer,nextval('mst_common_com_id_seq')),$1,$2,$3,$4,$5,$6,$7,CURRENT_TIMESTAMP,$6,$7,CURRENT_TIMESTAMP)",
          [...columns, action === 'A' ? null : Number(id)],
        );
      else
        await client.query(
          'UPDATE mst_common SET com_key=$1,com_index=$2,com_name=$3,com_value=$4,com_locale=$5,sys_update_term=$6,sys_update_user=$7,sys_update_time=CURRENT_TIMESTAMP WHERE com_id=$8',
          [...columns, Number(id)],
        );
      await client.query("SELECT setval('mst_common_com_id_seq',(SELECT MAX(com_id) FROM mst_common))");
      await client.query('COMMIT');
      results.push(importRowResult(0));
    } catch {
      await client.query('ROLLBACK');
      results.push(importRowResult(10020));
    } finally {
      client.release();
    }
  }
  return results;
}
