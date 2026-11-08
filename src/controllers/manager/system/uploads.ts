import { createReadStream } from 'node:fs';
import { open, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import type pg from 'pg';
import { hasSystemPermission } from '../../../middleware/manager/system/permissions.js';
import { licenseStatus } from '../../../shared/license-counts.js';
import { configuredPath } from './files.js';
import { maxSystemUploadBytes } from '../../../middleware/manager/system/upload-body.js';

const root = '/ConMasManager/System';
const pageSizesFallback = [10, 20, 50, 100];
const pageSizeFallbackOptions = pageSizesFallback.map((value) => ({ value, text: String(value) }));
const uploadFields: Record<string, true> = {
  file1: true,
  file2: true,
  file3: true,
  file4: true,
  file5: true,
  file6: true,
  file7: true,
  file8: true,
  file9: true,
  file10: true,
};
const maxUploadFiles = Object.keys(uploadFields).length;
const maxRequestBytes = maxSystemUploadBytes;
const roleError = 'Role authority is insufficient.';
const serverError = 'Server error has been occurred.';

type Render = (res: Response, data: Record<string, unknown>) => unknown;
type PageMode = 'list' | 'create' | 'denied';
type UploadRecord = { fileName: string; url: string; size: number; dateTimeUpload: string };
type DirectorySettings = { physical: string; virtual: string };

export function safeUploadFileName(value: string): string {
  if (value.includes('\0')) return '';
  const name = path.basename(path.win32.basename(value));
  return name === '.' || name === '..' ? '' : name;
}

function licenseStatusError(): { message: string; status: number } | null {
  try {
    return licenseStatus().freeDrawOnly ? { message: roleError, status: 403 } : null;
  } catch {
    return { message: 'License information is unavailable.', status: 503 };
  }
}

function show(res: Response, render: Render, page: Record<string, unknown>) {
  const mode = page.mode as PageMode;
  return render(res, {
    active: 'System',
    section: 'UploadList',
    login: false,
    title:
      typeof page.title === 'string'
        ? page.title
        : mode === 'create'
          ? 'File upload for reference'
          : 'List of file upload for reference',
    userName: res.locals.userName,
    systemUploadsPage: page,
  });
}

function showBlocked(res: Response, render: Render, title: string, licenseError: { message: string; status: number }) {
  return show(res.status(licenseError.status), render, { mode: 'denied', title, errors: [licenseError.message] });
}

function text(source: Record<string, unknown>, key: string): string {
  return typeof source[key] === 'string' ? (source[key] as string) : '';
}

function pageNumber(value: unknown, fallback: number): number {
  if (typeof value !== 'string' && typeof value !== 'number') return fallback;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? Math.min(number, 10000) : fallback;
}

async function pageSettings(db: pg.Pool, requestedSize: unknown) {
  const [defaultResult, optionResult] = await Promise.all([
    db.query<{ com_value: string }>(
      "SELECT com_value FROM mst_common WHERE com_key='DEFAULT_PAGE_SIZE' ORDER BY com_index LIMIT 1",
    ),
    db.query<{ com_value: string; com_name: string }>(
      "SELECT com_value,com_name FROM mst_common WHERE com_key='PAGE_SIZE' ORDER BY com_index",
    ),
  ]);
  const options = optionResult.rows
    .map((row) => ({ value: Number(row.com_value), text: row.com_name }))
    .filter((option) => Number.isSafeInteger(option.value) && option.value > 0 && option.value <= 10000)
    .filter((option, index, values) => values.findIndex((candidate) => candidate.value === option.value) === index);
  if (!options.length) options.push(...pageSizeFallbackOptions);
  const configured = Number(defaultResult.rows[0]?.com_value);
  const defaultSize = options.some((option) => option.value === configured)
    ? configured
    : (options.find((option) => option.value === 20)?.value ?? options[0].value);
  const pageSize = pageNumber(requestedSize, defaultSize);
  return { options, pageSize: options.some((option) => option.value === pageSize) ? pageSize : defaultSize };
}

async function directorySettings(db: pg.Pool): Promise<DirectorySettings> {
  const result = await db.query<{ com_name: string; com_value: string }>(
    'SELECT com_name,com_value FROM mst_common WHERE com_key=$1 AND com_name=ANY($2::text[])',
    ['VIRTUAL_DIRECTORY', ['REFERENCE_PHYSICAL', 'REFERENCE_VIRTUAL']],
  );
  const values: Record<string, string> = Object.fromEntries(result.rows.map((row) => [row.com_name, row.com_value]));
  if (!Object.hasOwn(values, 'REFERENCE_PHYSICAL') || !Object.hasOwn(values, 'REFERENCE_VIRTUAL'))
    throw new Error('Upload directory settings are missing.');
  const physicalValue = values.REFERENCE_PHYSICAL ?? '';
  const physical = physicalValue ? configuredPath(physicalValue) : '';
  return {
    physical,
    virtual: values.REFERENCE_VIRTUAL ?? '',
  };
}

function formatUploadTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

async function readUploads(physical: string, virtual: string): Promise<UploadRecord[]> {
  if (!physical) return [];
  const entries = await readdir(physical, { withFileTypes: true });
  const records: UploadRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const info = await stat(path.join(physical, entry.name));
    if (!info.isFile()) continue;
    records.push({
      fileName: entry.name,
      url: `${virtual.replace(/\/+$/, '')}/${entry.name.replace(/^\/+/, '')}`,
      size: Math.ceil(info.size / 1024),
      dateTimeUpload: formatUploadTime(info.mtime),
    });
  }
  return records;
}

async function accessError(db: pg.Pool, userId: string, action: 'read' | 'create'): Promise<string> {
  return (await hasSystemPermission(db, userId, 'data', action)) ? '' : roleError;
}

function renderListError(
  res: Response,
  render: Render,
  searchFileName: string,
  error: string,
  canCreate = false,
  canDelete = false,
  pageSizes = pageSizeFallbackOptions,
  pageSize = 20,
) {
  return show(res, render, {
    mode: 'list',
    rows: [],
    total: 0,
    pageIndex: 0,
    pageSize,
    pages: 1,
    pageSizes,
    searchFileName,
    canCreate,
    canDelete,
    errors: [error],
    message: '',
  });
}

export function registerSystemUploads(app: Express, db: pg.Pool, render: Render) {
  const renderList = async (
    req: Request,
    res: Response,
    source: Record<string, unknown>,
    message = '',
    errors: string[] = [],
  ) => {
    const searchFileName = text(source, 'searchFileName');
    try {
      const [settings, permissionCreate, permissionDelete, pageConfig] = await Promise.all([
        directorySettings(db),
        hasSystemPermission(db, req.session.userId ?? '', 'data', 'create'),
        hasSystemPermission(db, req.session.userId ?? '', 'data', 'delete'),
        pageSettings(db, source.pageSize),
      ]);
      if (!settings.physical)
        return renderListError(
          res,
          render,
          searchFileName,
          'Upload directory does not exist.',
          permissionCreate,
          permissionDelete,
          pageConfig.options,
          pageConfig.pageSize,
        );
      let records: UploadRecord[];
      try {
        records = await readUploads(settings.physical, settings.virtual);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT' || (cause as NodeJS.ErrnoException).code === 'ENOTDIR') {
          return renderListError(
            res,
            render,
            searchFileName,
            'Upload directory does not exist.',
            permissionCreate,
            permissionDelete,
            pageConfig.options,
            pageConfig.pageSize,
          );
        }
        throw cause;
      }
      const matching = records.filter((record) => !searchFileName || record.fileName.includes(searchFileName));
      const pageSize = pageConfig.pageSize;
      const pages = Math.max(1, Math.ceil(matching.length / pageSize));
      const pageIndex = Math.min(pageNumber(source.pageIndex, 0), pages - 1);
      return show(res, render, {
        mode: 'list',
        rows: matching.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize),
        total: matching.length,
        pageIndex,
        pageSize,
        pages,
        pageSizes: pageConfig.options,
        searchFileName,
        canCreate: permissionCreate,
        canDelete: permissionDelete,
        errors,
        message,
      });
    } catch {
      return renderListError(res.status(500), render, searchFileName, serverError);
    }
  };

  app.get(`${root}/UploadList`, async (req, res) => {
    const licenseError = licenseStatusError();
    if (licenseError) return showBlocked(res, render, 'List of file upload for reference', licenseError);
    try {
      const error = await accessError(db, req.session.userId ?? '', 'read');
      if (error) return show(res.status(403), render, { mode: 'denied', errors: [error] });
      return renderList(req, res, req.query as Record<string, unknown>);
    } catch {
      return renderListError(res.status(500), render, '', serverError);
    }
  });

  app.post(`${root}/UploadList`, async (req, res) => {
    const licenseError = licenseStatusError();
    if (licenseError) return showBlocked(res, render, 'List of file upload for reference', licenseError);
    const source = req.body as Record<string, unknown>;
    const searchFileName = text(source, 'searchFileName');
    try {
      const errors: string[] = [];
      if (source.act === 'delete') {
        if (!(await hasSystemPermission(db, req.session.userId ?? '', 'data', 'delete'))) {
          errors.push(roleError);
        } else {
          const selected = text(source, 'chkFiles');
          if (!selected) errors.push('Please select the file to be deleted.');
          else {
            const files = selected.split(',');
            if (files.some((file) => !file || safeUploadFileName(file) !== file))
              errors.push('Invalid file selection.');
            else {
              const settings = await directorySettings(db);
              if (settings.physical) {
                for (const file of files) {
                  try {
                    await unlink(path.join(settings.physical, file));
                  } catch (cause) {
                    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
                  }
                }
              }
            }
          }
        }
      }
      if (!(await hasSystemPermission(db, req.session.userId ?? '', 'data', 'read'))) {
        return show(res.status(403), render, { mode: 'denied', errors: [roleError] });
      }
      return renderList(req, res, source, '', errors);
    } catch {
      return renderListError(res.status(500), render, searchFileName, serverError);
    }
  });

  app.get(`${root}/CreateUpload`, async (req, res) => {
    const licenseError = licenseStatusError();
    if (licenseError) return showBlocked(res, render, 'File upload for reference', licenseError);
    try {
      const error = await accessError(db, req.session.userId ?? '', 'create');
      if (error) return show(res.status(403), render, { mode: 'denied', errors: [error] });
      return show(res, render, { mode: 'create', errors: [], message: '' });
    } catch {
      return show(res.status(500), render, { mode: 'create', errors: [serverError], message: '' });
    }
  });

  app.post(`${root}/CreateUpload`, async (req, res) => {
    const licenseError = licenseStatusError();
    if (licenseError) return showBlocked(res, render, 'File upload for reference', licenseError);
    try {
      const error = await accessError(db, req.session.userId ?? '', 'create');
      if (error) return show(res.status(403), render, { mode: 'denied', errors: [error] });
      const incomingFiles = req.files;
      const files: Express.Multer.File[] = Array.isArray(incomingFiles)
        ? incomingFiles
        : Object.values(incomingFiles ?? {}).flat();
      if (files.length > maxUploadFiles || files.some((file) => !Object.hasOwn(uploadFields, file.fieldname))) {
        return show(res.status(400), render, {
          mode: 'create',
          errors: ['Select files using the available file fields.'],
          message: '',
        });
      }
      const length = Number(req.headers['content-length']);
      if (
        (Number.isFinite(length) && length > maxRequestBytes) ||
        files.reduce((total, file) => total + file.size, 0) > maxRequestBytes
      ) {
        return show(res.status(413), render, {
          mode: 'create',
          errors: ['The upload exceeds the 1 GB request size limit.'],
          message: '',
        });
      }
      const settings = await directorySettings(db);
      if (!settings.physical) throw new Error('Upload directory is not configured.');
      const directory = await stat(settings.physical);
      if (!directory.isDirectory()) throw new Error('Upload directory is not available.');
      const errors: string[] = [];
      for (const file of files) {
        if (file.size === 0) continue;
        const fileName = safeUploadFileName(file.originalname);
        if (!fileName) {
          errors.push('File name is invalid.');
          continue;
        }
        try {
          const target = await open(path.join(settings.physical, fileName), 'wx');
          try {
            await target.writeFile(file.buffer ?? createReadStream(file.path));
          } finally {
            await target.close();
          }
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
            errors.push(`Failed to upload ${fileName} due to the same name file already existed.`);
            continue;
          }
          throw cause;
        }
      }
      const message = 'File upload has been registered.';
      if (errors.length) return show(res, render, { mode: 'create', errors, message });
      return res.redirect(`${root}/UploadList`);
    } catch {
      return show(res, render, { mode: 'create', errors: ['File upload has not been registered.'], message: '' });
    }
  });
}
