import type pg from 'pg';
import { mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { clientError } from '../services/client-xml.js';
import { readLicenseFields } from '../shared/license-counts.js';
import { query, queryDocument } from './client-definitions.js';
import { getReportDownload, ReportUnsupported, type ReportActor } from './client-reports.js';
import { clientConfiguration } from '../config/client.js';
import { directIsLinked } from '../controllers/manager/system/direct.js';
import { setReportAuditFields, setReportName } from './client-report-name.js';
import { createReportAutoLabels, updateReportAutoLabels } from './client-report-labels.js';
import { checkReportTables, reportTableValue, saveReportTables } from './client-report-tables.js';
import { reportApplicantLocked } from './client-report-lock.js';
import { documentAdministratorId } from './manager/documents/details.js';
import { documentSaveNumbering } from './manager/documents/numbering.js';
import { documentRefreshThumbnail } from './manager/documents/thumbnail.js';
import {
  child,
  children,
  content,
  element,
  field,
  integer,
  integerField,
  must,
  optionalField,
  remove,
  replace,
  root,
  serialize,
  tag,
  value,
  type XmlNode,
} from './client-definition-xml.js';

export interface ReportUpload {
  directory: string;
  top: string;
  baseline: string;
  sourceXml: string;
  sourceId: number;
  definition: boolean;
  sheets: Record<string, { xml: string; files: Record<string, string> }>;
  files: Record<string, string>;
  fdInfo?: string;
  fdFiles: Record<string, { pdf?: string; irfd?: string; deleted?: boolean }>;
  result?: string;
}
export interface ReportSheetDiagnostic {
  sheetNo?: number;
  defSheetId?: number;
  clusters?: number;
  reason?: string;
  clusterId?: number;
  field?: string;
}
const queries = () => queryDocument('ReportBiz.xml').baseQuery as Record<string, Record<string, string>>;
const binaries = ['FixedText', 'FreeText', 'FreeDraw', 'DrawingImage', 'Image', 'AudioRecording'];
const approvalTypes = ['Create', 'Inspect', 'Approve'];
const approvalFields = ['approver', 'approverName', 'approvalDate', 'approverComment', 'approvalSignImage'];
const applicantFields = ['applicant', 'applicantName', 'applicationDate', 'applicantComment'];
const remarks = (node: XmlNode, prefix: string) =>
  Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [
      [prefix + '_remarks_name' + (i + 1), optionalField(node, 'remarksName' + (i + 1))],
      [prefix + '_remarks' + (i + 1), optionalField(node, 'remarksValue' + (i + 1))],
    ]).flat(),
  );
function merge(target: XmlNode, source: XmlNode, names: string[]): void {
  for (const name of names) if (child(source, name)) replace(target, name, field(source, name));
}
const remarkValues = Array.from({ length: 10 }, (_, i) => 'remarksValue' + (i + 1));
function binary(text: string): Buffer | null {
  if (!text) return null;
  const result = Buffer.from(text, 'base64');
  if (result.toString('base64') !== text) throw new Error('Invalid report binary.');
  return result;
}
export async function cleanupReportUpload(upload?: ReportUpload): Promise<void> {
  if (upload) await rm(upload.directory, { recursive: true, force: true });
}
export async function checkReportSaveFeatures(
  db: Pick<pg.PoolClient, 'query'>,
  top: XmlNode,
  editStatus = field(top, 'editStatus'),
  numberingSupported = false,
): Promise<void> {
  // shortcut: feature pipelines remain separate work; reject them before success until all required side effects are ported.
  await checkReportTables(db, top);
  const reportId = integer(optionalField(top, 'repTopId'));
  if (
    reportId &&
    (
      await db.query(
        'SELECT 1 FROM binder_rep_src src JOIN rep_top rep ON rep.rep_top_org=src.rep_top_org WHERE rep.rep_top_id=$1 LIMIT 1',
        [reportId],
      )
    ).rowCount
  )
    throw new ReportUnsupported(
      'Binder report mapping/recalculation is not implemented.',
      'report_binder_mapping',
      integerField(top, 'defTopId'),
    );
  const systemHistory = (
    await db.query(
      "SELECT com_value FROM mst_common WHERE com_key='HISTORY_SETTING' AND com_name='ENABLE' AND com_index=0",
    )
  ).rows[0]?.com_value;
  if (['1', '2'].includes(optionalField(top, 'useInputHistory')) || ['1', '2'].includes(systemHistory)) {
    const trigger = await db.query(
      `SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE t.tgrelid='rep_cluster'::regclass AND NOT t.tgisinternal AND t.tgenabled IN ('O','A')
      AND p.proname='func_rep_cluster_trigger' AND (t.tgtype::int & 21)=21`,
    );
    if (!trigger.rowCount)
      throw new ReportUnsupported('Report history trigger is unavailable.', 'report_history_trigger');
  }
  for (const name of ['journalizingDefTopId', 'useAutoNumbering']) {
    if (name === 'useAutoNumbering' && numberingSupported) continue;
    const value = optionalField(top, name);
    if (value && !['0', '-1'].includes(value))
      throw new ReportUnsupported('Report feature is not implemented: ' + name, 'report_feature_' + name);
  }
  for (const name of ['completeMail', 'editMail'])
    if (optionalField(top, name).trim())
      throw new ReportUnsupported('Report mail delivery is not implemented.', 'report_mail');
  const complete = editStatus === '4',
    event = complete ? 'Complete' : 'Edit';
  const output = (
    await db.query(
      "SELECT com_name,com_value FROM mst_common WHERE com_key='OUTPUT_SETTING' AND com_name IN ('TMP_XML','FINISH','EDIT') ORDER BY com_index",
    )
  ).rows;
  const outputValue = (name: string) =>
    String(output.find((row) => row.com_name === name)?.com_value ?? '')
      .trim()
      .toLowerCase();
  const temporary = outputValue('TMP_XML');
  if (!['true', 'false'].includes(temporary)) throw new Error('Invalid report temporary-XML setting.');
  if (temporary === 'true')
    throw new ReportUnsupported('Report temporary-XML output is not implemented.', 'report_output_temporary');
  const enabled = outputValue(complete ? 'FINISH' : 'EDIT');
  // ReportBiz defaults malformed/missing FINISH to true and EDIT to false.
  if (enabled === 'true' || (complete && enabled !== 'false'))
    throw new ReportUnsupported('Report file output is not implemented.', 'report_output_' + event.toLowerCase());
  const mail = (await db.query('SELECT xml_data FROM mst_mail WHERE mail_file_name=$1', ['Mail' + event + '.xml']))
    .rows[0]?.xml_data;
  if (mail && (root(mail)[':@'] as Record<string, string> | undefined)?.['@_default'])
    throw new ReportUnsupported('Default report mail delivery is not implemented.', 'report_mail_default');
  const management = child(top, 'management');
  if (
    management &&
    ['completeDirect', 'editDirect', 'completeWebhook', 'editWebhook'].some((name) =>
      optionalField(management, name).trim(),
    )
  )
    throw new ReportUnsupported('Report notifications are not implemented.', 'report_notifications');
  if (await directIsLinked(db as pg.Pool)) {
    const setting = (await db.query('SELECT xml_data FROM mst_direct WHERE key=$1', [event])).rows[0]?.xml_data;
    // shortcut: configured linked defaults are refused even with a disabled event; refine when report delivery is ported.
    if (setting && optionalField(root(setting), 'defaultTemplateId'))
      throw new ReportUnsupported('Default report direct notification is not implemented.', 'report_direct_default');
  }
  for (const sheet of children(must(top, 'sheets'), 'sheet'))
    for (const cluster of children(must(sheet, 'clusters'), 'cluster')) {
      const type = field(cluster, 'type');
      if (type === 'AutoNumbering')
        throw new ReportUnsupported(
          'Server cluster pipeline is not implemented: ' + type,
          'report_cluster_' + type,
          integerField(top, 'defTopId'),
        );
      if (/AutoNumbering=1/.test(optionalField(cluster, 'inputParameters')))
        throw new ReportUnsupported(
          'Server cluster pipeline is not implemented: AutoNumbering',
          'report_cluster_AutoNumbering',
        );
      const management = child(cluster, 'management');
      if (
        management &&
        ['mail', 'direct', 'webhook'].some((name) => child(management, name) && value(must(management, name)).trim())
      )
        throw new ReportUnsupported('Cluster notifications are not implemented.', 'report_cluster_notifications');
    }
}
async function calculateLimits(
  db: Pick<pg.PoolClient, 'query'>,
  actor: ReportActor,
  top: XmlNode,
  sheet: XmlNode,
  incoming: XmlNode,
): Promise<string | undefined> {
  const mode = optionalField(top, 'cooperationTable');
  if (!['1', '2'].includes(mode)) return;
  const setting = (
    await db.query(
      "SELECT com_value FROM mst_common WHERE com_key='CONMAS_FUNCTION' AND com_name='CALCULATE_MAXMIN_VALID' ORDER BY com_index LIMIT 1",
    )
  ).rows[0]?.com_value;
  if (setting !== '3' && setting !== (actor.platform === 'Windows' ? '2' : '1')) return;
  const decimal = (raw: string) =>
    /[()]/.test(raw)
      ? null
      : reportTableValue(
          element('cluster', [element('type', 'Calculate'), element('value', raw)]),
          'N',
          actor.cultureName || 'en-US',
        );
  for (const submitted of children(must(incoming, 'clusters'), 'cluster')) {
    const cluster = children(must(sheet, 'clusters'), 'cluster').find(
      (node) => field(node, 'clusterId') === field(submitted, 'clusterId'),
    );
    if (
      !cluster ||
      field(cluster, 'type') !== 'Calculate' ||
      (mode === '2' && optionalField(cluster, 'cooperationCluster') !== '1')
    )
      continue;
    const parameters = optionalField(cluster, 'inputParameters'),
      pairs = parameters.split(';').map((pair) => pair.split('='));
    const dataType = pairs.filter((pair) => pair[0] === 'DataType').at(-1)?.[1];
    if (!parameters || dataType === '1' || dataType === '2') continue;
    const number = decimal(optionalField(submitted, 'value'));
    if (number === null) continue;
    let maximum = '0',
      minimum = '0';
    for (const [name, raw] of pairs)
      if ((name === 'Maximum' || name === 'Minimum') && raw) {
        const parsed = decimal(raw);
        if (parsed === null) continue;
        if (name === 'Maximum') maximum = parsed;
        else minimum = parsed;
      }
    // Use exact SQL decimals, not JavaScript floats, for the source's decimal comparisons.
    const result = (
      await db.query(
        `SELECT abs($1::numeric)<=79228162514264337593543950335 AS valid,
      ($1::numeric>$2::numeric OR $1::numeric>999999999) AS maximum,
      ($1::numeric<$3::numeric OR $1::numeric< -999999999) AS minimum`,
        [number, maximum, minimum],
      )
    ).rows[0];
    if (result.valid && (result.maximum || result.minimum))
      return clientError(
        10,
        `The value of sheet number ${field(sheet, 'sheetNo')}, ${field(cluster, 'name')} ${result.maximum ? 'exceeded the maximum value.' : 'is less than the minimum value.'}`,
      );
  }
}
function filesByName(
  files: Express.Multer.File[],
  allowed: (name: string) => boolean,
): Map<string, Express.Multer.File> {
  const named = new Map<string, Express.Multer.File>();
  for (const file of files) {
    if (named.has(file.fieldname) || !allowed(file.fieldname)) throw new Error('Invalid report multipart field.');
    named.set(file.fieldname, file);
  }
  return named;
}
async function retain(
  files: Map<string, Express.Multer.File>,
  directory: string,
  prefix: string,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [name, file] of files)
    if (name !== 'report' && name !== 'pageOrder') {
      const path = join(directory, prefix + '_' + name);
      await rename(file.path, path);
      result[name] = path;
    }
  return result;
}
export async function beginReportUpload(
  db: pg.Pool,
  actor: ReportActor,
  files: Express.Multer.File[],
): Promise<ReportUpload | string> {
  const named = filesByName(files, (name) => ['report', 'thumbnail'].includes(name));
  if (!named.has('report')) return clientError(2);
  const document = root(await readFile(named.get('report')!.path, 'utf8'));
  if (tag(document) !== 'conmas') return clientError(2);
  const top = must(document, 'top'),
    repText = optionalField(top, 'repTopId'),
    repId = repText ? integer(repText) : 0,
    defId = integerField(top, 'defTopId');
  if (repId === undefined || repId < 0) return clientError(2);
  if (!['0', '1', '2', '3', '4'].includes(field(top, 'editStatus'))) return clientError(2);
  if (children(must(top, 'sheets'), 'sheet').length) return clientError(2);
  const appId = optionalField(top, 'repTopAppId');
  const previous = appId
    ? (await db.query('SELECT rep_top_id FROM rep_top_app WHERE rep_top_app_id=$1', [appId])).rows[0]?.rep_top_id
    : undefined;
  const sourceId = previous ?? (repId || defId),
    definition = !previous && !repId;
  const source = await getReportDownload(db, actor, { topId: String(sourceId) }, definition, false);
  if (typeof source === 'string') return source;
  const sourceTop = must(root(source.xml), 'top');
  if (integerField(sourceTop, 'defTopId') !== defId) return clientError(2);
  if (!definition && field(sourceTop, 'editStatus') === '4') return clientError(1110, 'Report completed.');
  if (!definition && field(sourceTop, 'readOnly') === '1') return clientError(3);
  await checkReportSaveFeatures(db, sourceTop, field(top, 'editStatus'), true);
  const directory = await mkdtemp(join(tmpdir(), 'conmas-report-'));
  try {
    const raw = (
      await db.query(
        `SELECT xml_data FROM ${definition ? 'def_top' : 'rep_top'} WHERE ${definition ? 'def_top_id' : 'rep_top_id'}=$1`,
        [sourceId],
      )
    ).rows[0];
    return {
      directory,
      top: serialize(top),
      baseline: source.xml,
      sourceXml: raw.xml_data,
      sourceId,
      definition,
      sheets: {},
      files: await retain(named, directory, 'top'),
      fdFiles: {},
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
export async function stageReportSheet(
  db: pg.Pool,
  actor: ReportActor,
  upload: ReportUpload,
  files: Express.Multer.File[],
  diagnostic: ReportSheetDiagnostic = {},
): Promise<string> {
  const invalid = (reason: string, code = 2, clusterId?: number, field?: string) => {
    Object.assign(diagnostic, { reason, clusterId, field });
    return clientError(code);
  };
  if (upload.result) return invalid('already_committed');
  const named = filesByName(
    files,
    (name) =>
      ['report', 'thumbnail', 'inputImage'].includes(name) ||
      /^(?:cluster|layer)_\d+_(?:value|displayValue|sound|image_\d+)$/.test(name),
  );
  if (!named.has('report')) return invalid('missing_report');
  const document = root(await readFile(named.get('report')!.path, 'utf8'));
  if (tag(document) !== 'conmas') return invalid('invalid_envelope');
  const sheet = must(document, 'sheet'),
    number = integerField(sheet, 'sheetNo');
  diagnostic.sheetNo = number;
  diagnostic.defSheetId = integerField(sheet, 'defSheetId');
  if (optionalField(sheet, 'sheetNoOrg') && integer(optionalField(sheet, 'sheetNoOrg')) !== number)
    throw new ReportUnsupported('Sheet duplication/reordering is not implemented.', 'report_sheet_order');
  const original = children(must(must(root(upload.baseline), 'top'), 'sheets'), 'sheet').find(
    (item) => integerField(item, 'sheetNo') === number,
  );
  if (!original || integerField(sheet, 'defSheetId') !== integerField(original, 'defSheetId'))
    return invalid('unknown_sheet');
  const clusters = children(must(sheet, 'clusters'), 'cluster'),
    seen = new Set<number>();
  diagnostic.clusters = clusters.length;
  for (const cluster of clusters) {
    const id = integerField(cluster, 'clusterId'),
      target = children(must(original, 'clusters'), 'cluster').find((node) => integerField(node, 'clusterId') === id);
    if (seen.has(id) || !target) return invalid(seen.has(id) ? 'duplicate_cluster' : 'unknown_cluster', 2, id);
    seen.add(id);
    for (const name of ['verified', 'isHidden'])
      if (child(cluster, name) && !['', '0', '1'].includes(field(cluster, name)))
        return invalid('invalid_cluster_flag', 2, id, name);
    if (optionalField(target, 'readOnly') === '1' || optionalField(target, 'hide') === '1')
      return invalid('cluster_permission', 3, id);
  }
  const layers = child(sheet, 'layers') ? children(must(sheet, 'layers'), 'layer') : [],
    layerIds = new Set<number>();
  for (const layer of layers) {
    const id = integerField(layer, 'layerNo');
    if (
      layerIds.has(id) ||
      !child(original, 'layers') ||
      !children(must(original, 'layers'), 'layer').some((node) => integerField(node, 'layerNo') === id)
    )
      return invalid('invalid_layer');
    layerIds.add(id);
  }
  for (const name of named.keys()) {
    const match = /^(cluster|layer)_(\d+)_/.exec(name);
    if (!match) continue;
    const suffix = name.slice(match[0].length);
    if (match[1] === 'layer') {
      if (
        suffix === 'sound' ||
        !child(original, 'layers') ||
        !children(must(original, 'layers'), 'layer').some((layer) => field(layer, 'layerNo') === match[2])
      )
        return invalid('invalid_layer_file', 2, undefined, name);
    } else {
      if (!seen.has(Number(match[2]))) return invalid('file_without_cluster', 2, Number(match[2]), name);
      const target = children(must(original, 'clusters'), 'cluster').find(
          (node) => field(node, 'clusterId') === match[2],
        )!,
        type = field(target, 'type');
      // Windows can send image displayValue previews; RegistSheet ignores them unless FixedText/FreeDraw.
      if (
        !binaries.includes(type) ||
        (suffix === 'sound' && type !== 'AudioRecording') ||
        (suffix.startsWith('image_') && type !== 'FreeDraw') ||
        (suffix === 'value' && type === 'AudioRecording')
      )
        return invalid('invalid_cluster_file', 2, Number(match[2]), name);
    }
  }
  const limitError = await calculateLimits(db, actor, must(root(upload.baseline), 'top'), original, sheet);
  if (limitError) {
    diagnostic.reason = 'calculate_limits';
    return limitError;
  }
  const directory = await mkdtemp(join(upload.directory, 'sheet_' + number + '_'));
  const retained = await retain(named, directory, 'parts');
  upload.sheets[String(number)] = { xml: serialize(sheet), files: retained };
  return clientError(0);
}
export async function stageReportFreeDrawInfo(upload: ReportUpload, files: Express.Multer.File[]): Promise<string> {
  if (upload.result) return clientError(2);
  const named = filesByName(files, (name) => name === 'pageOrder'),
    file = named.get('pageOrder');
  const xml = file?.size ? await readFile(file.path, 'utf8') : '';
  if (xml) {
    const document = root(xml);
    if (tag(document) !== 'conmas') return clientError(2);
    const numbers = new Set<number>(),
      indexes = new Set<number>();
    for (const sheet of children(must(document, 'sheets'), 'sheet')) {
      const number = integerField(sheet, 'fdSheetNo'),
        index = integerField(sheet, 'sheetIndex');
      if (number < 1 || index < 1 || numbers.has(number) || indexes.has(index)) return clientError(2);
      numbers.add(number);
      indexes.add(index);
    }
  }
  upload.fdInfo = xml;
  upload.fdFiles = {};
  return clientError(0);
}
export async function stageReportFreeDraw(
  upload: ReportUpload,
  files: Express.Multer.File[],
  numberText: string,
  isDelete: string,
): Promise<string> {
  if (upload.result || upload.fdInfo === undefined) return clientError(2);
  const number = integer(numberText);
  if (number === undefined || number < 1 || !['0', '1'].includes(isDelete)) return clientError(2);
  const named = filesByName(files, (name) => ['pdfFile', 'irfdFile'].includes(name));
  if (isDelete === '1') upload.fdFiles[number] = { deleted: true };
  else {
    if (!named.get('pdfFile')?.size || !named.get('irfdFile')?.size) return clientError(2);
    const directory = await mkdtemp(join(upload.directory, 'fd_' + number + '_'));
    const paths = await retain(named, directory, 'parts');
    upload.fdFiles[number] = { pdf: paths.pdfFile, irfd: paths.irfdFile };
  }
  return clientError(0);
}

const finishing = new Map<string, Promise<string>>();
export async function finishReportUpload(
  db: pg.Pool,
  actor: ReportActor,
  upload: ReportUpload,
  unlock = true,
): Promise<string> {
  // Express loads separate session objects for simultaneous requests; share the commit/result by stage identity.
  if (!finishing.has(upload.directory)) {
    const result = commitReportUpload(db, actor, upload, unlock);
    finishing.set(upload.directory, result);
    void result.then(
      () => {
        if (!upload.result) finishing.delete(upload.directory);
        else {
          const timer = setTimeout(() => finishing.delete(upload.directory), clientConfiguration().idleMs);
          timer.unref();
        }
      },
      () => finishing.delete(upload.directory),
    );
  }
  const result = await finishing.get(upload.directory)!;
  if (/<code>0<\/code>/.test(result)) upload.result = result;
  return result;
}
async function commitReportUpload(
  db: pg.Pool,
  actor: ReportActor,
  upload: ReportUpload,
  unlock: boolean,
): Promise<string> {
  if (upload.result) return upload.result;
  const client = await db.connect(),
    sql = queries();
  try {
    await client.query('BEGIN');
    // One session-stage cannot be committed twice by simultaneous finish requests.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [upload.directory]);
    const current = (
      await client.query(
        `SELECT xml_data${upload.definition ? '' : ',auto_numbering_value,auto_numbering_message,auto_numbering_save_count,auto_numbering_display_save_count'} FROM ${upload.definition ? 'def_top' : 'rep_top'} WHERE ${upload.definition ? 'def_top_id' : 'rep_top_id'}=$1 FOR UPDATE`,
        [upload.sourceId],
      )
    ).rows[0];
    if (!current || current.xml_data !== upload.sourceXml) {
      await client.query('ROLLBACK');
      return clientError(1010, 'Source changed during upload.');
    }
    const dbInTransaction = {
      query: client.query.bind(client),
      connect: async () => ({ query: client.query.bind(client), release() {} }),
    } as unknown as pg.Pool;
    if (upload.result) {
      await client.query('ROLLBACK');
      return upload.result;
    }
    const source = await getReportDownload(
      dbInTransaction,
      actor,
      { topId: String(upload.sourceId) },
      upload.definition,
      false,
    );
    if (typeof source === 'string') {
      await client.query('ROLLBACK');
      return source;
    }
    const document = root(source.xml),
      top = must(document, 'top'),
      submitted = root(upload.top);
    if (!upload.definition && field(top, 'editStatus') === '4') {
      await client.query('ROLLBACK');
      return clientError(1110, 'Report completed.');
    }
    if (!upload.definition && field(top, 'readOnly') === '1') {
      await client.query('ROLLBACK');
      return clientError(3);
    }
    await checkReportSaveFeatures(client, top, field(submitted, 'editStatus'), true);
    const sheets = children(must(top, 'sheets'), 'sheet');
    if (sheets.some((sheet) => !upload.sheets[field(sheet, 'sheetNo')])) {
      await client.query('ROLLBACK');
      return clientError(2, 'Missing report sheet.');
    }
    const oldTop = must(root(upload.baseline), 'top');
    if (!upload.definition && optionalField(oldTop, 'updateTime') !== optionalField(top, 'updateTime')) {
      await client.query('ROLLBACK');
      return clientError(1010, 'Report changed during upload.');
    }
    const locks = (
      await client.query('SELECT user_id,sys_regist_term FROM rep_lock WHERE rep_top_id=$1', [
        upload.definition ? 0 : upload.sourceId,
      ])
    ).rows;
    if (locks.some((row) => row.user_id !== actor.userId && row.sys_regist_term !== actor.terminalId)) {
      await client.query('ROLLBACK');
      return clientError(1010);
    }
    const now = new Date(),
      audit = {
        sys_regist_term: actor.terminalId,
        sys_regist_user: actor.userId,
        sys_regist_time: now,
        sys_update_term: actor.terminalId,
        sys_update_user: actor.userId,
        sys_update_time: now,
      };
    const previousTop = root(serialize(top));
    const account = (
        await client.query('SELECT user_name,approval_sign FROM mst_user WHERE user_id=$1', [actor.userId])
      ).rows[0],
      user = account?.user_name ?? '';
    let id = upload.sourceId;
    if (upload.definition) {
      await client.query('LOCK TABLE rep_top IN SHARE ROW EXCLUSIVE MODE');
      const limit = integer(readLicenseFields().get('Report') ?? '');
      const count = Number(
        (
          await client.query(
            'SELECT COUNT(*) FROM rep_current cur JOIN rep_top rep ON cur.rep_top_id=rep.rep_top_id WHERE rep.deleted=0',
          )
        ).rows[0].count,
      );
      if (limit !== undefined && count >= limit) {
        await client.query('ROLLBACK');
        return clientError(11050, 'report license error.');
      }
      id = Number((await client.query("SELECT nextval('rep_top_rep_top_id_seq') AS id")).rows[0].id);
      replace(top, 'repTopId', String(id));
      replace(top, 'repTopOrg', String(id));
      for (const name of ['registUser', 'updateUser']) replace(top, name, actor.userId);
      for (const name of ['registUserName', 'updateUserName']) replace(top, name, user);
      replace(top, 'registTime', formatDate(now));
      for (let i = 1; i <= 5; i++) replace(top, 'systemKey' + i, '');
      for (const sheet of sheets)
        replace(
          sheet,
          'repSheetId',
          String((await client.query("SELECT nextval('rep_sheet_rep_sheet_id_seq') AS id")).rows[0].id),
        );
    }
    replace(top, 'updateTime', formatDate(now));
    replace(top, 'updateUser', actor.userId);
    replace(top, 'updateUserName', user);
    merge(top, submitted, ['repTopName', 'editStatus', 'displaySheetNumber', ...remarkValues]);
    const display = optionalField(top, 'displaySheetNumber');
    if (
      display &&
      (display.split(',').length !== sheets.length ||
        sheets.some((sheet) => !display.split(',').includes(field(sheet, 'sheetNo'))))
    )
      throw new ReportUnsupported('Sheet selection/removal is not implemented.', 'report_sheet_selection');
    replace(top, 'sheetCount', String(sheets.length));
    const topBytes = upload.files.thumbnail
      ? await readFile(upload.files.thumbnail)
      : (binary(optionalField(submitted, 'thumbnail')) ?? binary(optionalField(top, 'thumbnail')));
    replace(top, 'thumbnail', '');
    const topParams = {
      ...audit,
      ...remarks(top, 'top'),
      rep_top_id: id,
      rep_top_org: id,
      rev_no: 1,
      def_top_id: integerField(top, 'defTopId'),
      rep_top_name: field(top, 'repTopName'),
      report_type: integerField(top, 'reportType'),
      rep_sheet_count: sheets.length,
      xml_data: serialize(document),
      thumbnail_file: topBytes,
      edit_refer_status: integerField(top, 'editStatus'),
      complete_mail: optionalField(top, 'completeMail'),
      finish_output: optionalField(top, 'finishOutput') || '1',
      edit_output: optionalField(top, 'editOutput') || '1',
      finish_output_files: child(top, 'finishOutputFiles') ? serialize(must(top, 'finishOutputFiles')) : '',
      edit_output_files: child(top, 'editOutputFiles') ? serialize(must(top, 'editOutputFiles')) : '',
      display_sheet_number: optionalField(top, 'displaySheetNumber'),
      auto_gen: optionalField(top, 'autoGen') || '0',
      auto_select_gen: optionalField(top, 'autoSelectGen') || '0',
      mobile_save: optionalField(top, 'mobileSave') || '0',
      mobile_report_save: optionalField(top, 'mobileReportSave') || '1',
      remarks_edit: optionalField(top, 'remarksEditable') || '0',
      public_status: integerField(top, 'publicStatus'),
      server_version: optionalField(top, 'serverVersion'),
      pic_original_resolution: optionalField(top, 'picOriginalResolution') || '0',
      image_size: optionalField(top, 'imageSize') || null,
      excel_output: optionalField(top, 'excelOutput') || '1',
      can_send_mail_as_attachment: optionalField(top, 'canSendMailAsAttachment') || '1',
      can_open_as_pdf: optionalField(top, 'canOpenAsPdf') || '0',
      auto_numbering_value: current.auto_numbering_value ?? null,
      auto_numbering_message: current.auto_numbering_message ?? null,
      auto_numbering_save_count: current.auto_numbering_save_count ?? null,
      auto_numbering_display_save_count: current.auto_numbering_display_save_count ?? null,
      ...Object.fromEntries([1, 2, 3, 4, 5].map((i) => ['system_key' + i, optionalField(top, 'systemKey' + i)])),
    };
    if (upload.definition) await query(client, sql.top.insert, topParams);
    const changed = new Set<string>();
    for (const sheet of sheets) {
      const number = field(sheet, 'sheetNo'),
        stage = upload.sheets[number],
        incoming = root(stage.xml),
        sheetId = integerField(sheet, 'repSheetId');
      const limitError = await calculateLimits(client, actor, top, sheet, incoming);
      if (limitError) {
        await client.query('ROLLBACK');
        return limitError;
      }
      merge(sheet, incoming, remarkValues);
      if (child(incoming, 'layers'))
        for (const layer of children(must(incoming, 'layers'), 'layer')) {
          const target = children(must(sheet, 'layers'), 'layer').find(
            (node) => field(node, 'layerNo') === field(layer, 'layerNo'),
          );
          if (!target) throw new Error('Unknown report layer.');
          merge(target, layer, ['value', 'inputParameters']);
        }
      for (const cluster of children(must(incoming, 'clusters'), 'cluster')) {
        const target = children(must(sheet, 'clusters'), 'cluster').find(
          (node) => field(node, 'clusterId') === field(cluster, 'clusterId'),
        );
        if (!target) throw new Error('Unknown report cluster.');
        if (optionalField(target, 'readOnly') === '1' || optionalField(target, 'hide') === '1') {
          await client.query('ROLLBACK');
          return clientError(3);
        }
        if (
          optionalField(top, 'useChangeReason') === '1' &&
          optionalField(cluster, 'changeReasonValue') &&
          ![
            'Calculate',
            'IfFunction',
            'TimeCalculate',
            'MCNCalculate',
            'Registration',
            'RegistrationDate',
            'LatestUpdate',
            'LatestUpdateDate',
            'Gps',
            'Action',
          ].includes(field(target, 'type')) &&
          optionalField(target, 'editUser') === optionalField(cluster, 'editUser')
        ) {
          const editDate = (node: XmlNode) => {
            try {
              return reportTableValue(
                element('cluster', [
                  element('type', 'Date'),
                  element(
                    'value',
                    optionalField(node, 'editTime')
                      .trim()
                      .replace(/(\d{2}:\d{2}:\d{2})\.\d+$/, '$1'),
                  ),
                ]),
                'D',
                actor.cultureName || 'en-US',
              );
            } catch (error) {
              // CheckedChangeReson uses TryParse; an unfamiliar date cannot suppress the submitted reason.
              if (error instanceof ReportUnsupported && error.code === 'report_table_date_format') return null;
              throw error;
            }
          };
          const previous = editDate(target);
          if (previous && previous === editDate(cluster)) remove(cluster, 'changeReasonValue');
        }
        merge(target, cluster, [
          'value',
          'displayValue',
          'fileExtension',
          'editUser',
          'editUserName',
          'editTime',
          'gpsLat',
          'gpsLon',
          'gpsAlt',
          'verified',
          'changeReasonValue',
          'pinValue',
          'isHidden',
          ...remarkValues,
        ]);
        for (const name of ['comment', 'gps'])
          if (child(cluster, name)) {
            remove(target, name);
            content(target).push(root(serialize(must(cluster, name))));
          }
        // ReportBiz persists the client's Calculate formula/result; ordinary saves do not recalculate it on the server.
        if (field(target, 'type') === 'Calculate' && optionalField(cluster, 'function'))
          replace(target, 'function', field(cluster, 'function'));
        if (approvalTypes.includes(field(target, 'type'))) {
          merge(target, cluster, approvalFields);
          if (field(target, 'type') === 'Approve') {
            merge(target, cluster, applicantFields);
            if (['2', '3', '4'].includes(optionalField(target, 'value')) && !optionalField(target, 'applicant')) {
              replace(target, 'applicant', actor.userId);
              replace(target, 'applicantName', user);
            }
          }
          if (['3', '4'].includes(optionalField(target, 'value')) && !optionalField(target, 'approver')) {
            replace(target, 'approver', actor.userId);
            replace(target, 'approverName', user);
          }
          if (
            field(target, 'type') === 'Approve' &&
            optionalField(target, 'inputParameters').includes('SignType=0') &&
            optionalField(target, 'value') === '4' &&
            !optionalField(target, 'approvalSignImage').trim()
          )
            replace(
              target,
              'approvalSignImage',
              Buffer.isBuffer(account?.approval_sign)
                ? account.approval_sign.toString('base64')
                : (account?.approval_sign ?? ''),
            );
        }
        changed.add(number + ',' + integerField(target, 'clusterId'));
      }
      for (const clusterId of setReportAuditFields(top, sheet, actor.cultureName))
        changed.add(number + ',' + clusterId);
      const sheetParams = {
        ...audit,
        ...remarks(sheet, 'sheet'),
        rep_top_id: id,
        rep_sheet_id: sheetId,
        def_sheet_id: integerField(sheet, 'defSheetId'),
        rep_sheet_name: optionalField(sheet, 'repSheetName'),
        rep_sheet_no: integerField(sheet, 'sheetNo'),
        auto_select_gen: optionalField(sheet, 'autoSelectGen') || '0',
        copy_disable: optionalField(sheet, 'copyDisable') || '0',
        import_image: optionalField(sheet, 'importImage') || '0',
        sheet_no_org: optionalField(sheet, 'sheetNoOrg') || '0',
        xml_data: serialize(sheet),
      };
      await query(client, sql.sheet[upload.definition ? 'insert' : 'update'], sheetParams);
      if (upload.definition) {
        for (const name of ['clusterRole', 'clusterRefer', 'reference'])
          await query(client, sql[name].copy, sheetParams);
        await client.query(
          'UPDATE rep_sheet SET background_image_file=src.background_image_file,thumbnail_file=src.thumbnail_file FROM def_sheet src WHERE rep_sheet.rep_sheet_id=$1 AND src.def_sheet_id=$2',
          [sheetId, sheetParams.def_sheet_id],
        );
      }
      for (const name of ['inputImage', 'thumbnail']) {
        const bytes = stage.files[name] ? await readFile(stage.files[name]) : binary(optionalField(incoming, name));
        if (bytes)
          await client.query(
            `UPDATE rep_sheet SET ${name === 'inputImage' ? 'input_image_file' : 'thumbnail_file'}=$2 WHERE rep_sheet_id=$1`,
            [sheetId, bytes],
          );
      }
      for (const cluster of children(must(sheet, 'clusters'), 'cluster')) {
        const clusterId = integerField(cluster, 'clusterId'),
          type = field(cluster, 'type'),
          prefix = 'cluster_' + clusterId;
        const old = (
          await client.query(
            `SELECT * FROM ${upload.definition ? 'def_cluster' : 'rep_cluster'} WHERE ${upload.definition ? 'def_sheet_id' : 'rep_sheet_id'}=$1 AND cluster_id=$2`,
            [upload.definition ? sheetParams.def_sheet_id : sheetId, clusterId],
          )
        ).rows[0];
        const load = async (name: string, fallback: unknown) =>
          stage.files[name] ? await readFile(stage.files[name]) : (fallback ?? null);
        const ink = await load(
          prefix + '_value',
          type === 'FixedText' || type === 'FreeDraw'
            ? old?.[actor.platform === 'Windows' ? 'binary_file_win' : 'binary_file']
            : undefined,
        );
        const image = await load(
          prefix + (type === 'FreeDraw' || type === 'FixedText' ? '_displayValue' : '_value'),
          old?.image_file ??
            (upload.definition && ['Image', 'DrawingImage', 'FreeText'].includes(type)
              ? binary(optionalField(cluster, 'value'))
              : undefined),
        );
        const sound = await load(prefix + '_sound', old?.recording_file);
        const params = {
          ...audit,
          ...remarks(cluster, 'cluster'),
          rep_sheet_id: sheetId,
          cluster_id: clusterId,
          cluster_name: field(cluster, 'name'),
          cluster_type: type,
          input_parameter: optionalField(cluster, 'inputParameters'),
          left_position: optionalField(cluster, 'left') || '0',
          right_position: optionalField(cluster, 'right') || '0',
          top_position: optionalField(cluster, 'top') || '0',
          bottom_position: optionalField(cluster, 'bottom') || '0',
          input_value: optionalField(cluster, 'value'),
          display_value: optionalField(cluster, 'displayValue'),
          image_file: type === 'AudioRecording' ? null : image,
          recording_file: type === 'AudioRecording' ? sound : null,
          recording_file_extension: optionalField(cluster, 'fileExtension') || null,
          apply_mail: '',
          approve_mail: '',
          remand_mail: '',
          change_mail: '',
        };
        const approval = approvalTypes.includes(type),
          kind = type === 'Approve' ? 'applicant' : approval ? 'approver' : 'other';
        const approvalDate = (name: string) => {
          const raw = optionalField(cluster, name);
          if (!raw) return null;
          const result = reportTableValue(
            element('cluster', [element('type', 'Date'), element('value', raw)]),
            'D',
            actor.cultureName || 'en-US',
          );
          if (!result) throw new Error('Invalid report approval date.');
          return result;
        };
        const approvalParams = approval
          ? {
              approver: optionalField(cluster, 'approver'),
              approver_name: optionalField(cluster, 'approverName'),
              approver_date: approvalDate('approvalDate'),
              approver_comment: optionalField(cluster, 'approverComment'),
              approval_sign: optionalField(cluster, 'approvalSignImage'),
              applicant: optionalField(cluster, 'applicant'),
              applicant_name: optionalField(cluster, 'applicantName'),
              applicant_date: approvalDate('applicationDate'),
              applicant_comment: optionalField(cluster, 'applicantComment'),
            }
          : {};
        const submittedCluster = children(must(incoming, 'clusters'), 'cluster').find(
          (node) => integerField(node, 'clusterId') === clusterId,
        );
        const extra: Record<string, unknown> = {};
        if (submittedCluster) {
          for (const [name, column] of Object.entries({
            editUser: 'edit_user',
            editUserName: 'edit_user_name',
            editTime: 'edit_time',
            gpsLat: 'gps_lat',
            gpsLon: 'gps_lon',
            gpsAlt: 'gps_alt',
            changeReasonValue: 'change_reason',
            verified: 'verified',
            pinValue: 'pin_value',
            isHidden: 'is_hidden',
          }))
            if (child(submittedCluster, name)) {
              const raw = field(submittedCluster, name);
              extra[column] = name === 'editTime' ? raw || null : raw;
            }
          for (const [name, columns] of [
            ['comment', { value: 'comment_value', inputParameters: 'comment_input_parameters' }],
            ['gps', { lat: 'gps_lat', lon: 'gps_lon', alt: 'gps_alt' }],
          ] as const) {
            const node = child(submittedCluster, name);
            if (node)
              for (const [fieldName, column] of Object.entries(columns))
                if (child(node, fieldName)) extra[column] = field(node, fieldName);
          }
        }
        if (['FixedText', 'FreeDraw'].includes(type) && (upload.definition || stage.files[prefix + '_value'])) {
          extra[actor.platform === 'Windows' ? 'binary_file_win' : 'binary_file'] = ink;
          extra.binary_file_type = actor.platform === 'Windows' ? 'Windows' : '';
        }
        const clusterSql = (sql.cluster as unknown as Record<string, Record<string, string>>)[
          upload.definition ? 'insert' : 'update'
        ][kind]
          .replace(
            '{0}',
            Object.keys(extra)
              .map((name) => `, ${name}${upload.definition ? '' : ' = :' + name}`)
              .join(''),
          )
          .replace(
            '{1}',
            upload.definition
              ? Object.keys(extra)
                  .map((name) => ', :' + name)
                  .join('')
              : '',
          );
        // The original trigger must see values, metadata and binaries in one row operation.
        if (upload.definition || changed.has(number + ',' + clusterId))
          await query(client, clusterSql, { ...params, ...approvalParams, ...extra });
        await saveDrawImages(client, sql, stage.files, 'cluster', sheetId, clusterId, audit);
        if (['Image', 'DrawingImage', 'FreeText', 'FixedText'].includes(type)) {
          replace(cluster, 'value', '');
          replace(cluster, 'displayValue', '');
        }
      }
      if (child(sheet, 'layers'))
        for (const layer of children(must(sheet, 'layers'), 'layer')) {
          const layerId = integerField(layer, 'layerNo'),
            prefix = 'layer_' + layerId;
          if (
            !upload.definition &&
            !Object.keys(stage.files).some((name) => name.startsWith(prefix + '_')) &&
            !(
              child(incoming, 'layers') &&
              children(must(incoming, 'layers'), 'layer').some((node) => integerField(node, 'layerNo') === layerId)
            )
          )
            continue;
          const old = (
            await client.query('SELECT * FROM rep_layer WHERE rep_sheet_id=$1 AND layer_id=$2', [sheetId, layerId])
          ).rows[0];
          const bytes = async (name: string, fallback: unknown) =>
            stage.files[name] ? await readFile(stage.files[name]) : (fallback ?? null);
          await client.query(
            `INSERT INTO rep_layer (rep_top_id,rep_sheet_id,rep_sheet_no,layer_id,input_value,input_parameters,binary_file,image_file,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$9,$10,$11) ON CONFLICT (rep_sheet_id,layer_id) DO UPDATE SET input_value=EXCLUDED.input_value,input_parameters=EXCLUDED.input_parameters,binary_file=EXCLUDED.binary_file,image_file=EXCLUDED.image_file,sys_update_term=EXCLUDED.sys_update_term,sys_update_user=EXCLUDED.sys_update_user,sys_update_time=EXCLUDED.sys_update_time`,
            [
              id,
              sheetId,
              Number(number),
              layerId,
              optionalField(layer, 'value'),
              optionalField(layer, 'inputParameters'),
              await bytes(prefix + '_value', old?.binary_file),
              await bytes(prefix + '_displayValue', old?.image_file),
              actor.terminalId,
              actor.userId,
              now,
            ],
          );
          await saveDrawImages(client, sql, stage.files, 'layer', sheetId, layerId, audit);
        }
      replace(sheet, 'inputImage', '');
      replace(sheet, 'thumbnail', '');
      replace(sheet, 'backgroundImage', '');
      await client.query('UPDATE rep_sheet SET xml_data=$2 WHERE rep_sheet_id=$1', [sheetId, serialize(sheet)]);
    }
    const numbering = await documentSaveNumbering(
      client,
      id,
      top,
      actor.userId,
      now,
      actor.cultureName || 'en-US',
      upload.definition ? 'create' : 'update',
      actor.terminalId,
    );
    for (const key of numbering.changed) changed.add(key);
    setReportName(top, now, upload.definition || numbering.regenerateName);
    if (numbering.columns) Object.assign(topParams, numbering.columns);
    topParams.rep_top_name = field(top, 'repTopName');
    topParams.xml_data = serialize(document);
    await query(client, sql.top.update, topParams);
    if (upload.definition) {
      await query(client, sql.top.insertCurrent, topParams);
      const source = (
        await client.query('SELECT role_create_mode FROM def_top WHERE def_top_id=$1', [topParams.def_top_id])
      ).rows[0];
      const roleQuery = ['copy', 'copyGroupOnly', 'copyGroupOver', 'copyGroupOverUnder'][
        Number(source?.role_create_mode ?? 0)
      ];
      if (!roleQuery) throw new Error('Invalid report role-create mode.');
      for (const name of ['label', 'reportDocument', 'reportMaster']) await query(client, sql[name].copy, topParams);
      await query(client, sql.role[roleQuery], { ...topParams, user_id: actor.userId });
      await client.query(
        `INSERT INTO rep_role (rep_top_id,group_id,role_rep_read,role_rep_update,role_rep_delete,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time) SELECT $1,group_id,role_rep_read,role_rep_update,role_rep_delete,$2,$3,$4,$2,$3,$4 FROM def_role WHERE def_top_id=$5 AND role_rep_inherit_type=1 ON CONFLICT (rep_top_id,group_id) DO NOTHING`,
        [id, hostname(), actor.userId, now, topParams.def_top_id],
      );
      await client.query(
        `INSERT INTO rep_role (rep_top_id,group_id,role_rep_read,role_rep_update,role_rep_delete) VALUES ($1,-999,1,1,1) ON CONFLICT (rep_top_id,group_id) DO UPDATE SET role_rep_read=1,role_rep_update=1,role_rep_delete=1`,
        [id],
      );
      await client.query(
        'UPDATE rep_top SET background_image_file=src.background_image_file,def_file=src.def_file,def_file_name=src.def_file_name,def_file_type=src.def_file_type FROM def_top src WHERE rep_top.rep_top_id=$1 AND src.def_top_id=$2',
        [id, topParams.def_top_id],
      );
      const appId = optionalField(submitted, 'repTopAppId');
      if (appId)
        await client.query(
          'INSERT INTO rep_top_app (rep_top_id,rep_top_app_id,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time) VALUES ($1,$2,$3,$4,$5,$3,$4,$5)',
          [id, appId, actor.terminalId, actor.userId, now],
        );
    }
    if (upload.fdInfo !== undefined) {
      const fdSheets = upload.fdInfo ? children(must(root(upload.fdInfo), 'sheets'), 'sheet') : [];
      for (const [number, stage] of Object.entries(upload.fdFiles))
        if (!stage.deleted && !fdSheets.some((sheet) => field(sheet, 'fdSheetNo') === number))
          throw new Error('Uploaded FreeDraw sheet missing from index.');
      for (const sheet of fdSheets) {
        const number = integerField(sheet, 'fdSheetNo'),
          stage = upload.fdFiles[number];
        if (stage?.deleted) throw new Error('Deleted FreeDraw sheet remains in index.');
        if (stage?.pdf && stage.irfd)
          await client.query(
            'INSERT INTO rep_fd_sheet (top_id,fd_sheet_no,sheet_index,pdf_file,irfd_file) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (top_id,fd_sheet_no) DO UPDATE SET sheet_index=EXCLUDED.sheet_index,pdf_file=EXCLUDED.pdf_file,irfd_file=EXCLUDED.irfd_file',
            [id, number, integerField(sheet, 'sheetIndex'), await readFile(stage.pdf), await readFile(stage.irfd)],
          );
        else if (
          !(
            await client.query('UPDATE rep_fd_sheet SET sheet_index=$3 WHERE top_id=$1 AND fd_sheet_no=$2', [
              id,
              number,
              integerField(sheet, 'sheetIndex'),
            ])
          ).rowCount
        )
          throw new Error('Missing FreeDraw sheet binaries.');
      }
      for (const [number, stage] of Object.entries(upload.fdFiles))
        if (stage.deleted)
          await client.query('DELETE FROM rep_fd_sheet WHERE top_id=$1 AND fd_sheet_no=$2', [id, Number(number)]);
      await client.query('UPDATE rep_top SET fd_sheet_info=$2 WHERE rep_top_id=$1', [id, upload.fdInfo || null]);
    }
    await saveReportTables(client, top, changed, actor.cultureName);
    const labelActor = { userId: actor.userId, userName: user, terminalId: actor.terminalId };
    if (upload.definition) await createReportAutoLabels(client, top, labelActor, now);
    else await updateReportAutoLabels(client, previousTop, top, labelActor, now, true);
    const applicantLocked =
      (await reportApplicantLocked(client, id, actor.userId)) && actor.userId !== (await documentAdministratorId());
    if (unlock || applicantLocked)
      await client.query('DELETE FROM rep_lock WHERE rep_top_id=$1 AND (user_id=$2 OR sys_regist_term=$3)', [
        id,
        actor.userId,
        actor.terminalId,
      ]);
    else if (!locks.length && optionalField(top, 'lockMode') !== '1')
      await client.query(
        'INSERT INTO rep_lock (rep_top_id,user_id,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time) VALUES ($1,$2,$3,$2,$4,$3,$2,$4)',
        [id, actor.userId, actor.terminalId, now],
      );
    const result = clientError(0, [
      'repTopId=' + id,
      'applicantLock=' + Number(applicantLocked),
      ...['registUser', 'registUserName', 'registTime', 'updateUser', 'updateUserName', 'updateTime', 'repTopName'].map(
        (name) => name + '=' + optionalField(top, name),
      ),
    ]);
    if (numbering.refreshThumbnail)
      await documentRefreshThumbnail(
        client,
        id,
        integerField(top, 'defTopId'),
        actor.userId,
        actor.cultureName || 'en-US',
      );
    await client.query('COMMIT');
    upload.result = result;
    return upload.result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
function formatDate(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}
async function saveDrawImages(
  client: pg.PoolClient,
  sql: Record<string, Record<string, string>>,
  files: Record<string, string>,
  type: 'cluster' | 'layer',
  sheetId: number,
  keyId: number,
  audit: Record<string, unknown>,
): Promise<void> {
  const prefix = type + '_' + keyId + '_image_',
    entries = Object.entries(files).filter(([name]) => name.startsWith(prefix));
  if (!entries.length) return;
  const params = { ...audit, rep_sheet_id: sheetId, key_id: keyId };
  await query(client, sql.drawImages.delete.replace('{0}', 'rep_' + type + '_draw'), params);
  for (const [name, path] of entries)
    await query(client, sql.drawImages.insert.replace('{0}', 'rep_' + type + '_draw'), {
      ...params,
      image_no: Number(name.slice(prefix.length)),
      image_file: await readFile(path),
    });
}
