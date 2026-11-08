import type pg from 'pg';
import { licenseDate, readLicenseFields } from '../shared/license-counts.js';
import { clientElement } from '../services/client-xml.js';
import type { LoginContent, LogoutContent } from '../shared/operation-log.js';
import { loggingEnabled } from '../shared/operation-log.js';

export type ApiAccount = {
  userId: string;
  userName: string;
  address: string;
  sessionId: string;
  freeDrawOnly: boolean;
};

export function apiEntitlements(fields = readLicenseFields(), today = new Date()) {
  const day = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
  const valid = (name: string, count = false) => {
    const value = (fields.get(name) ?? '').trim();
    const integer = /^[+-]?\d+$/.test(value) && Number(value) >= -2147483648 && Number(value) <= 2147483647;
    const enabled = count
      ? integer && Number(value) > 0
      : ['ConMasIoTGateway', 'MappingTool', 'nXProjectHub'].includes(name)
        ? integer && Number(value) === 1
        : value === '1';
    const expiry = licenseDate(fields.get(`${name}Expire`));
    return enabled && (!expiry || expiry >= day);
  };
  const api =
    fields.get('ApiOption') !== '0' ||
    valid('ConMasIoTGateway') ||
    valid('MappingTool') ||
    valid('WorkFlow', true) ||
    valid('nXProjectHub') ||
    valid('i-RepoWeb') ||
    valid('i-RepoChat', true) ||
    valid('i-RepoLink');
  const freeDrawExpiry = licenseDate(fields.get('FreeDrawOnlyApiOptionExpire'));
  const legacyCounts = ['User', 'iPad', 'Designer', 'Expiration']
    .filter((name) => fields.has(name))
    .map((name) => fields.get(name)!);
  const notExpired =
    legacyCounts.every(
      (value) => /^[+-]?\d+$/.test(value.trim()) && Number(value) >= -2147483648 && Number(value) <= 2147483647,
    ) &&
    (legacyCounts.length < 4 || Number(fields.get('Expiration')) >= Number(day));
  return {
    api,
    motionboard: fields.get('MotionboardCloudAPIOption') === '1',
    irPlus: fields.get('IrPlus') === '1',
    freeDrawOnly: fields.get('FreeDrawOnlyApiOption') === '1',
    freeDrawExpired: Boolean(freeDrawExpiry && freeDrawExpiry < day),
    notExpired,
  };
}

export function apiLoginResult(code: number, remark = '', passwordExpired = false): string {
  const result = (code: number, remark: string) =>
    `<loginResult>${clientElement('code', code)}${clientElement('remark', remark)}</loginResult>`;
  return `<conmas>${result(code, remark)}${passwordExpired ? result(1, 'User Password Expiration') : ''}</conmas>`;
}

export async function logApiOperation(
  db: Pick<pg.Pool, 'query'>,
  account: ApiAccount,
  content: LoginContent | LogoutContent,
): Promise<void> {
  try {
    if (!(await loggingEnabled(db, 'OPERATION'))) return;
    await db.query(
      `INSERT INTO conmas_operation_log
      (log_id,log_type,operation_type,operation_content,app_type,user_id,user_name,client_ip_address,client_host_name,log_time,session_id)
      VALUES (to_char(clock_timestamp(),'YYYYMMDDHH24MISS') || lpad(nextval('conmas_operation_history_seq')::text,20,'0'),'Auth',$1,$2,'Api',$3,$4,$5,$5,clock_timestamp(),$6)`,
      [
        content.startsWith('Login') ? 'Login' : 'Logout',
        content,
        account.userId,
        account.userName,
        account.address,
        account.sessionId,
      ],
    );
  } catch {
    console.error('API operation log write failed.');
  }
}
