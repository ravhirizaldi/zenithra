import type pg from 'pg';
import { identifyClientApprover } from '../../client-catalog.js';
import { labelInteger, labelString, LabelValidationError } from '../labels/index.js';

export async function documentIdentificationRequired(db: Pick<pg.Pool, 'query'>, input: unknown, user: string) {
  const ids = labelString(input)
    .split(',')
    .map((id) => labelInteger(id));
  if (ids.some((id) => id <= 0)) throw new LabelValidationError('repTopIds', 'Select valid reports.');
  const rows = (
    await db.query(
      `SELECT a.use_identification FROM rep_top a WHERE a.rep_top_id=ANY($1::int[]) AND a.deleted=0
    AND EXISTS (SELECT 1 FROM rep_role r JOIN mst_group_affiation g USING(group_id)
      WHERE r.rep_top_id=a.rep_top_id AND (r.role_rep_read>0 OR r.role_rep_update>0) AND g.user_id=$2)`,
      [ids, user],
    )
  ).rows;
  if (rows.length !== new Set(ids).size)
    throw new LabelValidationError('repTopIds', 'A selected report is unavailable.');
  const mode = (
    await db.query(
      "SELECT com_value FROM mst_common WHERE com_key='IDENTIFICATION_SETTING' AND com_name='ENABLE_IDENTIFICATION' ORDER BY com_index LIMIT 1",
    )
  ).rows[0]?.com_value;
  return mode === '1' || (mode === '-1' && rows.some((row) => String(row.use_identification) === '1'));
}

export async function documentIdentify(db: Pick<pg.Pool, 'query'>, user: string, code: string) {
  return /<code>0<\/code>/.test(await identifyClientApprover(db, user, code));
}
