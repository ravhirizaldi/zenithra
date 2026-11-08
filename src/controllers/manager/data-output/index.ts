import type { Express, Request, RequestHandler, Response } from 'express';
import type pg from 'pg';
import { randomBytes } from 'node:crypto';
import { base } from '../../../config/manager.js';
import { licenseStatus } from '../../../shared/license-counts.js';
import { requestFailure } from '../../../middleware/request-log.js';
import type { RenderPage } from '../../../services/manager/page.js';
import {
  flattenLabels,
  labelChecked,
  labelInteger,
  labelRows,
  labelString,
  labelTree,
  LabelValidationError,
} from '../../../models/manager/labels/index.js';
import {
  LibraryError,
  LibraryPendingError,
  managerLibraryPermissions,
  managerTabAllowed,
} from '../../../models/manager/library/index.js';
import {
  outputAuthorize,
  outputCsvFiles,
  outputFieldLabels,
  outputLayoutInput,
  outputLayouts,
  outputLimits,
  outputList,
  outputSelection,
  outputSheetFields,
  outputTopFields,
  saveOutputLayout,
  type OutputKind,
  type OutputLayout,
} from '../../../models/manager/data-output/index.js';

type OutputState = {
  definitions: number[];
  reports: number[];
  layouts: OutputLayout[];
  defInput: Record<string, unknown>;
  repInput: Record<string, unknown>;
  auto: boolean;
};
declare module 'express-session' {
  interface SessionData {
    managerOutput?: OutputState;
  }
}
const source = (req: Request): Record<string, unknown> => ({
  ...req.query,
  ...(req.method === 'GET' ? {} : (req.body ?? {})),
});
export function registerManagerOutputController(
  app: Express,
  db: pg.Pool | null,
  authEnabled: boolean,
  page: RenderPage,
  requireAuth: RequestHandler,
) {
  app.use(`${base}/DataOutput`, requireAuth, async (req, res, next) => {
    if (!db) return res.status(503).send('Database is not configured.');
    if (
      !(await managerLibraryPermissions(db, req.session?.userId ?? '')).output ||
      !managerTabAllowed('DataOutput') ||
      licenseStatus().freeDrawOnly
    )
      return res.status(403).send('Role authority is insufficient.');
    if (authEnabled) {
      req.session.csrfToken ??= randomBytes(32).toString('hex');
      res.locals.csrfToken = req.session.csrfToken;
      if (
        !['GET', 'HEAD'].includes(req.method) &&
        labelString(req.body?.__RequestVerificationToken) !== req.session.csrfToken
      )
        return res.status(403).send('Invalid form verification token.');
    }
    req.session.managerOutput ??= {
      definitions: [],
      reports: [],
      layouts: [],
      defInput: {},
      repInput: {},
      auto: false,
    };
    return next();
  });
  if (!db) return;
  const state = (req: Request) => req.session.managerOutput!;
  const full = (req: Request, res: Response, data: Record<string, unknown>) =>
    page(res, {
      active: 'DataOutput',
      section: '',
      login: false,
      title: 'Data Output',
      userName: req.session.userName,
      outputPage: {
        base,
        csrfToken: res.locals.csrfToken ?? '',
        error: '',
        fieldLabels: outputFieldLabels,
        topFields: outputTopFields,
        sheetFields: outputSheetFields,
        ...data,
      },
    });
  const fail = (req: Request, res: Response, error: unknown) => {
    requestFailure(res, error);
    res.status(error instanceof LibraryPendingError ? 501 : error instanceof LabelValidationError ? 400 : 500);
    return full(req, res, {
      view: 'error',
      error: error instanceof LabelValidationError ? error.message : 'Server error has occurred.',
    });
  };
  const renderList = async (req: Request, res: Response, kind: OutputKind, partial = false) => {
    const selection = state(req),
      input = source(req),
      user = req.session.userId ?? '';
    const key = kind === 'def' ? 'defInput' : 'repInput',
      old = selection[key];
    const merged = ['BACK_INDEX', 'PAGE', 'NONE_SELECT', 'ALL_SELECTED', 'ALL_UNSELECTED'].includes(
      labelString(input.Act ?? input.act),
    )
      ? { ...old, ...input }
      : input;
    selection[key] = merged;
    const list = await outputList(
      db,
      kind,
      user,
      merged,
      selection.definitions,
      kind === 'def' ? selection.definitions : selection.reports,
    );
    const labels = flattenLabels(labelTree(await labelRows(db, kind === 'def' ? 'Def' : 'Rep', user), false));
    const data = {
      view: 'index',
      kind,
      input: merged,
      list,
      labels,
      selection,
      base,
      csrfToken: res.locals.csrfToken ?? '',
    };
    return partial ? res.render('manager/data-output/list', data) : full(req, res, data);
  };
  app.get([`${base}/DataOutput`, `${base}/DataOutput/Index`], async (req, res) => {
    try {
      if (!['BACK_INDEX', 'NONE_SELECT'].includes(labelString(req.query.act ?? req.query.Act)))
        req.session.managerOutput = {
          definitions: [],
          reports: [],
          layouts: [],
          defInput: {},
          repInput: {},
          auto: false,
        };
      return await renderList(req, res, 'def');
    } catch (error) {
      return fail(req, res, error);
    }
  });
  for (const [name, kind] of [
    ['IndexList', 'def'],
    ['RepIndexList', 'rep'],
  ] as const)
    app.post(`${base}/DataOutput/${name}`, async (req, res) => {
      try {
        const input = source(req),
          selection = state(req),
          key = kind === 'def' ? 'definitions' : 'reports';
        if (input.Act === 'ALL_UNSELECTED') selection[key] = [];
        else selection[key] = outputSelection(selection[key], input[kind === 'def' ? 'ChkDefTopID' : 'ChkRepTopID']);
        if (input.Act === 'ALL_SELECTED') {
          const list = await outputList(db, kind, req.session.userId ?? '', input, selection.definitions, [], true);
          selection[key] = list.rows.map((row) => row.id);
        }
        return await renderList(req, res, kind, true);
      } catch (error) {
        return fail(req, res, error);
      }
    });
  app.get(`${base}/DataOutput/NextDetails`, async (req, res) => {
    try {
      const selection = state(req);
      selection.definitions = outputSelection(selection.definitions, req.query.topIds);
      if (!selection.definitions.length) return res.redirect(`${base}/DataOutput?act=NONE_SELECT`);
      await outputAuthorize(db, 'def', selection.definitions, req.session.userId ?? '');
      selection.reports = [];
      selection.layouts = [];
      return res.redirect(`${base}/DataOutput/RepIndex`);
    } catch (error) {
      return fail(req, res, error);
    }
  });
  app.get(`${base}/DataOutput/RepIndex`, async (req, res) => {
    try {
      return await renderList(req, res, 'rep');
    } catch (error) {
      return fail(req, res, error);
    }
  });
  app.get(`${base}/DataOutput/NextSelectDetails`, async (req, res) => {
    try {
      const selection = state(req);
      selection.reports = outputSelection(selection.reports, req.query.topIds);
      if (!selection.reports.length) return res.redirect(`${base}/DataOutput/RepIndex?act=NONE_SELECT`);
      await outputAuthorize(db, 'rep', selection.reports, req.session.userId ?? '');
      await outputLimits(db, selection.reports.length);
      selection.layouts = await outputLayouts(db, selection.reports, req.session.userId ?? '');
      selection.auto = false;
      return res.redirect(`${base}/DataOutput/Details`);
    } catch (error) {
      return fail(req, res, error);
    }
  });
  const details = async (req: Request, res: Response) => {
    const selection = state(req);
    if (!selection.reports.length) return res.redirect(`${base}/DataOutput/RepIndex?act=NONE_SELECT`);
    const requested = labelInteger(source(req).requestTopId, -1),
      layout = selection.layouts.find((layout) => layout.org === requested) ?? selection.layouts[0];
    if (!layout) throw new LibraryError('', 'Select documents first.');
    await outputAuthorize(db, 'rep', selection.reports, req.session.userId ?? '');
    return full(req, res, { view: 'details', selection, layout });
  };
  app.get(`${base}/DataOutput/Details`, async (req, res) => {
    try {
      return await details(req, res);
    } catch (error) {
      return fail(req, res, error);
    }
  });
  app.post(`${base}/DataOutput/Details`, async (req, res) => {
    try {
      const input = source(req),
        selection = state(req),
        org = labelInteger(input['outputSelectData.defTopId']),
        actor = req.session.userId ?? '';
      const current = selection.layouts.find((layout) => layout.org === org);
      if (!current) throw new LibraryError('', 'Invalid output layout.');
      const action = labelString(input.act);
      if (action === 'BACK_INDEX') return res.redirect(`${base}/DataOutput/RepIndex?act=BACK_INDEX`);
      if (
        action === 'saveDefFieldAuto' ||
        action === 'saveDefFieldAutoClear' ||
        action === 'saveDefFieldAutoLoad' ||
        labelChecked(input.IsAutoOutput)
      )
        throw new LibraryPendingError(
          '',
          'Automatic-output configuration is not implemented yet. No settings were changed.',
        );
      const layout = outputLayoutInput(current, input);
      selection.layouts = selection.layouts.map((item) => (item.org === org ? layout : item));
      if (action === 'saveDefField' || action === 'saveDefFieldClear')
        await saveOutputLayout(db, layout, actor, false, action === 'saveDefFieldClear', selection.reports);
      if (action === 'saveDefFieldLoad' || action === 'saveDefFieldClear') {
        const loaded = await outputLayouts(db, selection.reports, actor);
        selection.layouts = selection.layouts.map((item) =>
          item.org === org ? loaded.find((layout) => layout.org === org)! : item,
        );
      }
      if (['link', 'saveDefField', 'saveDefFieldClear', 'saveDefFieldLoad'].includes(action))
        return res.redirect(`${base}/DataOutput/Details?requestTopId=${labelInteger(input.requestDefTopId, org)}`);
      if (action !== 'NEXT') throw new LibraryError('', 'Unknown output action.');
      return res.redirect(`${base}/DataOutput/Confirm`);
    } catch (error) {
      return fail(req, res, error);
    }
  });
  app.get(`${base}/DataOutput/Confirm`, async (req, res) => {
    try {
      const selection = state(req),
        result = await outputCsvFiles(db, selection.reports, selection.layouts, req.session.userId ?? '', 'en-US');
      return full(req, res, { view: 'confirm', selection, previews: result.previews });
    } catch (error) {
      return fail(req, res, error);
    }
  });
  app.post(`${base}/DataOutput/OutputCsv`, async (req, res) => {
    try {
      const selection = state(req),
        result = await outputCsvFiles(db, selection.reports, selection.layouts, req.session.userId ?? '', 'en-US');
      return res.attachment('tempZip.zip').type('application/zip').send(result.data);
    } catch (error) {
      return fail(req, res, error);
    }
  });
  app.get(`${base}/DataOutput/DetailInfo`, async (req, res) => {
    try {
      const kind = req.query.mode === 'rep' ? 'rep' : 'def',
        id = labelInteger(req.query.topId);
      await outputAuthorize(db, kind, [id], req.session.userId ?? '');
      const row = (
        await db.query(
          `SELECT ${kind}_top_id AS id,${kind}_top_name AS name,rev_no,public_status,sys_regist_user,sys_regist_time,sys_update_user,sys_update_time FROM ${kind}_top WHERE ${kind}_top_id=$1`,
          [id],
        )
      ).rows[0];
      return full(req, res, { view: 'info', row });
    } catch (error) {
      return fail(req, res, error);
    }
  });
  app.get(`${base}/DataOutput/GetThumbnail`, async (req, res) => {
    try {
      const kind = req.query.mode === 'rep' ? 'rep' : 'def',
        id = labelInteger(req.query.topId),
        sheet = labelInteger(req.query.sheetId);
      await outputAuthorize(db, kind, [id], req.session.userId ?? '');
      const row = (
        await db.query(`SELECT thumbnail_file FROM ${kind}_sheet WHERE ${kind}_top_id=$1 AND ${kind}_sheet_id=$2`, [
          id,
          sheet,
        ])
      ).rows[0];
      if (!row || !Buffer.isBuffer(row.thumbnail_file)) return res.sendStatus(404);
      return res.type('image/png').send(row.thumbnail_file);
    } catch (error) {
      return fail(req, res, error);
    }
  });
  // These supplied branches stay explicit failures until their persisted layout/row filtering contracts are ported.
  for (const name of ['NextCooperationView', 'CooperationViewList', 'CooperationViewDetail'] as const)
    app.get(`${base}/DataOutput/${name}`, (req, res) =>
      fail(
        req,
        res,
        new LibraryPendingError('', 'Cooperation-view output is not implemented yet. No changes were saved.'),
      ),
    );
  for (const name of ['CooperationViewList', 'CooperationViewDetail', 'CooperationViewFieldSetting'] as const)
    app.post(`${base}/DataOutput/${name}`, (req, res) =>
      fail(
        req,
        res,
        new LibraryPendingError(
          '',
          'Cooperation-view fields, filters, CSV/SQL and MotionBoard delivery are not implemented yet. No changes were saved.',
        ),
      ),
    );
}
