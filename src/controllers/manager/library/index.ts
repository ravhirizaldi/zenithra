import type { Express, Request, RequestHandler, Response } from 'express';
import type pg from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, copyFile, readFile, rm } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join, basename } from 'node:path';
import sharp from 'sharp';
import { irfdAttachments, irfdImagePreview } from '../../../shared/irfd.js';
import { base } from '../../../config/manager.js';
import { licenseStatus } from '../../../shared/license-counts.js';
import multer from 'multer';
import { requestFailure } from '../../../middleware/request-log.js';
import type { RenderPage } from '../../../services/manager/page.js';
import {
  flattenLabels,
  labelChecked,
  labelInput,
  labelInteger,
  labelRows,
  labelTree,
  saveLabel,
  deleteLabel,
  LabelValidationError,
} from '../../../models/manager/labels/index.js';
import {
  changeLibraryDocuments,
  libraryBinary,
  libraryDocument,
  libraryGroups,
  libraryIds,
  libraryInput,
  libraryList,
  libraryMode,
  libraryModes,
  libraryReferenceTypes,
  libraryText,
  LibraryError,
  LibraryPendingError,
  managerLibraryPermissions,
  managerTabAllowed,
  saveLibraryDocument,
  libraryIrfdContent,
  type LibraryFile,
  type LibraryMode,
  type LibraryRoles,
} from '../../../models/manager/library/index.js';

declare module 'express-session' {
  interface SessionData {
    libraryDraft?: {
      mode: LibraryMode;
      id: number;
      directory?: string;
      files: LibraryFile[];
      roles: LibraryRoles;
      input: Record<string, unknown>;
    };
    libraryIndex?: Record<string, unknown>;
    librarySelection?: { mode: LibraryMode; ids: number[] };
  }
}
const source = (req: Request): Record<string, unknown> => ({
  ...req.query,
  ...(req.method === 'GET' ? {} : (req.body ?? {})),
});
async function clearDraft(req: Request) {
  const directory = req.session?.libraryDraft?.directory;
  if (req.session) delete req.session.libraryDraft;
  if (directory) await rm(directory, { recursive: true, force: true });
}
export function registerManagerLibraryController(
  app: Express,
  db: pg.Pool | null,
  authEnabled: boolean,
  page: RenderPage,
  requireAuth: RequestHandler,
) {
  app.use(`${base}/Library`, requireAuth, async (req, res, next) => {
    if (!db) return res.status(503).send('Database is not configured.');
    const permissions = await managerLibraryPermissions(db, req.session?.userId ?? '');
    res.locals.libraryPermissions = permissions;
    if (!permissions.refer || !managerTabAllowed('Library'))
      return res.status(403).send('Role authority is insufficient.');
    return next();
  });
  const uploads = multer({ dest: tmpdir(), limits: { fileSize: 100_000_000, files: 10, fields: 4000 } }).fields([
    { name: 'fileDocs', maxCount: 10 },
    { name: 'fileDocsLegacy', maxCount: 10 },
    ...Array.from({ length: 10 }, (_, i) => ({ name: 'file' + (i + 1), maxCount: 1 })),
  ]);
  app.use(`${base}/Library`, (req, res, next) => {
    if (!req.is('multipart/form-data')) return next();
    if (Number(req.headers['content-length']) > 1_000_000_000)
      return res.status(413).send('The upload exceeds the request size limit.');
    return uploads(req, res, (error) => {
      const files = Array.isArray(req.files) ? req.files : Object.values(req.files ?? {}).flat();
      const cleanup = () => {
        void Promise.all(files.map((file) => rm(file.path, { force: true }).catch(() => {})));
      };
      res.once('finish', cleanup);
      res.once('close', cleanup);
      if (error) {
        cleanup();
        return res.status(400).send('Invalid or oversized library upload.');
      }
      return next();
    });
  });
  app.use(`${base}/Library`, (req, res, next) => {
    if (authEnabled) {
      req.session.csrfToken ??= randomBytes(32).toString('hex');
      res.locals.csrfToken = req.session.csrfToken;
      if (
        !['GET', 'HEAD'].includes(req.method) &&
        libraryText(req.body?.__RequestVerificationToken) !== req.session.csrfToken
      )
        return res.status(403).send('Invalid form verification token.');
    }
    try {
      const mode = libraryMode(source(req).mode ?? source(req).Mode);
      if (licenseStatus().freeDrawOnly && mode === 'RepLIb')
        return res.status(403).send('Role authority is insufficient.');
      res.locals.libraryMode = mode;
    } catch {
      return res.status(400).send('Invalid library mode.');
    }
    return next();
  });
  if (!db) return;
  const state = async (req: Request, res: Response) => {
    const mode = res.locals.libraryMode as LibraryMode,
      user = req.session?.userId ?? '';
    const labels = flattenLabels(labelTree(await labelRows(db, mode, user), false));
    return {
      base,
      mode,
      user,
      permissions: res.locals.libraryPermissions,
      labels,
      input: source(req),
      csrfToken: res.locals.csrfToken ?? '',
      freeDrawOnly: licenseStatus().freeDrawOnly,
      error: '',
      referenceTypes: libraryReferenceTypes,
    };
  };
  const full = (req: Request, res: Response, data: Record<string, unknown>) =>
    page(res, {
      active: 'Library',
      section: '',
      login: false,
      title: 'Library',
      userName: req.session?.userName,
      libraryPage: data,
    });
  const fail = (res: Response, error: unknown) => {
    requestFailure(res, error);
    res.status(error instanceof LibraryPendingError ? 501 : error instanceof LabelValidationError ? 400 : 500);
    return error instanceof LabelValidationError ? error.message : 'Server error has occurred.';
  };
  const draftFor = async (req: Request, mode: LibraryMode, id: number) => {
    if (!req.session.libraryDraft || req.session.libraryDraft.mode !== mode || req.session.libraryDraft.id !== id) {
      await clearDraft(req);
      req.session.libraryDraft = { mode, id, files: [], roles: {}, input: {} };
    }
    return req.session.libraryDraft;
  };
  const renderIndex = async (req: Request, res: Response, error = '', partial = false) => {
    const data = await state(req, res),
      input = data.input;
    if (['BACK_INDEX', 'PAGE', 'LINK_LABEL'].includes(libraryText(input.Act ?? input.act)) && req.session.libraryIndex)
      data.input = { ...req.session.libraryIndex, ...input };
    if (data.mode === 'ImageLib') {
      if (req.method === 'GET' && data.input.IstTumbnail === undefined)
        data.input.IstTumbnail = /(?:^|;\s*)ConMasCookie_LibraryIndex_IstTumbnail=true(?:;|$)/i.test(
          req.get('Cookie') ?? '',
        )
          ? 'true'
          : 'false';
      if (req.method === 'POST')
        res.cookie('ConMasCookie_LibraryIndex_IstTumbnail', labelChecked(data.input.IstTumbnail) ? 'true' : 'false', {
          path: base + '/Library',
          maxAge: 31 * 24 * 60 * 60 * 1000,
          sameSite: 'lax',
        });
    }
    const list = await libraryList(db, data.mode, data.user, data.input);
    req.session.libraryIndex = { ...data.input, PageIndex: list.index, PageSize: list.size };
    const view = { ...data, view: 'index', list, error };
    return partial ? res.render('manager/library/list', view) : full(req, res, view);
  };
  const renderDetail = async (req: Request, res: Response, view = 'details', error = '') => {
    const data = await state(req, res),
      input = data.input,
      id = labelInteger(input.documentId ?? input['Document.document_id'], 0);
    const detailsMode = libraryText(input.detailsMode ?? input.DetailsMode) || 'Search',
      create = detailsMode === 'Create' || detailsMode === '1';
    const edit = detailsMode === 'Edit' || detailsMode === '2';
    if ((create && !data.permissions.create) || (edit && !data.permissions.edit))
      return res.status(403).send('Role authority is insufficient.');
    const document = create
      ? { document_id: 0, document_name: '', document_save_kbn: 0, document_mobile_save: 1, is_other_app_open: 1 }
      : await libraryDocument(db, data.mode, id, data.user, edit);
    if (!document) return res.status(404).send('Document is not accessible.');
    const draft = await draftFor(req, data.mode, create ? 0 : id);
    let item = document;
    if ((create || edit) && Object.keys(draft.input).length) {
      try {
        item = { ...document, ...libraryInput(draft.input) };
      } catch (validation) {
        if (!(validation instanceof LabelValidationError)) throw validation;
      }
    }
    const category = libraryModes[data.mode],
      fd = Number(document.document_save_kbn) === 2;
    const attached =
      Object.keys(draft.input).length && (create || edit)
        ? libraryIds(draft.input.LabelIds)
        : create
          ? []
          : (await db.query(`SELECT mst_label_id FROM ${category}_document_label WHERE document_id=$1`, [id])).rows.map(
              (row) => row.mst_label_id,
            );
    const groups = await libraryGroups(db, data.mode, id, fd);
    const roles: LibraryRoles = Object.fromEntries(
      groups.map((group) => [group.group_id, { read: group.read, edit: group.edit }]),
    );
    Object.assign(roles, draft.roles);
    const groupSearch = libraryText(input['GroupSearchData.GroupName']),
      groupId = libraryText(input['GroupSearchData.GroupId']);
    const filtered = groups.filter(
      (group) =>
        (!groupSearch || String(group.group_name_path).toLowerCase().includes(groupSearch.toLowerCase())) &&
        (!groupId || String(group.group_id) === groupId),
    );
    const size = Math.max(1, Math.min(1000, labelInteger(input['PageData.PageSize'], 20))),
      pages = Math.max(1, Math.ceil(filtered.length / size));
    const index = Math.max(0, Math.min(pages - 1, labelInteger(input['PageData.PageIndex'], 0)));
    let rows: Record<string, unknown>[] = [];
    if (view === 'log') rows = await libraryLog(db, id, input);
    return full(req, res, {
      ...data,
      view,
      error,
      document: item,
      create,
      edit,
      fd,
      attached,
      draft,
      roles,
      noRoles: input.IsRoleNone === undefined ? !groups.some((group) => group.read) : labelChecked(input.IsRoleNone),
      groups: filtered.slice(index * size, (index + 1) * size),
      groupSearch,
      groupId,
      size,
      index,
      pages,
      rows,
    });
  };
  app.get([`${base}/Library`, `${base}/Library/Index`], async (req, res) => {
    await clearDraft(req);
    return renderIndex(req, res);
  });
  app.post([`${base}/Library`, `${base}/Library/Index`], async (req, res) => {
    const input = source(req),
      mode = res.locals.libraryMode as LibraryMode;
    try {
      const permissions = res.locals.labelPermissions;
      if (input.LabelAct === 'LABEL_MANAGEMENT_ADD') {
        if (!permissions?.create) return res.status(403).send('Role authority is insufficient.');
        const quick = libraryText(input.LabelCreateMode);
        if (quick !== '0' && quick !== '1') return res.sendStatus(400);
        await saveLabel(db, mode, labelInput(input, mode), req.session.userId ?? '', {
          quick,
          base: labelInteger(input.LabelSelectID, -1),
        });
      } else if (input.LabelAct === 'LABEL_MANAGEMENT_DELETE') {
        if (!permissions?.delete) return res.status(403).send('Role authority is insufficient.');
        await deleteLabel(db, mode, labelInteger(input.LabelSelectID));
      } else return res.status(400).send('Unknown action.');
      return res.redirect(`${base}/Library?mode=${mode}&Act=BACK_INDEX`);
    } catch (error) {
      return renderIndex(req, res, fail(res, error));
    }
  });
  app.post(`${base}/Library/IndexList`, async (req, res) => {
    try {
      const input = source(req),
        mode = res.locals.libraryMode as LibraryMode;
      if (input.Act === 'DELETE_DOCUMENT' || input.Act === 'LINK_LABEL')
        await changeLibraryDocuments(
          db,
          mode,
          libraryIds(input.ChkDefTopID),
          req.session.userId ?? '',
          input.Act === 'DELETE_DOCUMENT' ? 'delete' : 'labels',
          {
            labels: libraryIds(input.ChkLinkLabelID),
            remove: input.LinkLabelStatus === 'delete',
          },
        );
      return renderIndex(req, res, '', true);
    } catch (error) {
      return renderIndex(req, res, fail(res, error), true);
    }
  });
  app.get(`${base}/Library/Details`, async (req, res) => {
    if (labelChecked(req.query.isFirst)) await clearDraft(req);
    return renderDetail(req, res);
  });
  app.post(`${base}/Library/Details`, async (req, res) => {
    try {
      const input = source(req),
        mode = res.locals.libraryMode as LibraryMode,
        id = labelInteger(input['Document.document_id'], 0);
      const create = ['Create', '1'].includes(libraryText(input.DetailsMode)),
        actor = req.session.userId ?? '';
      if (!res.locals.libraryPermissions[create ? 'create' : 'edit'])
        return res.status(403).send('Role authority is insufficient.');
      if (!create && !(await libraryDocument(db, mode, id, actor, true)))
        return res.status(403).send('Role authority is insufficient.');
      if (input.act === 'EDIT_CANCEL') {
        await clearDraft(req);
        return res.redirect(`${base}/Library?mode=${mode}&Act=BACK_INDEX`);
      }
      const draft = await draftFor(req, mode, create ? 0 : id);
      draft.input = input;
      if (input.act === 'REVERT_INEDITING' || input.act === 'UNLOCK') {
        // FreeDraw state transitions need their original lock/concurrency contract, not an ordinary metadata update.
        throw new LibraryPendingError(
          '',
          'FreeDraw lock/state transitions are not implemented yet. No changes were saved.',
        );
      }
      if (
        ['ACT_SELECT_DEF', 'ACT_SELECT_REP', 'DELETE_DEF_REPORT', 'DELETE_REP_REPORT'].includes(libraryText(input.act))
      )
        throw new LibraryPendingError(
          '',
          'Linked form/document selection is not implemented yet. No changes were saved.',
        );
      if (input.act === 'FILE_DELETE') {
        const tokens = libraryText(input.DeleteObjectId).split(',');
        const removed = draft.files.filter((file) => tokens.includes(file.token));
        draft.files = draft.files.filter((file) => !tokens.includes(file.token));
        await Promise.all(removed.map((file) => rm(file.path, { force: true })));
      }
      const uploaded = Array.isArray(req.files) ? req.files : Object.values(req.files ?? {}).flat();
      if (draft.files.length + uploaded.filter((file) => file.size).length > 10)
        throw new LibraryError('', 'A maximum of ten files may be uploaded.');
      for (const file of uploaded.filter((file) => file.size)) {
        if (!draft.directory) draft.directory = await mkdtemp(join(tmpdir(), 'conmas-library-'));
        const token = randomUUID(),
          path = join(draft.directory, token);
        await copyFile(file.path, path);
        draft.files.push({
          token,
          path,
          name: basename(file.originalname.replaceAll('\\', '/')),
          type: file.mimetype,
          size: file.size,
        });
      }
      mergeRoles(input, draft.roles);
      if (input.act === 'FILE_UPLOAD' || input.act === 'FILE_DELETE')
        return res.json({
          UploadFiles: draft.files.map((file) => ({
            FileName: file.name,
            FilePath: file.token,
            FileContentType: file.type,
            IsDelete: false,
          })),
          ErrorMessage: '',
        });
      if (input.act === 'PageType') return renderDetail(req, res);
      if (input.act && input.act !== 'SAVE') return res.status(400).send('Unknown action.');
      const selectedLabels = libraryIds(input.LabelIds);
      for (const key of Object.keys(input)) {
        const match = /^labels\[(\d+)\]\.ID$/.exec(key);
        if (match && labelChecked(input[`labels[${match[1]}].Chk`])) selectedLabels.push(labelInteger(input[key]));
      }
      const ids = await saveLibraryDocument(db, mode, input, draft.files, actor, {
        create,
        labels: [...new Set(selectedLabels)],
        roles: draft.roles,
        noRoles: labelChecked(input.IsRoleNone),
      });
      await clearDraft(req);
      return res.redirect(
        create
          ? `${base}/Library?mode=${mode}`
          : `${base}/Library/Details?mode=${mode}&documentId=${ids[0]}&detailsMode=Search&isFirst=true`,
      );
    } catch (error) {
      const message = fail(res, error);
      if (['FILE_UPLOAD', 'FILE_DELETE'].includes(libraryText(req.body?.act)))
        return res.json({ UploadFiles: [], ErrorMessage: message });
      return renderDetail(req, res, 'details', message);
    }
  });
  app.get(`${base}/Library/Role`, async (req, res) => {
    if (req.session.libraryDraft) req.session.libraryDraft.roles = {};
    return renderDetail(req, res, 'role');
  });
  app.post(`${base}/Library/Role`, async (req, res) => {
    try {
      const input = source(req),
        mode = res.locals.libraryMode as LibraryMode,
        id = labelInteger(input['Document.document_id']);
      const draft = await draftFor(req, mode, id);
      mergeRoles(input, draft.roles);
      if (input.ActionCommonType === 'PageType') return renderDetail(req, res, 'role');
      if (input.ActionCommonType === 'SaveType') {
        const doc = await libraryDocument(db, mode, id, req.session.userId ?? '', true);
        if (!doc) return res.sendStatus(403);
        const groups = await libraryGroups(db, mode, id, Number(doc.document_save_kbn) === 2);
        const roles: LibraryRoles = Object.fromEntries(
          groups.map((group) => [group.group_id, { read: group.read, edit: group.edit }]),
        );
        Object.assign(roles, draft.roles);
        await changeLibraryDocuments(db, mode, [id], req.session.userId ?? '', 'roles', {
          roles,
          noRoles: labelChecked(input.IsRoleNone),
        });
      } else if (input.ActionCommonType !== 'CancelType') return res.status(400).send('Unknown action.');
      await clearDraft(req);
      return res.redirect(`${base}/Library/Role?mode=${mode}&documentId=${id}&detailsMode=Search`);
    } catch (error) {
      return renderDetail(req, res, 'role', fail(res, error));
    }
  });
  for (const [action, view] of [
    ['Log', 'log'],
    ['DetailInfo', 'info'],
  ] as const)
    app.get(`${base}/Library/${action}`, (req, res) => renderDetail(req, res, view));
  app.post(`${base}/Library/Log`, (req, res) => renderDetail(req, res, 'log'));
  const findDocument = async (req: Request, res: Response) => {
    const id = labelInteger(source(req).documentId, 0),
      actor = req.session.userId ?? '';
    for (const mode of Object.keys(libraryModes) as LibraryMode[]) {
      if (licenseStatus().freeDrawOnly && mode === 'RepLIb') continue;
      const document = await libraryDocument(db, mode, id, actor);
      if (document) return document;
    }
    res.status(404).send('Document is not accessible.');
  };
  const binary = (res: Response, data: Buffer, name: string, type: string) =>
    res
      .set('X-Content-Type-Options', 'nosniff')
      .attachment(name.replace(/[\r\n]/g, ''))
      .type(type)
      .send(data);
  for (const [action, view] of [
    ['IrfdHistory', 'history'],
    ['Image', 'images'],
  ] as const)
    app.get(`${base}/Library/${action}`, async (req, res) => {
      try {
        if (!res.locals.libraryPermissions.read) return res.status(403).send('Role authority is insufficient.');
        const document = await findDocument(req, res);
        if (!document) return;
        const mode = res.locals.libraryMode as LibraryMode;
        if (Number(document.document_save_kbn) !== 2)
          return res.redirect(
            `${base}/Library/Details?mode=${mode}&documentId=${document.document_id}&detailsMode=Search&isFirst=true`,
          );
        const revision = req.query.selectedRevNo === undefined ? undefined : labelInteger(req.query.selectedRevNo);
        const irfd = await libraryIrfdContent(db, document.document_id, revision);
        if (!irfd) return res.status(404).send('FreeDraw revision was not found.');
        return full(req, res, {
          ...(await state(req, res)),
          view,
          document,
          create: false,
          edit: false,
          fd: true,
          irfd,
        });
      } catch (error) {
        return res.send(fail(res, error));
      }
    });
  app.get(`${base}/Library/GetDocument`, async (req, res) => {
    try {
      if (req.query.tempFullFileName) {
        const file = req.session.libraryDraft?.files.find((file) => file.token === req.query.tempFullFileName);
        if (!file) return res.sendStatus(404);
        return binary(res, await readFile(file.path), file.name, file.type);
      }
      const document = await findDocument(req, res);
      if (!document) return;
      const file = await libraryBinary(db, document);
      return binary(res, file.data, file.name, file.type);
    } catch (error) {
      return res.send(fail(res, error));
    }
  });
  app.get(`${base}/Library/GetFreeDrawImageThumbnail`, async (req, res) => {
    try {
      const document = await findDocument(req, res);
      if (!document) return;
      const file = await libraryBinary(db, document),
        size = Math.max(1, Math.min(2048, labelInteger(req.query.customSize, 100)));
      return res
        .type('image/png')
        .send(await sharp(file.data).resize(size, size, { fit: 'inside', withoutEnlargement: true }).png().toBuffer());
    } catch (error) {
      return res.send(fail(res, error));
    }
  });
  for (const action of ['GetIrfdDocument', 'GetPdf'] as const)
    app.get(`${base}/Library/${action}`, async (req, res) => {
      try {
        const document = await findDocument(req, res);
        if (!document) return;
        const revision = labelInteger(req.query.revNo, 0),
          pdf = action === 'GetPdf' || req.query.fileType === '0';
        if (action === 'GetPdf' && revision <= 0) {
          const file = await libraryBinary(db, document);
          return res.set('X-Content-Type-Options', 'nosniff').type('application/pdf').send(file.data);
        }
        if (action === 'GetIrfdDocument' && !['0', '1'].includes(libraryText(req.query.fileType)))
          return res.sendStatus(400);
        const row = (
          await db.query(
            `SELECT ${pdf ? 'pdf_file AS data,pdf_file_name AS name' : 'irfd_file AS data,irfd_file_name AS name'} FROM common_document_irfd
        WHERE document_id=$1${revision > 0 ? ' AND rev_no=$2' : ''} ORDER BY rev_no DESC LIMIT 1`,
            revision > 0 ? [document.document_id, revision] : [document.document_id],
          )
        ).rows[0];
        if (!row || !Buffer.isBuffer(row.data)) return res.sendStatus(404);
        if (action === 'GetPdf')
          return res.set('X-Content-Type-Options', 'nosniff').type('application/pdf').send(row.data);
        return binary(res, row.data, String(row.name), pdf ? 'application/pdf' : 'application/octet-stream');
      } catch (error) {
        return res.send(fail(res, error));
      }
    });
  app.get(`${base}/Library/GetTemporaryIrfdDocument`, async (req, res) => {
    const file = req.session.libraryDraft?.files.find(
      (file) => file.token === req.query.tempFullFileName && file.name.toLowerCase().endsWith('.irfd'),
    );
    if (!file) return res.sendStatus(404);
    return binary(res, await readFile(file.path), file.name, 'application/octet-stream');
  });
  app.get(`${base}/Library/GetIrfdImage`, async (req, res) => {
    try {
      if (!res.locals.libraryPermissions.read) return res.status(403).send('Role authority is insufficient.');
      const document = await findDocument(req, res);
      if (!document) return;
      const revision = labelInteger(req.query.revNo),
        pageNumber = labelInteger(req.query.pageNumber),
        format = libraryText(req.query.format),
        name = libraryText(req.query.name);
      if (!['jpeg', 'png'].includes(format)) return res.status(400).send('Invalid image format.');
      const row = (
        await db.query('SELECT irfd_file FROM common_document_irfd WHERE document_id=$1 AND rev_no=$2', [
          document.document_id,
          revision,
        ])
      ).rows[0];
      if (!Buffer.isBuffer(row?.irfd_file)) return res.sendStatus(404);
      const image = irfdAttachments(row.irfd_file).find(
        (item) => item.format.toLowerCase() === format && item.pageNumber === pageNumber && item.name === name,
      );
      if (!image) return res.sendStatus(404);
      const resize = labelChecked(req.query.isResize),
        data = resize ? await irfdImagePreview(image.data) : image.data;
      return binary(
        res,
        data,
        `${image.name}.${format}`,
        resize && data !== image.data ? 'image/png' : `image/${format}`,
      );
    } catch (error) {
      return res.send(fail(res, error));
    }
  });
  app.post(`${base}/Library/unLockTable`, async (req, res) => {
    await db.query('DELETE FROM document_lock WHERE user_id=$1 AND sys_regist_user=$1 AND sys_regist_term=$2', [
      req.session.userId ?? '',
      hostname(),
    ]);
    return res.send('');
  });
  app.post(`${base}/Library/SelectIndex`, async (req, res) => {
    const input = source(req),
      controller = libraryText(input.RetrunControllerName),
      action = libraryText(input.RetrunActionMethod);
    if (!['DefReport', 'InputReport'].includes(controller) || !['Details', 'Library'].includes(action))
      return res.status(400).send('Invalid return destination.');
    req.session.librarySelection = {
      mode: res.locals.libraryMode,
      ids: input.ReturnAct === 'CANCEL' ? [] : libraryIds(input.ChkSelectDocID),
    };
    // The calling Manager tabs remain blocked; never pretend their pending selection handlers executed.
    return res
      .status(501)
      .send('The calling Forms/Documents workflow is not implemented yet. Selection has not been applied.');
  });
}
function mergeRoles(input: Record<string, unknown>, roles: LibraryRoles) {
  for (const key of Object.keys(input)) {
    const match = /^GroupRolePage\[(\d+)\]\.group_id$/.exec(key);
    if (!match) continue;
    roles[String(labelInteger(input[key]))] = {
      read: labelChecked(input[`GroupRolePage[${match[1]}].IsReferRole`]),
      edit: labelChecked(input[`GroupRolePage[${match[1]}].IsEditRole`]),
    };
  }
}
async function libraryLog(db: pg.Pool, id: number, input: Record<string, unknown>) {
  const kind = libraryText(input['WhereData.LogKbn']) || '0';
  if (!['0', '1'].includes(kind)) throw new LibraryError('', 'Invalid log type.');
  const table = kind === '1' ? 'log_library_refer' : 'log_library_download';
  return (
    await db.query(
      `SELECT log_date,log_user,log_user_name,log_term,log_term_name,log_gps_lat,log_gps_lon,log_gps_alt FROM ${table} WHERE document_id=$1 ORDER BY log_date DESC LIMIT $2 OFFSET $3`,
      [
        id,
        Math.max(1, Math.min(1000, labelInteger(input['WhereData.PageSize'], 20))),
        Math.max(0, labelInteger(input['WhereData.PageIndex'], 0)) *
          Math.max(1, Math.min(1000, labelInteger(input['WhereData.PageSize'], 20))),
      ],
    )
  ).rows;
}
