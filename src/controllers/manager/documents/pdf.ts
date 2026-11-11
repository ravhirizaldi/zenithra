import type { Express, Request, Response } from 'express';
import type pg from 'pg';
import { base } from '../../../config/manager.js';
import { text as pageText } from '../../../config/manager/documents/resources.js';
import { documentPdfData, documentPdfView } from '../../../models/manager/documents/pdf.js';
import { renderDocumentPdf } from '../../../services/manager/documents/pdf.js';
import { currentMailLocale } from '../system/mail.js';
import { labelString, LabelValidationError } from '../../../models/manager/labels/index.js';
import {
  documentDownloadName,
  documentDownloadCsv,
  documentDownloadDocuWorks,
} from '../../../models/manager/documents/output.js';
import { ReportUnsupported } from '../../../models/client-reports.js';
import { documentDetail, documentDetailId } from '../../../models/manager/documents/details.js';
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
          : error instanceof ReportUnsupported
            ? 501
            : 500,
      )
      .type('text/plain')
      .send(
        error instanceof LabelValidationError || error instanceof ReportUnsupported
          ? error.message
          : pageText['Server error has occurred.'],
      );
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
  app.get(`${base}/InputReport/DownLoadAction`, async (req, res) => {
    try {
      const id = documentDetailId(req.query.repTopId);
      const report = await documentDetail(db, id, req.session?.userId ?? '');
      if (!report) throw new LabelValidationError('access', pageText['Role authority is insufficient.']);
      const mode = labelString(req.query.downloadMode);
      const locale = await currentMailLocale(db, req);
      if (mode === 'csv') {
        const file = await documentDownloadCsv(db, id, req.session?.userId ?? '', locale);
        return res.attachment(file.name).type(file.type).send(file.data);
      }
      if (mode === 'xdw') {
        const file = await documentDownloadDocuWorks(db, id, req.session?.userId ?? '', locale);
        return res.attachment(file.name).type('application/vnd.fujixerox.docuworks').send(file.data);
      }
      if (mode !== 'pdf')
        throw new LabelValidationError(
          ['csv', 'csv2', 'excel', 'xdw'].includes(mode) ? 'pending' : 'downloadMode',
          pageText['This report download format has not been migrated.'],
        );
      // DownLoadAction's source signature does not bind isForciblyFontSize or per-sheet arguments.
      const data = await documentPdfData(
        db,
        {
          repTopId: req.query.repTopId,
          defTopId: String(report.def_top_id),
          isLayer: req.query.isLayer,
          isInitJudgeDisplay: req.query.isInitJudgeDisplay,
        },
        req.session?.userId ?? '',
        locale,
      );
      const name = await documentDownloadName(db, data.preview.repTopId, locale);
      return res
        .attachment(name + '.pdf')
        .type('application/pdf')
        .send(await renderDocumentPdf(data));
    } catch (error) {
      return failure(res, error);
    }
  });
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
