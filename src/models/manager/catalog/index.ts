import type pg from 'pg';

export type CatalogKind = 'form' | 'document';

const sources = {
  form: {
    table: 'def_top',
    id: 'def_top_id',
    name: 'def_top_name',
    org: 'def_top_org',
    sheets: 'def_sheet',
    sheetNo: 'def_sheet_no',
    sheetName: 'def_sheet_name',
    labels: 'def_label',
    labelMaster: 'mst_label_def',
  },
  document: {
    table: 'rep_top',
    id: 'rep_top_id',
    name: 'rep_top_name',
    org: 'rep_top_org',
    sheets: 'rep_sheet',
    sheetNo: 'rep_sheet_no',
    sheetName: 'rep_sheet_name',
    labels: 'rep_label',
    labelMaster: 'mst_label_rep',
  },
} as const;

export function catalogFilters(query: Record<string, unknown>) {
  const pageNumber = Number(query.page);
  return {
    label: typeof query.label === 'string' ? query.label.slice(0, 30) : 'all',
    status: query.status === 'all' ? 'all' : 'published',
    search: typeof query.search === 'string' ? query.search.trim().slice(0, 100) : '',
    page: Number.isSafeInteger(pageNumber) && pageNumber > 0 ? Math.min(pageNumber, 10_000) : 1,
  };
}

export async function listCatalog(db: pg.Pool, kind: CatalogKind, filters: ReturnType<typeof catalogFilters>) {
  const source = sources[kind];
  const values: unknown[] = [];
  const clauses = ['top.deleted = 0'];
  if (filters.status === 'published') clauses.push('top.public_status = 2');
  if (filters.search) {
    values.push(`%${filters.search.replace(/[\\%_]/g, '\\$&')}%`);
    clauses.push(`top.${source.name} ILIKE $${values.length} ESCAPE '\\'`);
  }
  if (filters.label === 'none') {
    clauses.push(`NOT EXISTS (SELECT 1 FROM ${source.labels} linked WHERE linked.${source.id} = top.${source.id})`);
  } else if (/^[1-9]\d*$/.test(filters.label)) {
    values.push(Number(filters.label));
    clauses.push(
      `EXISTS (SELECT 1 FROM ${source.labels} linked WHERE linked.${source.id} = top.${source.id} AND linked.mst_label_id = $${values.length})`,
    );
  }
  const where = clauses.join(' AND ');
  const count = await db.query<{ total: string }>(
    `SELECT count(*) AS total FROM ${source.table} top WHERE ${where}`,
    values,
  );
  const total = Number(count.rows[0].total);
  values.push(20, (filters.page - 1) * 20);
  const rows = await db.query(
    `SELECT top.${source.id} AS id, top.${source.name} AS name,
    top.${source.org} AS original_id, top.rev_no, top.auto_gen, top.public_status,
    (top.sys_regist_user = 'node-import') AS is_sample,
    to_char(top.sys_regist_time, 'YYYY/MM/DD HH24:MI') AS registered,
    coalesce(top.sys_regist_user_name, top.sys_regist_user) AS registered_by,
    to_char(top.sys_update_time, 'YYYY/MM/DD HH24:MI') AS updated,
    coalesce(top.sys_update_user_name, top.sys_update_user) AS updated_by
    FROM ${source.table} top WHERE ${where}
    ORDER BY top.sys_update_time DESC NULLS LAST, top.${source.id} DESC
    LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  const labels = await db.query(`SELECT mst_label_id AS id, label_name AS name, upper_label_id AS parent_id
    FROM ${source.labelMaster} ORDER BY label_id_path, mst_label_id`);
  return { kind, filters, total, pages: Math.max(1, Math.ceil(total / 20)), rows: rows.rows, labels: labels.rows };
}

export async function catalogDetail(db: pg.Pool, kind: CatalogKind, id: number) {
  const source = sources[kind];
  const result = await db.query(
    `SELECT top.${source.id} AS id, top.${source.name} AS name,
    top.${source.org} AS original_id, top.rev_no, top.public_status, top.auto_gen,
    top.def_top_id, (top.sys_regist_user = 'node-import') AS is_sample,
    top.def_file_name, top.def_file_type,
    to_char(top.sys_regist_time, 'YYYY/MM/DD HH24:MI') AS registered,
    coalesce(top.sys_regist_user_name, top.sys_regist_user) AS registered_by,
    to_char(top.sys_update_time, 'YYYY/MM/DD HH24:MI') AS updated,
    coalesce(top.sys_update_user_name, top.sys_update_user) AS updated_by
    FROM ${source.table} top WHERE top.${source.id} = $1 AND top.deleted = 0`,
    [id],
  );
  if (result.rowCount !== 1) return null;
  const sheets = await db.query(
    `SELECT ${source.sheetNo} AS sheet_no, ${source.sheetName} AS name
    FROM ${source.sheets} WHERE ${source.id} = $1 ORDER BY ${source.sheetNo}`,
    [id],
  );
  const labels = await db.query(
    `SELECT master.label_name AS name FROM ${source.labels} linked
    JOIN ${source.labelMaster} master ON master.mst_label_id = linked.mst_label_id
    WHERE linked.${source.id} = $1 ORDER BY master.label_id_path`,
    [id],
  );
  return { kind, top: result.rows[0], sheets: sheets.rows, labels: labels.rows };
}
