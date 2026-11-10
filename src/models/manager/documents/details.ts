import { text as pageText } from '../../../config/manager/documents/resources.js';
import type pg from 'pg';
import { hostname } from 'node:os';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { clientSettingsDirectory } from '../../../shared/license-counts.js';
import {
  flattenLabels,
  labelInteger,
  labelRows,
  labelSettings,
  labelString,
  labelTree,
  LabelValidationError,
} from '../labels/index.js';

type Database = Pick<pg.Pool, 'query'>;
export type DocumentRole = { read: boolean; update: boolean; delete: boolean };
export type DocumentRoleRow = DocumentRole & { group_id: number; group_name_path: string; assigned: boolean };

export function documentDetailId(value: unknown) {
  const id = labelInteger(value);
  if (id <= 0) throw new LabelValidationError('', pageText['Select a valid report.']);
  return id;
}

export async function documentDetail(db: Database, id: number, user: string, edit = false) {
  return (
    await db.query<{
      rep_top_id: number;
      rep_top_name: string;
      def_top_id: number;
      journalizing_def_top_id: number | null;
      workflow_locked: boolean;
      locked: boolean;
      lock_user_name: string;
      sys_update_user_name: string;
      current: boolean;
      role_update: boolean;
      role_delete: boolean;
      deleted: number;
      edit_refer_status: number;
      def_role_update: boolean;
      initial_input_judge: boolean;
    }>(
      `SELECT t.rep_top_id,COALESCE(t.rep_top_name,'') AS rep_top_name,COALESCE(t.def_top_id,-1) AS def_top_id,
    t.journalizing_def_top_id,COALESCE(t.workflow_lock,0)=1 AS workflow_locked,
    COALESCE(l.user_id,'0')<>'0' AS locked,COALESCE(u.user_name,'') AS lock_user_name,
    COALESCE(NULLIF(t.sys_update_user_name,''),NULLIF(up.user_name,''),t.sys_update_user,'') AS sys_update_user_name,
    EXISTS (SELECT 1 FROM rep_current c WHERE c.rep_top_id=t.rep_top_id) AS current,
    COALESCE(r.role_update,0)=1 AS role_update,COALESCE(r.role_delete,0)=1 AS role_delete,
    t.deleted,t.edit_refer_status,COALESCE(d.role_update,0)=1 AS def_role_update,
    COALESCE(t.use_init_input_judge,0)=1 AS initial_input_judge
    FROM rep_top t LEFT JOIN rep_lock l USING(rep_top_id) LEFT JOIN mst_user u ON u.user_id=l.user_id
    LEFT JOIN mst_user up ON up.user_id=t.sys_update_user
    LEFT JOIN LATERAL (SELECT MAX(role_rep_read) AS role_read,MAX(role_rep_update) AS role_update,
      MAX(role_rep_delete) AS role_delete
      FROM rep_role WHERE rep_top_id=t.rep_top_id AND group_id IN
      (SELECT group_id FROM mst_group_affiation WHERE user_id=$2)) r ON true
    LEFT JOIN LATERAL (SELECT MAX(role_def_update) AS role_update FROM def_role
      WHERE def_top_id=t.def_top_id AND group_id IN
      (SELECT group_id FROM mst_group_affiation WHERE user_id=$2)) d ON true
    WHERE t.rep_top_id=$1 AND ${edit ? 'r.role_update=1' : '(r.role_read=1 OR r.role_update=1)'}`,
      [id, user],
    )
  ).rows[0];
}

export async function documentDetailSheets(db: Database, id: number) {
  const rows = (
    await db.query<{ rep_sheet_no: number; rep_sheet_name: string }>(
      "SELECT rep_sheet_no,COALESCE(rep_sheet_name,'') AS rep_sheet_name FROM rep_sheet WHERE rep_top_id=$1 ORDER BY rep_sheet_no",
      [id],
    )
  ).rows;
  const sheets = rows.map((row, rownum) => ({ ...row, rownum, fdSheetNo: 0 }));
  const freeDraw = (
    await db.query<{ sheet_index: number; fd_sheet_no: number }>(
      'SELECT sheet_index,fd_sheet_no FROM rep_fd_sheet WHERE top_id=$1 ORDER BY sheet_index',
      [id],
    )
  ).rows;
  for (const row of freeDraw)
    if (row.sheet_index >= 1)
      sheets.splice(Math.min(row.sheet_index - 1, sheets.length), 0, {
        rep_sheet_no: 0,
        rep_sheet_name: '',
        rownum: -1,
        fdSheetNo: row.fd_sheet_no,
      });
  return sheets;
}

export async function documentDetailExternalTypes(db: Database, definitionId: number) {
  const row = (
    await db.query('SELECT enabled_system_types FROM def_external_output WHERE def_top_id=$1', [definitionId])
  ).rows[0];
  return Number(row?.enabled_system_types ?? 0);
}

export async function documentDetailLabels(db: Database, id: number, user: string) {
  const settings = await labelSettings(db as pg.Pool);
  const labels = await labelRows(db, 'Rep', user);
  const attached = new Set(
    (await db.query<{ mst_label_id: number }>('SELECT mst_label_id FROM rep_label WHERE rep_top_id=$1', [id])).rows.map(
      (row) => row.mst_label_id,
    ),
  );
  return flattenLabels(labelTree(labels, settings.nameSort)).filter((row) => attached.has(row.mst_label_id));
}

export async function documentLabelSearch(db: Database, id: number, user: string, input: Record<string, unknown>) {
  const name = labelString(input['LabelSerach.LabelName']);
  const checkedType = labelString(input['LabelSerach.LabelCheckedType']) || '0';
  if (!['0', '1', '2'].includes(checkedType)) throw new LabelValidationError('', pageText['Invalid label filter.']);
  if ((labelString(input['LabelSerach.LabelSearchType']) || '0') !== '0')
    throw new LabelValidationError('', pageText['This label search mode is not available for Documents.']);
  const settings = await labelSettings(db as pg.Pool);
  const attached = new Set(
    (await db.query<{ mst_label_id: number }>('SELECT mst_label_id FROM rep_label WHERE rep_top_id=$1', [id])).rows.map(
      (row) => row.mst_label_id,
    ),
  );
  let labels = (await labelRows(db, 'Rep', user, '', true, true)).filter(
    (row) => row.auto_creation !== 1 || !row.auto_label_name,
  );
  if (name.trim()) {
    const matches = new Set(
      (
        await db.query<{ mst_label_id: number }>('SELECT mst_label_id FROM mst_label_rep WHERE label_name LIKE $1', [
          '%' + name + '%',
        ])
      ).rows.map((row) => row.mst_label_id),
    );
    labels = labels.filter((row) => matches.has(row.mst_label_id));
  }
  labels = labels.filter((row) => checkedType === '0' || attached.has(row.mst_label_id) === (checkedType === '1'));
  return {
    labels: flattenLabels(labelTree(labels, settings.nameSort)).map((row) => ({
      ...row,
      checked: attached.has(row.mst_label_id),
    })),
    settings,
    name,
    checkedType,
  };
}

export async function documentDetailRoles(
  db: Database,
  id: number,
  groupId: number | null = null,
  groupName = '',
): Promise<DocumentRoleRow[]> {
  return (
    await db.query<DocumentRoleRow>(
      `SELECT g.group_id,COALESCE(g.group_name_path,'') AS group_name_path,
    COALESCE(r.role_rep_read,0)=1 AS read,COALESCE(r.role_rep_update,0)=1 AS update,
    COALESCE(r.role_rep_delete,0)=1 AS delete,r.group_id IS NOT NULL AS assigned
    FROM mst_group g LEFT JOIN rep_role r ON r.group_id=g.group_id AND r.rep_top_id=$1
    WHERE g.group_id>-999 AND ($2::int IS NULL OR g.group_id=$2) AND
    ($3='' OR g.group_name_path ILIKE $3) ORDER BY g.group_name_path,g.group_id`,
      [id, groupId, groupName.trim() ? '%' + groupName.replace(/[\\%_]/g, '\\$&') + '%' : ''],
    )
  ).rows;
}

async function requireEdit(client: Database, id: number, user: string) {
  const row = (
    await client.query(
      `SELECT t.rep_top_id FROM rep_top t WHERE t.rep_top_id=$1
    AND (SELECT MAX(role_rep_update) FROM rep_role WHERE rep_top_id=t.rep_top_id AND group_id IN
      (SELECT group_id FROM mst_group_affiation WHERE user_id=$2))=1 FOR UPDATE OF t`,
      [id, user],
    )
  ).rows[0];
  if (!row) throw new LabelValidationError('access', pageText['Role authority is insufficient.']);
}

export async function documentSaveLabelChanges(
  db: pg.Pool,
  id: number,
  changes: Record<string, boolean>,
  user: string,
) {
  const ids = Object.keys(changes).map(documentDetailId);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await requireEdit(client, id, user);
    const allowed = new Set(
      (await labelRows(client, 'Rep', user, '', true, true))
        .filter((row) => row.auto_creation !== 1 || !row.auto_label_name)
        .map((row) => row.mst_label_id),
    );
    if (ids.some((label) => !allowed.has(label)))
      throw new LabelValidationError('', pageText['A selected label is unavailable or belongs to a binder.']);
    // The whole draft commits together; a late failure must not leave a partly applied label selection.
    for (const label of ids) {
      await client.query('DELETE FROM rep_label WHERE rep_top_id=$1 AND mst_label_id=$2', [id, label]);
      if (changes[label])
        await client.query(
          `INSERT INTO rep_label
        (rep_top_id,mst_label_id,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time)
        VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP,$3,$4,CURRENT_TIMESTAMP)`,
          [id, label, hostname(), user],
        );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function documentSaveRoleChanges(
  db: pg.Pool,
  id: number,
  changes: Record<string, DocumentRole>,
  user: string,
) {
  const adminId = await documentAdministratorId();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await requireEdit(client, id, user);
    const roles = await documentDetailRoles(client, id);
    if (Object.keys(changes).some((group) => !roles.some((row) => String(row.group_id) === group)))
      throw new LabelValidationError('', pageText['A selected group is unavailable.']);
    await client.query('DELETE FROM rep_role WHERE rep_top_id=$1', [id]);
    for (const row of roles) {
      const role = changes[row.group_id] ?? row;
      if (role.read || role.update || role.delete)
        await client.query(
          `INSERT INTO rep_role
        (rep_top_id,group_id,role_rep_read,role_rep_update,role_rep_delete,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time)
        VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_TIMESTAMP,$6,$7,CURRENT_TIMESTAMP)`,
          [id, row.group_id, Number(role.read), Number(role.update), Number(role.delete), hostname(), user],
        );
    }
    await client.query(
      `INSERT INTO rep_role
      (rep_top_id,group_id,role_rep_read,role_rep_update,role_rep_delete,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time)
      VALUES ($1,-999,1,1,1,$2,$3,CURRENT_TIMESTAMP,$2,$3,CURRENT_TIMESTAMP)`,
      [id, hostname(), adminId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function documentAdministratorId() {
  const settings = clientSettingsDirectory();
  if (!settings) throw new Error(pageText['Client settings directory is unavailable.']);
  const admin: unknown = new XMLParser({ parseTagValue: false, trimValues: false }).parse(
    await readFile(join(settings, 'Admin.xml'), 'utf8'),
  );
  const adminId = (admin as { ConMas?: { userId?: unknown } })?.ConMas?.userId;
  if (typeof adminId !== 'string' || !adminId)
    throw new Error(pageText['Administrator audit identity is unavailable.']);
  return adminId;
}

export async function documentDetailUnlock(db: pg.Pool, user: string) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM rep_lock WHERE user_id=$1 AND sys_regist_user=$1 AND sys_regist_term=$2', [
      user,
      hostname(),
    ]);
    await client.query('COMMIT');
  } catch {
    // Common.UnAutoLock ignores a failed cleanup; document-lock cleanup remains independent.
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  await db.query('DELETE FROM document_lock WHERE user_id=$1 AND sys_regist_user=$1 AND sys_regist_term=$2', [
    user,
    hostname(),
  ]);
}
