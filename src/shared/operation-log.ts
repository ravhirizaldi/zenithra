import type pg from 'pg';
import type { Request } from 'express';
import type { ClientAccount } from '../models/client-account.js';

type Database = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;
export type LoginContent = 'LoginSuccess' | 'LoginAuthError' | 'LoginLockError' | 'LoginError';
export type LogoutContent = 'Logout' | 'LogoutTimeout';
export type ManagerLogContext = {
  userId: string;
  userName: string;
  clientAddress: string;
  clientName: string;
  browser: string;
  sessionId: string;
};

export function managerLogContext(req: Request, userId: string, userName: string): ManagerLogContext {
  const agent = req.get('user-agent') ?? '';
  const match = agent.match(/(Edg|Edge|OPR|Chrome|Firefox|Version|MSIE)[\s/]([\d.]+)/);
  const browser = match
    ? `${({ Edg: 'Chrome', Edge: 'Edge', OPR: 'Opera', Version: 'Safari', MSIE: 'IE' } as Record<string, string>)[match[1]] ?? match[1]}${match[2]}`
    : 'Unknown0.0';
  return { userId, userName, clientAddress: req.ip ?? '', clientName: req.ip ?? '', browser, sessionId: req.sessionID };
}

export async function loggingEnabled(db: Database, name: 'OPERATION' | 'USER_ACCOUNT_OPERATION_LOG'): Promise<boolean> {
  return (
    (
      await db.query(
        "SELECT com_value FROM mst_common WHERE com_key='LOG_SETTING' AND com_name=$1 ORDER BY com_index LIMIT 1",
        [name],
      )
    ).rows[0]?.com_value === '1'
  );
}

export async function logManagerOperation(
  db: Database,
  context: ManagerLogContext,
  content: LoginContent | LogoutContent,
): Promise<boolean> {
  try {
    if (!(await loggingEnabled(db, 'OPERATION'))) return false;
    await db.query(
      `INSERT INTO conmas_operation_log
      (log_id,log_type,operation_type,operation_content,app_type,browser_name,user_id,user_name,term_name,client_ip_address,client_host_name,log_time,session_id)
      VALUES (to_char(clock_timestamp(),'YYYYMMDDHH24MISS') || lpad(nextval('conmas_operation_history_seq')::text,20,'0'),'Auth',$1,$2,'Manager',$3,$4,$5,'',$6,$7,clock_timestamp(),$8)`,
      [
        content.startsWith('Login') ? 'Login' : 'Logout',
        content,
        context.browser,
        context.userId,
        context.userName,
        context.clientAddress,
        context.clientName,
        context.sessionId,
      ],
    );
    return true;
  } catch (error) {
    // Legacy InsertLog reports a logging failure without failing the user's action.
    console.error('Operation log write failed.', error instanceof Error ? error.message : 'Database error');
    return false;
  }
}

export async function logClientOperation(
  db: Database,
  account: ClientAccount,
  content: LoginContent | LogoutContent | 'LoginVersionError' | 'LoginTerminalApplyError' | 'LoginTerminalApproveError',
): Promise<void> {
  if (account.client === 'Designer' && account.version === '999.9.9999' && content.startsWith('Login')) return;
  try {
    if (!(await loggingEnabled(db, 'OPERATION'))) return;
    const terminal = (
      await db.query('SELECT term_id,term_name FROM mst_terminal WHERE term_type=$1 AND physical_id=$2 AND deleted=0', [
        account.client,
        account.physicalId,
      ])
    ).rows[0];
    await db.query(
      `INSERT INTO conmas_operation_log
      (log_id,log_type,operation_type,operation_content,app_type,device_type,app_version,user_id,user_name,term_id,physical_id,term_name,client_ip_address,client_host_name,log_time,session_id)
      VALUES (to_char(clock_timestamp(),'YYYYMMDDHH24MISS') || lpad(nextval('conmas_operation_history_seq')::text,20,'0'),'Auth',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,clock_timestamp(),$12)`,
      [
        content.startsWith('Login') ? 'Login' : 'Logout',
        content,
        account.client === 'Designer' ? 'Designer' : 'Tablet',
        account.client === 'Designer' ? '' : account.platform === 'Windows' ? 'Windows' : 'iOS',
        account.version,
        account.userId,
        account.userName,
        terminal?.term_id ?? null,
        account.physicalId,
        terminal?.term_name ?? null,
        account.address,
        account.sessionId,
      ],
    );
  } catch (error) {
    console.error('Client operation log write failed.', error instanceof Error ? error.message : 'Database error');
  }
}

export async function insertUserAccountLog(
  db: Database,
  userId: string,
  userName: string,
  actor: string,
  address: string,
  type: 'Insert' | 'Update' | 'Delete',
  content: string,
  terminalName: string | null = '',
  appType: 'Manager' | 'Api' = 'Manager',
): Promise<void> {
  await db.query(
    `INSERT INTO conmas_user_account_operation_log
    (log_id,operation_type,operation_content,app_type,user_id,user_name,term_id,physical_id,term_name,client_ip_address,log_time,update_user_id)
    VALUES (to_char(CURRENT_TIMESTAMP,'YYYYMMDDHH24MISS') || lpad(nextval('conmas_operation_history_seq')::text,20,'0'),$1,$2,$8,$3,$4,NULL,NULL,$7,$5,CURRENT_TIMESTAMP,$6)`,
    [type, content, userId, userName, address, actor, terminalName, appType],
  );
}

export type UserAuditSnapshot = {
  user_id: string;
  user_name: string;
  password: string;
  e_mail: string;
  start_minute: string;
  end_minute: string;
  approval_sign: string;
  amivoice_enable: string;
  groups: string[];
};
export async function userAuditSnapshot(db: Database, id: string): Promise<UserAuditSnapshot | null> {
  const row = (
    await db.query(
      `SELECT user_id,user_name,password,e_mail,approval_sign,coalesce(amivoice_enable,0)::text AS amivoice_enable,
    to_char(use_start_time,'YYYYMMDDHH24MI') AS start_minute,to_char(use_end_time,'YYYYMMDDHH24MI') AS end_minute,
    ARRAY(SELECT group_id::text FROM mst_group_affiation WHERE user_id=mst_user.user_id) AS groups FROM mst_user WHERE user_id=$1`,
      [id],
    )
  ).rows[0];
  return row
    ? ({
        ...row,
        user_name: row.user_name ?? '',
        e_mail: row.e_mail ?? '',
        approval_sign: row.approval_sign ?? '',
      } as UserAuditSnapshot)
    : null;
}

export function userAuditChanges(before: UserAuditSnapshot, after: UserAuditSnapshot): string {
  const fields = [
    ['user_name', 'UpdatetUserName'],
    ['password', 'UpdatetUserPassWd'],
    ['e_mail', 'UpdatetUserEmail'],
    ['start_minute', 'UpdatetUserStartTime'],
    ['end_minute', 'UpdatetUserEndTime'],
    ['approval_sign', 'UpdatetUserApprovalSign'],
    ['amivoice_enable', 'UpdatetUserAmiVoiceEnable'],
  ] as const;
  const changes: string[] = fields.filter(([field]) => before[field] !== after[field]).map(([, label]) => label);
  if (before.groups.some((id) => !after.groups.includes(id)) || after.groups.some((id) => !before.groups.includes(id)))
    changes.push('UpdatetUserGroup');
  return changes.join(';');
}

export async function logUserAccountChange(
  db: Database,
  before: UserAuditSnapshot | null,
  after: UserAuditSnapshot | null,
  actor: string,
  address: string,
): Promise<void> {
  const user = after ?? before;
  if (!user) return;
  try {
    if (!(await loggingEnabled(db, 'USER_ACCOUNT_OPERATION_LOG'))) return;
    const content = before && after ? userAuditChanges(before, after) : after ? 'RegistUser' : 'DeleteUser';
    if (content)
      await insertUserAccountLog(
        db,
        user.user_id,
        user.user_name,
        actor,
        address,
        before && after ? 'Update' : after ? 'Insert' : 'Delete',
        content,
      );
  } catch (error) {
    console.error('User account log write failed.', error instanceof Error ? error.message : 'Database error');
  }
}
