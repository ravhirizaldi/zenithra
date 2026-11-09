import { text as pageText } from '../../../config/manager/documents/resources.js';
import type { Express, Request, Response } from 'express';
import type pg from 'pg';
import { base } from '../../../config/manager.js';
import type { RenderPage } from '../../../services/manager/page.js';
import { documentDetailScript, documentViewSource } from '../../../services/manager/documents.js';
import { requestFailure } from '../../../middleware/request-log.js';
import { directIsLinked } from '../system/direct.js';
import { webhookIsLinked } from '../system/webhook.js';
import { labelChecked, labelInteger, labelString, LabelValidationError } from '../../../models/manager/labels/index.js';
import {
  documentDetail,
  documentDetailId,
  documentDetailExternalTypes,
  documentDetailLabels,
  documentDetailRoles,
  documentDetailSheets,
  documentDetailUnlock,
  documentLabelSearch,
  documentSaveLabelChanges,
  documentSaveRoleChanges,
  type DocumentRole,
} from '../../../models/manager/documents/details.js';

declare module 'express-session' {
  interface SessionData {
    documentLabelDraft?: { id: number; changes: Record<string, boolean> };
    documentRoleDraft?: { id: number; changes: Record<string, DocumentRole> };
  }
}

const ajax = (req: Request) => req.get('X-Requested-With') === 'XMLHttpRequest';
const inputFor = (req: Request): Record<string, unknown> => ({ ...req.query, ...req.body });
const documentMode = (input: Record<string, unknown>) =>
  ['Rep', '0'].includes(labelString(input.mode ?? input.ReportMode)) &&
  [input.mode, input.ReportMode].every((value) => value === undefined || ['Rep', '0'].includes(labelString(value)));
function pageState(
  input: Record<string, unknown>,
  sizeField: string,
  indexField: string,
  total: number,
  fallback: number,
) {
  const size = labelInteger(input[sizeField], fallback),
    index = labelInteger(input[indexField], 0);
  if (size <= 0 || index < 0) throw new LabelValidationError('', pageText['Invalid page size or index.']);
  const pages = Math.ceil(total / size);
  return { size, index: Math.min(index, Math.max(0, pages - 1)), pages, total };
}
function roleFlag(value: unknown) {
  const text = labelString(value).toLowerCase();
  if (!['true', 'false'].includes(text)) throw new LabelValidationError('', pageText['Invalid permission value.']);
  return text === 'true';
}

export function registerDocumentDetails(app: Express, db: pg.Pool, page: RenderPage) {
  const failure = (res: Response, error: unknown) => {
    requestFailure(res, error);
    return res
      .status(error instanceof LabelValidationError ? (error.field === 'access' ? 403 : 400) : 500)
      .send(error instanceof LabelValidationError ? error.message : pageText['Server error has occurred.']);
  };
  app.get(`${base}/InputReport/Details`, async (req, res) => {
    try {
      const id = documentDetailId(req.query.repTopId),
        report = await documentDetail(db, id, req.session?.userId ?? '');
      if (!report) return res.status(403).send(pageText['Role authority is insufficient.']);
      const initPageIndex = labelString(req.query.pageIndex) ? labelInteger(req.query.pageIndex) : '';
      if (typeof initPageIndex === 'number' && initPageIndex < 0)
        throw new LabelValidationError('', pageText['Invalid page index.']);
      const controller = labelString(req.query.backController),
        action = labelString(req.query.backAction) || 'Index';
      if (controller && ![controller, action].every((value) => /^[A-Za-z][A-Za-z0-9]*$/.test(value)))
        throw new LabelValidationError('', pageText['Invalid return destination.']);
      const params = new URLSearchParams();
      for (const part of labelString(req.query.backRequestParam).split('&')) {
        const pair = part.split('=');
        if (pair.length === 2) params.append(pair[0], pair[1]);
      }
      const backHref = controller
        ? `${base}/${controller}${action === 'Index' ? '' : '/' + action}${params.size ? '?' + params : ''}`
        : `${base}/InputReport?act=BACK_INDEX`;
      const [source, sheets, directLinked, webhookLinked, external] = await Promise.all([
        documentViewSource(),
        documentDetailSheets(db, id),
        directIsLinked(db),
        webhookIsLinked(db),
        documentDetailExternalTypes(db, report.def_top_id),
      ]);
      return page(res, {
        active: 'InputReport',
        section: '',
        login: false,
        title: source.v.InputReportDetails_viewTitle,
        userName: req.session?.userName,
        documentPage: {
          ...source,
          view: 'details',
          report,
          sheets,
          directLinked,
          webhookLinked,
          externalTypes: external,
          backHref,
          initPageIndex,
          initDetailsFunction: labelString(req.query.initDetailsFunction),
          errorViewName: labelString(req.query.errorViewName),
          errorCode: labelString(req.query.errorCode),
          settings: res.locals.documentSettings,
          js: await documentDetailScript('Details', id, labelChecked(req.query.copyError)),
        },
      });
    } catch (error) {
      return failure(res, error);
    }
  });
  for (const view of ['DetailsLabel', 'DetailsRole'] as const)
    app.get(`${base}/InputReport/${view}`, async (req, res) => {
      try {
        const id = documentDetailId(req.query.repTopId),
          user = req.session?.userId ?? '';
        if (view === 'DetailsRole') {
          try {
            await documentDetailUnlock(db, user);
          } catch (error) {
            requestFailure(res, error);
          }
        }
        if (!ajax(req)) return res.send('');
        const report = await documentDetail(db, id, user);
        if (!report) return res.status(403).send(pageText['Role authority is insufficient.']);
        const rows =
          view === 'DetailsLabel'
            ? await documentDetailLabels(db, id, user)
            : (await documentDetailRoles(db, id)).filter((row) => row.assigned);
        return res.render('manager/documents/detail-settings', {
          base,
          ...(await documentViewSource()),
          report,
          rows,
          view,
          permissions: res.locals.documentPermissions,
          js: await documentDetailScript(view, id),
        });
      } catch (error) {
        return failure(res, error);
      }
    });
  const labels = async (req: Request, res: Response) => {
    if (!ajax(req)) return res.send('');
    const input = inputFor(req);
    if (!documentMode(input)) return res.status(503).send(pageText['This Forms mode has not been migrated.']);
    try {
      if (!res.locals.documentPermissions.update)
        return res.status(403).send(pageText['Role authority is insufficient.']);
      const id = documentDetailId(input.defTopId ?? input.def_top_id),
        user = req.session?.userId ?? '';
      const report = await documentDetail(db, id, user, true);
      if (!report) return res.status(403).send(pageText['Role authority is insufficient.']);
      if (!req.session) return res.status(503).send(pageText['A Manager session is required.']);
      if (req.method === 'GET') req.session.documentLabelDraft = { id, changes: {} };
      const draft = req.session.documentLabelDraft;
      if (!draft || draft.id !== id)
        throw new LabelValidationError('', pageText['Reopen the label editor before saving.']);
      const action = req.method === 'GET' ? '' : labelString(input.ActionCommonType);
      if (labelString(input.isCanceled)) {
        delete req.session.documentLabelDraft;
        return res.redirect(`${base}/InputReport/DetailsLabel?repTopId=${id}`);
      }
      if (!['', 'SearchType', 'CancelType', 'PageType', 'EditType', 'SaveType'].includes(action))
        return res.status(501).send(pageText['This label action has not been migrated. No changes were saved.']);
      if (action === 'SearchType' || action === 'CancelType') draft.changes = {};
      const search = await documentLabelSearch(db, id, user, input);
      const locked = !['', 'CancelType'].includes(action);
      const rows = locked ? search.labels : [];
      const paging = pageState(input, 'LabelSerach.PageSize', 'PageIndex', rows.length, 20);
      let error = '';
      try {
        if (action === 'EditType') {
          const selected = labelInteger(input.SaveLabelId),
            checked = roleFlag(input.IsSaveLabelType);
          if (selected !== -1 && !search.labels.some((row) => row.mst_label_id === selected))
            throw new LabelValidationError('', pageText['A selected label is unavailable.']);
          const selectedRows =
            selected === -1
              ? search.labels.slice(paging.index * paging.size, (paging.index + 1) * paging.size)
              : search.labels.filter((row) => row.mst_label_id === selected);
          for (const row of selectedRows) draft.changes[row.mst_label_id] = checked;
        }
        if (action === 'SaveType') {
          await documentSaveLabelChanges(db, id, draft.changes, user);
          delete req.session.documentLabelDraft;
          return res.redirect(`${base}/InputReport/DetailsLabel?repTopId=${id}`);
        }
      } catch (cause) {
        requestFailure(res, cause);
        if (cause instanceof LabelValidationError && cause.field === 'access') return failure(res, cause);
        res.status(cause instanceof LabelValidationError ? 400 : 500);
        error = cause instanceof LabelValidationError ? cause.message : 'Server error has occurred.';
      }
      return res.render('manager/documents/edit-labels', {
        base,
        ...(await documentViewSource()),
        report,
        ...search,
        ...paging,
        locked,
        error,
        rows: rows
          .slice(paging.index * paging.size, (paging.index + 1) * paging.size)
          .map((row) => ({ ...row, checked: draft.changes[row.mst_label_id] ?? row.checked })),
        csrfToken: res.locals.csrfToken ?? '',
        js: await documentDetailScript('EditLabel', id),
      });
    } catch (error) {
      return failure(res, error);
    }
  };
  app.get(`${base}/DefReport/EditLabel`, labels);
  app.post(`${base}/DefReport/EditLabel`, labels);
  const roles = async (req: Request, res: Response) => {
    if (!ajax(req)) return res.send('');
    const input = inputFor(req);
    if (!documentMode(input)) return res.status(503).send(pageText['This Forms mode has not been migrated.']);
    try {
      if (!res.locals.documentPermissions.update)
        return res.status(403).send(pageText['Role authority is insufficient.']);
      const id = documentDetailId(input.defTopId),
        user = req.session?.userId ?? '';
      const report = await documentDetail(db, id, user, true);
      if (!report) return res.status(403).send(pageText['Role authority is insufficient.']);
      if (!req.session) return res.status(503).send(pageText['A Manager session is required.']);
      if (req.method === 'GET') req.session.documentRoleDraft = { id, changes: {} };
      const draft = req.session.documentRoleDraft;
      if (!draft || draft.id !== id)
        throw new LabelValidationError('', pageText['Reopen the permission editor before saving.']);
      if (labelString(input.isCanceled)) {
        delete req.session.documentRoleDraft;
        return res.redirect(`${base}/InputReport/DetailsRole?repTopId=${id}`);
      }
      const action = req.method === 'GET' ? '' : labelString(input.ActionCommonType);
      if (!['', 'PageType', 'SaveType'].includes(action))
        return res.status(501).send(pageText['This permission action has not been migrated. No changes were saved.']);
      const all = await documentDetailRoles(db, id);
      const changes: Record<string, DocumentRole> = {};
      for (const key of Object.keys(input)) {
        const match = /^RolePages\[(\d+)\]\.group_id$/.exec(key);
        if (!match || labelString(input[`RolePages[${match[1]}].EditFlg`]) !== '1') continue;
        const group = labelInteger(input[key]);
        if (!all.some((row) => row.group_id === group))
          throw new LabelValidationError('', pageText['A selected group is unavailable.']);
        changes[group] = {
          read: roleFlag(input[`RolePages[${match[1]}].role_rep_read`]),
          update: roleFlag(input[`RolePages[${match[1]}].role_rep_update`]),
          delete: roleFlag(input[`RolePages[${match[1]}].role_rep_delete`]),
        };
      }
      const groupId = labelString(input['GroupSearchData.GroupId']),
        groupName = labelString(input['GroupSearchData.GroupName']);
      const rows = await documentDetailRoles(db, id, groupId ? labelInteger(groupId) : null, groupName);
      const settings = res.locals.documentSettings;
      const paging = pageState(input, 'PageData.PageSize', 'PageData.PageIndex', rows.length, settings.pageSize);
      Object.assign(draft.changes, changes);
      let error = '';
      if (action === 'SaveType') {
        try {
          await documentSaveRoleChanges(db, id, draft.changes, user);
          delete req.session.documentRoleDraft;
          return res.redirect(`${base}/InputReport/DetailsRole?repTopId=${id}`);
        } catch (cause) {
          requestFailure(res, cause);
          if (cause instanceof LabelValidationError && cause.field === 'access') return failure(res, cause);
          res.status(cause instanceof LabelValidationError ? 400 : 500);
          error = cause instanceof LabelValidationError ? cause.message : 'Server error has occurred.';
        }
      }
      return res.render('manager/documents/edit-roles', {
        base,
        ...(await documentViewSource()),
        report,
        settings,
        ...paging,
        error,
        groupId,
        groupName,
        rows: rows
          .slice(paging.index * paging.size, (paging.index + 1) * paging.size)
          .map((row) => ({ ...row, ...draft.changes[row.group_id] })),
        csrfToken: res.locals.csrfToken ?? '',
        js: await documentDetailScript('EditRole', id),
      });
    } catch (error) {
      return failure(res, error);
    }
  };
  app.get(`${base}/DefReport/EditRole`, roles);
  app.post(`${base}/DefReport/EditRole`, roles);
}
