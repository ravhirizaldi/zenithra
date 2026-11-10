import type pg from 'pg';
import { documentAdministratorId, documentDetail, documentDetailId } from './details.js';
import { documentClusterPermissionQuery } from './clusters.js';
import { labelInteger, LabelValidationError } from '../labels/index.js';
import { text as pageText } from '../../../config/manager/documents/resources.js';

export function documentPdfOptions(input: Record<string, unknown>) {
  const flag = (name: string) => {
    const value = input[name];
    if (value === undefined || value === '') return false;
    if (typeof value !== 'string' || !/^(true|false)$/i.test(value))
      throw new LabelValidationError(name, pageText['Invalid PDF preview options.']);
    return value.toLowerCase() === 'true';
  };
  return {
    isLayer: flag('isLayer'),
    isInitJudgeDisplay: flag('isInitJudgeDisplay'),
    isForciblyFontSize: flag('isForciblyFontSize'),
    isClusterLine: flag('isClusterLine'),
  };
}

export async function documentPdfView(db: Pick<pg.Pool, 'query'>, input: Record<string, unknown>, user: string) {
  const scalar = (name: string) => {
    if (input[name] !== undefined && typeof input[name] !== 'string')
      throw new LabelValidationError(name, pageText['Invalid PDF preview options.']);
    return input[name];
  };
  const repTopId = documentDetailId(scalar('repTopId')),
    defTopId = documentDetailId(scalar('defTopId')),
    sheetNo = labelInteger(scalar('sheetNo'), -1),
    clusterId = labelInteger(scalar('clusterId'), -1),
    options = documentPdfOptions(input);
  if (sheetNo < -1 || clusterId < -1) throw new LabelValidationError('', pageText['Invalid PDF preview options.']);
  const report = await documentDetail(db, repTopId, user);
  if (!report || defTopId !== Number(report.def_top_id))
    throw new LabelValidationError('access', pageText['Role authority is insufficient.']);
  if (sheetNo !== -1) {
    const sheet = await db.query('SELECT 1 FROM rep_sheet WHERE rep_top_id=$1 AND rep_sheet_no=$2', [
      repTopId,
      sheetNo,
    ]);
    if (!sheet.rowCount) throw new LabelValidationError('sheetNo', pageText['Invalid page index.']);
  }
  return { repTopId, defTopId, sheetNo, clusterId, ...options };
}

export type PdfRow = Record<string, unknown>;
export type DocumentPdfData = {
  preview: Awaited<ReturnType<typeof documentPdfView>>;
  top: PdfRow;
  sheets: PdfRow[];
  clusters: PdfRow[];
  layers: PdfRow[];
  freeDraw: PdfRow[];
  history: PdfRow[];
  settings: Record<string, string>;
  locale: string;
};

export async function documentPdfData(db: pg.Pool, input: Record<string, unknown>, user: string, locale: string) {
  const client = await db.connect();
  try {
    // Authorization and every PDF input must describe the same report revision, without writes or locks.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const preview = await documentPdfView(client, input, user);
    const administrator = await documentAdministratorId();
    const top = (
      await client.query<PdfRow>(
        `SELECT t.background_image_file,t.display_sheet_number,t.rep_sheet_count,t.no_need_to_fill_type,
          t.use_init_input_judge_parameters,t.xml_data,o.pdf_fontsize_deduction,
          t.sys_regist_user,t.sys_update_user,COALESCE(r.user_name,'') AS regist_name,
          COALESCE(u.user_name,'') AS update_name,
          to_char(t.sys_regist_time,'YYYY-MM-DD HH24:MI:SS') AS regist_time,
          to_char(t.sys_update_time,'YYYY-MM-DD HH24:MI:SS') AS update_time
          FROM rep_top t LEFT JOIN rep_top_option o USING(rep_top_id)
          LEFT JOIN mst_user r ON r.user_id=t.sys_regist_user LEFT JOIN mst_user u ON u.user_id=t.sys_update_user
          WHERE t.rep_top_id=$1`,
        [preview.repTopId],
      )
    ).rows[0];
    if (!Buffer.isBuffer(top.background_image_file) || !top.background_image_file.length) {
      for (const table of ['def_top', 'def_top_backup']) {
        const row = (
          await client.query<PdfRow>(`SELECT background_image_file FROM ${table} WHERE def_top_id=$1`, [
            preview.defTopId,
          ])
        ).rows[0];
        if (Buffer.isBuffer(row?.background_image_file) && row.background_image_file.length) {
          top.background_image_file = row.background_image_file;
          break;
        }
      }
    }
    const sheets = (
      await client.query<PdfRow>(
        'SELECT rep_sheet_id,rep_sheet_no,COALESCE(sheet_no_org,rep_sheet_no) AS sheet_no_org FROM rep_sheet WHERE rep_top_id=$1 ORDER BY rep_sheet_no',
        [preview.repTopId],
      )
    ).rows;
    const clusters = (
      await client.query<PdfRow>(
        `SELECT c.rep_sheet_id,s.rep_sheet_no,c.cluster_id,c.cluster_type,c.input_parameter,
        c.left_position,c.top_position,c.right_position,c.bottom_position,c.input_value,c.display_value,
        c.image_file,c.approval_sign,c.verified,c.is_hidden,c.binary_file_type,
        COALESCE(length(c.binary_file),0) AS binary_file_length,
        COALESCE(length(c.binary_file_win),0) AS binary_file_length_win,
        COALESCE(length(c.recording_file),0) AS recording_file_length,
        c.approver||to_char(c.approver_date,'YYYYMMDDHH24MISS') AS input_approval_value,
        CASE WHEN $2=$3 THEN '1' WHEN NOT roles.refer AND (roles.none OR NOT roles.edit) THEN '2'
          WHEN roles.edit THEN '1' ELSE '0' END AS cluster_role
        FROM rep_cluster c JOIN rep_sheet s USING(rep_sheet_id)
        CROSS JOIN LATERAL(${documentClusterPermissionQuery.replaceAll('$1', '$2')}) roles
        WHERE s.rep_top_id=$1 AND ($4=-1 OR s.rep_sheet_no=$4) ORDER BY s.rep_sheet_no,c.cluster_id`,
        [preview.repTopId, user, administrator, preview.sheetNo],
      )
    ).rows;
    const layers = preview.isLayer
      ? (
          await client.query<PdfRow>(
            `SELECT s.rep_sheet_no,l.image_file FROM rep_layer l JOIN rep_sheet s USING(rep_sheet_id)
        WHERE s.rep_top_id=$1 AND l.layer_id=1 AND COALESCE(length(l.image_file),0)>0
        AND ($2=-1 OR s.rep_sheet_no=$2) ORDER BY s.rep_sheet_no,l.layer_id`,
            [preview.repTopId, preview.sheetNo],
          )
        ).rows
      : [];
    const freeDraw =
      preview.sheetNo === -1
        ? (
            await client.query<PdfRow>(
              'SELECT sheet_index,pdf_file FROM rep_fd_sheet WHERE top_id=$1 AND sheet_index>=1 ORDER BY sheet_index',
              [preview.repTopId],
            )
          ).rows
        : [];
    const history = preview.isInitJudgeDisplay
      ? (
          await client.query<PdfRow>(
            `SELECT h.rep_sheet_id,h.cluster_id,h.input_value,h.display_value,h.verified,h.init_history_input,
        COALESCE(length(h.image_file),0) AS image_file_length,
        COALESCE(length(h.binary_file),0) AS binary_file_length,
        COALESCE(length(h.binary_file_win),0) AS binary_file_length_win,h.binary_file_type,
        COALESCE(length(h.recording_file),0) AS recording_file_length,
        h.approver||to_char(h.approver_date,'YYYYMMDDHH24MISS') AS input_approval_value,h.history_type
        FROM history_rep_cluster h JOIN rep_sheet s USING(rep_sheet_id)
        WHERE s.rep_top_id=$1 AND ($2=-1 OR s.rep_sheet_no=$2) ORDER BY h.history_regist_time`,
            [preview.repTopId, preview.sheetNo],
          )
        ).rows
      : [];
    const settings = Object.fromEntries(
      (
        await client.query<{ com_name: string; com_value: string }>(
          `SELECT DISTINCT ON (com_name) com_name,com_value FROM mst_common WHERE
        (com_key='PDF_SETTING' AND com_name='FONT_FILE_PATH' AND COALESCE(com_locale,'')=$1)
        OR (com_key='OUTPUT_SETTING' AND com_name='PDF_FREE_DRAW_FORMAT')
        OR (com_key='CONMAS_FUNCTION' AND com_name='INITIAL_VALUE_CHANGE_DISPLAY_TYPE')
        ORDER BY com_name,com_index`,
          [locale],
        )
      ).rows.map((row) => [row.com_name, row.com_value]),
    );
    await client.query('COMMIT');
    return { preview, top, sheets, clusters, layers, freeDraw, history, settings, locale } satisfies DocumentPdfData;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
