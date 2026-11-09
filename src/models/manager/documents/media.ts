import { text as pageText } from '../../../config/manager/documents/resources.js';
import type pg from 'pg';
import { labelChecked, labelInteger, labelString, LabelValidationError } from '../labels/index.js';
import { irfdAttachments, irfdImageLocation, irfdImagePreview } from '../../../shared/irfd.js';
import { documentClusterPermissionQuery } from './clusters.js';
import { documentAdministratorId } from './details.js';

const reportAccess = `EXISTS (SELECT 1 FROM rep_role r JOIN mst_group_affiation a USING(group_id)
  WHERE r.rep_top_id=t.rep_top_id AND (r.role_rep_read>0 OR r.role_rep_update>0) AND a.user_id=$1)`;
export const documentMediaActions = [
  'GetRepTopName',
  'GetThumbnail',
  'GetInputValueImage',
  'GetRecordingValue',
  'GetLayerDraw',
  'GetHistoryImage',
  'GetFdPdf',
  'GetIrfdImage',
] as const;
export type DocumentMediaAction = (typeof documentMediaActions)[number];

export async function documentFdSheet(db: Pick<pg.Pool, 'query'>, input: Record<string, unknown>, user: string) {
  const repTopId = labelInteger(input.repTopId),
    fdSheetNo = labelInteger(input.fdSheetNo);
  const row = (
    await db.query(
      `SELECT t.rep_top_name,f.irfd_file FROM rep_top t LEFT JOIN rep_fd_sheet f ON f.top_id=t.rep_top_id AND f.fd_sheet_no=$3
    WHERE t.rep_top_id=$2 AND ${reportAccess}`,
      [user, repTopId, fdSheetNo],
    )
  ).rows[0];
  if (!row) return;
  const attachments = Buffer.isBuffer(row.irfd_file) ? irfdAttachments(row.irfd_file) : [];
  const images = [];
  for (const image of attachments.filter((image) => ['jpeg', 'png'].includes(image.format)))
    images.push({
      name: image.name,
      format: image.format,
      pageNumber: image.pageNumber,
      location: await irfdImageLocation(image.data),
    });
  return {
    repTopId,
    fdSheetNo,
    name: row.rep_top_name,
    images,
    texts: attachments.filter((image) => image.format === 'text').map((image) => image.data.toString('utf8')),
  };
}

export async function documentMedia(
  db: Pick<pg.Pool, 'query'>,
  action: DocumentMediaAction,
  input: Record<string, unknown>,
  user: string,
): Promise<{ data: string | Buffer; type: string; name?: string } | undefined> {
  const id = (name: string) => labelInteger(input[name]);
  const resize = labelChecked(input.isResize);
  let row: Record<string, unknown> | undefined;
  let signature = false,
    audio = false,
    download = false;
  if (action === 'GetRepTopName') {
    row = (
      await db.query(`SELECT t.rep_top_name AS name FROM rep_top t WHERE t.rep_top_id=$2 AND ${reportAccess}`, [
        user,
        id('repTopId'),
      ])
    ).rows[0];
    return row ? { data: String(row.name ?? ''), type: 'text/plain' } : undefined;
  }
  if (action === 'GetFdPdf' || action === 'GetIrfdImage') {
    const format = labelString(input.format);
    if (action === 'GetIrfdImage' && !['jpeg', 'png'].includes(format))
      throw new LabelValidationError('format', pageText['Invalid image format.']);
    row = (
      await db.query(
        `SELECT f.${action === 'GetFdPdf' ? 'pdf_file' : 'irfd_file'} AS data FROM rep_fd_sheet f
      JOIN rep_top t ON t.rep_top_id=f.top_id WHERE f.top_id=$2 AND f.fd_sheet_no=$3 AND ${reportAccess}`,
        [user, id('repTopId'), id('fdSheetNo')],
      )
    ).rows[0];
    if (!Buffer.isBuffer(row?.data)) return;
    if (action === 'GetFdPdf') return { data: row.data, type: 'application/pdf' };
    const page = id('pageNumber'),
      image = irfdAttachments(row.data).find(
        (image) =>
          image.pageNumber === page && image.format.toLowerCase() === format && image.name === labelString(input.name),
      );
    if (!image) return;
    const data = resize ? await irfdImagePreview(image.data) : image.data;
    return {
      data,
      type: resize && data !== image.data ? 'image/png' : 'image/' + format,
      name: image.name + '.' + format,
    };
  }
  if (action === 'GetThumbnail') {
    row = (
      await db.query(
        `SELECT s.input_image_file AS data FROM rep_sheet s JOIN rep_top t USING(rep_top_id)
      WHERE s.rep_top_id=$2 AND s.rep_sheet_id=$3 AND ${reportAccess}`,
        [user, id('repTopId'), id('repSheetId')],
      )
    ).rows[0];
  } else if (action === 'GetLayerDraw') {
    const type = labelString(input.type);
    if (!['layer', 'cluster'].includes(type)) throw new LabelValidationError('type', pageText['Invalid drawing type.']);
    row = (
      await db.query(
        `SELECT d.image_file AS data FROM rep_${type}_draw d JOIN rep_sheet s USING(rep_sheet_id)
      JOIN rep_top t USING(rep_top_id)
      ${type === 'cluster' ? `JOIN rep_cluster c ON c.rep_sheet_id=d.rep_sheet_id AND c.cluster_id=d.key_id CROSS JOIN LATERAL(${documentClusterPermissionQuery}) roles` : ''}
      WHERE d.rep_sheet_id=$2 AND d.key_id=$3 AND d.image_no=$4 AND ${reportAccess}
      ${type === 'cluster' ? 'AND ($1=$5 OR roles.refer OR NOT roles.none AND roles.edit)' : ''}`,
        [
          user,
          id('repSheetId'),
          id('layerId'),
          id('imageNo'),
          ...(type === 'cluster' ? [await documentAdministratorId()] : []),
        ],
      )
    ).rows[0];
    download = !resize;
  } else {
    const history = action === 'GetHistoryImage',
      imageType = labelString(input.imageType);
    if (history && !['0', '1', '2'].includes(imageType))
      throw new LabelValidationError('imageType', pageText['Invalid history image type.']);
    signature = history ? imageType === '1' : labelChecked(input.signFlg);
    audio = history ? imageType === '2' : action === 'GetRecordingValue';
    const column = audio ? 'recording_file' : signature ? 'approval_sign' : 'image_file';
    row = (
      await db.query(
        `SELECT c.${column} AS data,c.recording_file_extension AS extension FROM ${history ? 'history_rep_cluster' : 'rep_cluster'} c
       JOIN rep_sheet s USING(rep_sheet_id) JOIN rep_top t USING(rep_top_id)
       CROSS JOIN LATERAL(${documentClusterPermissionQuery}) roles
       WHERE ${history ? 'c.history_id=$2' : 'c.rep_sheet_id=$2 AND c.cluster_id=$3'} AND ${reportAccess}
       AND ($1=${history ? '$3' : '$4'} OR roles.refer OR NOT roles.none AND roles.edit)`,
        history
          ? [user, labelString(input.historyId), await documentAdministratorId()]
          : [user, id('repSheetId'), id('clusterId'), await documentAdministratorId()],
      )
    ).rows[0];
    download = history || audio || (!signature && !resize);
  }
  if (!row?.data) return;
  const original = signature && typeof row.data === 'string' ? Buffer.from(row.data, 'base64') : row.data;
  if (!Buffer.isBuffer(original) || !original.length) return;
  if (audio && !(action === 'GetHistoryImage' && resize)) {
    const extension = String(row.extension || 'm4a');
    return {
      data: original,
      type: extension === 'wav' ? 'audio/wav' : 'audio/mp4',
      name: `${action === 'GetHistoryImage' ? 'audio' : 'recording'}.${extension}`,
    };
  }
  const data =
    resize && action !== 'GetThumbnail' && (!signature || action === 'GetHistoryImage')
      ? await irfdImagePreview(original)
      : original;
  if (resize) download = false;
  const type = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? 'image/png'
    : data[0] === 255 && data[1] === 216
      ? 'image/jpeg'
      : 'image';
  return { data, type, ...(download ? { name: 'image.png' } : {}) };
}
