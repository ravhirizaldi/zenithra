import type pg from 'pg';
import { hostname } from 'node:os';
import { legacyPassword } from './legacy-auth.js';

// AccountController.LogOn, AuthenticationRepository.GetUser, and AuthManager lock rules.
export async function authenticate(
  db: pg.Pool,
  userId: string,
  password: string,
  key: string,
  mode: 'manager' | 'client' | 'api' = 'manager',
): Promise<{
  user?: { user_id: string; user_name: string; use_start_time: Date; use_end_time: Date };
  error?: string;
  logContent?: 'LoginAuthError' | 'LoginLockError';
}> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [userId]);
    const settings = (
      await client.query(
        "SELECT com_name,com_value FROM mst_common WHERE com_key='ACCOUNT_LOCK_SETTING' ORDER BY com_index",
      )
    ).rows;
    const value = (name: string) => String(settings.find((row) => row.com_name === name)?.com_value ?? '');
    const integer = (name: string) =>
      /^[+-]?\d+$/.test(value(name)) && Number(value(name)) >= -2147483648 && Number(value(name)) <= 2147483647
        ? Number(value(name))
        : 0;
    const threshold = integer('ACCOUNT_LOCKOUT_FAILCOUNT'),
      duration = integer('ACCOUNT_LOCKOUT_DURATION'),
      reset = integer('RESET_ACCOUNT_LOCKOUT_COUNTER_AFTER');
    const lockEnabled =
      userId !== 'conmasadmin' && value('ACCOUNT_LOCKOUT_ENABLE') === '1' && threshold !== 0 && duration !== 0;
    const lock = (
      await client.query(
        'SELECT *, extract(epoch FROM (now()-sys_update_time))/60 AS update_minutes, extract(epoch FROM (now()-sys_regist_time))/60 AS register_minutes FROM user_lock WHERE user_id=$1',
        [userId],
      )
    ).rows[0];
    if (lockEnabled && lock && lock.failure_count >= threshold && Number(lock.update_minutes) < duration) {
      await client.query('COMMIT');
      return {
        error: value('RESPONSE_TYPE') === '1' ? 'Incorrect user name or password.' : 'The user account is locked.',
        logContent: 'LoginLockError',
      };
    }
    const result = (
      await client.query(
        `SELECT user_id,user_name,password,${mode !== 'manager' ? "coalesce(use_start_time,now()) AS use_start_time,coalesce(use_end_time,timestamp '2038-01-01') AS use_end_time" : 'use_start_time,use_end_time'}, now() BETWEEN use_start_time AND use_end_time AS active,
      now() BETWEEN coalesce(use_start_time,now()) AND coalesce(use_end_time,timestamp '2038-01-01') AS active_for_failure
      FROM mst_user WHERE user_id=$1${mode !== 'manager' ? " AND now() BETWEEN coalesce(use_start_time,now()) AND coalesce(use_end_time,timestamp '2038-01-01')" : ''}`,
        [userId],
      )
    ).rows[0];
    const encrypted =
      mode !== 'api' ||
      (
        await client.query(
          "SELECT com_value FROM mst_common WHERE com_key='PASSWORD_ENCRYPTION' AND com_name='PASSWORD_ENCRYPTION' AND coalesce(com_locale,'')='' ORDER BY com_index LIMIT 1",
        )
      ).rows[0]?.com_value === '1';
    if (!result || result.password !== (encrypted ? legacyPassword(userId, password, key) : password)) {
      if (lockEnabled && result?.active_for_failure) {
        if (!lock)
          await client.query(
            `INSERT INTO user_lock (user_id,failure_count,sys_regist_term,sys_regist_user,sys_update_term,sys_update_user) VALUES ($1,1,$2,$1,$2,$1)`,
            [userId, hostname()],
          );
        else {
          const restart = reset !== 0 && Number(lock.register_minutes) > reset;
          await client.query(
            `UPDATE user_lock SET failure_count=$2,sys_regist_time=CASE WHEN $3 THEN now() ELSE sys_regist_time END,sys_update_term=$4,sys_update_user=$1,sys_update_time=now() WHERE user_id=$1`,
            [userId, restart ? 1 : lock.failure_count + 1, restart, hostname()],
          );
        }
      }
      await client.query('COMMIT');
      return { error: 'Incorrect user name or password.', logContent: 'LoginAuthError' };
    }
    await client.query('DELETE FROM user_lock WHERE user_id=$1', [userId]);
    await client.query('COMMIT');
    if (mode === 'manager' && !result.active) return { error: 'The user account is outside its validity dates.' };
    return {
      user: {
        user_id: result.user_id,
        user_name: result.user_name,
        use_start_time: result.use_start_time,
        use_end_time: result.use_end_time,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
