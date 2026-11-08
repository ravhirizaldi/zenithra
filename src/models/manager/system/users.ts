import type pg from 'pg';
import { licenseCounts } from '../../../shared/license-counts.js';

export async function listUsers(database: pg.Pool, query: Record<string, unknown>) {
  const searchId = typeof query.searchId === 'string' ? query.searchId.slice(0, 100) : '';
  const searchName = typeof query.searchName === 'string' ? query.searchName.slice(0, 100) : '';
  const searchGroupId =
    typeof query.searchGroupId === 'string' && /^\d+$/.test(query.searchGroupId) ? query.searchGroupId : '-1';
  const pageIndex =
    Number.isSafeInteger(Number(query.pageIndex)) && Number(query.pageIndex) >= 0
      ? Math.min(Number(query.pageIndex), 10000)
      : 0;
  const defaultSize = await database.query<{ com_value: string }>(
    "SELECT com_value FROM mst_common WHERE com_key = 'DEFAULT_PAGE_SIZE' ORDER BY com_index LIMIT 1",
  );
  const requestedSize = Number(query.pageSize ?? defaultSize.rows[0]?.com_value ?? 20);
  const pageSize = [10, 20, 50, 100].includes(requestedSize) ? requestedSize : 20;
  const filters = [searchId, searchName].map((value) => `%${value.replace(/[\\%_]/g, '\\$&')}%`);
  const where = `user_id <> $1 AND user_id LIKE $2 ESCAPE '\\' AND user_name LIKE $3 ESCAPE '\\'
    AND ($4 = '-1' OR user_id IN (SELECT user_id FROM mst_group_affiation WHERE group_id::text = $4))`;
  const parameters = ['conmasadmin', ...filters, searchGroupId];
  const count = await database.query<{ total: string }>(
    `SELECT count(*) AS total FROM mst_user WHERE ${where}`,
    parameters,
  );
  const users = await database.query(
    `SELECT user_id, user_name, e_mail,
    to_char(use_start_time, 'YYYY/MM/DD HH24:MI') AS use_start_time,
    to_char(use_end_time, 'YYYY/MM/DD HH24:MI') AS use_end_time,
    identification_code, EXISTS(SELECT 1 FROM user_lock l WHERE l.user_id=mst_user.user_id) AS has_lock
    FROM mst_user WHERE ${where} ORDER BY user_id LIMIT $5 OFFSET $6`,
    [...parameters, pageSize, pageIndex * pageSize],
  );
  const groups = await database.query('SELECT group_id, group_name_path FROM mst_group ORDER BY group_id_path');
  return {
    users: users.rows,
    userCount: Number(count.rows[0].total),
    searchId,
    searchName,
    userFilters: {
      searchGroupId,
      pageIndex,
      pageSize,
      groups: groups.rows,
      pages: Math.max(1, Math.ceil(Number(count.rows[0].total) / pageSize)),
      licenseCount: licenseCounts().User,
    },
  };
}
