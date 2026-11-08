import type pg from 'pg';
import { clientError } from '../services/client-xml.js';
import { child, element, integer, root, serialize, value } from './client-definition-xml.js';

export async function getClientDownloadReportList(
  db: Pick<pg.Pool, 'query'>,
  userId: string,
  now = new Date(),
): Promise<string> {
  const settings = new Map<string, string>();
  for (const row of (
    await db.query("SELECT com_name,com_value FROM mst_common WHERE com_key='SCHEDULE_SETTING' ORDER BY com_index")
  ).rows) {
    if (!settings.has(row.com_name)) settings.set(row.com_name, row.com_value ?? '');
  }
  if (settings.get('AUTO_DOWNLOAD') !== '1')
    return clientError(-1, 'Auto-Download has been disabled in Common-Master.');
  const rangeType = settings.get('AUTO_DOWNLOAD_RANGE_TYPE')?.trim() ?? '';
  // Enum.TryParse accepts named/numeric values and comma-separated names even without Flags.
  const all = integer(rangeType) === 0 || rangeType.split(',').every((part) => part.trim() === 'All');
  const range = (direction: number) => {
    const name = direction < 0 ? 'PAST' : 'FUTURE';
    const amount = (unit: string) =>
      Math.max(0, integer(settings.get(`AUTO_DOWNLOAD_RANGE_${name}_${unit}`) ?? '') ?? 0);
    // DateTime arithmetic is local wall-clock arithmetic, not timezone/DST elapsed-time arithmetic.
    const date = new Date(0);
    date.setUTCFullYear(now.getFullYear(), now.getMonth(), now.getDate());
    date.setUTCHours(now.getHours(), now.getMinutes(), 0, 0);
    date.setTime(date.getTime() + direction * (amount('HOUR') * 60 + amount('MINUTE')) * 60000);
    if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999)
      throw new Error('Schedule range exceeds DateTime bounds.');
    return date.toISOString().slice(0, 19).replace('T', ' ');
  };
  const rows = (
    await db.query(
      `SELECT top.rep_top_id,top.xml_data FROM rep_top top JOIN rep_schedule sch ON sch.rep_top_id=top.rep_top_id
    WHERE top.public_status=2 AND top.edit_refer_status IN (0,1) AND top.deleted=0 AND sch.auto_download=1
      AND EXISTS (SELECT 1 FROM rep_schedule_user u WHERE u.schedule_id=sch.schedule_id AND u.user_id=$1)
      AND EXISTS (SELECT 1 FROM rep_role r WHERE r.rep_top_id=top.rep_top_id AND (r.role_rep_read=1 OR r.role_rep_update=1)
        AND EXISTS (SELECT 1 FROM mst_group_affiation a WHERE a.group_id=r.group_id AND a.user_id=$1))
      ${
        all
          ? ''
          : `AND CASE WHEN sch.start_date IS NULL THEN '-infinity'::TIMESTAMP
        WHEN sch.start_time IS NULL THEN DATE_TRUNC('day',sch.start_date)
        ELSE DATE_TRUNC('day',sch.start_date)+TO_TIMESTAMP(sch.start_time,'hh24:mi')::TIME END <= $2
      AND CASE WHEN sch.end_date IS NULL THEN 'infinity'::TIMESTAMP
        WHEN sch.end_time IS NULL THEN DATE_TRUNC('day',sch.end_date)+time '23:59'
        ELSE DATE_TRUNC('day',sch.end_date)+TO_TIMESTAMP(sch.end_time,'hh24:mi')::TIME END >= $3`
      }
    ORDER BY sch.start_date ASC,sch.start_time ASC,top.rep_top_id ASC`,
      all ? [userId] : [userId, range(1), range(-1)],
    )
  ).rows;
  const seen = new Set<number>(),
    reports = [];
  for (const row of rows) {
    const xml = root(String(row.xml_data));
    if (seen.has(row.rep_top_id)) continue;
    seen.add(row.rep_top_id);
    const top = child(xml, 'top'),
      lock = top && child(top, 'lockMode'),
      mobile = top && child(top, 'mobileReportSave');
    if (top && (!lock || value(lock) === '0') && (!mobile || value(mobile) === '1'))
      reports.push(element('report', [element('repTopId', String(row.rep_top_id))]));
  }
  return serialize(element('conmas', [element('reports', reports)]));
}
