import type pg from 'pg';
import { clientElement, clientError } from '../services/client-xml.js';

export type ClientAccount = {
  userId: string;
  userName: string;
  client: string;
  physicalId: string;
  version: string;
  platform: string;
  address: string;
  sessionId: string;
};
type Database = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

export async function clientCommonSettings(db: Database): Promise<Map<string, string>> {
  const rows = (
    await db.query(`SELECT com_key,com_name,com_value FROM mst_common WHERE com_key IN
    ('LOGIN_SETTING','TABLET_SETTING','PASSWORD_SETTING','DEFINITION_SETTING','IPAD_SETTING','FUNCTION_SETTING','TERMINAL_SETTING') ORDER BY com_index`)
  ).rows;
  const settings = new Map<string, string>();
  for (const row of rows)
    if (!settings.has(`${row.com_key}/${row.com_name}`))
      settings.set(`${row.com_key}/${row.com_name}`, row.com_value ?? '');
  return settings;
}

export async function clientTerminal(db: Database, account: Pick<ClientAccount, 'client' | 'physicalId'>) {
  const row = (
    await db.query(
      'SELECT term_id,term_name,approver FROM mst_terminal WHERE term_type=$1 AND physical_id=$2 AND deleted=0',
      [account.client, account.physicalId],
    )
  ).rows[0];
  return { code: row ? (row.approver ? 0 : 4) : 3, id: row?.term_id ?? null, name: row?.term_name ?? null };
}

export async function clientUserInfo(db: Database, account: ClientAccount): Promise<string> {
  const user = (await db.query('SELECT approval_sign FROM mst_user WHERE user_id=$1', [account.userId])).rows[0];
  const groups = (await db.query('SELECT group_id FROM mst_group_affiation WHERE user_id=$1', [account.userId])).rows
    .map((row) => row.group_id)
    .join(',');
  const terminal = await clientTerminal(db, account);
  return `<conmas><userInfo>${clientElement('userId', account.userId)}${clientElement('userName', account.userName)}${clientElement('approvalSign', user?.approval_sign)}${clientElement('group', groups)}${clientElement('terminalState', terminal.code)}</userInfo></conmas>`;
}

export async function clientPasswordExpired(db: Database, userId: string, maximumAge: string): Promise<string> {
  if (!maximumAge || maximumAge === '0' || userId === 'conmasadmin') return '0';
  if (!/^[+-]?\d+$/.test(maximumAge) || !Number.isSafeInteger(Number(maximumAge)))
    throw new Error('Invalid password age setting.');
  const row = (
    await db.query(
      `SELECT CURRENT_DATE > date_trunc('day',coalesce(password_change_time,sys_update_time))
    + interval '23 hours 59 minutes 59 seconds' + $2::integer * interval '1 day' AS expired FROM mst_user WHERE user_id=$1`,
      [userId, Number(maximumAge)],
    )
  ).rows[0];
  return row?.expired ? '1' : '0';
}

export async function changeClientTerminal(db: Database, account: ClientAccount, approve: boolean): Promise<string> {
  // AuthManager's public approval action deliberately has no deleted/permission/quota filter; it targets only this session's device.
  const changed = await db.query(
    `UPDATE mst_terminal SET ${approve ? 'approver=$3,approver_name=$4,approver_date=now()' : 'deleted=1'},
    sys_update_user=$3,sys_update_term=$2,sys_update_time=now() WHERE term_type=$1 AND physical_id=$2${approve ? '' : ' AND deleted=0'}`,
    approve
      ? [account.client, account.physicalId, account.userId, account.userName]
      : [account.client, account.physicalId, account.userId],
  );
  return clientError(approve || changed.rowCount ? 0 : 8, '');
}

export async function registerClientTerminal(
  db: pg.Pool,
  account: ClientAccount,
  comment: string,
  biometrics: string,
): Promise<void> {
  const connection = await db.connect();
  try {
    await connection.query('BEGIN');
    await connection.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `terminal:${account.client}:${account.physicalId}`,
    ]);
    const pending = (
      await connection.query(
        "SELECT term_id FROM mst_terminal WHERE term_type=$1 AND physical_id=$2 AND coalesce(approver,'')='' AND deleted=0",
        [account.client, account.physicalId],
      )
    ).rows[0];
    if (!pending) {
      const row = (
        await connection.query(
          `INSERT INTO mst_terminal
        (term_id,term_type,physical_id,applicant,applicant_name,applicant_date,applicant_comment,sys_regist_term,sys_regist_user,sys_update_term,sys_update_user,use_biometrics)
        VALUES (nextval('mst_terminal_term_id_seq'),$1,$2,$3,$4,now(),$5,$2,$3,$2,$3,$6) RETURNING term_id`,
          [account.client, account.physicalId, account.userId, account.userName, comment, biometrics === '1' ? 1 : 0],
        )
      ).rows[0];
      const settings = await clientCommonSettings(connection);
      if (settings.get('TERMINAL_SETTING/APPROVE_MODE') === '1') {
        await connection.query(
          `UPDATE mst_terminal SET term_name=physical_id,approver=$2,approver_name=$3,approver_date=now(),sys_update_term=$4,sys_update_user=$2,sys_update_time=now() WHERE term_id=$1`,
          [row.term_id, account.userId, account.userName, account.physicalId],
        );
      }
    }
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
}
