import { existsSync } from 'node:fs';
import { clientSettingsDirectory, licenseStatus } from '../../../shared/license-counts.js';
import type { Express, Request, Response } from 'express';
import type pg from 'pg';
import type { Dirent, Stats } from 'node:fs';
import { lstat, readFile, readdir, realpath, rm, stat, unlink } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { hasSystemPermission } from '../../../middleware/manager/system/permissions.js';

declare module 'express-session' {
  interface SessionData {
    systemFileDeleteErrors?: { route: string; fileNames: string[] };
  }
}

type Scope = 'system' | 'data';
type Action = 'read' | 'delete';
type FileMode = 'backup' | 'autoOutput' | 'serverLog' | 'error';
type ListedFile = {
  fileName: string;
  downloadName?: string;
  folder: 'File' | 'Folder';
  dateText: string;
  sizeText: string;
  physicalId?: string | null;
  defId?: number | null;
  sheetNo?: number | null;
  clusterIndex?: number | null;
  repId?: number | null;
  src?: string;
};
type FileRoots = { backupLog: string; backupImage: string; autoOutput: string; serverLog: string };
type DiskPage = { root: string; directory: string; files: ListedFile[]; totalItems: number };
type PageInfo = {
  pageNo: number;
  pageSize: number;
  pageSizes: number[];
  totalItems: number;
  totalPages: number;
  startPageNo: number;
  endPageNo: number;
  startItemNo: number;
  endItemNo: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
};
type ZipEntry = { name: string; data: Buffer; date: Date; directory?: boolean };
type SystemFilesPage = {
  mode: FileMode;
  section: string;
  title: string;
  route: string;
  error: string;
  deleteErrors: string[];
  deleteErrorTitle: string;
  deleteConfirmMessage: string;
  searchText: string;
  searchLabel: string;
  emptyMessage: string;
  hasPermissionToDelete: boolean;
  files: ListedFile[];
  page: PageInfo;
  type?: number;
  rootPath?: string;
  rootFolder?: string;
  currentPath?: string;
  parentPath?: string;
};

const routeRoot = '/ConMasManager/System';
const pageSizes = [20, 50, 100, 200, 500];
const legacyWebConfig = '/mnt/c/Users/DELL/CONMASSERVER/ConMasManager/Web.config';
const emptyBuffer = Buffer.alloc(0);
let rootsPromise: Promise<FileRoots> | undefined;

class ConfigurationError extends Error {}
class InvalidFilePath extends Error {}

export function resolvePathUnderRoot(root: string, candidate: string): string {
  if (typeof candidate !== 'string' || candidate.includes('\0') || candidate.split(/[\\/]/).includes('..')) {
    throw new InvalidFilePath('Invalid file path.');
  }
  const absoluteRoot = resolve(root);
  const absoluteCandidate = isAbsolute(candidate)
    ? resolve(candidate)
    : resolve(absoluteRoot, candidate.replace(/\\/g, sep));
  const rel = relative(absoluteRoot, absoluteCandidate);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new InvalidFilePath('Invalid file path.');
  return absoluteCandidate;
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
    result[match[1]] = (match[2] ?? match[3] ?? '').replace(/&amp;/g, '&');
  return result;
}

function configuredValue(
  xml: string,
  tagName: string,
  keyName: string,
  keyValue: string,
  valueName: string,
): string | undefined {
  for (const tag of xml.match(new RegExp(`<${tagName}\\b[^>]*\\/?>(?:)`, 'gi')) ?? []) {
    const values = attributes(tag);
    if (values[keyName] === keyValue && values[valueName]) return values[valueName];
  }
  return undefined;
}

export function configuredPath(value: string): string {
  const normalized = value.replace(/[\\/]+/g, '/');
  const packagedRoot = '/mnt/c/Users/DELL/CONMASSERVER';
  if (/^c:\/conmas(?:\/|$)/i.test(normalized) && existsSync(packagedRoot)) {
    return resolve(packagedRoot, normalized.replace(/^c:\/conmas\/?/i, ''));
  }
  const windowsDrive = normalized.match(/^([a-z]):\/?(.*)$/i);
  if (windowsDrive && process.platform === 'linux')
    return resolve(`/mnt/${windowsDrive[1].toLowerCase()}`, windowsDrive[2]);
  return resolve(normalized);
}

async function loadFileRoots(): Promise<FileRoots> {
  const configPath = process.env.CONMAS_MANAGER_WEB_CONFIG || legacyWebConfig;
  let xml: string;
  try {
    xml = await readFile(configPath, 'utf8');
  } catch {
    throw new ConfigurationError('File location configuration is unavailable.');
  }
  const clientSettingsValue = configuredValue(xml, 'add', 'key', 'ClientSettings', 'value');
  const rootAppender = xml.match(
    /<appender\b(?=[^>]*\bname\s*=\s*["']RootAppender["'])[^>]*>([\s\S]*?)<\/appender>/i,
  )?.[1];
  const logFileValue = rootAppender ? configuredValue(rootAppender, 'param', 'name', 'File', 'value') : undefined;
  if (!clientSettingsValue || !logFileValue) throw new ConfigurationError('File location configuration is incomplete.');
  const clientSettings = clientSettingsDirectory() ?? configuredPath(clientSettingsValue);
  return {
    backupLog: join(clientSettings, 'recovery', 'logs'),
    backupImage: join(clientSettings, 'recovery', 'images'),
    autoOutput: join(dirname(dirname(clientSettings)), 'output'),
    serverLog: dirname(configuredPath(logFileValue)),
  };
}

function show(
  render: (res: Response, data: Record<string, unknown>) => unknown,
  res: Response,
  data: SystemFilesPage,
  status = 200,
): unknown {
  return render(res.status(status), {
    active: 'System',
    section: data.section,
    login: false,
    title: data.title,
    userName: res.locals.userName,
    systemFilesPage: data,
  });
}

function renderError(
  render: (res: Response, data: Record<string, unknown>) => unknown,
  res: Response,
  section: string,
  title: string,
  error: string,
  status = 500,
): unknown {
  return show(render, res, emptyPage('error', section, title, error), status);
}

function emptyPage(mode: FileMode, section: string, title: string, error = ''): SystemFilesPage {
  return {
    mode,
    section,
    title,
    route: '',
    error,
    deleteErrors: [],
    deleteErrorTitle: '',
    deleteConfirmMessage: '',
    searchText: '',
    searchLabel: '',
    emptyMessage: '',
    hasPermissionToDelete: false,
    files: [],
    page: pagination(0, 1, 20),
  };
}

function missing(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code))
  );
}

function statusFor(error: unknown): number {
  if (error instanceof ConfigurationError) return 503;
  if (error instanceof InvalidFilePath) return 400;
  if (missing(error)) return 404;
  return 500;
}

function messageFor(error: unknown): string {
  if (error instanceof ConfigurationError) return 'File or license configuration is unavailable.';
  if (error instanceof InvalidFilePath) return 'Invalid file path or name.';
  if (missing(error)) return 'File or folder does not exist.';
  return 'Unable to access configured files.';
}

async function loadAccessibleRoots(
  render: (res: Response, data: Record<string, unknown>) => unknown,
  res: Response,
  section: string,
  title: string,
): Promise<FileRoots | null> {
  try {
    if (licenseStatus().freeDrawOnly) {
      renderError(render, res, section, title, 'Role authority is insufficient.', 403);
      return null;
    }
    return await (rootsPromise ??= loadFileRoots());
  } catch (error) {
    rootsPromise = undefined;
    renderError(render, res, section, title, messageFor(error), statusFor(error));
    return null;
  }
}

async function checkPermission(
  render: (res: Response, data: Record<string, unknown>) => unknown,
  db: pg.Pool,
  req: Request,
  res: Response,
  scope: Scope,
  action: Action,
  section: string,
  title: string,
): Promise<boolean> {
  const userId = req.session?.userId;
  try {
    if (userId && (await hasSystemPermission(db, userId, scope, action))) return true;
  } catch {
    renderError(render, res, section, title, 'Unable to check file permissions.', 500);
    return false;
  }
  renderError(render, res, section, title, 'Access denied.', 403);
  return false;
}

async function commonFlag(db: pg.Pool, key: string, name: string): Promise<boolean> {
  const result = await db.query(
    'SELECT com_value FROM mst_common WHERE com_key = $1 AND com_name = $2 ORDER BY com_index LIMIT 1',
    [key, name],
  );
  return String(result.rows[0]?.com_value ?? '') === '1';
}

function stringParam(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function pageParam(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : fallback;
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, 10000);
}

function pageQuery(
  req: Request,
  query: Request['query'] | Request['body'],
): { pageNo: number; pageSize: number; searchText: string } {
  return {
    pageNo: pageParam(query.pageNo, 1),
    pageSize: pageParam(query.pageSize, 20),
    searchText: stringParam(query.searchText),
  };
}

function searchMatches(name: string, searchText: string): boolean {
  return searchText
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => name.includes(word));
}

function readableSize(size: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = size;
  let unit = 0;
  while (unit < units.length - 1 && value > 1024) {
    value /= 1024;
    unit++;
  }
  return `${Number(value.toFixed(2))}${units[unit]}`;
}

function dateText(date: Date | null, withTime = false): string {
  if (!date || Number.isNaN(date.getTime())) return '';
  const two = (value: number) => String(value).padStart(2, '0');
  const result = `${date.getFullYear()}/${two(date.getMonth() + 1)}/${two(date.getDate())}`;
  return withTime
    ? `${result} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, '0')}`
    : result;
}

function dateFromName(value: string, format: 'log' | 'image'): Date | null {
  const pattern = format === 'log' ? /^(\d{4})(\d{2})(\d{2})$/ : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})$/;
  const parts = value.match(pattern);
  if (!parts) return null;
  const [year, month, day, hour = '0', minute = '0', second = '0', millisecond = '0'] = parts.slice(1);
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(millisecond),
  );
  return date.getFullYear() === Number(year) &&
    date.getMonth() === Number(month) - 1 &&
    date.getDate() === Number(day) &&
    date.getHours() === Number(hour) &&
    date.getMinutes() === Number(minute) &&
    date.getSeconds() === Number(second) &&
    date.getMilliseconds() === Number(millisecond)
    ? date
    : null;
}

function integerField(value: string | undefined): number | null {
  if (!value || !/^[+-]?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= -2147483648 && parsed <= 2147483647 ? parsed : null;
}

function pagination(totalItems: number, pageNo: number, pageSize: number): PageInfo {
  const totalPages = Math.ceil(totalItems / pageSize);
  const middle = 5;
  const startPageNo =
    totalPages <= 10 || pageNo <= middle ? 1 : totalPages - middle + 1 <= pageNo ? totalPages - 9 : pageNo - middle + 1;
  const endPageNo =
    totalPages <= 10 || totalPages - middle + 1 <= pageNo ? totalPages : pageNo <= middle ? 10 : pageNo + middle;
  return {
    pageNo,
    pageSize,
    pageSizes,
    totalItems,
    totalPages,
    startPageNo,
    endPageNo,
    startItemNo: 1 + pageSize * (pageNo - 1),
    endItemNo: pageSize * pageNo < totalItems ? pageSize * pageNo : totalItems,
    hasPreviousPage: pageNo > 1,
    hasNextPage: pageNo < totalPages,
  };
}

function safeName(name: string): boolean {
  return (
    Boolean(name) &&
    name !== '.' &&
    name !== '..' &&
    !/[\\/:\x7f]/.test(name) &&
    !Array.from(name).some((character) => character.charCodeAt(0) < 32)
  );
}

async function existingPath(root: string, candidate: string): Promise<{ path: string; stat: Stats }> {
  const lexicalPath = resolvePathUnderRoot(root, candidate);
  const linkInfo = await lstat(lexicalPath);
  if (linkInfo.isSymbolicLink()) throw new InvalidFilePath('Symbolic links are not allowed.');
  const actualPath = await realpath(lexicalPath);
  const rel = relative(root, actualPath);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new InvalidFilePath('Invalid file path.');
  return { path: actualPath, stat: await stat(actualPath) };
}

async function existingRoot(root: string): Promise<string> {
  const actual = await realpath(root);
  if (!(await stat(actual)).isDirectory()) throw new InvalidFilePath('Configured path is not a folder.');
  return actual;
}

async function childPath(root: string, parentPath: string, name: string): Promise<{ path: string; stat: Stats }> {
  if (!safeName(name)) throw new InvalidFilePath('Invalid file name.');
  const parent = await existingPath(root, parentPath);
  if (!parent.stat.isDirectory()) throw new InvalidFilePath('Invalid folder path.');
  return existingPath(root, join(parent.path, name));
}

function direntNames(
  items: Dirent[],
  searchText: string,
  includeFolders: boolean,
): { name: string; folder: boolean }[] {
  return items.flatMap((item) => {
    if (!safeName(item.name) || item.isSymbolicLink()) return [];
    const folder = item.isDirectory();
    if ((!folder && !item.isFile()) || (folder && !includeFolders) || !searchMatches(item.name, searchText)) return [];
    return [{ name: item.name, folder }];
  });
}

async function directoryPage(
  root: string,
  requestedPath: string,
  searchText: string,
  pageNo: number,
  pageSize: number,
  includeFolders: boolean,
  directoriesFirst: boolean,
): Promise<DiskPage> {
  const canonicalRoot = await existingRoot(root);
  const current = await existingPath(canonicalRoot, requestedPath);
  if (!current.stat.isDirectory()) throw new InvalidFilePath('Invalid folder path.');
  const names = direntNames(await readdir(current.path, { withFileTypes: true }), searchText, includeFolders);
  names.sort((left, right) =>
    directoriesFirst && left.folder !== right.folder
      ? Number(right.folder) - Number(left.folder)
      : left.name.localeCompare(right.name),
  );
  const totalItems = names.length;
  const selected = names.slice((pageNo - 1) * pageSize, pageNo * pageSize);
  const files: ListedFile[] = [];
  for (const entry of selected) {
    const item = await existingPath(canonicalRoot, join(current.path, entry.name));
    files.push({
      fileName: entry.name,
      folder: entry.folder ? 'Folder' : 'File',
      dateText: dateText(item.stat.mtime),
      sizeText: entry.folder ? '' : readableSize(item.stat.size),
    });
  }
  return { root: canonicalRoot, directory: current.path, files, totalItems };
}

async function backupDirectoryPage(
  root: string,
  type: number,
  searchText: string,
  pageNo: number,
  pageSize: number,
): Promise<DiskPage> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await existingRoot(root);
  } catch (error) {
    if (missing(error)) return { root: resolve(root), directory: resolve(root), files: [], totalItems: 0 };
    throw error;
  }
  const names = (await readdir(canonicalRoot, { withFileTypes: true }))
    .filter((item) => item.isFile() && safeName(item.name) && searchMatches(item.name, searchText))
    .map((item) => item.name)
    .sort((left, right) => right.localeCompare(left));
  const totalItems = names.length;
  const selected = names.slice((pageNo - 1) * pageSize, pageNo * pageSize);
  const files: ListedFile[] = [];
  for (const fileName of selected) {
    const item = await existingPath(canonicalRoot, join(canonicalRoot, fileName));
    if (!item.stat.isFile()) continue;
    if (type === 0) {
      const fields = fileName.split('@').slice(0, -1);
      const date = dateFromName(fields[0] ?? '', 'log');
      files.push({
        fileName,
        downloadName: `${fileName}.log`,
        folder: 'File',
        dateText: dateText(date),
        sizeText: '',
        physicalId: fields.length > 1 ? fields[1] : null,
      });
    } else {
      const fields = fileName.split('@').slice(0, -1);
      const thumbnail = await imageThumbnail(item.path);
      files.push({
        fileName,
        downloadName: `${fileName}.${thumbnail.extension === 'jpeg' ? 'jpg' : thumbnail.extension}`,
        folder: 'File',
        dateText: dateText(dateFromName(fields[0] ?? '', 'image'), true),
        sizeText: '',
        physicalId: fields.length > 1 ? fields[1] : null,
        defId: integerField(fields[2]),
        sheetNo: integerField(fields[3]),
        clusterIndex: integerField(fields[4]),
        repId: integerField(fields[5]),
        src: thumbnail.src,
      });
    }
  }
  return { root: canonicalRoot, directory: canonicalRoot, files, totalItems };
}

async function imageThumbnail(filePath: string): Promise<{ src: string; extension: string }> {
  try {
    const image = sharp(filePath);
    const metadata = await image.metadata();
    if (!metadata.format) return { src: 'data:image/;base64,', extension: '' };
    const bytes = await sharp(filePath).resize(100, 75, { fit: 'inside', withoutEnlargement: true }).toBuffer();
    return { src: `data:image/${metadata.format};base64,${bytes.toString('base64')}`, extension: metadata.format };
  } catch {
    return { src: 'data:image/;base64,', extension: '' };
  }
}

function filePage(
  mode: FileMode,
  section: string,
  title: string,
  route: string,
  searchText: string,
  page: PageInfo,
  files: ListedFile[],
  extra: Partial<SystemFilesPage> = {},
): SystemFilesPage {
  return {
    mode,
    section,
    title,
    route,
    error: '',
    deleteErrors: [],
    deleteErrorTitle: '',
    deleteConfirmMessage: '',
    searchText,
    searchLabel: '',
    emptyMessage: '',
    hasPermissionToDelete: false,
    files,
    page,
    ...extra,
  };
}

function indexUrl(route: string, values: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== '') query.set(key, String(value));
  const search = query.toString();
  return `${routeRoot}/${route}${search ? `?${search}` : ''}`;
}

function takeDeleteErrors(req: Request, route: string): string[] {
  const errors = req.session?.systemFileDeleteErrors;
  if (req.session) req.session.systemFileDeleteErrors = undefined;
  return errors?.route === route ? errors.fileNames : [];
}

function sendAttachment(res: Response, fileName: string, contentType: string, data: Buffer): unknown {
  return res.attachment(fileName).type(contentType).send(data);
}

function extensionContentType(fileName: string): string {
  switch (extname(fileName)) {
    case '.xlsx':
    case '.xls':
      return 'application/vnd.ms-excel';
    case '.csv':
      return 'text/csv';
    case '.zip':
      return 'application/zip';
    case '.pdf':
      return 'application/pdf';
    case '.png':
      return 'image/png';
    case '.jpeg':
    case '.jpg':
      return 'image/jpeg';
    case '.xml':
      return 'application/xml; charset="UTF-8"';
    case '.xdw':
      return 'application/vnd.fujixerox.docuworks';
    default:
      return 'text/plain';
  }
}

function zipDate(date: Date): { time: number; day: number } {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    day: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index++) {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crcTable[index] = value >>> 0;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function zipBuffer(entries: ZipEntry[]): Buffer {
  if (entries.length > 0xffff) throw new Error('Too many archive entries.');
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
    if (!name.length || name.length > 0xffff || entry.data.length > 0xffffffff || offset > 0xffffffff)
      throw new Error('Archive exceeds ZIP limits.');
    const checksum = crc32(entry.data);
    const stamp = zipDate(entry.date);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(stamp.time, 10);
    header.writeUInt16LE(stamp.day, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(entry.data.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, entry.data);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(0, 10);
    record.writeUInt16LE(stamp.time, 12);
    record.writeUInt16LE(stamp.day, 14);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(entry.data.length, 20);
    record.writeUInt32LE(entry.data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(entry.directory ? 0x10 : 0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + name.length + entry.data.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  if (offset > 0xffffffff || centralSize > 0xffffffff) throw new Error('Archive exceeds ZIP limits.');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

async function addDirectoryTree(
  root: string,
  directory: string,
  archiveName: string,
  entries: ZipEntry[],
  includeRoot: boolean,
): Promise<void> {
  const current = await existingPath(root, directory);
  if (!current.stat.isDirectory()) throw new InvalidFilePath('Invalid folder path.');
  if (includeRoot)
    entries.push({ name: `${archiveName}/`, data: emptyBuffer, date: current.stat.mtime, directory: true });
  const children = await readdir(current.path, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    if (!safeName(child.name) || child.isSymbolicLink()) continue;
    const found = await existingPath(root, join(current.path, child.name));
    const childArchiveName = `${archiveName}/${child.name}`;
    if (found.stat.isDirectory()) {
      await addDirectoryTree(root, found.path, childArchiveName, entries, true);
    } else if (found.stat.isFile()) {
      entries.push({ name: childArchiveName, data: await readFile(found.path), date: found.stat.mtime });
    }
  }
}

async function readPageFiles(
  root: string,
  directory: string,
  files: ListedFile[],
  folderNames: boolean,
): Promise<ZipEntry[]> {
  const entries: ZipEntry[] = [];
  for (const file of files) {
    const found = await childPath(root, directory, file.fileName);
    if (file.folder === 'Folder' && folderNames) {
      await addDirectoryTree(root, found.path, file.fileName, entries, true);
    } else if (found.stat.isFile()) {
      entries.push({
        name: file.downloadName ?? file.fileName,
        data: await readFile(found.path),
        date: found.stat.mtime,
      });
    }
  }
  return entries;
}

async function deleteEntries(
  root: string,
  directory: string,
  names: string[],
  recursive: boolean,
  missingIsSuccess: boolean,
): Promise<string[]> {
  const failed: string[] = [];
  for (const name of names) {
    try {
      if (!safeName(name)) throw new InvalidFilePath('Invalid file name.');
      let found: { path: string; stat: Stats } | null;
      try {
        found = await childPath(root, directory, name);
      } catch (error) {
        if (missingIsSuccess && missing(error)) continue;
        throw error;
      }
      if (!found.stat.isFile() && !(recursive && found.stat.isDirectory()))
        throw new InvalidFilePath('Invalid file type.');
      if (found.stat.isDirectory()) await rm(found.path, { recursive: true });
      else await unlink(found.path);
    } catch {
      failed.push(name);
    }
  }
  return failed;
}

function sendZip(res: Response, fileName: string, entries: ZipEntry[]): unknown {
  return sendAttachment(res, fileName, 'application/zip', zipBuffer(entries));
}

function timestamp(date: Date): string {
  const two = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

export function registerSystemFiles(
  app: Express,
  db: pg.Pool,
  render: (res: Response, data: Record<string, unknown>) => unknown,
): void {
  const showError = (res: Response, section: string, title: string, error: string, status = 500) =>
    renderError(render, res, section, title, error, status);
  const accessibleRoots = (res: Response, section: string, title: string) =>
    loadAccessibleRoots(render, res, section, title);
  const permitted = (
    pool: pg.Pool,
    req: Request,
    res: Response,
    scope: Scope,
    action: Action,
    section: string,
    title: string,
  ) => checkPermission(render, pool, req, res, scope, action, section, title);
  app.get(`${routeRoot}/BackupFile`, async (req, res) => {
    const roots = await accessibleRoots(res, 'BackupFile', 'Backup file');
    if (!roots) return;
    const rawType = stringParam(req.query.type) || '0';
    const type = rawType === '0' ? 0 : rawType === '1' ? 1 : null;
    if (type === null) return showError(res, 'BackupFile', 'Backup file', 'Invalid backup file type.', 404);
    const fileTypeName = type === 0 ? 'Log' : 'Image';
    const section = type === 0 ? 'BackupLog' : 'BackupImage';
    const title = `Backup${fileTypeName}`;
    if (!(await permitted(db, req, res, 'system', 'read', 'BackupFile', title))) return;
    try {
      const enabled = await commonFlag(db, 'APP_STORAGE_MODE', type === 0 ? 'LOG' : 'IMAGE_BACKUP');
      if (!enabled) return showError(res, 'BackupFile', title, 'Backup files are unavailable.', 200);
      const query = pageQuery(req, req.query);
      const result = await backupDirectoryPage(
        type === 0 ? roots.backupLog : roots.backupImage,
        type,
        query.searchText,
        query.pageNo,
        query.pageSize,
      );
      if (result.totalItems > 0 && query.pageNo > Math.ceil(result.totalItems / query.pageSize))
        return res.redirect(`${routeRoot}/BackupFile?type=${type}`);
      const page = pagination(result.totalItems, query.pageNo, query.pageSize);
      const data = filePage('backup', section, title, 'BackupFile', query.searchText, page, result.files, {
        type,
        searchLabel: type === 0 ? 'Log file name' : 'Image file name',
        emptyMessage: 'Not exsist backup (0)',
        deleteErrorTitle: 'Failed to delete the following files',
        deleteConfirmMessage: 'Is it OK to delet the file?',
        hasPermissionToDelete: await hasSystemPermission(db, req.session?.userId ?? '', 'system', 'delete'),
        deleteErrors: takeDeleteErrors(req, `BackupFile:${type}`),
      });
      return show(render, res, data);
    } catch (error) {
      return showError(res, 'BackupFile', title, messageFor(error), statusFor(error));
    }
  });

  app.get(`${routeRoot}/DownloadBackupFile`, async (req, res) => {
    const roots = await accessibleRoots(res, 'BackupFile', 'Backup file');
    if (!roots) return;
    const type = stringParam(req.query.type) || '0';
    const fileType = type === '0' ? 0 : type === '1' ? 1 : null;
    if (fileType === null) return showError(res, 'BackupFile', 'Backup file', 'Invalid backup file type.', 404);
    if (!(await permitted(db, req, res, 'system', 'read', 'BackupFile', `Backup${fileType === 0 ? 'Log' : 'Image'}`)))
      return;
    try {
      const root = await existingRoot(fileType === 0 ? roots.backupLog : roots.backupImage);
      const name = stringParam(req.query.fileName);
      const file = await childPath(root, root, name);
      if (!file.stat.isFile()) throw new InvalidFilePath('Invalid file type.');
      if (fileType === 0) return sendAttachment(res, `${name}.log`, 'text/plain', await readFile(file.path));
      const thumbnail = await imageThumbnail(file.path);
      const downloadName = `${name}.${thumbnail.extension === 'jpeg' ? 'jpg' : thumbnail.extension}`;
      return sendAttachment(res, downloadName, `image/${thumbnail.extension}`, await readFile(file.path));
    } catch (error) {
      return showError(res, 'BackupFile', 'Backup file', messageFor(error), statusFor(error));
    }
  });

  app.get(`${routeRoot}/DownloadBackupFiles`, async (req, res) => {
    const roots = await accessibleRoots(res, 'BackupFile', 'Backup file');
    if (!roots) return;
    const typeValue = stringParam(req.query.type) || '0';
    const type = typeValue === '0' ? 0 : typeValue === '1' ? 1 : null;
    if (type === null) return showError(res, 'BackupFile', 'Backup file', 'Invalid backup file type.', 404);
    const title = `Backup${type === 0 ? 'Log' : 'Image'}`;
    if (!(await permitted(db, req, res, 'system', 'read', 'BackupFile', title))) return;
    try {
      const query = pageQuery(req, req.query);
      const result = await backupDirectoryPage(
        type === 0 ? roots.backupLog : roots.backupImage,
        type,
        query.searchText,
        query.pageNo,
        query.pageSize,
      );
      const entries: ZipEntry[] = [];
      for (const item of result.files) {
        const file = await childPath(result.root, result.root, item.fileName);
        if (file.stat.isFile())
          entries.push({ name: item.downloadName ?? item.fileName, data: await readFile(file.path), date: new Date() });
      }
      return sendZip(res, `${type === 0 ? 'Log' : 'Image'}_${timestamp(new Date())}.zip`, entries);
    } catch (error) {
      return showError(res, 'BackupFile', title, messageFor(error), statusFor(error));
    }
  });

  app.post(`${routeRoot}/DeleteBackupFile`, async (req, res) => {
    const roots = await accessibleRoots(res, 'BackupFile', 'Backup file');
    if (!roots) return;
    const typeValue = stringParam(req.body.type) || '0';
    const type = typeValue === '0' ? 0 : typeValue === '1' ? 1 : null;
    if (type === null) return showError(res, 'BackupFile', 'Backup file', 'Invalid backup file type.', 404);
    const title = `Backup${type === 0 ? 'Log' : 'Image'}`;
    if (!(await permitted(db, req, res, 'system', 'delete', 'BackupFile', title))) return;
    try {
      const query = pageQuery(req, req.body);
      const rawNames = req.body.fileNames;
      const names = (Array.isArray(rawNames) ? rawNames : [rawNames]).filter(
        (name): name is string => typeof name === 'string',
      );
      const rawRoot = type === 0 ? roots.backupLog : roots.backupImage;
      let root = resolve(rawRoot);
      try {
        root = await existingRoot(rawRoot);
      } catch (error) {
        if (!missing(error)) throw error;
      }
      const failed = await deleteEntries(root, root, names, false, true);
      if (req.session) req.session.systemFileDeleteErrors = { route: `BackupFile:${type}`, fileNames: failed };
      return res.redirect(
        indexUrl('BackupFile', { type, pageNo: query.pageNo, pageSize: query.pageSize, searchText: query.searchText }),
      );
    } catch (error) {
      return showError(res, 'BackupFile', title, messageFor(error), statusFor(error));
    }
  });

  app.get(`${routeRoot}/AutoOutputFile`, async (req, res) => {
    const roots = await accessibleRoots(res, 'AutoOutputFile', 'Auto output file');
    if (!roots) return;
    if (!(await permitted(db, req, res, 'data', 'read', 'AutoOutputFile', 'Auto output file'))) return;
    try {
      const requestedPath = stringParam(req.query.currentPath);
      const requestedNext = stringParam(req.query.nextPath);
      const root = await existingRoot(roots.autoOutput);
      let currentPath = requestedPath.trim() ? requestedPath : root;
      if (requestedPath.trim() && requestedNext.trim()) {
        if (!safeName(requestedNext)) throw new InvalidFilePath('Invalid folder name.');
        const parent = await existingPath(root, requestedPath);
        currentPath = join(parent.path, requestedNext);
      }
      const query = pageQuery(req, req.query);
      const result = await directoryPage(root, currentPath, query.searchText, query.pageNo, query.pageSize, true, true);
      if (result.totalItems > 0 && query.pageNo > Math.ceil(result.totalItems / query.pageSize))
        return res.redirect(`${routeRoot}/AutoOutputFile?currentPath=${encodeURIComponent(result.directory)}`);
      const data = filePage(
        'autoOutput',
        'AutoOutputFile',
        'Auto output file',
        'AutoOutputFile',
        query.searchText,
        pagination(result.totalItems, query.pageNo, query.pageSize),
        result.files,
        {
          rootFolder: root,
          currentPath: result.directory,
          parentPath: result.directory === root ? root : dirname(result.directory),
          searchLabel: 'Auto output file name',
          emptyMessage: 'Auto output file does not exist',
          deleteErrorTitle: 'Failed to delete the following items',
          deleteConfirmMessage: 'Is it OK to delet the file?',
          hasPermissionToDelete: await hasSystemPermission(db, req.session?.userId ?? '', 'data', 'delete'),
          deleteErrors: takeDeleteErrors(req, 'AutoOutputFile'),
        },
      );
      return show(render, res, data);
    } catch (error) {
      return showError(res, 'AutoOutputFile', 'Auto output file', messageFor(error), statusFor(error));
    }
  });

  app.get(`${routeRoot}/DownloadAutoOutputFile`, async (req, res) => {
    const roots = await accessibleRoots(res, 'AutoOutputFile', 'Auto output file');
    if (!roots) return;
    if (!(await permitted(db, req, res, 'data', 'read', 'AutoOutputFile', 'Auto output file'))) return;
    try {
      const root = await existingRoot(roots.autoOutput);
      const currentPath = stringParam(req.query.currentPath);
      if (!currentPath.trim()) throw new InvalidFilePath('Invalid folder path.');
      const fileName = stringParam(req.query.fileName);
      const file = await childPath(root, currentPath, fileName);
      if (!file.stat.isFile()) throw new InvalidFilePath('Invalid file type.');
      return sendAttachment(res, fileName, extensionContentType(fileName), await readFile(file.path));
    } catch (error) {
      return showError(res, 'AutoOutputFile', 'Auto output file', messageFor(error), statusFor(error));
    }
  });

  app.get(`${routeRoot}/DownloadAutoOutputFolder`, async (req, res) => {
    const roots = await accessibleRoots(res, 'AutoOutputFile', 'Auto output file');
    if (!roots) return;
    if (!(await permitted(db, req, res, 'data', 'read', 'AutoOutputFile', 'Auto output file'))) return;
    try {
      const root = await existingRoot(roots.autoOutput);
      const folderName = stringParam(req.query.folderName);
      const currentPath = stringParam(req.query.currentPath);
      if (!currentPath.trim()) throw new InvalidFilePath('Invalid folder path.');
      const folder = await childPath(root, currentPath, folderName);
      if (!folder.stat.isDirectory()) throw new InvalidFilePath('Invalid folder type.');
      const entries: ZipEntry[] = [];
      await addDirectoryTree(root, folder.path, folderName, entries, true);
      return sendZip(res, `AutoOutputFile_${folderName}_${timestamp(new Date())}.zip`, entries);
    } catch (error) {
      return showError(res, 'AutoOutputFile', 'Auto output file', messageFor(error), statusFor(error));
    }
  });

  app.get(`${routeRoot}/DownloadAutoOutputFiles`, async (req, res) => {
    const roots = await accessibleRoots(res, 'AutoOutputFile', 'Auto output file');
    if (!roots) return;
    if (!(await permitted(db, req, res, 'data', 'read', 'AutoOutputFile', 'Auto output file'))) return;
    try {
      const query = pageQuery(req, req.query);
      const currentPath = stringParam(req.query.currentPath);
      if (!currentPath.trim()) return sendZip(res, `AutoOutputFile_${timestamp(new Date())}.zip`, []);
      const result = await directoryPage(
        roots.autoOutput,
        currentPath,
        query.searchText,
        query.pageNo,
        query.pageSize,
        true,
        true,
      );
      const entries = await readPageFiles(result.root, result.directory, result.files, true);
      return sendZip(res, `AutoOutputFile_${timestamp(new Date())}.zip`, entries);
    } catch (error) {
      return showError(res, 'AutoOutputFile', 'Auto output file', messageFor(error), statusFor(error));
    }
  });

  app.post(`${routeRoot}/DeleteAutoOutputFile`, async (req, res) => {
    const roots = await accessibleRoots(res, 'AutoOutputFile', 'Auto output file');
    if (!roots) return;
    if (!(await permitted(db, req, res, 'data', 'read', 'AutoOutputFile', 'Auto output file'))) return;
    try {
      const query = pageQuery(req, req.body);
      const rawNames = req.body.fileNames;
      const names = (Array.isArray(rawNames) ? rawNames : [rawNames]).filter(
        (name): name is string => typeof name === 'string',
      );
      const currentPath = stringParam(req.body.currentPath);
      if (!currentPath.trim()) throw new InvalidFilePath('Invalid folder path.');
      const root = await existingRoot(roots.autoOutput);
      const failed = await deleteEntries(root, currentPath, names, true, false);
      if (req.session) req.session.systemFileDeleteErrors = { route: 'AutoOutputFile', fileNames: failed };
      return res.redirect(
        indexUrl('AutoOutputFile', {
          currentPath,
          pageNo: query.pageNo,
          pageSize: query.pageSize,
          searchText: query.searchText,
        }),
      );
    } catch (error) {
      return showError(res, 'AutoOutputFile', 'Auto output file', messageFor(error), statusFor(error));
    }
  });

  app.get(`${routeRoot}/ServerLogFile`, async (req, res) => {
    const roots = await accessibleRoots(res, 'ServerLogFile', 'Server log');
    if (!roots) return;
    if (!(await permitted(db, req, res, 'system', 'read', 'ServerLogFile', 'Server log'))) return;
    try {
      const query = pageQuery(req, req.query);
      const result = await directoryPage(
        roots.serverLog,
        roots.serverLog,
        query.searchText,
        query.pageNo,
        query.pageSize,
        false,
        false,
      );
      if (result.totalItems > 0 && query.pageNo > Math.ceil(result.totalItems / query.pageSize))
        return res.redirect(`${routeRoot}/ServerLogFile?rootPath=${encodeURIComponent(result.root)}`);
      const data = filePage(
        'serverLog',
        'ServerLogFile',
        'Server log',
        'ServerLogFile',
        query.searchText,
        pagination(result.totalItems, query.pageNo, query.pageSize),
        result.files,
        {
          rootPath: result.root,
          searchLabel: 'Server log name',
          emptyMessage: 'Server log file does not exist',
          deleteErrorTitle: 'Failed to delete the following server logs',
          deleteConfirmMessage: 'Is it OK to delet the file?',
          hasPermissionToDelete: await hasSystemPermission(db, req.session?.userId ?? '', 'system', 'delete'),
          deleteErrors: takeDeleteErrors(req, 'ServerLogFile'),
        },
      );
      return show(render, res, data);
    } catch (error) {
      return showError(res, 'ServerLogFile', 'Server log', messageFor(error), statusFor(error));
    }
  });

  app.get(`${routeRoot}/DownloadServerLogFile`, async (req, res) => {
    const roots = await accessibleRoots(res, 'ServerLogFile', 'Server log');
    if (!roots) return;
    if (!(await permitted(db, req, res, 'system', 'read', 'ServerLogFile', 'Server log'))) return;
    try {
      const root = await existingRoot(roots.serverLog);
      const fileName = stringParam(req.query.fileName);
      const requestedRoot = stringParam(req.query.rootPath);
      if (!requestedRoot.trim()) throw new InvalidFilePath('Invalid folder path.');
      const file = await childPath(root, requestedRoot, fileName);
      if (!file.stat.isFile()) throw new InvalidFilePath('Invalid file type.');
      return sendZip(res, `${fileName.replace(/\.[^.]*$/, '')}.zip`, [
        { name: fileName, data: await readFile(file.path), date: file.stat.mtime },
      ]);
    } catch (error) {
      return showError(res, 'ServerLogFile', 'Server log', messageFor(error), statusFor(error));
    }
  });

  app.get(`${routeRoot}/DownloadServerLogFiles`, async (req, res) => {
    const roots = await accessibleRoots(res, 'ServerLogFile', 'Server log');
    if (!roots) return;
    if (!(await permitted(db, req, res, 'system', 'read', 'ServerLogFile', 'Server log'))) return;
    try {
      const query = pageQuery(req, req.query);
      const requestedRoot = stringParam(req.query.rootPath);
      if (!requestedRoot.trim()) return sendZip(res, `ServerLog_${timestamp(new Date())}.zip`, []);
      const result = await directoryPage(
        roots.serverLog,
        requestedRoot,
        query.searchText,
        query.pageNo,
        query.pageSize,
        false,
        false,
      );
      const entries = await readPageFiles(result.root, result.directory, result.files, false);
      return sendZip(res, `ServerLog_${timestamp(new Date())}.zip`, entries);
    } catch (error) {
      return showError(res, 'ServerLogFile', 'Server log', messageFor(error), statusFor(error));
    }
  });

  app.post(`${routeRoot}/DeleteServerLogFile`, async (req, res) => {
    const roots = await accessibleRoots(res, 'ServerLogFile', 'Server log');
    if (!roots) return;
    if (!(await permitted(db, req, res, 'system', 'delete', 'ServerLogFile', 'Server log'))) return;
    try {
      const query = pageQuery(req, req.body);
      const rawNames = req.body.fileNames;
      const names = (Array.isArray(rawNames) ? rawNames : [rawNames]).filter(
        (name): name is string => typeof name === 'string',
      );
      const root = await existingRoot(roots.serverLog);
      const requestedRoot = stringParam(req.body.rootPath);
      if (!requestedRoot.trim()) throw new InvalidFilePath('Invalid folder path.');
      const failed = await deleteEntries(root, requestedRoot, names, false, true);
      if (req.session) req.session.systemFileDeleteErrors = { route: 'ServerLogFile', fileNames: failed };
      return res.redirect(
        indexUrl('ServerLogFile', {
          rootPath: requestedRoot,
          pageNo: query.pageNo,
          pageSize: query.pageSize,
          searchText: query.searchText,
        }),
      );
    } catch (error) {
      return showError(res, 'ServerLogFile', 'Server log', messageFor(error), statusFor(error));
    }
  });
}
