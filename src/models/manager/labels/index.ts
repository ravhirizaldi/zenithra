import { text as pageText } from '../../../config/manager/labels/resources.js';
import type pg from 'pg';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

export const labelModes = {
  Def: {
    table: 'mst_label_def',
    role: 'def_label_role',
    sequence: 'mst_label_def_mst_label_id_seq',
    title: pageText['For Form'],
  },
  Rep: {
    table: 'mst_label_rep',
    role: 'rep_label_role',
    sequence: 'mst_label_def_mst_label_id_seq',
    title: pageText['For Document'],
  },
  ComLIb: {
    table: 'mst_label_common_document',
    role: 'common_document_label_role',
    sequence: 'mst_label_common_document_mst_label_id_seq',
    title: pageText['Common document'],
  },
  RepLIb: {
    table: 'mst_label_report_document',
    role: 'report_document_label_role',
    sequence: 'mst_label_report_document_mst_label_id_seq',
    title: pageText['Documents by form'],
  },
  ComMas: {
    table: 'mst_label_common_custom_table',
    role: 'common_custom_table_label_role',
    sequence: 'mst_label_common_custom_table_mst_label_id_seq',
    title: pageText['Custom master'],
  },
  RepMas: {
    table: 'mst_label_report_custom_table',
    role: 'report_custom_table_label_role',
    sequence: 'mst_label_report_custom_table_mst_label_id_seq',
    title: pageText['Master by document'],
  },
  ImageLib: {
    table: 'mst_label_image_document',
    role: 'image_document_label_role',
    sequence: 'mst_label_def_mst_label_id_seq',
    title: pageText['Image file for FreeDraw'],
  },
} as const;
export type LabelMode = keyof typeof labelModes;
export type LabelRecord = {
  mst_label_id: number;
  upper_label_id: number | null;
  label_name: string;
  label_id_path: string;
  label_name_path: string;
  label_icon_id: number;
  label_remarks: string;
  diplay_number: number;
  auto_delete: number;
  auto_creation?: number;
  auto_label_name?: string;
  bottom_layer?: number;
  auto_slash_hierarchy?: number;
  report_update_type?: number;
  system_key?: string;
  binder_rep_id?: number | null;
};
export type LabelPermissions = { read: boolean; create: boolean; edit: boolean; delete: boolean; refer: boolean };
export function labelRecord(row: LabelRecord): LabelRecord {
  return {
    ...row,
    label_name: row.label_name ?? '',
    label_remarks: row.label_remarks ?? '',
    label_icon_id: row.label_icon_id ?? 0,
    auto_delete: Number(row.auto_delete ?? 0),
    auto_creation: Number(row.auto_creation ?? 0),
    bottom_layer: Number(row.bottom_layer ?? 0),
    auto_slash_hierarchy: Number(row.auto_slash_hierarchy ?? 0),
    report_update_type: Number(row.report_update_type ?? 0),
  };
}
export class LabelValidationError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
  }
}
export const labelString = (value: unknown): string =>
  typeof value === 'string' ? value : Array.isArray(value) ? labelString(value[0]) : '';
export const labelChecked = (value: unknown): boolean => labelString(value).toLowerCase() === 'true';
export function labelInteger(value: unknown, fallback?: number): number {
  const text = labelString(value).trim();
  if (!text && fallback !== undefined) return fallback;
  if (!/^[+-]?\d+$/.test(text) || Number(text) < -2147483648 || Number(text) > 2147483647)
    throw new LabelValidationError('', pageText['Please enter an integer value.']);
  return Number(text);
}
export function labelMode(value: unknown): LabelMode {
  const text = labelString(value) || 'Def';
  const numeric: Record<string, LabelMode> = {
    '0': 'Rep',
    '1': 'Def',
    '2': 'Rep',
    '3': 'ComLIb',
    '4': 'RepLIb',
    '5': 'ComMas',
    '6': 'RepMas',
    '8': 'ImageLib',
    DefRep: 'Rep',
  };
  if (Object.hasOwn(numeric, text)) return numeric[text];
  if (Object.hasOwn(labelModes, text)) return text as LabelMode;
  throw new LabelValidationError('mode', pageText['Invalid label mode.']);
}

export async function labelPermissions(db: pg.Pool, user: string): Promise<LabelPermissions> {
  const bits =
    (
      await db.query(
        `SELECT MAX(role_label_read_manager) AS "read", MAX(role_label_create_manager) AS "create",
    MAX(role_label_update_manager) AS "edit", MAX(role_label_delete_manager) AS "delete" FROM mst_group
    WHERE group_id IN (SELECT group_id FROM mst_group_affiation WHERE user_id=$1)`,
        [user],
      )
    ).rows[0] ?? {};
  const permissions = { read: false, create: false, edit: false, delete: false, refer: false };
  for (const action of ['read', 'create', 'edit', 'delete'] as const)
    permissions[action] = String(bits[action]) === '1';
  permissions.refer = permissions.read || permissions.create || permissions.edit || permissions.delete;
  return permissions;
}

export async function labelSettings(db: pg.Pool) {
  const rows = (
    await db.query(`SELECT com_key,com_name,com_value FROM mst_common WHERE com_key IN
    ('LABEL_SETTING','CONMAS_FUNCTION','API_MODE','DEFAULT_PAGE_SIZE','PAGE_SIZE') ORDER BY com_index`)
  ).rows;
  const value = (key: string, name: string) =>
    String(rows.find((row) => row.com_key === key && row.com_name === name)?.com_value ?? '');
  const positive = (text: string, fallback: number) =>
    /^\d+$/.test(text) && Number(text) > 0 && Number(text) <= 2147483647 ? Number(text) : fallback;
  return {
    nameSort: value('LABEL_SETTING', 'SORT_TYPE') === '1',
    keyMode: value('API_MODE', 'MST_LABEL_REP_KEY_MODE') === '1',
    grid: value('CONMAS_FUNCTION', 'LABEL_MANAGER_LIST_DISPLAY') === '1',
    treePageSize: positive(value('LABEL_SETTING', 'PAGE_SIZE'), 500),
    pageSize: positive(String(rows.find((row) => row.com_key === 'DEFAULT_PAGE_SIZE')?.com_value ?? ''), 20),
    pageSizes: rows.filter((row) => row.com_key === 'PAGE_SIZE').map((row) => positive(String(row.com_value), 20)),
  };
}

export async function labelRows(
  db: Pick<pg.Pool, 'query'>,
  mode: LabelMode,
  user: string,
  search = '',
  automatic = false,
  excludeBinder = false,
): Promise<LabelRecord[]> {
  const spec = labelModes[mode];
  const allowed = `(NOT EXISTS (SELECT 1 FROM ${spec.role} rl WHERE rl.mst_label_id=a.mst_label_id)
    OR EXISTS (SELECT 1 FROM ${spec.role} rl WHERE rl.mst_label_id=a.mst_label_id AND rl.group_id IN
      (SELECT group_id FROM mst_group_affiation WHERE user_id=$1)) OR $1='conmasadmin')`;
  const nonAuto = mode === 'Rep' && !automatic ? ' AND COALESCE(a.auto_creation,0)<>1' : '';
  const binder = mode === 'Rep' && excludeBinder ? ' AND a.binder_rep_id IS NULL' : '';
  return (
    await db.query<LabelRecord>(
      `WITH RECURSIVE tree AS (
    SELECT a.*,ARRAY[a.mst_label_id] AS visited FROM ${spec.table} a WHERE a.upper_label_id IS NULL AND ${allowed}${nonAuto}${binder}
    UNION ALL SELECT a.*,tree.visited||a.mst_label_id FROM ${spec.table} a JOIN tree ON a.upper_label_id=tree.mst_label_id
      WHERE NOT a.mst_label_id=ANY(tree.visited) AND ${allowed}${nonAuto}${binder})
    SELECT * FROM tree WHERE ($2='' OR label_name_path ILIKE '%'||$2||'%') ORDER BY label_id_path`,
      [user, search],
    )
  ).rows.map(labelRecord);
}

export type LabelNode = LabelRecord & { children: LabelNode[] };
export function labelTree(rows: LabelRecord[], nameSort: boolean): LabelNode[] {
  const nodes = new Map(rows.map((row) => [row.mst_label_id, { ...row, children: [] } as LabelNode]));
  const roots: LabelNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.upper_label_id === null ? undefined : nodes.get(node.upper_label_id);
    (parent?.children ?? roots).push(node);
  }
  const sort = (items: LabelNode[]) => {
    items.sort((a, b) =>
      nameSort
        ? a.label_name.localeCompare(b.label_name, 'en-US') ||
          String(a.mst_label_id).localeCompare(String(b.mst_label_id))
        : a.diplay_number - b.diplay_number,
    );
    for (const item of items) sort(item.children);
  };
  sort(roots);
  return roots;
}
export function flattenLabels(nodes: LabelNode[]): LabelNode[] {
  return nodes.flatMap((node) => [node, ...flattenLabels(node.children)]);
}

export async function labelGroups(db: pg.Pool, mode: LabelMode, id: number) {
  return (
    await db.query<{ group_id: number; group_name: string; group_name_path: string; refer: boolean }>(
      `SELECT g.group_id,g.group_name,g.group_name_path,
    NOT EXISTS (SELECT 1 FROM ${labelModes[mode].role} WHERE mst_label_id=$1) OR EXISTS
      (SELECT 1 FROM ${labelModes[mode].role} WHERE mst_label_id=$1 AND group_id=g.group_id) AS refer
    FROM mst_group g WHERE g.group_id<>-999 ORDER BY g.group_name_path,g.group_id`,
      [id],
    )
  ).rows;
}

export function labelInput(body: Record<string, unknown>, mode: LabelMode): LabelRecord {
  const get = (name: string) => body['mst_label.' + name];
  return {
    mst_label_id: labelInteger(get('mst_label_id'), 0),
    upper_label_id: labelInteger(get('upper_label_id'), -1) === -1 ? null : labelInteger(get('upper_label_id')),
    label_name: labelString(get('label_name')),
    label_remarks: labelString(get('label_remarks')),
    label_icon_id: labelInteger(get('label_icon_id'), 0),
    diplay_number: labelInteger(get('diplay_number'), 0),
    label_id_path: '',
    label_name_path: '',
    auto_delete: labelChecked(get('IsAutoDelete')) ? 1 : 0,
    auto_creation: mode === 'Rep' && labelChecked(get('IsAutoCreation')) ? 1 : 0,
    auto_label_name: labelString(get('auto_label_name')),
    bottom_layer: labelChecked(get('IsBottomLayer')) ? 1 : 0,
    auto_slash_hierarchy: labelChecked(get('IsSlashHierarchy')) ? 1 : 0,
    report_update_type: labelChecked(get('IsReportUpdateType')) ? 1 : 0,
    system_key: labelString(get('systemKey')),
  };
}

export const autoLabelItems = [
  ['Document information', 'Name of form', '{report:defTopName}'],
  ['Document information', 'Name of Document', '{report:repTopName}'],
  ...Array.from({ length: 10 }, (_, index) => [
    'Document information',
    `Document remarks ${index + 1}`,
    `{report:remarksValue${index + 1}}`,
  ]),
  ['Document information', 'clusterDisplayValue_S_C', '{report:clusterDisplayValue}'],
  ['Document information', 'clusterValue_S_C', '{report:clusterValue}'],
  ...['yyyy', 'MM', 'dd', 'HH', 'mm', 'ss'].map((token, index) => [
    'Date',
    ['Year of issue', 'Month of issue', 'Date of issue', 'Time of issue (h)', 'Time of issue (m)', 'Time of issue (s)'][
      index
    ],
    `{regist:${token}}`,
  ]),
  ['User information', 'Issuer ID', '{regist:User}'],
  ['User information', 'Name of Issuer', '{regist:UserName}'],
];
export function autoLabelLocale(value: string, reverse = false): string {
  for (const [, label, token] of autoLabelItems)
    if (!token.includes('cluster'))
      value = value.split(reverse ? token : `{${label}}`).join(reverse ? `{${label}}` : token);
  return value;
}
export function validateLabel(record: LabelRecord, mode: LabelMode): void {
  if (!record.label_name.trim())
    throw new LabelValidationError('mst_label.label_name', pageText['Please enter Label name.']);
  if (record.diplay_number < 0)
    throw new LabelValidationError('mst_label.diplay_number', pageText['Display sequence is invalid.']);
  if (mode === 'Rep') {
    for (const match of (record.auto_label_name ?? '').matchAll(/\{cluster(?:DisplayValue|Value)[^{}]*\}/g)) {
      const parts = match[0].slice(1, -1).split('_');
      if (parts.length !== 3)
        throw new LabelValidationError('mst_label.auto_label_name', pageText['Naming rule of label name is invalid.']);
      for (const value of parts.slice(1)) labelInteger(value);
    }
    if (record.auto_creation) {
      const rule = (record.auto_label_name ?? '').trim();
      const error = !rule
        ? 'No value for Naming rule of label name.'
        : rule.includes(';')
          ? 'Not available to use ","'
          : rule.startsWith('/')
            ? 'Not available to use "/" for initial letter of value.'
            : rule.endsWith('/')
              ? 'Not available to use "/" for end letter of value.'
              : '';
      if (error) throw new LabelValidationError('mst_label.auto_label_name', error);
    }
  }
}

async function bumpMasterLabels(client: pg.PoolClient, mode: LabelMode, actor: string): Promise<void> {
  if (mode !== 'ComMas' && mode !== 'RepMas') return;
  for (const id of ['CustomMaster', 'CustomMasterlabel']) {
    await client.query('SAVEPOINT label_version');
    try {
      await client.query(
        `UPDATE common_data_version SET data_version=to_char(CURRENT_TIMESTAMP,'YYYYMMDDHH24MISS')||'_'||$1,
        sys_update_term=$2,sys_update_user=$3,sys_update_time=CURRENT_TIMESTAMP WHERE data_id=$4`,
        [randomUUID(), hostname(), actor, id],
      );
    } catch {
      await client.query('ROLLBACK TO SAVEPOINT label_version');
    }
    await client.query('RELEASE SAVEPOINT label_version');
  }
}

export async function saveLabel(
  db: pg.Pool,
  mode: LabelMode,
  record: LabelRecord,
  actor: string,
  options: {
    edit?: boolean;
    quick?: '0' | '1';
    base?: number;
    copy?: boolean;
    noRoles?: boolean;
    roles?: Record<string, boolean>;
  } = {},
): Promise<number> {
  validateLabel(record, mode);
  const client = await db.connect(),
    spec = labelModes[mode];
  try {
    await client.query('BEGIN');
    // Serialize empty-tree inserts and hierarchy moves, including definition-to-report copying.
    await client.query(
      `LOCK TABLE ${mode === 'Def' && options.copy ? 'mst_label_def,mst_label_rep' : spec.table} IN SHARE ROW EXCLUSIVE MODE`,
    );
    const rows = (
      await client.query<LabelRecord>(`SELECT * FROM ${spec.table} ORDER BY diplay_number FOR UPDATE`)
    ).rows.map(labelRecord);
    const old = rows.find((row) => row.mst_label_id === record.mst_label_id);
    if (options.edit && !old) throw new LabelValidationError('', pageText['Label was not found.']);
    if (options.edit && old?.binder_rep_id != null && old.label_name !== record.label_name)
      throw new LabelValidationError('mst_label.label_name', pageText['Failed to update Label name.']);
    if (options.quick !== undefined) {
      record.auto_creation = 0;
      record.diplay_number = 0;
      const base = rows.find((row) => row.mst_label_id === options.base);
      record.upper_label_id = options.quick === '1' ? (base?.mst_label_id ?? null) : (base?.upper_label_id ?? null);
      const siblings = rows.filter((row) => row.upper_label_id === record.upper_label_id);
      record.diplay_number = options.quick === '0' && base ? base.diplay_number + 1 : 0;
      let previous = record.diplay_number,
        after = !base || options.quick === '1';
      for (const sibling of siblings) {
        if (!after && sibling.mst_label_id === base?.mst_label_id) {
          after = true;
          continue;
        }
        if (!after) continue;
        const display = Math.max(previous + 1, sibling.diplay_number);
        if (!sibling.auto_creation)
          await client.query(`UPDATE ${spec.table} SET diplay_number=$1 WHERE mst_label_id=$2`, [
            display,
            sibling.mst_label_id,
          ]);
        previous = display;
      }
    }
    const parent = rows.find((row) => row.mst_label_id === record.upper_label_id);
    if (record.upper_label_id !== null && !parent)
      throw new LabelValidationError('mst_label.upper_label_id', pageText['Parent label was not found.']);
    if (
      options.edit &&
      (parent?.mst_label_id === record.mst_label_id ||
        parent?.label_id_path.split('/').includes(String(record.mst_label_id)))
    ) {
      throw new LabelValidationError(
        'mst_label.upper_label_id',
        pageText['Child label cannot be set as Parent label.'],
      );
    }
    if (!options.edit)
      record.mst_label_id = Number(
        (await client.query('SELECT nextval($1::regclass) AS id', [spec.sequence])).rows[0].id,
      );
    record.label_id_path = (parent ? parent.label_id_path + '/' : '') + record.mst_label_id;
    record.label_name_path = (parent ? parent.label_name_path + '/' : '') + record.label_name;
    const columns = [
      'upper_label_id',
      'label_name',
      'label_id_path',
      'label_name_path',
      'label_icon_id',
      'diplay_number',
      'label_remarks',
      'auto_delete',
    ];
    if (mode === 'Rep')
      columns.push(
        ...(options.edit
          ? ['auto_label_name', 'bottom_layer', 'auto_slash_hierarchy', 'report_update_type', 'system_key']
          : ['auto_creation', 'auto_label_name', 'bottom_layer', 'auto_slash_hierarchy', 'report_update_type']),
      );
    const values: unknown[] = columns.map((column) => record[column as keyof LabelRecord] ?? null);
    if (!options.edit && !record.label_icon_id) values[columns.indexOf('label_icon_id')] = null;
    const parameters = columns.map((_, index) => '$' + (index + 1));
    values.push(hostname(), actor, record.mst_label_id);
    const host = '$' + (columns.length + 1),
      user = '$' + (columns.length + 2),
      id = '$' + (columns.length + 3);
    if (options.edit) {
      await client.query(
        `UPDATE ${spec.table} SET ${columns.map((column, index) => `${column}=${parameters[index]}`).join(',')},
        sys_update_term=${host},sys_update_user=${user},sys_update_time=CURRENT_TIMESTAMP WHERE mst_label_id=${id}`,
        values,
      );
      // Use path prefixes, never label-name LIKE patterns: names may contain slash, percent or underscore.
      await client.query(
        `UPDATE ${spec.table} SET label_id_path=$1||substring(label_id_path FROM $2::integer),
        label_name_path=$3||substring(label_name_path FROM $4::integer) WHERE left(label_id_path,$5)=$6`,
        [
          record.label_id_path,
          old!.label_id_path.length + 1,
          record.label_name_path,
          [...old!.label_name_path].length + 1,
          old!.label_id_path.length + 1,
          old!.label_id_path + '/',
        ],
      );
    } else
      await client.query(
        `INSERT INTO ${spec.table} (${columns.join(',')},sys_regist_term,sys_regist_user,sys_regist_time,
      sys_update_term,sys_update_user,sys_update_time,mst_label_id) VALUES (${parameters.join(',')},${host},${user},CURRENT_TIMESTAMP,${host},${user},CURRENT_TIMESTAMP,${id})`,
        values,
      );
    if (options.quick === undefined) {
      await client.query(`DELETE FROM ${spec.role} WHERE mst_label_id=$1`, [record.mst_label_id]);
      if (!options.noRoles)
        for (const [group, refer] of Object.entries(options.roles ?? {}))
          if (refer) {
            await client.query(
              `INSERT INTO ${spec.role} (mst_label_id,group_id,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time)
          VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP,$3,$4,CURRENT_TIMESTAMP)`,
              [record.mst_label_id, labelInteger(group), hostname(), actor],
            );
          }
    }
    if (mode === 'Def' && !options.edit && options.copy) await copyReportLabels(client, record.mst_label_id, actor);
    await bumpMasterLabels(client, mode, actor);
    await client.query('COMMIT');
    return record.mst_label_id;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function copyReportLabels(client: pg.PoolClient, labelId: number, actor: string): Promise<void> {
  const chain = (
    await client.query<LabelRecord>(
      `WITH RECURSIVE chain AS (SELECT * FROM mst_label_def WHERE mst_label_id=$1
    UNION ALL SELECT a.* FROM mst_label_def a JOIN chain ON a.mst_label_id=chain.upper_label_id)
    SELECT * FROM chain ORDER BY label_id_path`,
      [labelId],
    )
  ).rows;
  let parent: LabelRecord | undefined;
  for (const label of chain) {
    const existing = (
      await client.query<LabelRecord>(
        `SELECT * FROM mst_label_rep WHERE label_name=$1
      AND upper_label_id IS NOT DISTINCT FROM $2 AND COALESCE(auto_creation,0)=0 LIMIT 1`,
        [label.label_name, parent?.mst_label_id ?? null],
      )
    ).rows[0];
    if (existing) {
      parent = existing;
      continue;
    }
    const id = Number((await client.query("SELECT nextval('mst_label_def_mst_label_id_seq') AS id")).rows[0].id);
    const idPath = (parent ? parent.label_id_path + '/' : '') + id,
      namePath = (parent ? parent.label_name_path + '/' : '') + label.label_name;
    await client.query(
      `INSERT INTO mst_label_rep (mst_label_id,upper_label_id,label_name,label_id_path,label_name_path,label_icon_id,label_remarks,diplay_number,
      auto_creation,auto_label_name,bottom_layer,auto_slash_hierarchy,auto_delete,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,'',0,0,$9,$10,$11,CURRENT_TIMESTAMP,$10,$11,CURRENT_TIMESTAMP)`,
      [
        id,
        parent?.mst_label_id ?? null,
        label.label_name,
        idPath,
        namePath,
        label.label_icon_id || 1,
        label.label_remarks,
        label.diplay_number,
        label.auto_delete || 0,
        hostname(),
        actor,
      ],
    );
    await client.query(
      `INSERT INTO rep_label_role (mst_label_id,group_id,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time)
      SELECT $1,group_id,$2,$3,CURRENT_TIMESTAMP,$2,$3,CURRENT_TIMESTAMP FROM def_label_role WHERE mst_label_id=$4`,
      [id, hostname(), actor, label.mst_label_id],
    );
    parent = { ...label, mst_label_id: id, label_id_path: idPath, label_name_path: namePath };
  }
}

export async function deleteLabel(db: pg.Pool, mode: LabelMode, id: number): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM ${labelModes[mode].table} WHERE mst_label_id=$1`, [id]);
    await bumpMasterLabels(client, mode, '');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
