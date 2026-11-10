import type { Express, Request, Response } from 'express';
import type pg from 'pg';
import { base } from '../../../config/manager.js';
import { text as pageText } from '../../../config/manager/documents/resources.js';
import { documentPdfData, documentPdfView } from '../../../models/manager/documents/pdf.js';
import { renderDocumentPdf } from '../../../services/manager/documents/pdf.js';
import { currentMailLocale } from '../system/mail.js';
import { LabelValidationError } from '../../../models/manager/labels/index.js';
import { documentViewSource } from '../../../services/manager/documents.js';
import { requestFailure } from '../../../middleware/request-log.js';

export function registerDocumentPdf(app: Express, db: pg.Pool) {
  const failure = (res: Response, error: unknown) => {
    requestFailure(res, error);
    return res
      .status(
        error instanceof LabelValidationError
          ? error.field === 'access'
            ? 403
            : error.field === 'pending'
              ? 501
              : 400
          : 500,
      )
      .type('text/plain')
      .send(error instanceof LabelValidationError ? error.message : pageText['Server error has occurred.']);
  };
  const viewer = async (req: Request, res: Response) => {
    try {
      const { repTopId, defTopId, isLayer, isInitJudgeDisplay, isForciblyFontSize } = await documentPdfView(
        db,
        { ...req.query, ...req.body },
        req.session?.userId ?? '',
      );
      // The installed viewer embeds the whole report, omitting its sheet/cluster-display arguments.
      const preview = { repTopId, defTopId, isLayer, isInitJudgeDisplay, isForciblyFontSize };
      return res.render('manager/documents/pdf-view', { base, ...(await documentViewSource()), preview });
    } catch (error) {
      return failure(res, error);
    }
  };
  app.get(`${base}/Common/PdfViewReport`, viewer);
  app.post(`${base}/Common/PdfViewReport`, viewer);
  app.get(`${base}/InputReport/GetPdf`, async (req, res) => {
    try {
      const data = await documentPdfData(db, req.query, req.session?.userId ?? '', await currentMailLocale(db, req));
      return res
        .set('Cache-Control', 'no-store')
        .type('application/pdf')
        .send(await renderDocumentPdf(data));
    } catch (error) {
      return failure(res, error);
    }
  });
}
