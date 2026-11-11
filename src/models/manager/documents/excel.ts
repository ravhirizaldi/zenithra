import type pg from 'pg';
import { readFile } from 'node:fs/promises';
import { documentDetail } from './details.js';
import { LabelValidationError } from '../labels/index.js';
import { r, text as pageText } from '../../../config/manager/documents/resources.js';

// InputReportRepository.DownloadExcel/PatchExcel modify the shared definition, retaining its first backup.
export async function documentInnerExcel(db: pg.Pool, id: number, user: string, files?: Express.Multer.File[]) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    if (!(await documentDetail(client, id, user, true)))
      throw new LabelValidationError('access', pageText['Role authority is insufficient.']);
    let uploaded: Buffer | undefined;
    if (files) {
      if (!files.length || !files[0].size)
        throw new LabelValidationError('PatchExcelFileNotExists', r.PatchExcelFileNotExists);
      if (files.length !== 1 || files[0].fieldname !== 'patchedExcel')
        throw new LabelValidationError('PatchExcelNotExcelFile', r.PatchExcelNotExcelFile);
      if (
        !['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel'].some(
          (type) => files[0].mimetype.startsWith(type),
        )
      )
        throw new LabelValidationError('PatchExcelNotExcelFile', r.PatchExcelNotExcelFile);
      uploaded = await readFile(files[0].path);
    }
    const row = (
      await client.query(
        `SELECT d.def_top_id,d.def_file,d.def_file_backup,d.def_file_type FROM rep_top t JOIN def_top d USING(def_top_id)
      WHERE t.rep_top_id=$1 FOR UPDATE OF d`,
        [id],
      )
    ).rows[0];
    if (!row || !['xls', 'xlsx'].includes(row.def_file_type))
      throw new LabelValidationError('excel', pageText['The internal Excel file is unavailable.']);
    const backup =
      Buffer.isBuffer(row.def_file_backup) && row.def_file_backup.length ? row.def_file_backup : row.def_file;
    if (!Buffer.isBuffer(backup) || !backup.length)
      throw new LabelValidationError('excel', pageText['The internal Excel file is unavailable.']);
    if (!Buffer.isBuffer(row.def_file_backup) || !row.def_file_backup.length)
      await client.query('UPDATE def_top SET def_file_backup=$2 WHERE def_top_id=$1', [row.def_top_id, backup]);
    if (uploaded) await client.query('UPDATE def_top SET def_file=$2 WHERE def_top_id=$1', [row.def_top_id, uploaded]);
    await client.query('COMMIT');
    return { data: backup, type: row.def_file_type as string, name: `def${row.def_top_id}.${row.def_file_type}` };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
