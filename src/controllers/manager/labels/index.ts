import { text as pageText } from '../../../config/manager/labels/resources.js';
import type { Express, Request, RequestHandler, Response } from 'express';
import type pg from 'pg';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { base } from '../../../config/manager.js';
import { licenseStatus } from '../../../shared/license-counts.js';
import type { RenderPage } from '../../../services/manager/page.js';
import { requestFailure } from '../../../middleware/request-log.js';
import { documentPermissions, documentSettings } from '../../../models/manager/documents/index.js';
import {
  autoLabelItems,
  autoLabelLocale,
  deleteLabel,
  flattenLabels,
  labelChecked,
  labelGroups,
  labelInput,
  labelInteger,
  labelMode,
  labelModes,
  labelRecord,
  labelRows,
  labelSettings,
  labelString,
  labelTree,
  LabelValidationError,
  saveLabel,
  type LabelMode,
  type LabelPermissions,
  type LabelRecord,
} from '../../../models/manager/labels/index.js';

declare module 'express-session' {
  interface SessionData {
    labelRoleDraft?: { mode: LabelMode; id: number; roles: Record<string, boolean> };
  }
}

const ajax = (req: Request) => req.get('X-Requested-With') === 'XMLHttpRequest';
const defaults = (): LabelRecord => ({
  mst_label_id: 0,
  upper_label_id: null,
  label_name: '',
  label_name_path: '',
  label_id_path: '',
  label_icon_id: 1,
  label_remarks: '',
  diplay_number: 99,
  auto_delete: 0,
  auto_creation: 0,
  auto_label_name: '',
});

export function registerLabelController(
  app: Express,
  db: pg.Pool | null,
  authEnabled: boolean,
  page: RenderPage,
  requireAuth: RequestHandler,
): void {
  const paths = [`${base}/Label`, `${base}/Common/LabelManagerListView`, `${base}/Common/LabelSelectListView`];
  app.use(paths, requireAuth, async (req, res, next) => {
    if (!db) return res.status(503).send(pageText['Database is not configured.']);
    if (authEnabled) {
      req.session.csrfToken ??= randomBytes(32).toString('hex');
      res.locals.csrfToken = req.session.csrfToken;
      if (
        !['GET', 'HEAD'].includes(req.method) &&
        labelString(req.body?.__RequestVerificationToken) !== req.session.csrfToken
      )
        return res.status(403).send(pageText['Invalid form verification token.']);
    }
    if (!res.locals.labelPermissions?.refer) {
      const reportMode = labelString(req.query.reportMode ?? req.body?.reportMode ?? req.body?.LabelReportMode);
      const documentSelector =
        req.originalUrl.split('?')[0] === `${base}/Common/LabelSelectListView` && ['Rep', '0'].includes(reportMode);
      if (
        !documentSelector ||
        !(await documentPermissions(db, req.session?.userId ?? '', await documentSettings(db))).refer
      )
        return res.status(403).send(pageText['Role authority is insufficient.']);
    }
    return next();
  });
  if (!db) return;
  const data = async (req: Request, res: Response) => {
    const source = { ...req.query, ...(req.method === 'GET' ? {} : (req.body ?? {})) };
    const mode = labelMode(source.mode ?? source.reportMode ?? source.LabelReportMode);
    return {
      base,
      csrfToken: res.locals.csrfToken ?? '',
      mode,
      permissions: res.locals.labelPermissions as LabelPermissions,
      settings: await labelSettings(db),
      freeDrawOnly: licenseStatus().freeDrawOnly,
      modeTitle: labelModes[mode].title,
      source,
      error: '',
      record: defaults(),
      autoLabelItems,
      result: '',
    };
  };
  const full = (req: Request, res: Response, labelPage: Record<string, unknown>) =>
    page(res, {
      active: 'Label',
      section: '',
      login: false,
      title: pageText['Label Manager'],
      userName: req.session?.userName,
      labelPage,
    });
  const renderList = async (req: Request, res: Response, error = '') => {
    const state = await data(req, res);
    const rows = await labelRows(db, state.mode, req.session?.userId ?? '', '', true);
    return res.render('manager/labels/list', {
      ...state,
      error,
      rows: flattenLabels(labelTree(rows, state.settings.nameSort && ['Def', 'Rep'].includes(state.mode))).map(
        (row) => ({ ...row, auto_label_name: autoLabelLocale(row.auto_label_name ?? '', true) }),
      ),
    });
  };
  const formState = async (req: Request, res: Response, create: boolean, record: LabelRecord, error = '') => {
    const state = await data(req, res),
      groups = await labelGroups(db, state.mode, record.mst_label_id);
    const source = state.source;
    const draft = req.session?.labelRoleDraft;
    const roles = Object.fromEntries(groups.map((group) => [group.group_id, group.refer]));
    if (draft?.mode === state.mode && draft.id === record.mst_label_id) Object.assign(roles, draft.roles);
    if (req.method === 'POST' && !labelChecked(source.IsRoleNone)) {
      for (const key of Object.keys(source)) {
        const match = /^mst_label\.GroupRolePages\[(\d+)\]\.group_id$/.exec(key);
        if (!match) continue;
        const group = labelInteger(source[key]);
        if (Object.hasOwn(roles, group))
          roles[group] = labelChecked(source[`mst_label.GroupRolePages[${match[1]}].IsReferRole`]);
      }
      if (req.session) req.session.labelRoleDraft = { mode: state.mode, id: record.mst_label_id, roles };
    }
    const noRoles =
      req.method === 'POST'
        ? labelChecked(source.IsRoleNone)
        : (
            await db.query(`SELECT 1 FROM ${labelModes[state.mode].role} WHERE mst_label_id=$1 LIMIT 1`, [
              record.mst_label_id,
            ])
          ).rowCount === 0;
    const groupId = labelString(source['GroupSearchData.GroupId']),
      groupName = labelString(source['GroupSearchData.GroupName']);
    const selected = groups.filter(
      (group) =>
        (!groupId || group.group_id === labelInteger(groupId)) &&
        (!groupName.trim() || group.group_name_path.toLowerCase().includes(groupName.toLowerCase())),
    );
    const pageSize = Math.max(1, labelInteger(source['PageData.PageSize'], state.settings.pageSize));
    const pages = Math.max(1, Math.ceil(selected.length / pageSize)),
      pageIndex = Math.max(0, Math.min(pages - 1, labelInteger(source['PageData.PageIndex'], 0)));
    const parent =
      record.upper_label_id === null
        ? undefined
        : (
            await db.query<LabelRecord>(`SELECT * FROM ${labelModes[state.mode].table} WHERE mst_label_id=$1`, [
              record.upper_label_id,
            ])
          ).rows[0];
    const descendants = create
      ? []
      : (
          await db.query<{ label_name_path: string }>(
            `SELECT label_name_path FROM ${labelModes[state.mode].table}
      WHERE mst_label_id=$1 OR left(label_id_path,$2)=$3 ORDER BY label_name_path`,
            [record.mst_label_id, record.label_id_path.length + 1, record.label_id_path + '/'],
          )
        ).rows;
    return {
      ...state,
      create,
      record: { ...record, auto_label_name: autoLabelLocale(record.auto_label_name ?? '', true) },
      error,
      roles,
      noRoles,
      groups: selected
        .slice(pageIndex * pageSize, (pageIndex + 1) * pageSize)
        .map((group) => ({ ...group, refer: roles[group.group_id] })),
      pageIndex,
      pageSize,
      pages,
      groupId,
      groupName,
      parentName: parent?.label_name_path ?? '',
      deleteNames: descendants.map((row) => row.label_name_path).join('\n'),
    };
  };
  const getForm = async (req: Request, res: Response, create: boolean) => {
    if (!ajax(req)) return res.send('');
    const state = await data(req, res);
    if (!state.permissions[create ? 'create' : 'edit'])
      return res.status(403).send(pageText['Role authority is insufficient.']);
    const id = create ? 0 : labelInteger(req.query.id);
    if (req.session) req.session.labelRoleDraft = { mode: state.mode, id, roles: {} };
    const record = create
      ? defaults()
      : id === -1
        ? { ...defaults(), mst_label_id: -1 }
        : (await db.query<LabelRecord>(`SELECT * FROM ${labelModes[state.mode].table} WHERE mst_label_id=$1`, [id]))
            .rows[0];
    if (!record) return res.sendStatus(404);
    if (create && req.query.act === 'autoCreate' && state.mode === 'Rep') record.auto_creation = 1;
    return res.render('manager/labels/form', await formState(req, res, create, labelRecord(record)));
  };
  const postForm = async (req: Request, res: Response, create: boolean) => {
    const state = await data(req, res),
      source = state.source;
    const deleting = !create && source.act === 'DELETE_LABEL';
    if (!state.permissions[deleting ? 'delete' : create ? 'create' : 'edit'])
      return res.status(403).send(pageText['Role authority is insufficient.']);
    let record = defaults();
    try {
      record = labelInput(source, state.mode);
      if (!create) {
        const old = (
          await db.query<LabelRecord>(`SELECT * FROM ${labelModes[state.mode].table} WHERE mst_label_id=$1`, [
            record.mst_label_id,
          ])
        ).rows[0];
        if (!old) return res.sendStatus(404);
        record = {
          ...labelRecord(old),
          ...record,
          label_id_path: old.label_id_path,
          label_name_path: old.label_name_path,
          auto_creation: Number(old.auto_creation ?? 0),
          binder_rep_id: old.binder_rep_id,
        };
      }
      const form = await formState(req, res, create, record);
      if (!deleting && source.ActionCommonType === 'PageType') return res.render('manager/labels/form', form);
      if (deleting) await deleteLabel(db, state.mode, record.mst_label_id);
      else if (source.ActionCommonType === 'SaveType') {
        record.auto_label_name = autoLabelLocale(record.auto_label_name ?? '');
        await saveLabel(db, state.mode, record, req.session?.userId ?? '', {
          edit: !create,
          noRoles: form.noRoles,
          roles: form.roles,
          copy: create && state.mode === 'Def' && labelChecked(source['mst_label.IsRepCopy']),
        });
      } else if (source.ActionCommonType === 'CancelType') return res.redirect(`${base}/Label?mode=${state.mode}`);
      else throw new LabelValidationError('', pageText['Unknown action.']);
      if (req.session) delete req.session.labelRoleDraft;
      if (!create) return res.redirect(`${base}/Label/Edit?mode=${state.mode}&id=-1`);
      return res.render('manager/labels/form', { ...form, result: 'success' });
    } catch (error) {
      requestFailure(res, error);
      return res.render(
        'manager/labels/form',
        await formState(
          req,
          res,
          create,
          record,
          error instanceof LabelValidationError
            ? error.message
            : create
              ? 'Failed to register label.'
              : 'Failed to update label.',
        ),
      );
    }
  };
  app.get([`${base}/Label`, `${base}/Label/Index`], async (req, res) => {
    const state = await data(req, res);
    if (state.freeDrawOnly && state.mode !== 'ComLIb') return res.redirect(`${base}/Label?mode=ComLIb`);
    return full(req, res, { ...state, view: 'index' });
  });
  app.get(`${base}/Label/IndexList`, (req, res) => (ajax(req) ? renderList(req, res) : res.send('')));
  app.post(`${base}/Label/IndexList`, async (req, res) => {
    const state = await data(req, res),
      source = state.source;
    const action = source.LabelAct;
    if (!state.permissions[action === 'LABEL_MANAGEMENT_ADD' ? 'create' : 'delete'])
      return res.status(403).send(pageText['Role authority is insufficient.']);
    try {
      if (action === 'LABEL_MANAGEMENT_ADD') {
        const record = labelInput(source, state.mode);
        const quick = labelString(source.LabelCreateMode);
        if (quick !== '0' && quick !== '1') return res.sendStatus(400);
        await saveLabel(db, state.mode, record, req.session?.userId ?? '', {
          quick,
          base: labelInteger(source.LabelSelectID, -1),
          copy: labelChecked(source['mst_label.IsRepCopy']),
        });
      } else if (action === 'LABEL_MANAGEMENT_DELETE')
        await deleteLabel(db, state.mode, labelInteger(source.LabelSelectID));
      else return res.sendStatus(400);
      return res.redirect(
        `${base}/Label/IndexList?mode=${state.mode}&LabelPageIndex=${labelInteger(source.LabelPageIndexBackup, 1)}`,
      );
    } catch (error) {
      requestFailure(res, error);
      return renderList(
        req,
        res,
        error instanceof LabelValidationError ? error.message : 'Server error has been occurred.',
      );
    }
  });
  app.get(`${base}/Label/Details`, async (req, res) => {
    const state = await data(req, res);
    return full(req, res, {
      ...state,
      view: 'details',
      id: labelInteger(req.query.id, 0),
      act: labelString(req.query.act),
    });
  });
  app.get(`${base}/Label/Create`, (req, res) => getForm(req, res, true));
  app.post(`${base}/Label/Create`, (req, res) => postForm(req, res, true));
  app.get(`${base}/Label/Edit`, (req, res) => getForm(req, res, false));
  app.post(`${base}/Label/Edit`, (req, res) => postForm(req, res, false));
  app.post(`${base}/Label/Delete`, async (req, res) => {
    const state = await data(req, res);
    if (!state.permissions.delete) return res.status(403).send(pageText['Role authority is insufficient.']);
    await deleteLabel(db, state.mode, labelInteger(state.source.id));
    return res.redirect(`${base}/Label?mode=${state.mode}`);
  });
  app.post(`${base}/Label/unLockTable`, async (req, res) => {
    const actor = req.session?.userId ?? '';
    for (const table of ['rep_lock', 'document_lock']) {
      try {
        await db.query(`DELETE FROM ${table} WHERE user_id=$1 AND sys_regist_user=$1 AND sys_regist_term=$2`, [
          actor,
          hostname(),
        ]);
      } catch (error) {
        requestFailure(res, error);
      }
    }
    return res.send('');
  });
  const tree = async (req: Request, res: Response, select: boolean) => {
    const state = await data(req, res),
      source = state.source;
    const search = labelString(source[select ? 'SearchNameLabelSelectView' : 'SearchNameLabelView']);
    let rows = await labelRows(
      db,
      state.mode,
      req.session?.userId ?? '',
      search,
      false,
      labelChecked(source.excludeBinderLabel),
    );
    const excluded = labelString(source.conmasSelectLabelId);
    if (select && excluded) rows = rows.filter((row) => !row.label_id_path.split('/').includes(excluded));
    const nodes = labelTree(rows, state.settings.nameSort && ['Def', 'Rep'].includes(state.mode)),
      flat = flattenLabels(nodes);
    const size = state.settings.treePageSize,
      pages = Math.ceil(flat.length / size);
    const index = Math.max(
      1,
      Math.min(Math.max(1, pages), labelInteger(source[select ? 'LabelSelectPageIndex' : 'LabelPageIndex'], 1)),
    );
    const visible = new Set(flat.slice((index - 1) * size, index * size).map((node) => node.mst_label_id));
    const first = flat[(index - 1) * size];
    if (first) for (const ancestor of first.label_id_path.split('/')) visible.add(Number(ancestor));
    return res.render('manager/labels/tree', {
      ...state,
      select,
      nodes,
      visible,
      search,
      index,
      pages,
      total: flat.length,
      lastCount: index === pages ? flat.length % size : size,
      isLink: labelChecked(source.isLink),
      selectedId: labelString(source.SelectedId),
      inputType: ['button', 'checkbox', 'radio'].includes(labelString(source.InputType))
        ? labelString(source.InputType)
        : 'checkbox',
    });
  };
  for (const [name, select] of [
    ['LabelManagerListView', false],
    ['LabelSelectListView', true],
  ] as const) {
    app.get(`${base}/Common/${name}`, (req, res) => tree(req, res, select));
    app.post(`${base}/Common/${name}`, (req, res) => tree(req, res, select));
  }
}
