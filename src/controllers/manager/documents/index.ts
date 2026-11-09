import { text as pageText } from '../../../config/manager/documents/resources.js';
import type { Express, Request, RequestHandler, Response } from 'express';
import type pg from 'pg';
import { randomBytes } from 'node:crypto';
import { registerDocumentMedia } from './media.js';
import { registerDocumentDetails } from './details.js';
import { registerDocumentContent } from './content.js';
import { licenseStatus } from '../../../shared/license-counts.js';
import { base } from '../../../config/manager.js';
import type { RenderPage } from '../../../services/manager/page.js';
import { documentTaskScript, documentViewSource } from '../../../services/manager/documents.js';
import { documentDelete } from '../../../models/manager/documents/lifecycle.js';
import { documentIdentificationRequired, documentIdentify } from '../../../models/manager/documents/identification.js';
import {
  documentTaskList,
  documentTaskPeople,
  documentTaskState,
  documentRegistTask,
} from '../../../models/manager/documents/tasks.js';
import {
  documentAppLaunch,
  documentLabels,
  documentLinkLabels,
  documentList,
  documentPermissions,
  documentSettings,
  documentState,
  type DocumentState,
} from '../../../models/manager/documents/index.js';
import {
  deleteLabel,
  flattenLabels,
  labelChecked,
  labelInput,
  labelInteger,
  labelPermissions,
  labelSettings,
  labelString,
  labelTree,
  LabelValidationError,
  saveLabel,
} from '../../../models/manager/labels/index.js';

declare module 'express-session' {
  interface SessionData {
    documentIndex?: DocumentState;
    documentLabelHidden?: boolean;
    documentApprovalIdentity?: { reports: string; token: string };
    documentTaskSearchAll?: boolean;
  }
}
const pending = 'This Documents action has not been migrated. No changes were saved.';
export function registerDocumentController(
  app: Express,
  db: pg.Pool | null,
  authEnabled: boolean,
  page: RenderPage,
  requireAuth: RequestHandler,
): void {
  const entry = [`${base}/`, `${base}/InputReport`, `${base}/InputReport/Index`];
  const common = `${base}/Common/LabelListView`;
  app.use(base, (req, res, next) => {
    if (
      req.path !== '/' &&
      req.path !== '/InputReport' &&
      !req.path.startsWith('/InputReport/') &&
      !['/DefReport/EditLabel', '/DefReport/EditRole'].includes(req.path) &&
      !['/Common/LabelListView', '/Common/TaskList', '/Common/RegistTask'].includes(req.path)
    )
      return next();
    return requireAuth(req, res, async (error) => {
      if (error) return next(error);
      try {
        if (!db) return res.status(503).send(pageText['Database is not configured.']);
        if (licenseStatus().freeDrawOnly)
          return res.status(403).send(pageText['Documents is unavailable with this license.']);
        if (authEnabled) {
          req.session.csrfToken ??= randomBytes(32).toString('hex');
          res.locals.csrfToken = req.session.csrfToken;
          if (
            !['GET', 'HEAD'].includes(req.method) &&
            labelString(req.body?.__RequestVerificationToken) !== req.session.csrfToken
          )
            return res.status(403).send(pageText['Invalid form verification token.']);
        }
        const settings = await documentSettings(db);
        const permissions = await documentPermissions(db, req.session?.userId ?? '', settings);
        if (!permissions.refer) return res.status(403).send(pageText['Role authority is insufficient.']);
        res.locals.documentSettings = settings;
        res.locals.documentPermissions = permissions;
        res.set('Cache-Control', 'no-store');
        return next();
      } catch (failure) {
        return next(failure);
      }
    });
  });
  const stateFor = (req: Request, res: Response, input: Record<string, unknown>) =>
    documentState(input, res.locals.documentSettings, req.session?.documentIndex);
  const renderIndex = async (req: Request, res: Response, labelError = '') => {
    const cookies = Object.fromEntries(
      (req.get('cookie') ?? '').split(';').map((item) => {
        const [key, ...value] = item.trim().split('=');
        return [key, value.join('=')];
      }),
    );
    const approval = cookies.ConMasCookie_ReportIndex_ApprovalStatusSelectedValue;
    const state = stateFor(req, res, labelError ? { act: 'BACK_INDEX' } : req.query);
    state.ApprovalStatus = ['-1', '0', '1', '2', '3'].includes(approval) ? approval : '-1';
    if (cookies.ConMasCookie_ReportIndex_IsLabelUnderSearch?.toUpperCase() === 'TRUE') state.IsLabelUnderSearch = true;
    const source = await documentViewSource();
    return page(res, {
      active: 'InputReport',
      section: '',
      login: false,
      title: source.v.viewTitleInputReportList,
      userName: req.session?.userName,
      documentPage: {
        ...source,
        state,
        settings: res.locals.documentSettings,
        permissions: res.locals.documentPermissions,
        hidden: req.session?.documentLabelHidden ?? false,
        copyDocuments: cookies.testCookies === '1',
        labelError,
        labelForm: labelError ? req.body : {},
      },
    });
  };
  app.get(entry, (req, res) => renderIndex(req, res));
  app.post(entry, async (req, res) => {
    const action = labelString(req.body.LabelAct);
    if (
      ![
        'LABEL_MANAGEMENT_ADD',
        'LABEL_MANAGEMENT_DELETE',
        'LABEL_MODE_CHANGE_NORMAL',
        'LABEL_MODE_CHANGE_HIDDEN',
      ].includes(action)
    )
      return res.status(501).send(pending);
    if (!req.session)
      return res.status(503).send(pageText['A Manager session is required for label display preferences.']);
    try {
      if (action === 'LABEL_MANAGEMENT_ADD' || action === 'LABEL_MANAGEMENT_DELETE') {
        const permissions = await labelPermissions(db!, req.session.userId ?? '');
        if (!permissions[action === 'LABEL_MANAGEMENT_ADD' ? 'create' : 'delete'])
          return res.status(403).send(pageText['Role authority is insufficient.']);
        const selected = labelString(req.body.LabelSelectID);
        const id = ['', 'All', 'NoLabel', 'Charge'].includes(selected) ? -1 : labelInteger(selected);
        if (action === 'LABEL_MANAGEMENT_ADD') {
          const quick = labelString(req.body.LabelCreateMode);
          if (!['0', '1'].includes(quick) || (quick === '1' && id <= 0))
            throw new LabelValidationError('LabelCreateMode', pageText['Invalid label creation mode.']);
          const record = labelInput(req.body, 'Rep');
          if (record.label_icon_id < 1 || record.label_icon_id > 10)
            throw new LabelValidationError('mst_label.label_icon_id', pageText['Invalid label icon.']);
          await saveLabel(db!, 'Rep', record, req.session.userId ?? '', { quick: quick as '0' | '1', base: id });
          req.session.documentLabelHidden = false;
        } else {
          if (id <= 0) throw new LabelValidationError('LabelSelectID', pageText['Select a label to delete.']);
          await deleteLabel(db!, 'Rep', id);
        }
      } else req.session.documentLabelHidden = action === 'LABEL_MODE_CHANGE_HIDDEN';
    } catch (error) {
      if (!(error instanceof LabelValidationError)) throw error;
      return renderIndex(req, res, error.message);
    }
    return res.redirect(`${base}/InputReport?act=BACK_INDEX`);
  });
  app.post(`${base}/InputReport/IndexList`, async (req, res) => {
    if (req.get('X-Requested-With') !== 'XMLHttpRequest') return res.send('');
    const action = labelString(req.body.Act);
    if (
      !['', 'PAGE', 'BACK_INDEX', 'LINK_LABEL', 'DELETE_REPORT', 'DELETE_RETURN_REPORT', 'DELETE_PHYSICAL'].includes(
        action,
      )
    )
      return res.status(501).send(pending);
    try {
      const state = stateFor(req, res, req.body);
      let wrongIds: string[] = [];
      if (action.startsWith('DELETE_')) {
        if (!res.locals.documentPermissions.delete)
          return res.status(403).send(pageText['Role authority is insufficient.']);
        wrongIds = await documentDelete(
          db!,
          req.body.ChkRepTopID,
          action,
          labelString(req.body.ActMode),
          req.session?.userId ?? '',
        );
      }
      if (action === 'LINK_LABEL') {
        if (!res.locals.documentPermissions.update)
          return res.status(403).send(pageText['Role authority is insufficient.']);
        await documentLinkLabels(
          db!,
          req.body.ChkRepTopID,
          req.body.ChkLinkLabelID,
          labelString(req.body.LinkLabelStatus),
          req.session?.userId ?? '',
        );
      }
      if (!['PAGE', 'BACK_INDEX', 'LINK_LABEL', 'APPROVE'].includes(action)) state.PageIndex = 0;
      const list = await documentList(db!, state, res.locals.documentSettings, req.session?.userId ?? '');
      if (req.session) req.session.documentIndex = list.state;
      const expires = new Date();
      expires.setMonth(expires.getMonth() + 1);
      res.cookie('ConMasCookie_ReportIndex_IsLabelUnderSearch', String(state.IsLabelUnderSearch), {
        path: base,
        expires,
        sameSite: 'lax',
      });
      res.cookie('ConMasCookie_ReportIndex_ApprovalStatusSelectedValue', state.ApprovalStatus, {
        path: base,
        expires,
        sameSite: 'lax',
      });
      return res.render('manager/documents/list', {
        base,
        ...(await documentViewSource()),
        ...list,
        settings: res.locals.documentSettings,
        wrongIds,
        appLaunch: await documentAppLaunch(
          db!,
          res.locals.documentSettings,
          req.session?.userId ?? '',
          req.get('User-Agent') ?? '',
        ),
      });
    } catch (error) {
      if (!(error instanceof LabelValidationError)) throw error;
      return res.status(400).send(error.message);
    }
  });
  const labelView = async (req: Request, res: Response) => {
    const input = { ...req.query, ...req.body };
    if (!['Rep', '0'].includes(labelString(input.reportMode ?? input.LabelReportMode) || 'Rep'))
      return res.status(501).send(pageText['This label navigation mode has not been migrated.']);
    const settings = await labelSettings(db!);
    const search = labelString(input.SearchNameLabelView);
    const rows = await documentLabels(
      db!,
      req.session?.userId ?? '',
      search,
      req.session?.documentLabelHidden ?? false,
    );
    const nodes = labelTree(rows, settings.nameSort),
      flat = flattenLabels(nodes),
      pages = Math.ceil(flat.length / settings.treePageSize);
    const index = Math.max(1, Math.min(Math.max(1, pages), labelInteger(input.LabelPageIndex, 1)));
    const visible = new Set(
      flat.slice((index - 1) * settings.treePageSize, index * settings.treePageSize).map((row) => row.mst_label_id),
    );
    const first = flat[(index - 1) * settings.treePageSize];
    if (first) for (const id of first.label_id_path.split('/')) visible.add(Number(id));
    return res.render('manager/documents/labels', {
      base,
      ...(await documentViewSource()),
      nodes,
      visible,
      index,
      pages,
      total: flat.length,
      search,
      lastCount: index === pages ? flat.length % settings.treePageSize : settings.treePageSize,
      allDisplay: labelString(input.isLabelAllDisplay).toLowerCase() !== 'false',
    });
  };
  app.get(common, labelView);
  app.post(common, labelView);
  app.post(`${base}/InputReport/GetIdentificationRequired`, async (req, res) => {
    if (req.get('X-Requested-With') !== 'XMLHttpRequest') return res.status(500).send('');
    if (!req.session) return res.status(503).send(pageText['A Manager session is required.']);
    delete req.session.documentApprovalIdentity;
    try {
      const required = await documentIdentificationRequired(db!, req.body.repTopIds, req.session.userId ?? '');
      const state = required ? '' : randomBytes(16).toString('hex');
      req.session.documentApprovalIdentity = { reports: labelString(req.body.repTopIds), token: state };
      return res.json({ required, state });
    } catch (error) {
      if (!(error instanceof LabelValidationError)) throw error;
      return res.status(400).send(error.message);
    }
  });
  app.post(`${base}/InputReport/Identification`, async (req, res) => {
    if (req.get('X-Requested-With') !== 'XMLHttpRequest') return res.status(500).send('');
    const identity = req.session?.documentApprovalIdentity;
    if (!identity) return res.json({ succeeded: false, state: '' });
    identity.token = '';
    const succeeded = await documentIdentify(db!, req.session.userId ?? '', labelString(req.body.identificationCode));
    const state = succeeded ? randomBytes(16).toString('hex') : '';
    identity.token = state;
    return res.json({ succeeded, state });
  });
  const taskList = async (req: Request, res: Response) => {
    try {
      return res.render('manager/documents/tasks', {
        base,
        csrfToken: res.locals.csrfToken,
        ...(await documentViewSource()),
        ...(await documentTaskList(db!, req.method === 'POST' ? req.body : req.query, res.locals.documentSettings)),
      });
    } catch (error) {
      if (!(error instanceof LabelValidationError)) throw error;
      return res.status(400).send(error.message);
    }
  };
  app.get(`${base}/Common/TaskList`, taskList);
  app.post(`${base}/Common/TaskList`, taskList);
  const registTask = async (req: Request, res: Response) => {
    try {
      if (!res.locals.documentPermissions.schedule)
        return res.status(403).send(pageText['Role authority is insufficient.']);
      const input = req.method === 'POST' ? req.body : req.query;
      if (
        (labelString(input.RequestKbn ?? input.requestKbn) || '0') !== '0' ||
        (labelString(input.ControllerName ?? input.controllerName) || 'InputReport') !== 'InputReport' ||
        labelInteger(input['SchData.schedule_id'] ?? input.scheduleId, -1) !== -1 ||
        labelChecked(input['SchData.report_type']) ||
        labelString(input.SelectDefTask)
      )
        return res.status(501).send(pageText['This task mode has not been migrated. No changes were saved.']);
      const state = documentTaskState(req.method === 'POST' ? input : {});
      if (req.method === 'GET') {
        const year = labelInteger(input.year, 0),
          month = labelInteger(input.month, 0),
          day = labelInteger(input.day, 0);
        if (year && month && day)
          state.record.start_date = `${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`;
        if (req.session) req.session.documentTaskSearchAll = false;
      }
      let error = '',
        errorField = 'SelectRepTask',
        closed: '0' | '2' = '0';
      try {
        const action = req.method === 'POST' ? labelString(input.SchAction) : '';
        if (!['', 'Submit', 'UserSearch', 'GroupSelect', 'Cancel'].includes(action))
          return res.status(501).send(pageText['This task action has not been migrated. No changes were saved.']);
        if (action === 'Submit') {
          if (await documentRegistTask(db!, state, req.session?.userId ?? '')) {
            const [year, month, day] = state.record.start_date.split(/[/-]/);
            return res.redirect(
              `${base}/Common/RegistTask?requestKbn=0&controllerName=InputReport&year=${year}&month=${month}&day=${day}`,
            );
          }
          closed = '2';
        }
        if (action === 'GroupSelect') {
          state.search = '';
          if (req.session) req.session.documentTaskSearchAll = false;
        }
        if (action === 'UserSearch' && req.session) req.session.documentTaskSearchAll = true;
        if (action === 'Cancel')
          return res.redirect(`${base}/Common/RegistTask?requestKbn=0&controllerName=InputReport`);
      } catch (failure) {
        if (!(failure instanceof LabelValidationError)) throw failure;
        const { r } = await documentViewSource();
        error = r[failure.message] ?? failure.message;
        errorField = failure.field || 'SelectRepTask';
      }
      return res.render('manager/documents/regist-task', {
        base,
        csrfToken: res.locals.csrfToken,
        ...(await documentViewSource()),
        state,
        error,
        errorField,
        ...(await documentTaskPeople(
          db!,
          state,
          req.session?.userId ?? '',
          req.method === 'GET',
          req.session?.documentTaskSearchAll,
        )),
        js: await documentTaskScript(closed),
        closed,
      });
    } catch (error) {
      if (!(error instanceof LabelValidationError)) throw error;
      return res.status(400).send(error.message);
    }
  };
  app.get(`${base}/Common/RegistTask`, registTask);
  app.post(`${base}/Common/RegistTask`, registTask);
  if (db) {
    registerDocumentDetails(app, db, page);
    registerDocumentContent(app, db);
    registerDocumentMedia(app, db);
  }
  app.use(`${base}/InputReport`, (_req, res) => res.status(501).send(pending));
}
