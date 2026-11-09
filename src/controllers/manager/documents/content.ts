import type { Express, Request, Response } from 'express';
import type pg from 'pg';
import { base } from '../../../config/manager.js';
import { documentDetailScript, documentViewSource } from '../../../services/manager/documents.js';
import { requestFailure } from '../../../middleware/request-log.js';
import { documentDetailId, documentDetailUnlock } from '../../../models/manager/documents/details.js';
import {
  documentApprovalRows,
  documentEditLock,
  documentSaveTop,
  documentTop,
} from '../../../models/manager/documents/top.js';
import { documentSaveSheetMetadata, documentSheet } from '../../../models/manager/documents/sheet.js';
import { documentClusterHistory } from '../../../models/manager/documents/clusters.js';
import { labelChecked, labelInteger, labelString, LabelValidationError } from '../../../models/manager/labels/index.js';
import { ReportUnsupported } from '../../../models/client-reports.js';
import { currentMailLocale } from '../system/mail.js';
import { reportNotificationValues } from '../../../models/manager/common/notifications.js';
import {
  documentHistoryCsv,
  documentHistoryHeaders,
  documentReportHistory,
} from '../../../models/manager/documents/history.js';

const ajax = (req: Request) => req.get('X-Requested-With') === 'XMLHttpRequest';
const errorStatus = (error: unknown) =>
  error instanceof LabelValidationError
    ? error.field === 'access'
      ? 403
      : error.field === 'pending'
        ? 501
        : 400
    : error instanceof ReportUnsupported
      ? 501
      : 500;
const errorMessage = (error: unknown) =>
  error instanceof LabelValidationError
    ? error.message
    : error instanceof ReportUnsupported
      ? error.message + ' No changes were saved.'
      : 'Server error has occurred.';

export function registerDocumentContent(app: Express, db: pg.Pool) {
  const failure = (res: Response, error: unknown) => {
    requestFailure(res, error);
    return res.status(errorStatus(error)).send(errorMessage(error));
  };
  const unlock = async (res: Response, user: string) => {
    try {
      await documentDetailUnlock(db, user);
    } catch (error) {
      requestFailure(res, error);
    }
  };
  for (const edit of [false, true]) {
    const action = edit ? 'EditTop' : 'DetailsTop';
    const handler = async (req: Request, res: Response) => {
      const user = req.session?.userId ?? '';
      try {
        if (!edit) await unlock(res, user);
        if (req.method === 'GET' && !ajax(req)) return res.send('');
        const input: Record<string, unknown> = { ...req.query, ...req.body };
        const id = documentDetailId(req.method === 'POST' ? input['rep_top.rep_top_id'] : input.repTopId);
        if (edit && !res.locals.documentPermissions.update)
          return res.status(403).send('Role authority is insufficient.');
        if (edit && labelString(input.isCanceled)) {
          await unlock(res, user);
          return res.redirect(`${base}/InputReport/DetailsTop?repTopId=${id}`);
        }
        const locale = await currentMailLocale(db, req);
        let model = await documentTop(db, id, user, locale),
          error = '';
        if (edit && !model.report.role_update) return res.status(403).send('Role authority is insufficient.');
        if (edit && req.method === 'GET' && !(await documentEditLock(db, id, user)))
          return res.redirect(`${base}/InputReport/DetailsTop?repTopId=${id}`);
        if (req.method === 'POST') {
          try {
            await documentSaveTop(db, id, input, user, locale);
            await unlock(res, user);
            return res.redirect(`${base}/InputReport/DetailsTop?repTopId=${id}`);
          } catch (cause) {
            requestFailure(res, cause);
            if (cause instanceof LabelValidationError && cause.field === 'access') return failure(res, cause);
            res.status(errorStatus(cause));
            error = errorMessage(cause);
            model = await documentTop(db, id, user, locale);
            for (const field of model.fields)
              if (field.editable && Object.hasOwn(input, 'rep_top.' + field.name))
                field.value = labelString(input['rep_top.' + field.name]);
            for (const output of model.outputs)
              for (const field of output.fields) {
                const key = `rep_top.${output.name}.${field.name}`;
                if (Object.hasOwn(input, key)) field.checked = labelString(input[key]).toLowerCase() === 'true';
              }
            if (Object.hasOwn(input, 'rep_top_option.PdfFontSizeDeductionAmount'))
              model.fontDeduction = labelString(input['rep_top_option.PdfFontSizeDeductionAmount']);
            for (const notification of model.notifications)
              if (Object.hasOwn(input, 'rep_top.' + notification.name)) {
                try {
                  notification.value = reportNotificationValues(
                    input['rep_top.' + notification.name],
                    notification.multiple,
                  ).join(',');
                } catch {
                  /* Invalid posted shapes are not echoed into the form. */
                }
              }
          }
        }
        return res.render('manager/documents/top', {
          base,
          ...(await documentViewSource()),
          ...model,
          edit,
          error,
          permissions: res.locals.documentPermissions,
          csrfToken: res.locals.csrfToken,
          approvals: edit ? [] : await documentApprovalRows(db, id, user),
          js: await documentDetailScript(action, id),
        });
      } catch (error) {
        return failure(res, error);
      }
    };
    app.get(`${base}/InputReport/${action}`, handler);
    if (edit) app.post(`${base}/InputReport/${action}`, handler);
  }
  for (const edit of [false, true]) {
    const action = edit ? 'EditSheet' : 'DetailsSheet';
    const handler = async (req: Request, res: Response) => {
      const user = req.session?.userId ?? '';
      try {
        if (!edit) await unlock(res, user);
        if (req.method === 'GET' && !ajax(req)) return res.send('');
        const input: Record<string, unknown> = { ...req.query, ...req.body };
        const id = documentDetailId(req.method === 'POST' ? input['rep_sheets[0].rep_top_id'] : input.repTopId);
        const pageIndex = labelInteger(req.method === 'POST' ? input['rep_sheets.PageIndex'] : input.pageIndex, 0);
        if (edit && !res.locals.documentPermissions.update)
          return res.status(403).send('Role authority is insufficient.');
        if (edit && labelString(input.isCanceled)) {
          await unlock(res, user);
          return res.redirect(`${base}/InputReport/Details?repTopId=${id}&pageIndex=${pageIndex}`);
        }
        let model = await documentSheet(db, id, pageIndex, user, edit),
          error = '';
        if (edit && !model.report.role_update) return res.status(403).send('Role authority is insufficient.');
        if (edit && req.method === 'GET' && !(await documentEditLock(db, id, user)))
          return res.redirect(`${base}/InputReport/DetailsSheet?repTopId=${id}&pageIndex=${pageIndex}`);
        if (req.method === 'POST') {
          try {
            await documentSaveSheetMetadata(db, id, pageIndex, input, user);
            await unlock(res, user);
            return res.redirect(`${base}/InputReport/Details?repTopId=${id}&pageIndex=${pageIndex}`);
          } catch (cause) {
            requestFailure(res, cause);
            if (cause instanceof LabelValidationError && cause.field === 'access') return failure(res, cause);
            res.status(errorStatus(cause));
            error = errorMessage(cause);
            model = await documentSheet(db, id, pageIndex, user, edit);
            for (const name of [
              'rep_sheet_name',
              ...Array.from({ length: 10 }, (_, index) => 'sheet_remarks' + (index + 1)),
            ])
              if (Object.hasOwn(input, 'rep_sheets[0].' + name))
                model.sheet[name] = labelString(input['rep_sheets[0].' + name]);
            model.clusters.forEach((row, index) => {
              if (row.cluster_role !== '1') return;
              for (const name of [
                'input_value',
                'input_value_date',
                'input_value_time',
                'KeyboardValue',
                'comment_value',
                'ChangeReason',
              ]) {
                const key = `rep_clusters[${index}].${name}`;
                if (Object.hasOwn(input, key))
                  row[name === 'KeyboardValue' ? 'keyboardValue' : name === 'ChangeReason' ? 'change_reason' : name] =
                    labelString(input[key]);
              }
              for (const [name, field] of [
                ['IsKeyboardInput', 'isKeyboardInput'],
                ['Verified', 'verified'],
                ['input_check_value', 'input_check_value'],
              ]) {
                const key = `rep_clusters[${index}].${name}`;
                if (Object.hasOwn(input, key)) row[field] = labelChecked(input[key]);
              }
              if (Object.hasOwn(input, `rep_clusters[${index}].input_value`)) row.selected = row.input_value;
              const selected = input[`rep_clusters[${index}].multi_input_value`];
              if (typeof selected === 'string') row.multi_input_value = [selected];
              else if (Array.isArray(selected) && selected.every((value) => typeof value === 'string'))
                row.multi_input_value = selected;
            });
          }
        }
        return res.render('manager/documents/sheet', {
          base,
          ...(await documentViewSource()),
          ...model,
          edit,
          error,
          permissions: res.locals.documentPermissions,
          isLayer: labelChecked(input.isLayer),
          isInitJudgeDisplay: labelChecked(input.isInitJudgeDisplay),
          csrfToken: res.locals.csrfToken,
          js: await documentDetailScript(action, id),
        });
      } catch (error) {
        return failure(res, error);
      }
    };
    app.get(`${base}/InputReport/${action}`, handler);
    if (edit) app.post(`${base}/InputReport/${action}`, handler);
  }
  app.get(`${base}/InputReport/DetailsClusterHistory`, async (req, res) => {
    try {
      if (!ajax(req)) return res.send('');
      const id = documentDetailId(req.query.repTopId),
        pageIndex = labelInteger(req.query.pageIndex, 0),
        user = req.session?.userId ?? '';
      const model = await documentSheet(db, id, pageIndex, user),
        clusterId = labelInteger(req.query.clusterId);
      const history = await documentClusterHistory(db, id, user, Number(model.sheet.rep_sheet_id), clusterId);
      const eligible = model.clusters.filter((row) => row.cluster_role !== '2' && Number(row.history_count) > 1);
      return res.render('manager/documents/cluster-history', {
        base,
        ...(await documentViewSource()),
        ...model,
        clusterId,
        history,
        previousClusterId: eligible.filter((row) => Number(row.cluster_id) < clusterId).at(-1)?.cluster_id ?? -1,
        nextClusterId: eligible.find((row) => Number(row.cluster_id) > clusterId)?.cluster_id ?? -1,
        isLayer: labelChecked(req.query.isLayer),
        isInitJudgeDisplay: labelChecked(req.query.isInitJudgeDisplay),
        js: await documentDetailScript('DetailsClusterHistory', id),
      });
    } catch (error) {
      return failure(res, error);
    }
  });
  const reportHistory = async (req: Request, res: Response) => {
    try {
      const input: Record<string, unknown> = { ...req.query, ...req.body };
      const id = documentDetailId(req.method === 'POST' ? input['rep_top.rep_top_id'] : input.repTopId),
        user = req.session?.userId ?? '';
      return res.render('manager/documents/report-history', {
        base,
        ...(await documentViewSource()),
        ...(await documentTop(db, id, user)),
        ...(await documentReportHistory(db, id, user, input)),
        headers: documentHistoryHeaders,
        csrfToken: res.locals.csrfToken,
        js: await documentDetailScript('DetailsClusterHistoryTop', id),
      });
    } catch (error) {
      return failure(res, error);
    }
  };
  app.get(`${base}/InputReport/DetailsClusterHistoryTop`, reportHistory);
  app.post(`${base}/InputReport/DetailsClusterHistoryTop`, reportHistory);
  app.get(`${base}/InputReport/GetClusterHistoryTopCsv`, async (req, res) => {
    try {
      const result = await documentHistoryCsv(
        db,
        documentDetailId(req.query.repTopId),
        req.session?.userId ?? '',
        {
          'PageData.SortColumn': req.query.sortColumn,
          'PageData.SortDirection': req.query.sortDirection,
        },
        await currentMailLocale(db, req),
      );
      return res.attachment(result.name).type(result.type).send(result.data);
    } catch (error) {
      return failure(res, error);
    }
  });
  app.get(`${base}/InputReport/GetPdf`, async (req, res) => {
    try {
      const model = await documentTop(db, documentDetailId(req.query.repTopId), req.session?.userId ?? '');
      if (documentDetailId(req.query.defTopId) !== Number(model.report.def_top_id))
        throw new LabelValidationError('access', 'Role authority is insufficient.');
      return res.status(501).type('text/plain').send('Report PDF rendering has not been migrated.');
    } catch (error) {
      return failure(res, error);
    }
  });
}
