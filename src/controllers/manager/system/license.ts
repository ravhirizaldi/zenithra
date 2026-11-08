import type { Express, Request, Response } from 'express';
import type pg from 'pg';
import { XMLParser } from 'fast-xml-parser';
import { lstat, mkdir, readdir, readFile, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { legacyEncrypt } from '../../../shared/legacy-auth.js';
import {
  clientSettingsDirectory,
  edgeOcrLicense,
  licenseCounts,
  licenseStatus,
  nodeLicenseFile,
  parseLicenseFields,
  readLicenseFields,
} from '../../../shared/license-counts.js';
import { hasSystemPermission } from '../../../middleware/manager/system/permissions.js';

const root = '/ConMasManager/System';
const projectRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const legacySettingsRoot = resolve(projectRoot, 'legacy/SettingFiles');
const xmlParser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: false });

type LicenseCounts = Record<'User' | 'iPad' | 'Designer' | 'Type' | 'Scandit', number>;
type SizePart = { size: string; prettySize: string; gigabytes: string };
type StorageSnapshot = {
  type: string;
  measuredAt: string;
  hasIrepoId: boolean;
  database: SizePart | null;
  databaseLogic: SizePart | null;
  directory: SizePart | null;
  summary: SizePart | null;
  summaryLogic: SizePart | null;
};
type TemporaryStorage = { available: boolean; garbageSize: string; garbagePrettySize: string };
type UploadedFeature = { name: string; expires: string | null; limit: number | null };
type UploadedLicenseSummary = {
  user: number;
  freeDrawOnly: boolean;
  designer: number | null;
  ipad: number | null;
  type: string;
  definition: number | null;
  report: number | null;
  document: number | null;
  excel: boolean;
  tab: boolean;
  tabOptions: string[];
  expiration: string | null;
  expirationExpired: boolean;
  storage: number | null;
  freeDrawUser: number | null;
  iRepoChatUser: number | null;
  edgeOCRTokenId: string;
  edgeOCRLimit: number | null;
  features: UploadedFeature[];
};
type UploadedLicense = { summary: UploadedLicenseSummary; needsActivation: boolean };
type LicensePage = Record<string, unknown> & {
  mode: 'details' | 'storage' | 'upload' | 'error';
  fragment?: 'storage';
  error?: string;
  current?: {
    license: LicenseCounts;
    details: UploadedLicenseSummary;
    used: {
      user: number;
      designer: number;
      ipad: number;
      definition: number;
      report: number;
      document: number;
      amiVoice: number;
      freeDraw: number;
      scandit: number;
      iRepoChat: number;
      edgeOCR: number;
    };
  };
  uploaded?: UploadedLicenseSummary;
  fileHasUploaded?: boolean;
  uploadEnabled?: boolean;
  canUpload?: boolean;
  canCleanup?: boolean;
  storage?: StorageSnapshot | null;
  temporary?: TemporaryStorage;
  isCloud?: boolean;
};
type SessionWithLicense = NonNullable<Request['session']> & { uploadedSystemLicense?: string };
type UploadedFile = { buffer: Buffer; originalname: string; size: number; fieldname: string };
type RequestWithFiles = Request & { files?: Record<string, UploadedFile[]>; file?: UploadedFile };
type XmlRecord = Record<string, unknown>;

function record(value: unknown): XmlRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as XmlRecord) : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function sizePart(value: unknown): SizePart | null {
  const row = record(value);
  const size = stringValue(row?.size);
  const prettySize = stringValue(row?.prettySize);
  if (!/^\d+$/.test(size) || !prettySize) return null;
  const bytes = Number(size);
  if (!Number.isSafeInteger(bytes)) return null;
  return { size, prettySize, gigabytes: String(Number((bytes / 1073741824).toFixed(4))) };
}

function parseStorageSnapshot(xml: string): StorageSnapshot | null {
  try {
    const conmas = record(xmlParser.parse(xml)?.conmas);
    if (!conmas) return null;
    return {
      type: stringValue(conmas.type),
      measuredAt: stringValue(conmas.lastUpdateTime),
      hasIrepoId: conmas.irepoid !== undefined,
      database: sizePart(conmas.database),
      databaseLogic: sizePart(conmas.databaseLogic),
      directory: sizePart(conmas.directory),
      summary: sizePart(conmas.summary),
      summaryLogic: sizePart(conmas.summaryLogic),
    };
  } catch {
    return null;
  }
}

function dateOnly(value: string | undefined): { digits: string; display: string } | null {
  const match = value?.trim().match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { digits: match[1] + match[2] + match[3], display: `${match[1]}/${match[2]}/${match[3]}` };
}

function licenseNeedsActivation(expirationPresent: boolean, storage: number | null): boolean {
  return !expirationPresent && !(storage !== null && storage > 0);
}

export { licenseNeedsActivation };

function parseInteger(value: string | undefined): number | null {
  const normalized = value?.trim();
  if (!normalized || !/^-?\d+$/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isSafeInteger(number) ? number : null;
}

function parseDecimal(value: string | undefined): number | null {
  const normalized = value?.trim();
  if (!normalized || !/^-?(?:\d+\.?\d*|\.\d+)$/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function decodeXml(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe)
    return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff)
    return new TextDecoder('utf-16be').decode(buffer.subarray(2));
  if (buffer.length >= 4 && buffer[0] === 0x00 && buffer[1] === 0x3c) return new TextDecoder('utf-16be').decode(buffer);
  if (buffer.length >= 4 && buffer[0] === 0x3c && buffer[1] === 0x00) return new TextDecoder('utf-16le').decode(buffer);
  return new TextDecoder('utf-8').decode(buffer);
}

export function summarizeLicense(fields: Map<string, string>): UploadedLicense | null {
  const user = parseInteger(fields.get('User'));
  if (user === null) return null;
  const getInt = (name: string) => parseInteger(fields.get(name));
  const getDate = (...names: string[]) => {
    for (const name of names) {
      const value = dateOnly(fields.get(name));
      if (value) return value.display;
    }
    return null;
  };
  const now = new Date();
  const today = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const positive = (name: string) => (getInt(name) ?? 0) > 0;
  const features: UploadedFeature[] = [];
  const feature = (name: string, enabled: boolean, expiryKeys: string[] = [], limit: number | null = null) => {
    if (enabled) features.push({ name, expires: getDate(...expiryKeys), limit });
  };
  feature('API external system coordination', fields.get('ApiOption') !== '0');
  feature('Option for cooperation with MobileIron', fields.get('MobileIron') === '1');
  feature('Option for cooperation with BizMobile', fields.get('BizMobile') === '1');
  feature('Voice Input Option', positive('AmiVoice'), ['AmiVoiceExpire'], getInt('AmiVoice'));
  const airWatchExpiry = dateOnly(fields.get('AirWarchExpire'));
  feature('AirWatch license', positive('AirWatch') && (!airWatchExpiry || airWatchExpiry.digits >= today), [
    'AirWarchExpire',
  ]);
  feature('ConMas IoT Option', getInt('ConMasIoTGateway') === 1, ['ConMasIoTGatewayExpire']);
  feature('MappingTool License', getInt('MappingTool') === 1, ['MappingToolExpire']);
  feature('i-Repo WorkFlow Option', positive('WorkFlow'), ['WorkFlowExpire'], getInt('WorkFlow'));
  feature('i-Repo Project Option', getInt('nXProjectHub') === 1, ['nXProjectHubExpire']);
  feature('i-Repo FreeDraw option', positive('FreeDraw'), ['FreeDrawExprie'], getInt('FreeDraw'));
  feature('i-Repo Scan dedicated version', positive('i-RepoScanLimited'), [], getInt('i-RepoScanLimited'));
  const scanditLimit = positive('Scandit') ? getInt('Scandit') : getInt('i-RepoScanLimited');
  feature('i-Repo Scan option', (scanditLimit ?? 0) > 0, ['ScanditExpire', 'i-RepoScanLimitedExpire'], scanditLimit);
  feature('i-Repo Web Option', fields.get('i-RepoWeb') === '1', ['i-RepoWebExpire']);
  feature('i-Repo Chat Option', positive('i-RepoChat'), ['i-RepoChatExpire'], getInt('i-RepoChat'));
  feature('i-Repo Link Option', fields.get('i-RepoLink') === '1', ['i-RepoLinkExpire']);
  feature('Motionboard Cloud API Option', fields.get('MotionboardCloudAPIOption') === '1');
  feature('i-Repo EdgeOCR dedicated version', positive('i-RepoEdgeOCRLimited'), [], getInt('i-RepoEdgeOCRLimited'));
  const edge = edgeOcrLicense(fields);
  const edgeOcrLimit = edge.limit;
  const edgeOcrExpiry = edge.expires ? (dateOnly(edge.expires)?.display ?? null) : null;
  const edgeOcrToken = edge.token;
  if (edge.enabled) features.push({ name: 'EdgeOCR Option', expires: edgeOcrExpiry, limit: edgeOcrLimit });
  const storage = parseDecimal(fields.get('Strage'));
  const expiration = dateOnly(fields.get('Expiration')) ?? dateOnly(fields.get('FreeDrawOnlyExpire'));
  const tabLabels: Record<string, string> = {
    AutoGenerate: 'Automatic report creation',
    DataOutput: 'Data Output',
    Library: 'Library',
    Schdule: 'Schedule',
    CustomMaster: 'Custom Master',
  };
  const tabOptions = (fields.get('TabOption') ?? '')
    .split(',')
    .filter(Boolean)
    .map((option) => tabLabels[option])
    .filter((option): option is string => Boolean(option));
  return {
    needsActivation: licenseNeedsActivation(fields.has('Expiration'), storage),
    summary: {
      user,
      freeDrawOnly: fields.get('FreeDrawOnly') === '1',
      designer: getInt('Designer'),
      ipad: getInt('iPad'),
      type: fields.get('Type') ?? '',
      definition: getInt('Definition'),
      report: getInt('Report'),
      document: getInt('Document'),
      excel: fields.get('Excel') !== '0',
      tab: fields.get('Tab') === '1',
      tabOptions,
      expiration: expiration?.display ?? null,
      expirationExpired: expiration !== null && expiration.digits < today,
      storage,
      freeDrawUser: getInt('FreeDraw'),
      iRepoChatUser: getInt('i-RepoChat'),
      edgeOCRTokenId: edgeOcrToken.length > 7 ? `${edgeOcrToken.slice(0, 7)}...` : edgeOcrToken,
      edgeOCRLimit: edgeOcrLimit,
      features,
    },
  };
}

function windowsMachineGuid(): string | null {
  const executables =
    process.platform === 'win32'
      ? ['reg.exe']
      : ['/mnt/c/Windows/System32/reg.exe', '/mnt/c/Windows/Sysnative/reg.exe', 'reg.exe'];
  for (const executable of executables) {
    try {
      const output = execFileSync(
        executable,
        ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
        {
          encoding: 'utf8',
          timeout: 2000,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
      const value = output.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i)?.[1]?.trim() ?? '';
      if (/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value)) return value;
    } catch {
      /* Continue to the next Windows registry executable. */
    }
  }
  return null;
}

function licenseActivationError(fields: Map<string, string>, needsActivation: boolean): string {
  if (!needsActivation) return '';
  const activation = fields.get('Activate')?.trim();
  const allowDate = dateOnly(fields.get('ActivateAllowDate'));
  if (activation) {
    const machineGuid = windowsMachineGuid();
    if (!machineGuid) return 'The Windows MachineGuid could not be read on this host.';
    return activation === machineGuid ? '' : 'This license is activated for a different Windows MachineGuid.';
  }
  if (!allowDate) return 'The license activation information is invalid.';
  const now = new Date();
  const today = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  return allowDate.digits < today ? 'The license activation period has expired.' : '';
}

function parseUploadedLicense(
  xml: string,
  key: string,
): { license?: UploadedLicense; fields?: Map<string, string>; error?: string } {
  if (!key) return { error: 'License compatibility key is not configured.' };
  try {
    const fields = parseLicenseFields(xml, key);
    const license = summarizeLicense(fields);
    if (!license) return { error: 'The selected file is not a valid license.' };
    const activationError = licenseActivationError(fields, license.needsActivation);
    if (activationError) return { error: activationError };
    return { license, fields };
  } catch {
    return { error: 'The selected file is not a valid license.' };
  }
}

async function saveUploadedLicense(xml: string): Promise<void> {
  const directory = dirname(nodeLicenseFile);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
    throw new Error('The Node license directory is not safe.');
  const temporary = `${nodeLicenseFile}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporary, xml, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try {
    await rename(temporary, nodeLicenseFile);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function activateLicense(fields: Map<string, string>, key: string): string {
  const machineGuid = windowsMachineGuid();
  if (!machineGuid) throw new Error('The Windows MachineGuid could not be read on this host.');
  const entries = [...fields].filter(([name]) => name !== 'Activate' && name !== 'ActivateAllowDate');
  entries.push(['Activate', machineGuid]);
  const encrypted = legacyEncrypt(entries.map(([name, value]) => `${name}=${value}`).join(';'), key);
  return `<?xml version="1.0" encoding="utf-8"?>\n<ConMas>\n  <license>${encrypted}</license>\n</ConMas>`;
}

function fileFor(req: Request, field: string): UploadedFile | undefined {
  const uploadRequest = req as RequestWithFiles;
  const fieldFiles = uploadRequest.files?.[field];
  if (fieldFiles?.length) return fieldFiles[0];
  const singleFile = uploadRequest.file;
  return singleFile?.fieldname === field ? singleFile : undefined;
}

async function currentLicense(db: pg.Pool): Promise<NonNullable<LicensePage['current']>> {
  const fields = readLicenseFields();
  const details = summarizeLicense(fields)?.summary;
  if (!details) throw new Error('The current license is invalid.');
  const license = licenseCounts(fields);
  const [users, terminals, reports, definitions, documents, scandit] = await Promise.all([
    db.query<{ count: string; ami_voice: string; free_draw: string; irepo_chat: string }>(
      `SELECT
      count(1) FILTER (WHERE user_id <> $1)::text AS count,
      count(1) FILTER (WHERE user_id <> $1 AND amivoice_enable = '1')::text AS ami_voice,
      count(1) FILTER (WHERE irfd_enable = 1)::text AS free_draw,
      count(1) FILTER (WHERE irchat_enable = 1)::text AS irepo_chat
      FROM mst_user`,
      ['conmasadmin'],
    ),
    db.query<{ term_type: string; count: string }>(
      `SELECT term_type, count(1)::text AS count
      FROM mst_terminal WHERE deleted = 0 AND coalesce(approver, '') <> '' AND term_type IN ($1, $2) GROUP BY term_type`,
      ['iPad', 'Designer'],
    ),
    db.query<{ count: string }>('SELECT count(1)::text AS count FROM rep_current'),
    db.query<{ count: string }>('SELECT count(1)::text AS count FROM def_current'),
    db.query<{ count: string }>(`SELECT (SELECT count(1) FROM mst_common_document) +
      (SELECT count(1) FROM mst_report_document) AS count`),
    db.query<{ count: string }>('SELECT count(1)::text AS count FROM mst_terminal WHERE deleted = 0 AND scandit = 1'),
  ]);
  const edgeOCR = details.features.some((feature) => feature.name === 'EdgeOCR Option')
    ? Number(
        (await db.query<{ count: string }>('SELECT count(1)::text AS count FROM edgeocr_use_terminals')).rows[0]
          ?.count ?? 0,
      )
    : 0;
  const byType = new Map(terminals.rows.map((row) => [row.term_type, Number(row.count)]));
  return {
    license,
    details,
    used: {
      user: Number(users.rows[0]?.count ?? 0),
      designer: byType.get('Designer') ?? 0,
      ipad: byType.get('iPad') ?? 0,
      definition: Number(definitions.rows[0]?.count ?? 0),
      report: Number(reports.rows[0]?.count ?? 0),
      document: Number(documents.rows[0]?.count ?? 0),
      amiVoice: Number(users.rows[0]?.ami_voice ?? 0),
      freeDraw: Number(users.rows[0]?.free_draw ?? 0),
      scandit: Number(scandit.rows[0]?.count ?? 0),
      iRepoChat: Number(users.rows[0]?.irepo_chat ?? 0),
      edgeOCR,
    },
  };
}

export async function systemLicenseUploadingEnabled(db: pg.Pool): Promise<boolean> {
  const setting = await db.query<{ com_value: string }>(
    `SELECT com_value FROM mst_common
    WHERE com_key = $1 AND com_name = $2 ORDER BY com_index LIMIT 1`,
    ['SYSTEM', 'LICENSE_UPLOADING_IS_ENABLED'],
  );
  return setting.rows[0]?.com_value === '1';
}

async function allowed(db: pg.Pool, req: Request, action: 'read' | 'delete'): Promise<boolean> {
  const userId = req.session?.userId ?? '';
  return hasSystemPermission(db, userId, 'system', action);
}

async function pageData(db: pg.Pool, req: Request, mode: LicensePage['mode'], error = ''): Promise<LicensePage> {
  const details = mode === 'details';
  const [current, uploadEnabled, canUpload, canCleanup, storage, temporary] = await Promise.all([
    currentLicense(db),
    details ? Promise.resolve(false) : systemLicenseUploadingEnabled(db),
    details ? Promise.resolve(false) : allowed(db, req, 'read'),
    details ? allowed(db, req, 'delete') : Promise.resolve(false),
    details ? loadCachedStorage() : Promise.resolve(null),
    details ? temporaryStorage(db) : Promise.resolve(undefined),
  ]);
  return {
    mode,
    error,
    current,
    uploadEnabled,
    canUpload,
    canCleanup,
    storage,
    temporary,
    isCloud: process.env.CONMAS_PLATFORM?.toLowerCase() === 'cloud',
  };
}

function renderPage(
  res: Response,
  render: (res: Response, data: Record<string, unknown>) => unknown,
  page: LicensePage,
): unknown {
  return render(res, {
    active: 'System',
    section: 'License',
    login: false,
    title: page.mode === 'upload' ? 'License Update' : 'License',
    userName: res.locals.userName,
    systemLicensePage: page,
  });
}

async function settingsAndTempAvailable(): Promise<{ settings: string; temp: string } | null> {
  const settings = clientSettingsDirectory();
  if (!settings) return null;
  const temp = resolve(settings, 'temp');
  const historical = relative(legacySettingsRoot, temp);
  if (historical === '' || (!historical.startsWith(`..${sep}`) && historical !== '..')) return null;
  try {
    const details = await lstat(temp);
    if (!details.isDirectory() || details.isSymbolicLink()) return null;
    return { settings, temp };
  } catch {
    return null;
  }
}

type TempFile = { path: string; size: number; modified: number };

async function temporaryFiles(directory: string): Promise<{ files: TempFile[]; directories: string[] }> {
  const files: TempFile[] = [];
  const directories: string[] = [];
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      const path = resolve(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        directories.push(path);
        pending.push(path);
      } else if (entry.isFile()) {
        const details = await stat(path);
        files.push({ path, size: details.size, modified: details.mtimeMs });
      }
    }
  }
  return { files, directories };
}

async function retentionMinutes(db: pg.Pool): Promise<number> {
  const result = await db.query<{ com_value: string }>(
    `SELECT com_value FROM mst_common
    WHERE com_key = $1 AND com_name = $2 ORDER BY com_index LIMIT 1`,
    ['STRAGE_SETTING', 'TEMPORARY_RETENTION_PERIOD'],
  );
  const configured = result.rows[0]?.com_value?.trim() ?? '';
  if (!/^-?\d+$/.test(configured)) return 4320;
  const parsed = Number(configured);
  return Number.isSafeInteger(parsed) ? parsed : 4320;
}

async function prettySize(db: pg.Pool, bytes: string): Promise<string> {
  const result = await db.query<{ pretty_size: string }>('SELECT pg_size_pretty($1::numeric) AS pretty_size', [bytes]);
  return result.rows[0]?.pretty_size ?? `${bytes} bytes`;
}

async function temporaryStorage(db: pg.Pool): Promise<TemporaryStorage> {
  const location = await settingsAndTempAvailable();
  if (!location) return { available: false, garbageSize: '0', garbagePrettySize: '0 bytes' };
  const [files, retention] = await Promise.all([temporaryFiles(location.temp), retentionMinutes(db)]);
  const cutoff = Date.now() - retention * 60_000;
  const garbage = files.files.filter((file) => file.modified < cutoff);
  const garbageBytes = garbage.reduce((total, file) => total + file.size, 0);
  return {
    available: true,
    garbageSize: String(garbageBytes),
    garbagePrettySize: await prettySize(db, String(garbageBytes)),
  };
}

async function loadCachedStorage(): Promise<StorageSnapshot | null> {
  const settings = clientSettingsDirectory();
  if (!settings) return null;
  try {
    return parseStorageSnapshot(await readFile(resolve(settings, 'strageSizeTemporary.xml'), 'utf8'));
  } catch {
    return null;
  }
}

function xmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function storagePartXml(name: string, part: SizePart | null): string {
  return (
    '<' +
    name +
    '><size>' +
    (part?.size ?? '') +
    '</size><prettySize>' +
    xmlText(part?.prettySize ?? '') +
    '</prettySize></' +
    name +
    '>'
  );
}

async function saveCachedStorage(storage: StorageSnapshot): Promise<void> {
  const settings = clientSettingsDirectory();
  if (!settings) return;
  try {
    const directory = await lstat(settings);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return;
    const xml =
      '<conmas><type>' +
      xmlText(storage.type) +
      '</type>' +
      storagePartXml('database', storage.database) +
      storagePartXml('databaseLogic', storage.databaseLogic) +
      storagePartXml('directory', storage.directory) +
      storagePartXml('summary', storage.summary) +
      storagePartXml('summaryLogic', storage.summaryLogic) +
      '<lastUpdateTime>' +
      xmlText(storage.measuredAt) +
      '</lastUpdateTime></conmas>';
    const temporary = resolve(settings, 'strageSizeTemporary.' + randomBytes(8).toString('hex') + '.tmp');
    await writeFile(temporary, xml, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    try {
      await rename(temporary, resolve(settings, 'strageSizeTemporary.xml'));
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  } catch {
    // Like legacy, treat this file as a best-effort display cache.
  }
}

function partFromSize(size: string, pretty: string): SizePart | null {
  if (!/^\d+$/.test(size)) return null;
  const bytes = Number(size);
  if (!Number.isSafeInteger(bytes)) return null;
  return { size, prettySize: pretty, gigabytes: String(Number((bytes / 1073741824).toFixed(4))) };
}

async function storageDirectory(db: pg.Pool, settings: string, freeDrawOnly: boolean): Promise<string> {
  if (!freeDrawOnly) return dirname(settings);
  const configured = await db.query<{ com_value: string }>(
    'SELECT com_value FROM mst_common WHERE com_key = $1 AND com_name = $2 ORDER BY com_index LIMIT 1',
    ['LIBRARY', 'BASE_FOLDER'],
  );
  const baseFolder = configured.rows[0]?.com_value?.trim();
  if (baseFolder && isAbsolute(baseFolder)) {
    try {
      const details = await lstat(baseFolder);
      if (details.isDirectory() && !details.isSymbolicLink()) return baseFolder;
    } catch {
      /* Fall back to the legacy ClientSettings Library directory. */
    }
  }
  return resolve(settings, 'Library');
}

export async function directorySize(directory: string): Promise<string | null> {
  try {
    const rootInfo = await lstat(directory);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return null;
    const pending = [directory];
    let total = 0n;
    while (pending.length) {
      const current = pending.pop()!;
      for (const entry of await readdir(current, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const path = resolve(current, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'fonts' && entry.name !== 'logs') pending.push(path);
        } else if (entry.isFile()) {
          total += (await stat(path, { bigint: true })).size;
        }
      }
    }
    return total.toString();
  } catch {
    return null;
  }
}

async function totalPart(db: pg.Pool, parts: Array<SizePart | null>): Promise<SizePart | null> {
  const present = parts.filter((part): part is SizePart => part !== null);
  if (!present.length) return null;
  const size = present.reduce((total, part) => total + BigInt(part.size), 0n).toString();
  return partFromSize(size, await prettySize(db, size));
}

async function measureStorage(db: pg.Pool, freeDrawOnly: boolean): Promise<StorageSnapshot> {
  const setting = await db.query<{ com_value: string }>(
    `SELECT com_value FROM mst_common
    WHERE com_key = $1 AND com_name = $2 ORDER BY com_index LIMIT 1`,
    ['STRAGE_SETTING', 'DISPLAY_MODE'],
  );
  const type = setting.rows[0]?.com_value ?? '';
  let database: SizePart | null = null;
  let databaseLogic: SizePart | null = null;
  if (type === '0' || type === '2') {
    const result = await db.query<{
      size: string;
      pretty_size: string;
    }>(`SELECT pg_database_size(current_database())::text AS size,
      pg_size_pretty(pg_database_size(current_database())) AS pretty_size`);
    database = partFromSize(result.rows[0]?.size ?? '', result.rows[0]?.pretty_size ?? '');
    if (!database) throw new Error('Database storage size is unavailable.');
  }
  if (type === '1' || type === '2') {
    const result = await db.query<{
      size: string;
    }>(`SELECT SUM(cast(relpages as decimal(19,0)) * cast(8192 as decimal(19,0)) -
      (select free_space from pgstattuple(pg_stat_all_tables.relname)))::text AS size
      FROM pg_stat_all_tables INNER JOIN pg_class ON pg_stat_all_tables.relname = pg_class.relname
      WHERE pg_stat_all_tables.schemaname = 'public'`);
    const size = result.rows[0]?.size ?? '';
    if (!size) throw new Error('Database storage size is unavailable.');
    databaseLogic = partFromSize(size, await prettySize(db, size));
    if (!databaseLogic) throw new Error('Database storage size is unavailable.');
  }
  const settings = clientSettingsDirectory();
  const directoryPath = settings ? await storageDirectory(db, settings, freeDrawOnly) : null;
  const directoryBytes = directoryPath ? await directorySize(directoryPath) : null;
  const directory = directoryBytes === null ? null : partFromSize(directoryBytes, await prettySize(db, directoryBytes));
  const summary = await totalPart(db, [database, directory]);
  const summaryLogic = await totalPart(db, [databaseLogic, directory]);
  const now = new Date();
  const measuredAt = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  return { type, measuredAt, hasIrepoId: false, database, databaseLogic, directory, summary, summaryLogic };
}

async function disposeOfGarbage(db: pg.Pool): Promise<void> {
  const location = await settingsAndTempAvailable();
  if (!location) throw new Error('Temporary-file cleanup requires a configured legacy ClientSettings temp directory.');
  const [contents, retention] = await Promise.all([temporaryFiles(location.temp), retentionMinutes(db)]);
  const cutoff = Date.now() - retention * 60_000;
  for (const file of contents.files) {
    if (file.modified < cutoff) {
      try {
        await unlink(file.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  for (const directory of contents.directories.sort((left, right) => right.length - left.length)) {
    try {
      if ((await readdir(directory)).length === 0) await rmdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY')
        throw error;
    }
  }
}

async function renderStorageFragment(res: Response, page: LicensePage): Promise<unknown> {
  return res.render('manager/system/license', {
    base: '/ConMasManager',
    csrfToken: res.locals.csrfToken ?? '',
    systemLicensePage: { ...page, fragment: 'storage' },
  });
}

export function registerSystemLicense(
  app: Express,
  db: pg.Pool,
  render: (res: Response, data: Record<string, unknown>) => unknown,
): void {
  app.get(`${root}/DetailsLicense`, async (req, res) => {
    if (!(await allowed(db, req, 'read'))) return res.sendStatus(403);
    try {
      return renderPage(res, render, await pageData(db, req, 'details'));
    } catch {
      return res.status(503).send('License information is unavailable.');
    }
  });

  app.get(`${root}/DetailsStrageLicense`, async (req, res) => {
    if (!(await allowed(db, req, 'read'))) return res.sendStatus(403);
    let page: LicensePage;
    let freeDrawOnly = false;
    try {
      freeDrawOnly = licenseStatus().freeDrawOnly;
      const storage = await measureStorage(db, freeDrawOnly);
      await saveCachedStorage(storage);
      const temporary = await temporaryStorage(db);
      page = { mode: 'storage', storage, temporary, freeDrawOnly, canCleanup: await allowed(db, req, 'delete') };
    } catch {
      page = { mode: 'storage', error: 'Error.', canCleanup: false, storage: null, freeDrawOnly };
    }
    return renderStorageFragment(res, page);
  });

  app.post(`${root}/StorageCleanUp`, async (req, res) => {
    if (!(await allowed(db, req, 'delete'))) return res.sendStatus(403);
    try {
      await disposeOfGarbage(db);
      const [storage, temporary] = await Promise.all([loadCachedStorage(), temporaryStorage(db)]);
      return renderStorageFragment(res, {
        mode: 'storage',
        storage,
        temporary,
        freeDrawOnly: licenseStatus().freeDrawOnly,
        canCleanup: true,
      });
    } catch {
      return renderStorageFragment(res, { mode: 'storage', error: 'Error.', canCleanup: false });
    }
  });

  app.get(`${root}/UploadLicense`, async (req, res) => {
    if (!(await allowed(db, req, 'read'))) return res.sendStatus(403);
    const state = req.session as SessionWithLicense | undefined;
    if (state) delete state.uploadedSystemLicense;
    try {
      const page = await pageData(db, req, 'upload');
      if (!page.uploadEnabled)
        return renderPage(res, render, { ...page, mode: 'error', error: 'License uploading is disabled.' });
      return renderPage(res, render, page);
    } catch {
      return res.status(503).send('License information is unavailable.');
    }
  });

  app.post(`${root}/UploadLicense`, async (req, res) => {
    if (!(await allowed(db, req, 'read'))) return res.sendStatus(403);
    const action = typeof req.body?.act === 'string' ? req.body.act : '';
    try {
      const page = await pageData(db, req, 'upload');
      if (!page.uploadEnabled)
        return renderPage(res, render, { ...page, mode: 'error', error: 'License uploading is disabled.' });
      if (action === 'pdf') {
        const file = fileFor(req, 'pdfLicenseFile');
        if (!file || file.size === 0 || !file.originalname.toLowerCase().endsWith('.zip')) {
          return renderPage(res, render, { ...page, error: 'No PDF license file was uploaded.' });
        }
        if (process.env.CONMAS_PLATFORM?.toLowerCase() === 'cloud')
          return renderPage(res, render, {
            ...page,
            mode: 'error',
            error: 'PDF license upload is unavailable on the cloud platform.',
          });
        return res
          .status(503)
          .send(
            'PDF license upload requires the legacy Apryse PDFNet integration, which is not configured in this Node runtime.',
          );
      }
      if (action === 'upload') {
        const file = fileFor(req, 'uploadLicenseFile');
        if (!file || file.size === 0)
          return renderPage(res, render, { ...page, error: 'No license file was uploaded.' });
        const xml = decodeXml(file.buffer);
        const key = process.env.CONMAS_LICENSE_KEY ?? '';
        const parsed = parseUploadedLicense(xml, key);
        if (!parsed.license)
          return renderPage(res, render, {
            ...page,
            error: parsed.error ?? 'The selected file is not a valid license.',
          });
        const state = req.session as SessionWithLicense | undefined;
        if (!state) return res.status(503).send('License upload requires an active session.');
        state.uploadedSystemLicense = xml;
        return renderPage(res, render, { ...page, uploaded: parsed.license.summary, fileHasUploaded: true, error: '' });
      }
      if (action === 'fix') {
        const state = req.session as SessionWithLicense | undefined;
        const xml = state?.uploadedSystemLicense;
        if (!xml) return renderPage(res, render, { ...page, error: 'No license file was uploaded.' });
        const key = process.env.CONMAS_LICENSE_KEY ?? '';
        const parsed = parseUploadedLicense(xml, key);
        if (!parsed.license || !parsed.fields)
          return renderPage(res, render, {
            ...page,
            error: parsed.error ?? 'The selected file is not a valid license.',
          });
        await saveUploadedLicense(parsed.license.needsActivation ? activateLicense(parsed.fields, key) : xml);
        delete state.uploadedSystemLicense;
        return res.redirect(`${root}/DetailsLicense`);
      }
      return renderPage(res, render, { ...page, mode: 'error', error: 'Invalid license action.' });
    } catch {
      return res.status(503).send('License upload could not be completed.');
    }
  });
}
