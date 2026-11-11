import type pg from 'pg';
import { documentPdfInputs } from './pdf.js';
import { renderDocumentPdf } from '../../../services/manager/documents/pdf.js';
import { documentThumbnail } from '../../../services/manager/documents/thumbnail.js';

export async function documentRefreshThumbnail(
  db: Pick<pg.Pool, 'query'>,
  id: number,
  definition: number,
  user: string,
  locale: string,
) {
  if ((await db.query('SELECT 1 FROM rep_fd_sheet WHERE top_id=$1 AND sheet_index=1', [id])).rowCount) return;
  const data = await documentPdfInputs(
    db,
    { repTopId: String(id), defTopId: String(definition), sheetNo: '1', isLayer: 'true' },
    user,
    locale,
  );
  const pixels = Number(
    (
      await db.query(
        "SELECT com_value FROM mst_common WHERE com_key='PDF_SETTING' AND com_name='THUMBNAIL_PIXEL' ORDER BY com_index LIMIT 1",
      )
    ).rows[0]?.com_value,
  );
  const thumbnail = await documentThumbnail(await renderDocumentPdf(data), pixels);
  await db.query('UPDATE rep_top SET thumbnail_file=$2 WHERE rep_top_id=$1', [id, thumbnail]);
}
