import type pg from 'pg';
import { importRowResult, importXmlRecords, parseImportCsv, type ImportResult } from './data-import.js';

type RoleKind = 'definition' | 'report';
const specs = {
  definition: {
    table: 'def_role',
    id: 'def_top_id',
    tag: 'defRole',
    fields: [
      'action',
      'defTopId',
      'groupId',
      'roleDefRead',
      'roleDefUpdate',
      'roleDefDelete',
      'roleRepRead',
      'roleRepUpdate',
      'roleRepCreate',
      'roleRepDelete',
    ],
    columns: [
      'role_def_read',
      'role_def_update',
      'role_def_delete',
      'role_rep_read',
      'role_rep_update',
      'role_rep_create',
      'role_rep_delete',
    ],
  },
  report: {
    table: 'rep_role',
    id: 'rep_top_id',
    tag: 'repRole',
    fields: ['action', 'repTopId', 'groupId', 'roleRepRead', 'roleRepUpdate', 'roleRepDelete'],
    columns: ['role_rep_read', 'role_rep_update', 'role_rep_delete'],
  },
};

export function roleImportRows(text: string, format: string, kind: RoleKind): string[][] {
  if (format === 'csv') return parseImportCsv(text);
  if (format !== 'xml') throw new Error('Invalid format.');
  const spec = specs[kind];
  return importXmlRecords(text, spec.tag).map((row) => spec.fields.map((field) => String(row[field] ?? '')));
}

function integerError(value: string, field: string, allowIgnore = false): ImportResult | undefined {
  if (!value) return importRowResult(11010, field);
  if (value === '{ignore}') return allowIgnore ? undefined : importRowResult(11020, field);
  if (!/^[+-]?\d+$/.test(value.trim()) || Number(value) < 0 || Number(value) > 2147483647)
    return importRowResult(11030, field);
  return undefined;
}

async function writeRole(
  client: pg.PoolClient,
  kind: RoleKind,
  action: string,
  id: number,
  group: number | 'ALL',
  flags: number[],
  actor: string,
  host: string,
  now: Date,
): Promise<void> {
  const { table, id: idColumn, columns } = specs[kind];
  if (action === 'D') {
    await client.query(
      `DELETE FROM ${table} WHERE ${idColumn}=$1 AND ${group === 'ALL' ? 'group_id<>-999' : 'group_id=$2'}`,
      group === 'ALL' ? [id] : [id, group],
    );
    return;
  }
  const values = [id, group, ...flags, 'WEBAPI/' + host, actor, now];
  const audit = columns.length + 3;
  if (action === 'U' || action === 'M') {
    const changed = await client.query(
      `UPDATE ${table} SET ${columns.map((column, i) => `${column}=$${i + 3}`).join(',')},sys_update_term=$${audit},sys_update_user=$${audit + 1},sys_update_time=$${audit + 2} WHERE ${idColumn}=$1 AND group_id=$2`,
      values,
    );
    if (action === 'U' || changed.rowCount) return;
  }
  await client.query(
    `INSERT INTO ${table} (${idColumn},group_id,${columns.join(',')},sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time) VALUES (${values.map((_, i) => '$' + (i + 1)).join(',')},$${audit},$${audit + 1},$${audit + 2})`,
    values,
  );
}

export async function importRoles(
  db: pg.Pool,
  text: string,
  format: string,
  kind: RoleKind,
  actor: string,
  host: string,
  options: Record<string, unknown> = {},
): Promise<ImportResult[]> {
  const targets = (key: string) =>
    typeof options[key] === 'string' && options[key] !== '' ? options[key].split(',') : ['U'];
  const defTargets = targets('defRoleModeTarget'),
    repTargets = targets('repRoleModeTarget');
  if (kind === 'definition') {
    for (const [key, values] of [
      ['defRoleModeTarget', defTargets],
      ['repRoleModeTarget', repTargets],
    ] as const) {
      if (values.some((value) => !['A', 'U', 'D', 'M'].includes(value)))
        return [
          { code: '2', remark: '' },
          { code: '', remark: `Invalid Parameter (${key})` },
        ];
    }
  }
  const spec = specs[kind];
  const now = new Date();
  const results: ImportResult[] = [];
  for (const fields of roleImportRows(text, format, kind)) {
    if (fields.length !== spec.fields.length) {
      results.push(importRowResult(10010));
      continue;
    }
    const [action, id, group] = fields;
    if (!['A', 'U', 'D', 'M'].includes(action)) {
      results.push(importRowResult(action ? 11020 : 11010, 'action'));
      continue;
    }
    let error = integerError(id, spec.fields[1]);
    if (!error && !(action === 'D' && group === 'ALL')) error = integerError(group, 'groupId');
    if (error) {
      results.push(error);
      continue;
    }
    const client = await db.connect();
    try {
      let dbAction = action;
      if (kind === 'report' && group !== 'ALL') {
        const exists = Boolean(
          (
            await client.query('SELECT 1 FROM rep_role WHERE rep_top_id=$1 AND group_id=$2', [
              Number(id),
              Number(group),
            ])
          ).rowCount,
        );
        if (action === 'M') dbAction = exists ? 'U' : 'A';
      }
      const flags: number[] = [];
      if (action !== 'D') {
        for (let i = 3; i < fields.length; i++) {
          error = integerError(fields[i], spec.fields[i], dbAction !== 'A');
          if (!error && fields[i] !== '{ignore}' && ![0, 1].includes(Number(fields[i])))
            error = importRowResult(11020, spec.fields[i]);
          if (error || fields[i] === '{ignore}') break;
          flags.push(Number(fields[i]));
        }
        // Legacy Valid() returns false with a success code at the first allowed ignore flag.
        if (error || flags.length !== spec.columns.length) {
          results.push(error ?? importRowResult(0));
          continue;
        }
      }
      await client.query('BEGIN');
      try {
        const ids: number[] =
          kind === 'definition' && options.defRoleMode === '1' && defTargets.includes(action)
            ? (
                await client.query<{ def_top_id: number }>(
                  'SELECT d.def_top_id FROM def_top d JOIN def_top b ON d.def_top_org=b.def_top_org WHERE b.def_top_id=$1 AND d.rev_no>=b.rev_no ORDER BY d.rev_no',
                  [Number(id)],
                )
              ).rows.map((row) => row.def_top_id)
            : [Number(id)];
        for (const target of ids) {
          await writeRole(
            client,
            kind,
            dbAction,
            target,
            group === 'ALL' ? group : Number(group),
            flags,
            actor,
            host,
            now,
          );
          if (kind === 'definition' && options.repRoleMode === '1' && repTargets.includes(action)) {
            const reports = await client.query<{ rep_top_id: number }>(
              'SELECT rep_top_id FROM rep_top WHERE def_top_id=$1 ORDER BY rep_top_id',
              [target],
            );
            for (const report of reports.rows)
              await writeRole(
                client,
                'report',
                action,
                report.rep_top_id,
                group === 'ALL' ? group : Number(group),
                [flags[3], flags[4], flags[6]],
                actor,
                host,
                now,
              );
          }
        }
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
