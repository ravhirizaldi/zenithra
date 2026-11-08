import type pg from 'pg';

export async function taskList(
  db: Pick<pg.Pool, 'query'>,
  input: { searchName: string; searchRemark: string; pageIndex: number; pageSize: number },
) {
  const { searchName, searchRemark, pageIndex, pageSize } = input;
  const values = [
    searchName.trim() ? '%' + searchName + '%' : null,
    searchRemark.trim() ? '%' + searchRemark + '%' : null,
  ];
  const where = '($1::text IS NULL OR task_name LIKE $1) AND ($2::text IS NULL OR task_remark LIKE $2)';
  const total = Number((await db.query(`SELECT COUNT(*) AS total FROM mst_task WHERE ${where}`, values)).rows[0].total);
  const rows = (
    await db.query(
      `SELECT task_id,task_name,COALESCE(task_remark,'') AS task_remark,COALESCE(display_number,0) AS display_number
    FROM mst_task WHERE ${where} ORDER BY display_number,task_name,task_id LIMIT $3 OFFSET $4`,
      [...values, pageSize, pageIndex * pageSize],
    )
  ).rows;
  return { rows, total };
}
