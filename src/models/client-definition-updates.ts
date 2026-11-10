import type pg from 'pg';
import { clientElement, clientError } from '../services/client-xml.js';

const lightInfo = `SELECT def_top_id,public_status,deleted,use_start_date,use_end_date,
  COALESCE(to_char(sys_update_time,'YYYY/MM/DD HH24:MI:SS'),'') AS update_date
  FROM def_top`;

// DefinitionBiz.GetDefinitionUpdateList: publication/current/validity rules differ from the definition list.
export async function getDefinitionUpdateList(
  db: Pick<pg.Pool, 'query'>,
  defTopIds: string,
  now = new Date(),
): Promise<string> {
  if (!defTopIds) return clientError(2);
  const requestedIds = defTopIds.split(',');
  if (requestedIds.some((id) => !/^[+-]?\d+$/.test(id.trim()) || Number(id) < -2147483648 || Number(id) > 2147483647))
    return clientError(-1, 'server error.');
  const rows = (
    await db.query(`${lightInfo} WHERE def_top_id=ANY($1::int[]) ORDER BY sys_update_time ASC`, [
      requestedIds.map(Number),
    ])
  ).rows;
  const tops: string[] = [],
    returned = new Set<string>();
  const deleted = (id: string) => {
    returned.add(id);
    tops.push(`<top>${clientElement('defTopId', id)}<deleted>1</deleted></top>`);
  };
  for (const requested of [
    ...rows.filter((row) => String(row.public_status) === '2'),
    ...rows.filter((row) => String(row.public_status) !== '2'),
  ]) {
    const id = String(requested.def_top_id),
      published = String(requested.public_status) === '2';
    const current = published
      ? (
          await db.query(
            `${lightInfo} WHERE public_status=2 AND def_top_id IN
              (SELECT def_top_id FROM def_current WHERE def_top_org=(SELECT def_top_org FROM def_top WHERE def_top_id=$1))
              ORDER BY sys_update_time ASC`,
            [requested.def_top_id],
          )
        ).rows
      : [requested];
    if (!current.length) deleted(id);
    for (const row of current) {
      if (published && !requested.update_date) throw new Error('Invalid definition update date.');
      let useDateType = 0,
        expired = false;
      if (published) {
        const start = row.use_start_date ? new Date(row.use_start_date) : null,
          end = row.use_end_date ? new Date(row.use_end_date) : null;
        // Legacy parses DateTime.ToString(), which drops stored fractional seconds.
        start?.setMilliseconds(0);
        end?.setSeconds(59, 0);
        if (!start && !end) useDateType = 1;
        else if (start && !end) {
          useDateType = 1;
          if (now < start) {
            const minute = new Date(now);
            minute.setSeconds(0, 0);
            const nextMinute = new Date(minute);
            nextMinute.setMinutes(nextMinute.getMinutes() + 1);
            const lastSecond = new Date(minute);
            lastSecond.setSeconds(59);
            const state = (
              await db.query(
                `SELECT (SELECT def_top_id FROM def_top
                  WHERE def_top_org=(SELECT def_top_org FROM def_top WHERE def_top_id=$1)
                    AND deleted=0 AND public_status=2
                    AND (use_start_date IS NULL OR use_start_date <= $2)
                    AND (use_end_date IS NULL OR use_end_date >= $3)
                  ORDER BY sys_update_time DESC,def_top_id DESC LIMIT 1) AS operation_id,
                  EXISTS (SELECT 1 FROM def_top top JOIN def_current cur ON cur.def_top_id=top.def_top_id
                    WHERE top.def_top_id=$1 AND top.public_status=2 AND top.use_start_date >= $4) AS reserved`,
                [requested.def_top_id, minute, lastSecond, nextMinute],
              )
            ).rows[0];
            if (String(state.operation_id ?? 0) === id) {
              if (state.reserved) expired = true;
              else useDateType = 0;
            }
          }
        } else if (!start && end) {
          expired = now > end;
          useDateType = expired ? 0 : 1;
        } else if (start && end) {
          // The source marks an IN-window two-bound definition deleted; do not invert this surprising rule.
          expired = now >= start && now <= end;
          useDateType = expired ? 1 : 0;
        }
      }
      returned.add(id);
      const date =
        published && String(requested.def_top_id) !== String(row.def_top_id) && String(requested.deleted) === '1'
          ? requested.update_date
          : row.update_date;
      tops.push(
        `<top>${clientElement('defTopId', id)}${clientElement('lastUpdateDate', date)}${clientElement('useDateType', useDateType)}${String(row.deleted) === '1' || expired ? '<deleted>1</deleted>' : ''}</top>`,
      );
    }
  }
  // Legacy only supplements missing IDs after at least one top was emitted.
  if (tops.length) for (const id of requestedIds) if (!returned.has(id)) deleted(id);
  return `<conmas><tops>${tops.join('')}</tops></conmas>`;
}
