import { text as pageText } from '../../../config/manager/system/resources.js';
import type pg from 'pg';
import { importRowResult, importXmlRecords, parseImportCsv, type ImportResult } from './data-import.js';

type LabelKind = 'def' | 'rep';
const fields = [
  'action',
  'labelId',
  'upperLabelId',
  'labelName',
  'labelIconId',
  'labelRemarks',
  'displayNumber',
  'labelRoleGroup',
  'autoDelete',
];
type Label = {
  action: string;
  id: number | null;
  parent: number | null;
  name: string;
  idPath: string;
  namePath: string;
  upperPath: string;
  beforePath: string | null;
  icon: string;
  remarks: string;
  display: string;
  autoDelete: string;
  groups?: number[];
};
const path = (upper: string, value: string) => (!value ? '' : upper ? upper + '/' + value : value);

export function labelMasterImportRows(text: string, format: string, kind: LabelKind): string[][] {
  if (format === 'csv') return parseImportCsv(text);
  if (format !== 'xml') throw new Error(pageText['Invalid format.']);
  return importXmlRecords(text, kind === 'def' ? 'definitionLabelMaster' : 'reportLabelMaster').map((row) =>
    fields.map((field) => String(row[field] ?? '')),
  );
}

function check(
  value: string,
  field: string,
  required: boolean,
  ignore: boolean,
  numeric = false,
): ImportResult | undefined {
  if (required && !value) return importRowResult(11010, field);
  if (value === '{ignore}') return ignore ? undefined : importRowResult(11020, field);
  if (numeric && value && (!/^[+-]?\d+$/.test(value.trim()) || Number(value) < 0 || Number(value) > 2147483647))
    return importRowResult(11030, field);
  return undefined;
}

async function prepareLabel(client: pg.PoolClient, row: string[], kind: LabelKind): Promise<Label | ImportResult> {
  if (row.length < 7) return importRowResult(10010);
  const [action, id, parent, name, icon, remarks, display, groups, autoDelete] = row;
  if (!['A', 'U', 'D', 'M'].includes(action)) return importRowResult(action ? 11020 : 11010, 'action');
  if (action === 'A' && id) return importRowResult(11020, 'labelId');
  let error = action === 'A' ? undefined : check(id, 'labelId', true, false, true);
  if (error) return error;
  const old =
    action === 'A'
      ? undefined
      : (
          await client.query(
            `SELECT m.*,p.label_id_path AS upper_id_path,p.label_name_path AS upper_name_path FROM mst_label_${kind} m LEFT JOIN mst_label_${kind} p ON m.upper_label_id=p.mst_label_id WHERE m.mst_label_id=$1`,
            [Number(id)],
          )
        ).rows[0];
  const label: Label = {
    action: action === 'M' ? (old ? 'U' : 'A') : action,
    id: action === 'A' ? null : Number(id),
    parent: old?.upper_label_id ?? null,
    name: String(old?.label_name ?? ''),
    idPath: old ? String(old.label_id_path ?? '') : action === 'A' ? '' : String(Number(id)),
    namePath: String(old?.label_name_path ?? ''),
    upperPath: String(old?.upper_id_path ?? ''),
    beforePath: old ? String(old.label_id_path ?? '') : null,
    icon: String(old?.label_icon_id ?? ''),
    remarks: String(old?.label_remarks ?? ''),
    display: String(old?.diplay_number ?? ''),
    autoDelete: String(old?.auto_delete ?? ''),
  };
  if (autoDelete && autoDelete !== '{ignore}') {
    error = check(autoDelete, 'autoDelete', false, false, true);
    if (error) return error;
    if (autoDelete === '0' || autoDelete === '1') label.autoDelete = autoDelete;
  }
  if (label.action === 'D') return label;
  const allowIgnore = label.action !== 'A';
  error = check(parent, 'upperLabelId', false, allowIgnore, true);
  if (error) return error;
  let upperId = String(old?.upper_id_path ?? ''),
    upperName = String(old?.upper_name_path ?? '');
  if (parent !== '{ignore}') {
    label.parent = parent ? Number(parent) : null;
    const upper = parent
      ? (
          await client.query(`SELECT label_id_path,label_name_path FROM mst_label_${kind} WHERE mst_label_id=$1`, [
            Number(parent),
          ])
        ).rows[0]
      : undefined;
    upperId = String(upper?.label_id_path ?? '');
    upperName = String(upper?.label_name_path ?? '');
    if (parent && !upperId) return importRowResult(11020, 'upperLabelId');
    label.idPath = path(upperId, label.id === null ? '' : String(label.id));
    label.namePath = path(upperName, label.name);
  }
  label.upperPath = upperId;
  error = check(name, 'labelName', true, allowIgnore);
  if (error) return error;
  if (name !== '{ignore}') {
    if (kind === 'rep' && label.action === 'U' && old?.binder_rep_id != null && label.name !== name)
      return importRowResult(11000, 'labelName');
    label.name = name;
    label.namePath = path(upperName, name);
  }
  error = check(remarks, 'labelRemarks', false, allowIgnore);
  if (error) return error;
  if (remarks !== '{ignore}') label.remarks = remarks;
  error = check(icon, 'labelIconId', false, allowIgnore, true);
  if (error) return error;
  if (icon !== '{ignore}') label.icon = icon;
  if (!/^[+-]?\d+$/.test(label.icon.trim()) || Number(label.icon) <= 0 || Number(label.icon) >= 11)
    return importRowResult(11020, 'labelIconId');
  error = check(display, 'displayNumber', false, allowIgnore, true);
  if (error) return error;
  if (display !== '{ignore}') label.display = display;
  if (groups && groups !== '{ignore}') {
    if (groups.trim() === '-1') label.groups = [-1];
    else {
      label.groups = [];
      for (const group of groups.split(';')) {
        error = check(group, 'labelRoleGroup', false, allowIgnore, true);
        if (error) return error;
        // Empty/ignore group items pass CheckInt but fail the legacy int.Parse before writes.
        if (!group.trim() || group === '{ignore}') throw new Error(pageText['Invalid group ID.']);
        label.groups.push(Number(group));
      }
      const existing = new Set(
        (
          await client.query<{ group_id: number }>('SELECT group_id FROM mst_group WHERE group_id=ANY($1::int[])', [
            label.groups,
          ])
        ).rows.map((row) => row.group_id),
      );
      if (label.groups.some((group) => !existing.has(group))) return importRowResult(11020, 'labelRoleGroup');
    }
  }
  return label;
}

async function rebuildChildPaths(client: pg.PoolClient, kind: LabelKind, beforePath: string | null): Promise<void> {
  const children = (
    await client.query<{ mst_label_id: number }>(
      `SELECT mst_label_id FROM mst_label_${kind} WHERE label_id_path LIKE $1`,
      [(beforePath ?? '') + '/%'],
    )
  ).rows;
  for (const child of children) {
    const seen = new Set<number>();
    const ids: number[] = [],
      names: string[] = [];
    let current: number | null = child.mst_label_id;
    while (current !== null) {
      // Roll back cyclic parentage instead of recursing forever as the legacy helper does.
      if (seen.has(current)) throw new Error(pageText['Cyclic label hierarchy.']);
      seen.add(current);
      const item: { mst_label_id: number; label_name: string | null; upper_label_id: number | null } | undefined = (
        await client.query(
          `SELECT mst_label_id,label_name,upper_label_id FROM mst_label_${kind} WHERE mst_label_id=$1`,
          [current],
        )
      ).rows[0];
      if (!item) break;
      ids.unshift(item.mst_label_id);
      names.unshift(String(item.label_name ?? ''));
      current = item.upper_label_id;
    }
    await client.query(`UPDATE mst_label_${kind} SET label_id_path=$1,label_name_path=$2 WHERE mst_label_id=$3`, [
      ids.join('/'),
      names.join('/'),
      child.mst_label_id,
    ]);
  }
}

export async function importLabelMasters(
  db: pg.Pool,
  rows: string[][],
  kind: LabelKind,
  actor: string,
  host: string,
): Promise<ImportResult[]> {
  const now = new Date();
  if (
    kind === 'rep' &&
    (
      await db.query(
        "SELECT com_value FROM mst_common WHERE com_key='API_MODE' AND com_name='MST_GROUP_KEY_MODE' ORDER BY com_index LIMIT 1",
      )
    ).rows[0]?.com_value === '1'
  ) {
    rows = rows.map((row) => [...row]);
    for (const row of rows) {
      if (row.length <= 7) throw new Error(pageText['Missing label role field.']);
      if (!row[7]) continue;
      const groups = await db.query<{ group_id: number }>(
        'SELECT group_id FROM mst_group WHERE system_key=ANY($1::text[])',
        [row[7].split(';')],
      );
      row[7] = groups.rows.map((group) => group.group_id).join(';');
    }
  }
  const results: ImportResult[] = [];
  for (const row of rows) {
    const client = await db.connect();
    try {
      const label = await prepareLabel(client, row, kind);
      if ('code' in label) {
        results.push(label);
        continue;
      }
      await client.query('BEGIN');
      try {
        if (label.action === 'D') await client.query(`DELETE FROM mst_label_${kind} WHERE mst_label_id=$1`, [label.id]);
        else {
          if (label.action === 'A' && label.id === null) {
            // Both installed query files allocate from the definition-label sequence.
            label.id = Number(
              (await client.query("SELECT nextval('mst_label_def_mst_label_id_seq') AS id")).rows[0].id,
            );
            label.idPath = path(label.upperPath, String(label.id));
          }
          const values = [
            label.id,
            label.parent,
            label.name,
            label.idPath,
            label.namePath,
            label.icon,
            label.remarks,
            label.display,
            label.autoDelete || '0',
            'WEBAPI/' + host,
            actor,
            now,
          ];
          if (label.action === 'A')
            await client.query(
              `INSERT INTO mst_label_${kind} (mst_label_id,upper_label_id,label_name,label_id_path,label_name_path,label_icon_id,label_remarks,diplay_number,auto_delete,label_back_color,label_fore_color,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,NULL,$10,$11,$12,$10,$11,$12)`,
              values,
            );
          else {
            await client.query(
              `UPDATE mst_label_${kind} SET upper_label_id=$2,label_name=$3,label_id_path=$4,label_name_path=$5,label_icon_id=$6,label_remarks=$7,diplay_number=$8,auto_delete=$9,label_back_color=NULL,label_fore_color=NULL,sys_update_term=$10,sys_update_user=$11,sys_update_time=$12 WHERE mst_label_id=$1`,
              values,
            );
            if (label.idPath !== label.beforePath) await rebuildChildPaths(client, kind, label.beforePath);
          }
          if (label.groups?.length) {
            await client.query(`DELETE FROM ${kind}_label_role WHERE mst_label_id=$1`, [label.id]);
            if (label.groups[0] !== -1)
              for (const group of label.groups)
                await client.query(
                  `INSERT INTO ${kind}_label_role (mst_label_id,group_id,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time) VALUES ($1,$2,$3,$4,$5,$3,$4,$5)`,
                  [label.id, group, 'WEBAPI/' + host, actor, now],
                );
          }
        }
        if (kind === 'rep')
          await client.query(
            "SELECT setval('mst_label_rep_mst_label_id_seq',(SELECT MAX(mst_label_id) FROM mst_label_rep))",
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
