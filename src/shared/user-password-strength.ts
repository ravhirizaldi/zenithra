import type pg from 'pg';
import { legacyPassword } from './legacy-auth.js';

// UserPasswordStrengthBiz.CheckPasswordStrength/GetCheckList (including its original VXW order).
const sequences =
  '012 123 234 345 456 567 678 789 987 876 765 654 543 432 321 210 ABC BCD CDE DEF EFG FGH GHI HIJ IJK JKL KLM LMN MNO NOP OPQ PQR QRS RST STU TUV UVW VWX WXY XYZ ZYX VXW XWV WVU VUT UTS TSR SRQ RQP QPO PON ONM NML MLK LKJ KJI JIH IHG HGF GFE FED EDC DCB CBA abc bcd cde def efg fgh ghi hij ijk jkl klm lmn mno nop opq pqr qrs rst stu tuv uvw vwx wxy xyz zyx vxw xwv wvu vut uts tsr srq rqp qpo pon onm nml mlk lkj kji jih ihg hgf gfe fed edc dcb cba'.split(
    ' ',
  );
export function passwordRuleErrors(settings: Record<string, string>, userId: string, password: string): string[] {
  const errors: string[] = [];
  if (settings.INCLUDE_MIXED_CASE === '1' && (!/[A-Z]/.test(password) || !/[a-z]/.test(password)))
    errors.push('Include uppercase and lowercase letters.');
  if (settings.INCLUDE_NUMBERS === '1' && !/[0-9]/.test(password)) errors.push('Include a number.');
  if (settings.INCLUDE_SYMBOLS === '1' && !/[!?,./:;()&@'"[\]{}#%^*+=_\\|~<>$-]/.test(password))
    errors.push('Include a symbol.');
  const length = Number(settings.PASSWORD_LENGTH);
  if (Number.isInteger(length) && length > 0 && password.length < length)
    errors.push(`Password must contain at least ${length} characters.`);
  if (
    settings.SIMILAR_PASSWORD === '1' &&
    (/(.)\1\1/.test(password) || sequences.some((value) => password.includes(value)) || password.includes(userId))
  )
    errors.push('Avoid repeated characters, sequences, and the user ID in the password.');
  return errors;
}
export async function passwordStrength(
  db: pg.PoolClient,
  userId: string,
  password: string,
  key: string,
  oldEncrypted?: string,
): Promise<string[]> {
  if (!password) return [];
  const rows = (
    await db.query("SELECT com_name,com_value FROM mst_common WHERE com_key='PASSWORD_SETTING' ORDER BY com_index")
  ).rows;
  const settings: Record<string, string> = {};
  for (const row of rows) settings[row.com_name] ??= row.com_value;
  const errors = passwordRuleErrors(settings, userId, password);
  const count = Number(settings.ALLOW_SAME_PASSWORD_PREVIOUS);
  const encrypted = legacyPassword(userId, password, key);
  if (count === 1 && encrypted === oldEncrypted) errors.push('Do not reuse the previous password.');
  if (Number.isSafeInteger(count) && count > 1) {
    const history = await db.query(
      'SELECT password FROM history_user_password WHERE user_id=$1 ORDER BY sys_regist_time DESC LIMIT $2',
      [userId, count],
    );
    if (history.rows.some((row) => row.password === encrypted)) errors.push('Do not reuse a previous password.');
  }
  return errors;
}
