import type pg from 'pg';
import sharp from 'sharp';
import { documentAdministratorId, documentDetail } from './details.js';
import { documentClusterPermissionQuery, documentHistoryColumns } from './clusters.js';
import { documentMedia } from './media.js';
import { labelInteger, labelString, LabelValidationError } from '../labels/index.js';
import { encodeExport } from '../system/data-export.js';
import { zipBuffer } from '../../../controllers/manager/system/files.js';
import { r } from '../../../config/manager/documents/resources.js';

type Database = Pick<pg.Pool, 'query'>;
export const documentHistoryHeaders = [
  ['sys_update_time', 'ServerLastUpdateDate'],
  ['sys_update_user', 'sys_update_info'],
  ['rep_sheet_no', 'rep_sheet_no'],
  ['rep_sheet_name', 'rep_sheet_name'],
  ['cluster_id', 'cluster_id'],
  ['cluster_name', 'cluster_name'],
  ['input_value', 'input_value'],
  ['edit_time', 'DatabaseResource_edit_time'],
  ['edit_user', 'DatabaseResource_edit_user'],
  ['GPS', 'DatabaseResource_GPS'],
  ['comment_value', 'DatabaseResource_comment'],
  ['change_reason', 'change_reason'],
] as const;

export function documentHistorySort(column: unknown, direction: unknown) {
  const sortColumn = labelString(column) || 'sys_update_time',
    sortDirection = labelString(direction) || 'ASC';
  if (!documentHistoryHeaders.some(([name]) => name === sortColumn) || !['ASC', 'DESC'].includes(sortDirection))
    throw new LabelValidationError('', 'Invalid history sort.');
  const selected =
    sortColumn === 'GPS'
      ? `h.gps_lat ${sortDirection},h.gps_lon`
      : ['rep_sheet_no', 'rep_sheet_name'].includes(sortColumn)
        ? `s.${sortColumn}`
        : `h.${sortColumn}`;
  return {
    sortColumn,
    sortDirection,
    order: `${selected} ${sortDirection}${sortColumn === 'sys_update_time' ? '' : ',h.sys_update_time'},s.rep_sheet_id,h.cluster_id`,
  };
}

export async function documentReportHistory(
  db: Database,
  id: number,
  user: string,
  input: Record<string, unknown>,
  all = false,
) {
  if (!(await documentDetail(db, id, user)))
    throw new LabelValidationError('access', 'Role authority is insufficient.');
  const sort = documentHistorySort(input['PageData.SortColumn'], input['PageData.SortDirection']);
  const common = (
    await db.query(
      "SELECT com_key,com_value FROM mst_common WHERE com_key IN ('DEFAULT_PAGE_SIZE','PAGE_SIZE') ORDER BY com_index",
    )
  ).rows;
  const defaultSize = labelInteger(common.find((row) => row.com_key === 'DEFAULT_PAGE_SIZE')?.com_value, 20);
  const size = labelInteger(input['PageData.PageSize'], defaultSize),
    requested = labelInteger(input['PageData.PageIndex'], 0);
  if (size <= 0 || requested < 0) throw new LabelValidationError('', 'Invalid page size or index.');
  const pageSizes = common
    .filter((row) => row.com_key === 'PAGE_SIZE')
    .map((row) => labelInteger(row.com_value))
    .filter((value) => value > 0);
  const from = `FROM history_rep_cluster h JOIN rep_sheet s USING(rep_sheet_id) LEFT JOIN mst_user u ON u.user_id=h.sys_update_user
    CROSS JOIN LATERAL(${documentClusterPermissionQuery.replaceAll('c.', 'h.')}) roles
    WHERE s.rep_top_id=$2 AND ($3=$1 OR roles.refer OR NOT roles.none AND roles.edit)`;
  const values: unknown[] = [user, id, await documentAdministratorId()];
  const total = Number((await db.query(`SELECT count(*)::integer AS total ${from}`, values)).rows[0]?.total ?? 0);
  const pages = Math.ceil(total / size),
    index = Math.min(requested, Math.max(0, pages - 1));
  const rows: Record<string, unknown>[] = (
    await db.query(
      `SELECT ${documentHistoryColumns},s.rep_sheet_no,s.rep_sheet_name ${from} ORDER BY ${sort.order}${all ? '' : ' LIMIT $4 OFFSET $5'}`,
      all ? values : [...values, size, index * size],
    )
  ).rows.map((row) => ({
    ...row,
    cluster_role: '0',
    summary_verified:
      Number(row.verified) === 1 &&
      (['FixedText', 'FreeText', 'Image', 'DrawingImage', 'FreeDraw'].includes(row.cluster_type)
        ? !row.has_image
        : !row.display_value || (row.cluster_type === 'Check' && String(row.display_value).toUpperCase() === 'FALSE')),
  }));
  return { ...sort, rows, total, pages, index, size, pageSizes: [...new Set([...pageSizes, size])] };
}

const historyFileName = (value: unknown) =>
  String(value ?? '')
    .replace(/[\\/:*?<>|"\r\n]/g, '_')
    .replaceAll(String.fromCharCode(0), '_');
export async function documentHistoryCsv(
  db: Database,
  id: number,
  user: string,
  input: Record<string, unknown>,
  locale: string,
) {
  const history = await documentReportHistory(db, id, user, input, true);
  const report = (await db.query('SELECT rep_top_name,no_need_to_fill_string FROM rep_top WHERE rep_top_id=$1', [id]))
    .rows[0];
  const encoding =
    (
      await db.query(
        "SELECT com_value FROM mst_common WHERE com_key='ENCODING' AND com_locale=$1 ORDER BY com_index LIMIT 1",
        [locale],
      )
    ).rows[0]?.com_value || '65001';
  if (!['65001', '932'].includes(encoding))
    throw new LabelValidationError('pending', 'This history CSV encoding has not been migrated.');
  const date = new Date(),
    entries: Array<{ name: string; data: Buffer; date: Date }> = [],
    lines: unknown[][] = [documentHistoryHeaders.map(([, label]) => r[label])];
  for (const row of history.rows) {
    let inputValue = String(row.input_value ?? '');
    const image =
      ['FixedText', 'FreeText', 'Image', 'DrawingImage', 'FreeDraw'].includes(String(row.cluster_type)) &&
      row.has_image;
    if (image || row.cluster_type === 'AudioRecording') {
      inputValue = '';
      if (image || row.has_recording) {
        const binary = await documentMedia(
          db,
          'GetHistoryImage',
          { historyId: row.history_id, imageType: image ? '0' : '2' },
          user,
        );
        if (!binary || !Buffer.isBuffer(binary.data))
          throw new LabelValidationError('access', 'History media is unavailable.');
        const extension = image ? (await sharp(binary.data).metadata()).format : row.recording_file_extension || 'm4a';
        if (!extension || !/^[A-Za-z0-9]+$/.test(String(extension)))
          throw new LabelValidationError('pending', 'History media format has not been migrated.');
        inputValue = `${historyFileName(row.history_id)}_${row.cluster_id}_${historyFileName(row.cluster_name)}.${extension}`;
        entries.push({ name: inputValue, data: binary.data, date });
      }
    } else if (
      Number(row.verified) === 1 &&
      (!inputValue || (row.cluster_type === 'Check' && inputValue.toUpperCase() === 'FALSE'))
    )
      inputValue = String(report.no_need_to_fill_string ?? '');
    lines.push([
      row.updated,
      `${row.sys_update_user ?? ''}:${row.updated_by ?? ''}`,
      String(row.rep_sheet_no),
      row.rep_sheet_name,
      String(row.cluster_id),
      row.cluster_name,
      inputValue,
      row.edit_time,
      `${row.edit_user ?? ''}:${row.edit_user_name ?? ''}`,
      `${row.gps_lat ?? ''}:${row.gps_lon ?? ''}:${row.gps_alt ?? ''}`,
      row.comment_value,
      row.change_reason,
    ]);
  }
  const text = lines
    .map((line) => line.map((value) => '"' + String(value ?? '').replaceAll('"', '""') + '"').join(',') + '\r\n')
    .join('');
  const csv = encodeExport((encoding === '65001' ? '\ufeff' : '') + text, 'csv', encoding);
  return {
    name: historyFileName(report.rep_top_name) + (entries.length ? '.zip' : '.csv'),
    type: entries.length ? 'application/zip' : 'text/csv',
    data: entries.length ? zipBuffer([{ name: 'download.csv', data: csv, date }, ...entries]) : csv,
  };
}
