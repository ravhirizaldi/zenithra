import { text as pageText } from '../../../config/manager/documents/resources.js';
import type pg from 'pg';
import { hostname } from 'node:os';
import { labelInteger, labelString, LabelValidationError } from '../labels/index.js';
import { attachedAutoDeleteLabels, deleteEmptyReportLabels } from '../../client-report-labels.js';

type Report = {
  rep_top_id: number;
  rep_top_org: number;
  rep_top_name: string;
  deleted: string;
  readable: boolean;
  deletable: boolean;
  locked: boolean;
  current: boolean;
};

async function updateCurrent(client: pg.PoolClient, org: number) {
  const latest = (
    await client.query<{ rep_top_id: number }>(
      'SELECT rep_top_id FROM rep_top WHERE rep_top_org=$1 AND deleted=0 ORDER BY rev_no DESC,rep_top_id DESC LIMIT 1',
      [org],
    )
  ).rows[0];
  // The source retains the current pointer when no undeleted revision exists.
  if (!latest) return;
  await client.query('DELETE FROM rep_current WHERE rep_top_org=$1', [org]);
  await client.query('INSERT INTO rep_current (rep_top_org,rep_top_id) VALUES ($1,$2)', [org, latest.rep_top_id]);
}

export async function documentDelete(db: pg.Pool, input: unknown, action: string, mode: string, user: string) {
  if (!['DELETE_REPORT', 'DELETE_RETURN_REPORT', 'DELETE_PHYSICAL'].includes(action))
    throw new LabelValidationError('Act', pageText['Invalid document deletion action.']);
  if (!['', 'REV', 'ALL'].includes(mode) || (action !== 'DELETE_REPORT' && mode))
    throw new LabelValidationError('ActMode', pageText['Invalid document deletion mode.']);
  const ids = [
    ...new Set(
      labelString(input)
        .split(',')
        .map((id) => labelInteger(id)),
    ),
  ];
  if (ids.some((id) => id <= 0)) throw new LabelValidationError('ChkRepTopID', pageText['Select valid reports.']);
  const physical = action === 'DELETE_PHYSICAL',
    restore = action === 'DELETE_RETURN_REPORT',
    all = mode === 'ALL';
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const fields = `SELECT a.rep_top_id,a.rep_top_org,a.rep_top_name,a.deleted,
      EXISTS (SELECT 1 FROM rep_role r JOIN mst_group_affiation g USING(group_id)
        WHERE r.rep_top_id=a.rep_top_id AND r.role_rep_read>0 AND g.user_id=$2) AS readable,
      EXISTS (SELECT 1 FROM rep_role r JOIN mst_group_affiation g USING(group_id)
        WHERE r.rep_top_id=a.rep_top_id AND r.role_rep_delete=1 AND g.user_id=$2) AS deletable,
      EXISTS (SELECT 1 FROM rep_lock l WHERE l.rep_top_id=a.rep_top_id AND l.user_id<>$2) AS locked,
      EXISTS (SELECT 1 FROM rep_current c WHERE c.rep_top_id=a.rep_top_id) AS current FROM rep_top a`;
    const selected = (
      await client.query<Report>(
        `${fields} WHERE a.rep_top_id=ANY($1::int[]) ORDER BY array_position($1::int[],a.rep_top_id) FOR UPDATE OF a`,
        [ids, user],
      )
    ).rows;
    if (selected.length !== ids.length || selected.some((row) => !row.readable || !row.deletable))
      throw new LabelValidationError('ChkRepTopID', pageText['A selected report is unavailable or cannot be deleted.']);
    if (selected.some((row) => Number(row.deleted) !== (restore || physical ? 1 : 0)))
      throw new LabelValidationError('ChkRepTopID', pageText['A selected report is no longer in the requested list.']);
    // Delete skips another user's selected lock; restore does not run the source lock check.
    const eligible = action === 'DELETE_REPORT' ? selected.filter((row) => !row.locked) : selected;
    const reports = all
      ? (
          await client.query<Report>(
            `${fields} WHERE a.rep_top_org=ANY($1::int[])
            ORDER BY array_position($1::int[],a.rep_top_org),a.rev_no,a.rep_top_id FOR UPDATE OF a`,
            [[...new Set(eligible.map((row) => row.rep_top_org))], user],
          )
        ).rows
      : eligible;
    if (physical && reports.some((row) => row.locked))
      throw new LabelValidationError(
        'ChkRepTopID',
        pageText['A selected report revision is locked or cannot be deleted.'],
      );
    const autoMode = (
      await client.query(
        "SELECT com_value FROM mst_common WHERE com_key='LABEL_SETTING' AND com_name='LABEL_AUTO_DELETE_MODE' ORDER BY com_index LIMIT 1",
      )
    ).rows[0]?.com_value;
    const cleanup = !restore && (!autoMode || autoMode === '1');
    const failed: string[] = [];
    for (const report of reports) {
      if (physical) await client.query('SAVEPOINT report_delete');
      try {
        const labels = cleanup ? await attachedAutoDeleteLabels(client, report.rep_top_id) : [];
        await client.query(
          `UPDATE rep_top SET deleted=$2,sys_update_term=$3,sys_update_user=$4,
          sys_update_user_name=(SELECT user_name FROM mst_user WHERE user_id=$4),sys_update_time=CURRENT_TIMESTAMP
          WHERE rep_top_id=$1`,
          [report.rep_top_id, restore ? 0 : 1, hostname(), user],
        );
        if (physical) await client.query('DELETE FROM rep_lock WHERE rep_top_id=$1', [report.rep_top_id]);
        if (physical) await client.query('DELETE FROM rep_top WHERE rep_top_id=$1 AND deleted=1', [report.rep_top_id]);
        if (cleanup) await deleteEmptyReportLabels(client, labels);
        if (!physical) await client.query('DELETE FROM rep_lock WHERE rep_top_id=$1', [report.rep_top_id]);
        if (!all && (report.current || restore)) await updateCurrent(client, report.rep_top_org);
        if (physical) await client.query('RELEASE SAVEPOINT report_delete');
      } catch (error) {
        if (!physical) throw error;
        await client.query('ROLLBACK TO SAVEPOINT report_delete');
        await client.query('RELEASE SAVEPOINT report_delete');
        failed.push(`${report.rep_top_id}:${report.rep_top_name}`);
      }
    }
    await client.query('COMMIT');
    if (!physical && !all) {
      // Delete performs a second unlock transaction after committing, including on restore.
      await client.query('BEGIN');
      await client.query('DELETE FROM rep_lock WHERE rep_top_id=ANY($1::int[])', [
        eligible.map((row) => row.rep_top_id),
      ]);
      await client.query('COMMIT');
    }
    return failed;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
