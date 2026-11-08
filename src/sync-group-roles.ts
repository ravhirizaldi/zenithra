import type pg from 'pg';
import { hostname } from 'node:os';

// ConMasUtility.SyncDefRole; only missing definition grants are inserted.
export async function syncGroupRoles(
  db: pg.PoolClient,
  groupId: number,
  parentId: number,
  actor: string,
): Promise<void> {
  const rows = (
    await db.query("SELECT com_name,com_value FROM mst_common WHERE com_key='SYSTEM_ROLE_SETTING' ORDER BY com_index")
  ).rows;
  const value = (name: string) => String(rows.find((row) => row.com_name === name)?.com_value || '0');
  const def = value('DEF'),
    rep = value('REP'),
    auto = value('AUTO_TYPE');
  if (value('ENABLE') === '0' || def === '0' || rep === '0') return;
  const mode = Math.max(Number(def), Number(rep));
  if (![2, 3, 4].includes(mode)) return;
  const definitions =
    rep === '4'
      ? (
          await db.query(
            'SELECT top.def_top_id,top.sys_regist_user FROM def_top top INNER JOIN def_current cur ON top.def_top_id=cur.def_top_id WHERE top.def_top_id>100 AND top.deleted=0',
          )
        ).rows
      : (
          await db.query(
            'SELECT rl.def_top_id,top.sys_regist_user FROM def_role rl INNER JOIN def_top top ON rl.def_top_id=top.def_top_id INNER JOIN def_current cur ON top.def_top_id=cur.def_top_id WHERE rl.def_top_id>100 AND top.deleted=0 AND ((rl.group_id=$1 AND rl.group_id<>$2) OR (rl.group_id=$2 AND rl.group_id<>$1))',
            [parentId, groupId],
          )
        ).rows;
  const columns = [
    'role_def_read',
    'role_def_update',
    'role_def_delete',
    'role_rep_create',
    'role_rep_read',
    'role_rep_update',
    'role_rep_delete',
  ];
  const insert = async (definition: number, id: number, flags: number[]) =>
    db.query(
      `INSERT INTO def_role(def_top_id,group_id,${columns.join(',')},sys_regist_term,sys_regist_user,sys_update_term,sys_update_user)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$10,$11 WHERE NOT EXISTS(SELECT 1 FROM def_role WHERE def_top_id=$1 AND group_id=$2)`,
      [definition, id, ...flags, hostname(), actor],
    );
  for (const definition of definitions) {
    for (const direction of mode === 2 ? ['up'] : ['up', 'down']) {
      const relation = direction === 'up' ? 'g.group_id=r.upper_group_id' : 'g.upper_group_id=r.group_id';
      const groups = (
        await db.query(
          `WITH RECURSIVE r AS (SELECT g.* FROM mst_group g WHERE group_id IN(SELECT group_id FROM mst_group_affiation WHERE user_id=$1)
        UNION SELECT g.* FROM mst_group g JOIN r ON ${relation}) SELECT DISTINCT r.* FROM r WHERE NOT EXISTS(SELECT 1 FROM def_role WHERE def_top_id=$2 AND group_id=r.group_id) ORDER BY group_id_path`,
          [definition.sys_regist_user, definition.def_top_id],
        )
      ).rows;
      for (const group of groups) {
        let flags: number[];
        if (auto === '1')
          flags = columns.map((column, index) => (direction === 'down' && index < 3 ? 0 : Number(group[column] ?? 0)));
        else if (direction === 'up')
          flags = [...Array(3).fill(def === '2' ? 1 : 0), ...Array(4).fill(['2', '3', '4'].includes(rep) ? 1 : 0)];
        else flags = [1, 0, 0, ...Array(4).fill(['3', '4'].includes(rep) ? 1 : 0)];
        await insert(definition.def_top_id, group.group_id, flags);
      }
    }
    if (mode === 4 && auto === '0') await insert(definition.def_top_id, groupId, [1, 0, 0, 1, 1, 1, 1]);
  }
}
