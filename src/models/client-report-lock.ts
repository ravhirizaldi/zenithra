import type pg from 'pg';

// ReportBiz.GetReportData: either the report or the system can enable applicant locking.
export async function reportApplicantLocked(
  db: Pick<pg.Pool, 'query'>,
  id: number,
  user: string,
  copy = false,
): Promise<boolean> {
  return (
    (
      await db.query<{ locked: boolean }>(
        `SELECT (t.edit_refer_status<>4 OR $3::boolean)
    AND (t.use_applicant_lock=1 OR
      (SELECT com_value FROM mst_common WHERE com_key='IPAD_SETTING' AND com_name='USE_APPLICANT_LOCK' ORDER BY com_index LIMIT 1)='1')
    AND EXISTS(SELECT 1 FROM rep_cluster c JOIN rep_sheet s USING(rep_sheet_id)
      WHERE s.rep_top_id=t.rep_top_id AND c.cluster_type='Approve' AND c.input_value IN ('2','4')
      AND EXISTS(SELECT 1 FROM rep_cluster_role r WHERE r.rep_sheet_id=c.rep_sheet_id AND r.cluster_id=c.cluster_id)
      AND NOT EXISTS(SELECT 1 FROM rep_cluster_role r JOIN mst_group_affiation a USING(group_id)
        WHERE r.rep_sheet_id=c.rep_sheet_id AND r.cluster_id=c.cluster_id AND a.user_id=$2))
    AND ((SELECT com_value FROM mst_common WHERE com_key='IPAD_SETTING' AND com_name='APPLICANT_LOCK_TYPE' ORDER BY com_index LIMIT 1) IS DISTINCT FROM '1'
      OR NOT EXISTS(SELECT 1 FROM rep_cluster c JOIN rep_sheet s USING(rep_sheet_id)
        WHERE s.rep_top_id=t.rep_top_id AND c.cluster_type='Approve' AND
        (c.input_value='3' AND c.applicant=$2 OR c.input_value='2' AND
          (NOT EXISTS(SELECT 1 FROM rep_cluster_role r WHERE r.rep_sheet_id=c.rep_sheet_id AND r.cluster_id=c.cluster_id)
          OR EXISTS(SELECT 1 FROM rep_cluster_role r JOIN mst_group_affiation a USING(group_id)
            WHERE r.rep_sheet_id=c.rep_sheet_id AND r.cluster_id=c.cluster_id AND a.user_id=$2))))) AS locked
    FROM rep_top t WHERE rep_top_id=$1`,
        [id, user, copy],
      )
    ).rows[0]?.locked === true
  );
}
