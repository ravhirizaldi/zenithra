import type pg from 'pg';
import { importRowResult, importXmlRecords, parseImportCsv, type ImportResult } from './data-import.js';
import { insertUserAccountLog } from '../../../shared/operation-log.js';

export function affiliationImportRows(text: string, format: string): string[][] {
  if (format === 'csv') return parseImportCsv(text);
  if (format !== 'xml') throw new Error('Invalid format.');
  return importXmlRecords(text, 'groupAffiliation').map((row) =>
    ['action', 'groupId', 'userId'].map((field) => String(row[field] ?? '')),
  );
}
export function validateAffiliationFields(fields: string[]): ImportResult | null {
  if (fields.length !== 3) return importRowResult(10010);
  const [action, group, user] = fields;
  if (!action) return importRowResult(11010, 'action');
  if (!['A', 'U', 'D', 'M'].includes(action)) return importRowResult(11020, 'action');
  const actionError = !['A', 'D'].includes(action) ? importRowResult(11020, 'action') : null;
  if (!group) return importRowResult(11010, 'groupId');
  if (group === '{ignore}') return importRowResult(11020, 'groupId');
  if (actionError) return actionError;
  if (!/^[+-]?\d+$/.test(group.trim()) || Number(group) < 0 || Number(group) > 2147483647)
    return importRowResult(11030, 'groupId');
  if (!user) return importRowResult(11010, 'userId');
  if (user === '{ignore}') return importRowResult(11020, 'userId');
  return null;
}
export async function importAffiliationRows(
  db: pg.Pool,
  uploaded: string[][],
  actor: string,
  host: string,
  appType: 'Manager' | 'Api' = 'Manager',
): Promise<ImportResult[]> {
  const mode = await db.query(
    'SELECT com_value FROM mst_common WHERE com_key=$1 AND com_name=$2 ORDER BY com_index LIMIT 1',
    ['API_MODE', 'MST_GROUP_KEY_MODE'],
  );
  const rows = uploaded.map((fields) => [...fields]);
  if (mode.rows[0]?.com_value === '1') {
    // Legacy resolves every system key before applying any rows in the file.
    for (const row of rows) {
      if (row.length < 2) throw new Error('Invalid group key row.');
      const group = await db.query('SELECT group_id FROM mst_group WHERE system_key=$1', [row[1]]);
      if (!group.rows.length) throw new Error('Group key not found.');
      row[1] = String(group.rows[0].group_id);
    }
  }
  const logging =
    (
      await db.query('SELECT com_value FROM mst_common WHERE com_key=$1 AND com_name=$2 ORDER BY com_index LIMIT 1', [
        'LOG_SETTING',
        'USER_ACCOUNT_OPERATION_LOG',
      ])
    ).rows[0]?.com_value === '1';
  const results: ImportResult[] = [];
  const now = new Date();
  for (const fields of rows) {
    const invalid = validateAffiliationFields(fields);
    if (invalid) {
      results.push(invalid);
      continue;
    }
    const [action, group, user] = fields;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const info = (await client.query('SELECT user_name FROM mst_user WHERE user_id=$1', [user])).rows[0];
      const before = (await client.query('SELECT group_id FROM mst_group_affiation WHERE user_id=$1', [user])).rows.map(
        (row) => String(row.group_id),
      );
      if (action === 'A')
        await client.query(
          'INSERT INTO mst_group_affiation (group_id,user_id,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time) VALUES ($1,$2,$3,$4,$5,$3,$4,$5)',
          [Number(group), user, 'WEBAPI/' + host, actor, now],
        );
      else
        await client.query('DELETE FROM mst_group_affiation WHERE group_id=$1 AND user_id=$2', [Number(group), user]);
      if (logging) {
        if (!info) throw new Error('User not found.');
        const after = (
          await client.query('SELECT group_id FROM mst_group_affiation WHERE user_id=$1', [user])
        ).rows.map((row) => String(row.group_id));
        const changed = before.some((id) => !after.includes(id)) || after.some((id) => !before.includes(id));
        if (changed)
          await insertUserAccountLog(
            client,
            user,
            info.user_name ?? '',
            actor,
            host,
            'Update',
            'UpdatetUserGroup',
            null,
            appType,
          );
      }
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
