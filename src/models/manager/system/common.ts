import type pg from 'pg';

export async function listCommonSettings(database: pg.Pool, query: Record<string, unknown>) {
  const key = typeof query.key === 'string' ? query.key.trim().slice(0, 100) : '';
  const name = typeof query.name === 'string' ? query.name.trim().slice(0, 100) : '';
  const rawPage = Number(query.page);
  const pageIndex = Number.isSafeInteger(rawPage) && rawPage > 0 ? Math.min(rawPage, 10_000) : 1;
  const filters = [key, name].map((value) => `%${value.replace(/[\\%_]/g, '\\$&')}%`);
  const where = `com_key ILIKE $1 ESCAPE '\\' AND com_name ILIKE $2 ESCAPE '\\'`;
  const count = await database.query<{ total: string }>(
    `SELECT count(*) AS total FROM mst_common WHERE ${where}`,
    filters,
  );
  const result = await database.query(
    `SELECT com_key, com_name, com_locale FROM mst_common
    WHERE ${where} ORDER BY com_key, com_index, com_name LIMIT 50 OFFSET $3`,
    [...filters, (pageIndex - 1) * 50],
  );
  return {
    columns: ['Key', 'Name', 'Locale'],
    rows: result.rows.map((row) => [row.com_key, row.com_name, row.com_locale]),
    total: Number(count.rows[0].total),
    page: pageIndex,
    pages: Math.max(1, Math.ceil(Number(count.rows[0].total) / 50)),
    key,
    name,
  };
}
