import { text as pageText } from '../../../config/manager/documents/resources.js';
import type { Express, Request, Response } from 'express';
import type pg from 'pg';
import { base } from '../../../config/manager.js';
import { documentDetailScript, documentViewSource } from '../../../services/manager/documents.js';
import { requestFailure } from '../../../middleware/request-log.js';
import { documentDetail, documentDetailId, documentDetailUnlock } from '../../../models/manager/documents/details.js';
import { documentDelete, documentUnlock } from '../../../models/manager/documents/lifecycle.js';
import { documentPdfOptions } from '../../../models/manager/documents/pdf.js';
import { registerDocumentPdf } from './pdf.js';
import { documentInnerExcel } from '../../../models/manager/documents/excel.js';
import { documentManualNumber } from '../../../models/manager/documents/numbering.js';
import { documentApprove } from '../../../models/manager/documents/approval.js';
import { documentCopy } from '../../../models/manager/documents/copy.js';
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
  app.get(`${base}/InputReport/DownLoadInnerExcel`, async (req, res) => {
    try {
      if (!res.locals.documentPermissions.update)
        return res.status(403).send(pageText['Role authority is insufficient.']);
      const file = await documentInnerExcel(db, documentDetailId(req.query.repTopId), req.session?.userId ?? '');
      return res.attachment(file.name).type(file.type).send(file.data);
    } catch (error) {
      return failure(res, error);
    }
  });
  app.post(`${base}/InputReport/UploadInnerExcel`, async (req, res) => {
    let id: number;
    try {
      id = documentDetailId(req.body?.['rep_top.rep_top_id']);
    } catch (error) {
      return failure(res, error);
    }
    let code = 'Success';
    try {
      if (!res.locals.documentPermissions.update)
        throw new LabelValidationError('access', pageText['Role authority is insufficient.']);
      await documentInnerExcel(db, id, req.session?.userId ?? '', Array.isArray(req.files) ? req.files : []);
    } catch (error) {
      requestFailure(res, error);
      code =
        error instanceof LabelValidationError
          ? error.field === 'access'
            ? 'RoleError'
            : ['PatchExcelFileNotExists', 'PatchExcelNotExcelFile'].includes(error.field)
              ? error.field
              : 'Unknown'
          : 'Unknown';
    }
    return res.redirect(`${base}/InputReport/Details?repTopId=${id}&errorCode=${code}`);
  });
  app.post(`${base}/InputReport/UpdateAutoNumber`, async (req, res) => {
    try {
      const id = documentDetailId(req.body?.repTopId),
        definition = documentDetailId(req.body?.defTopId);
      await documentManualNumber(db, id, definition, req.session?.userId ?? '', await currentMailLocale(db, req));
      return res.redirect(`${base}/InputReport/DetailsTop?repTopId=${id}`);
    } catch (error) {
      return failure(res, error);
    }
  });
  app.post(`${base}/InputReport/CopyTop`, async (req, res) => {
    try {
      const id = await documentCopy(
        db,
        documentDetailId(req.body?.repTopId),
        req.session?.userId ?? '',
        await currentMailLocale(db, req),
      );
      return res.redirect(`${base}/InputReport/Details?repTopId=${id}`);
    } catch (error) {
      return failure(res, error);
    }
  });
  for (const edit of [false, true]) {
    const action = edit ? 'EditTop' : 'DetailsTop';
    const handler = async (req: Request, res: Response) => {
      const user = req.session?.userId ?? '';
      try {
        if (!edit && req.method === 'GET') await unlock(res, user);
        if (req.method === 'GET' && !ajax(req)) return res.send('');
        const input: Record<string, unknown> = { ...req.query, ...req.body };
        const previewOptions = documentPdfOptions(input);
        const id = documentDetailId(req.method === 'POST' ? input['rep_top.rep_top_id'] : input.repTopId);
        if ((edit || req.method === 'POST') && !res.locals.documentPermissions.update)
          return res.status(403).send(pageText['Role authority is insufficient.']);
        if (edit && labelString(input.isCanceled)) {
          await unlock(res, user);
          return res.redirect(`${base}/InputReport/DetailsTop?repTopId=${id}`);
        }
        const locale = await currentMailLocale(db, req);
        let model = await documentTop(db, id, user, locale),
          error = '',
          complete = false,
          forcedComplete = false,
          finishReason = String(model.report.finish_reason ?? '');
        if (edit && !model.report.role_update) return res.status(403).send(pageText['Role authority is insufficient.']);
        if (edit && req.method === 'GET' && !(await documentEditLock(db, id, user)))
          return res.redirect(`${base}/InputReport/DetailsTop?repTopId=${id}`);
        if (req.method === 'POST') {
          try {
            if (edit) await documentSaveTop(db, id, input, user, locale);
            else {
              const identity = req.session?.documentApprovalIdentity;
              if (
                labelString(input.approveEditStatus) === '4' &&
                (!identity?.token ||
                  identity.reports !== String(id) ||
                  identity.token !== labelString(input.approveIdentificationState))
              )
                throw new LabelValidationError('approveIdentificationState', 'Invalid Identification.');
              await documentApprove(
                db,
                id,
                documentDetailId(input.approveRepSheetId),
                labelInteger(input.approveClusterId),
                labelString(input.approveEditStatus),
                labelString(input.approveComment),
                user,
                locale,
              );
              if (req.session) delete req.session.documentApprovalIdentity;
            }
            await unlock(res, user);
            return res.redirect(`${base}/InputReport/DetailsTop?repTopId=${id}`);
          } catch (cause) {
            requestFailure(res, cause);
            if (cause instanceof LabelValidationError && cause.field === 'access') return failure(res, cause);
            res.status(errorStatus(cause));
            error = errorMessage(cause);
            complete = labelChecked(input.IsComplete);
            forcedComplete = labelChecked(input.IsCompleteSuperManager);
            model = await documentTop(db, id, user, locale);
            if (model.canForceComplete && Object.hasOwn(input, 'rep_top.finish_reason'))
              finishReason = labelString(input['rep_top.finish_reason']);
            for (const field of model.fields)
              if (field.editable && Object.hasOwn(input, 'rep_top.' + field.name)) {
                field.value = labelString(input['rep_top.' + field.name]);
                if (field.name === 'UseVoiceInputEndTime' && ['true', 'false'].includes(field.value.toLowerCase()))
                  field.value = field.value.toLowerCase() === 'true' ? '1' : '0';
              }
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
          complete,
          forcedComplete,
          finishReason,
          approvalDraft:
            !edit && req.method === 'POST'
              ? {
                  sheet: labelString(input.approveRepSheetId),
                  cluster: labelString(input.approveClusterId),
                  comment: labelString(input.approveComment).slice(0, 4000),
                }
              : undefined,
          excelErrorCode: [
            'Success',
            'RoleError',
            'PatchExcelFileNotExists',
            'PatchExcelNotExcelFile',
            'Unknown',
          ].includes(labelString(input.errorCode))
            ? labelString(input.errorCode)
            : '',
          permissions: res.locals.documentPermissions,
          csrfToken: res.locals.csrfToken,
          approvals: edit ? [] : await documentApprovalRows(db, id, user),
          previewOptions,
          js: await documentDetailScript(action, id),
        });
      } catch (error) {
        return failure(res, error);
      }
    };
    app.get(`${base}/InputReport/${action}`, handler);
    app.post(`${base}/InputReport/${action}`, handler);
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
          return res.status(403).send(pageText['Role authority is insufficient.']);
        if (edit && labelString(input.isCanceled)) {
          await unlock(res, user);
          return res.redirect(`${base}/InputReport/Details?repTopId=${id}&pageIndex=${pageIndex}`);
        }
        let model = await documentSheet(db, id, pageIndex, user, edit),
          error = '';
        if (edit && !model.report.role_update) return res.status(403).send(pageText['Role authority is insufficient.']);
        if (edit && req.method === 'GET' && !(await documentEditLock(db, id, user)))
          return res.redirect(`${base}/InputReport/DetailsSheet?repTopId=${id}&pageIndex=${pageIndex}`);
        if (req.method === 'POST') {
          try {
            await documentSaveSheetMetadata(
              db,
              id,
              pageIndex,
              input,
              user,
              await currentMailLocale(db, req),
              Array.isArray(req.files) ? req.files : [],
            );
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
                ['IsImageClear', 'is_image_clear'],
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
  app.post(`${base}/InputReport/Delete`, async (req, res) => {
    try {
      if (!res.locals.documentPermissions.delete)
        return res.status(403).send(pageText['Role authority is insufficient.']);
      const id = documentDetailId(req.body['rep_top.rep_top_id']),
        user = req.session?.userId ?? '',
        mode = labelString(req.body.actMode);
      if (!['REV', 'ALL', 'REVIVAL'].includes(mode))
        throw new LabelValidationError('actMode', pageText['Invalid document deletion mode.']);
      const report = await documentDetail(db, id, user);
      if (!report?.role_delete) throw new LabelValidationError('access', pageText['Role authority is insufficient.']);
      if (
        mode !== 'REVIVAL' &&
        (await db.query('SELECT 1 FROM rep_lock WHERE rep_top_id=$1 AND user_id<>$2', [id, user])).rowCount
      )
        return res.redirect(`${base}/InputReport/Details?repTopId=${id}`);
      await documentDelete(
        db,
        String(id),
        mode === 'REVIVAL' ? 'DELETE_RETURN_REPORT' : 'DELETE_REPORT',
        mode === 'REVIVAL' ? '' : mode,
        user,
      );
      return res.redirect(mode === 'REVIVAL' ? `${base}/InputReport/Details?repTopId=${id}` : `${base}/InputReport`);
    } catch (error) {
      return failure(res, error);
    }
  });
  app.post(`${base}/InputReport/UnLock`, async (req, res) => {
    try {
      if (!res.locals.documentPermissions.update)
        return res.status(403).send(pageText['Role authority is insufficient.']);
      const id = documentDetailId(req.body['rep_top.rep_top_id']);
      await documentUnlock(db, id, req.session?.userId ?? '');
      return res.redirect(`${base}/InputReport/Details?repTopId=${id}`);
    } catch (error) {
      return failure(res, error);
    }
  });
  registerDocumentPdf(app, db);
}
