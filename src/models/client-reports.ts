import type pg from 'pg';
import { clientError } from '../services/client-xml.js';
import { validClientVersion } from '../config/client.js';
import { zipBuffer } from '../controllers/manager/system/files.js';
import { type DefinitionActor, query, queryDocument, rowElement } from './client-definitions.js';
import {
  type XmlNode,
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
} from './client-definition-xml.js';

export interface ReportActor extends DefinitionActor {
  platform: string;
  version: string;
}
export interface ReportDownload {
  xml: string;
  topId: number;
  definition: boolean;
  binaries?: Record<string, string>;
}
export class ReportUnsupported extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly definitionId?: number,
  ) {
    super(message);
  }
}
const binaryTypes = ['FixedText', 'FreeText', 'FreeDraw', 'DrawingImage', 'Image', 'AudioRecording'];
const queries = () => queryDocument('ReportBiz.xml').baseQuery as Record<string, Record<string, string>>;
const dateText = (date: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};
function text(value: unknown): string {
  return value instanceof Date ? dateText(value) : String(value ?? '');
}

export function defaultReportLayers(sheet: XmlNode): void {
  if (!child(sheet, 'layers')) content(sheet).push(element('layers'));
  const layers = must(sheet, 'layers');
  if (!child(layers, 'layer')) content(layers).push(element('layer'));
  const layer = must(layers, 'layer');
  for (const [name, value] of Object.entries({
    layerNo: '1',
    type: 'FreeDraw',
    inputParameters: 'Required=0;Width=8;Color=0,0,0',
    value: '',
  }))
    if (!child(layer, name)) content(layer).push(element(name, value));
}
async function clusterPermissions(
  client: pg.PoolClient,
  section: Record<string, string>,
  sheet: XmlNode,
  actor: ReportActor,
  definition: boolean,
  forceReadOnly: boolean,
): Promise<void> {
  if (actor.userId === 'conmasadmin') return;
  const params = { sheet_id: integerField(sheet, definition ? 'defSheetId' : 'repSheetId'), user_id: actor.userId };
  const rows = [];
  for (const name of ['clusterRole', 'clusterHide', 'clusterRoleNone'])
    rows.push(await query(client, section[name], params));
  const sets = rows.map((result) => new Set(result.rows.map((row) => String(row.clusterId))));
  const [denied, hidden, unrestricted] = sets;
  if (!denied.size && !hidden.size && !forceReadOnly) return;
  for (const cluster of children(must(sheet, 'clusters'), 'cluster')) {
    const id = field(cluster, 'clusterId');
    if (forceReadOnly || denied.has(id) || (hidden.has(id) && unrestricted.has(id))) replace(cluster, 'readOnly', '1');
    else if (optionalField(cluster, 'readOnly') !== '1') replace(cluster, 'readOnly', '0');
    if (hidden.has(id) && (denied.has(id) || unrestricted.has(id))) replace(cluster, 'hide', '1');
  }
}

// ReportBiz's tablet pipeline is distinct from Designer GetDefinitionData (which acquires a definition lock).
export async function getReportDownload(
  db: pg.Pool,
  actor: ReportActor,
  params: Record<string, string>,
  definition: boolean,
  lock = true,
): Promise<string | ReportDownload> {
  if (!actor.userId || !actor.terminalId) return clientError(5);
  if (params.copyReportMode === '1')
    throw new ReportUnsupported(
      'Current-revision report copy transfer is not implemented.',
      'report_copy_current_revision',
    );
  const copy = !definition && params.copy === '1';
  const client = await db.connect();
  const sql = queries(),
    section = sql[definition ? 'createData' : 'getData'];
  try {
    const settings = new Map<string, string>(
      (await client.query('SELECT com_key,com_name,com_value FROM mst_common ORDER BY com_index')).rows.map((row) => [
        row.com_key + '/' + row.com_name,
        row.com_value ?? '',
      ]),
    );
    const setting = (key: string, name: string, fallback = '') => settings.get(key + '/' + name) ?? fallback;
    let topId = integer(params.topId ?? '');
    const keys = [1, 2, 3, 4, 5].filter((index) => params['systemKey' + index]);
    if (keys.length) {
      const rows = (
        await client.query(
          `SELECT ${definition ? 'def' : 'rep'}_top_id AS id FROM ${definition ? 'def' : 'rep'}_top WHERE deleted=0 AND ${keys.map((index, i) => `system_key${index}=$${i + 1}`).join(' AND ')}`,
          keys.map((index) => params['systemKey' + index]),
        )
      ).rows;
      if (!rows.length) return clientError(8, 'DATA NOT FOUND');
      if (rows.length > 1) return clientError(9, 'DATA DUPLICATES');
      topId = Number(rows[0].id);
    }
    if (topId === undefined) return clientError(2);
    if (lock && definition && setting('IPAD_SETTING', 'DOWNLOAD_PUBLIC_DEFINITION_MODE') === '1') {
      const current = (
        await client.query(
          'SELECT cur.def_top_id FROM def_current cur JOIN def_top src ON cur.def_top_org=src.def_top_org WHERE src.def_top_id=$1 ORDER BY cur.def_top_id DESC LIMIT 1',
          [topId],
        )
      ).rows[0];
      if (current) topId = Number(current.def_top_id);
      const boundary = new Date();
      boundary.setSeconds(0, 0);
      const reserved = (
        await client.query('SELECT def_top_org,public_status,use_start_date FROM def_top WHERE def_top_id=$1', [topId])
      ).rows[0];
      if (Number(reserved?.public_status) === 2 && reserved?.use_start_date && reserved.use_start_date > boundary) {
        const old = (
          await client.query(
            'SELECT def_top_id FROM def_top WHERE def_top_org=$1 AND public_status=2 AND deleted=0 AND def_top_id<>$2 AND (use_start_date IS NULL OR use_start_date<=$3) ORDER BY rev_no DESC LIMIT 1',
            [reserved.def_top_org, topId, boundary],
          )
        ).rows[0];
        if (!old) return clientError(8);
        topId = Number(old.def_top_id);
      }
    }
    const data = (await query(client, section.xmlData, { top_id: topId, user_id: actor.userId })).rows[0];
    if (!data) return clientError(8);
    if (definition && !(Number(data.role_create) > 0)) return clientError(3);
    if (!definition && Number(data.role_update) === 0 && Number(data.role_read) === 0) return clientError(1003);
    const document = root(data.xml_data),
      top = must(document, 'top');
    if (definition && optionalField(top, 'publicStatus') === '0') return clientError(2001);
    const constrained = ['constrainedFunction', 'constrainedFunctionOther'].map((name) =>
      optionalField(top, name).trim().toUpperCase(),
    );
    if (data.fd_sheet_info && children(must(root(data.fd_sheet_info), 'sheets'), 'sheet').length)
      constrained.push('IREPO_FREEDRAW_SHEET');
    for (const key of constrained) {
      const limit = setting(actor.platform === 'Windows' ? 'CONSTRAINEDFUNCTION_WIN' : 'CONSTRAINEDFUNCTION_IOS', key);
      if (key && limit && actor.version && !validClientVersion(limit, actor.version))
        return serialize(
          element('conmas', [
            element('error', [
              element('code', '2002'),
              element('remarks', [
                element('remark', 'keyName=' + key),
                element('remark', 'implementedVersion=' + limit),
              ]),
            ]),
          ]),
        );
    }
    let readOnly = definition ? 0 : 1 - Number(data.role_update),
      forceReadOnly = false;
    if (!definition) {
      if (Number(data.edit_refer_status) === 4 && !copy) {
        readOnly = 1;
        forceReadOnly = true;
      }
      if (Number(data.workflow_lock) === 1) {
        readOnly = 1;
        forceReadOnly = true;
      }
      // shortcut: applicant locks/referenced-cluster substitution are not yet ported; refuse those downloads rather than permit unauthorized editing.
      if (text(data.use_applicant_lock) === '1')
        throw new ReportUnsupported('Applicant-lock report retrieval is not implemented.', 'report_applicant_lock');
    }
    replace(top, 'locked', '0');
    replace(top, 'readOnly', String(readOnly));
    const mapping: Record<string, string> = {
      isReportCopy: 'report_copy_enable',
      mobileEditType: 'mobile_edit_type',
      useApplicantLock: 'use_applicant_lock',
      useInputHistory: 'use_input_history',
      useChangeReason: 'use_change_reason',
      useInitInputJudge: 'use_init_input_judge',
      useExclusiveMode: 'use_exclusive_mode',
      noNeedToFillOutType: 'no_need_to_fill_type',
      noNeedToFillOutString: 'no_need_to_fill_string',
      editMail: 'edit_mail',
      calculateMode: 'calculate_mode',
      isSortReport: 'is_sort_report',
      journalizingDefTopId: 'journalizing_def_top_id',
      requiredCheckMode: 'required_check_mode',
      requiredSaveMode: 'required_save_mode',
      useIdentification: 'use_identification',
      useStartTime: 'use_start_date',
      useEndTime: 'use_end_date',
    };
    for (let index = 1; index <= 5; index++) mapping['systemKey' + index] = 'system_key' + index;
    for (const [name, column] of Object.entries(mapping))
      if (data[column] !== undefined && data[column] !== null) replace(top, name, text(data[column]));
    if (!text(data.report_copy_enable)) replace(top, 'isReportCopy', '1');
    if (!text(data.mobile_edit_type)) replace(top, 'mobileEditType', '0');
    if (!child(top, 'noNeedToFillOutMode')) replace(top, 'noNeedToFillOutMode', '0');
    if (setting('IPAD_SETTING', 'SAVE_LOCAL_CAMERA_IMAGE') === '1') replace(top, 'saveLocalCameraImage', '1');
    const history = setting('HISTORY_SETTING', 'ENABLE');
    if (definition && ['1', '2'].includes(history)) {
      replace(top, 'useInputHistory', history);
      replace(
        top,
        'useChangeReason',
        setting('HISTORY_SETTING', 'CHANGE_REASON_ENABLE') === '1' || text(data.use_change_reason) === '1' ? '1' : '0',
      );
    }
    remove(top, 'useInitInputJudgeParameters');
    if (data.use_init_input_judge_parameters) content(top).push(root(data.use_init_input_judge_parameters));
    if (definition) {
      replace(top, 'repTopId', '');
      replace(top, 'defTopOrg', text(data.top_org_id));
      replace(top, 'repTopName', optionalField(top, 'defTopName'));
      for (const name of ['registTime', 'registUser', 'registUserName', 'updateTime', 'updateUser', 'updateUserName'])
        replace(top, name, '');
    } else {
      for (const [name, column] of Object.entries({
        registTime: 'sys_regist_time',
        registUser: 'sys_regist_user',
        registUserName: 'sys_regist_user_name',
        updateTime: 'sys_update_time',
        updateUser: 'sys_update_user',
        updateUserName: 'sys_update_user_name',
      }))
        replace(top, name, text(data[column]));
    }
    replace(
      top,
      'useIdentification',
      setting('IDENTIFICATION_SETTING', 'ENABLE_IDENTIFICATION', '-1') !== '-1'
        ? setting('IDENTIFICATION_SETTING', 'ENABLE_IDENTIFICATION')
        : optionalField(top, 'useIdentification') || '0',
    );
    remove(top, 'labels');
    content(top).push(
      element(
        'labels',
        (await query(client, section.label, { top_id: topId })).rows.map((row) => rowElement('label', row)),
      ),
    );
    const images = (
      await query(client, sql.getImage[definition ? 'definitionImage' : 'reportImage'], { top_id: topId })
    ).rows;
    const storedSheets = (
      await client.query(
        `SELECT * FROM ${definition ? 'def_sheet' : 'rep_sheet'} WHERE ${definition ? 'def_top_id' : 'rep_top_id'}=$1`,
        [topId],
      )
    ).rows;
    for (const sheet of children(must(top, 'sheets'), 'sheet')) {
      const image = images.find((row) => String(row.sheet_no) === field(sheet, 'sheetNo'));
      const stored = storedSheets.find(
        (row) => String(row[definition ? 'def_sheet_no' : 'rep_sheet_no']) === field(sheet, 'sheetNo'),
      );
      if (stored) {
        replace(sheet, 'defSheetId', String(stored.def_sheet_id));
        if (!definition) replace(sheet, 'repSheetId', String(stored.rep_sheet_id));
      }
      if (definition) {
        replace(sheet, 'repSheetId', '');
        replace(sheet, 'repSheetName', optionalField(sheet, 'defSheetName'));
      }
      if (image)
        for (const [name, column] of Object.entries({
          backgroundImage: 'background_image_file',
          inputImage: 'input_image_file',
          thumbnail: 'thumbnail_file',
        }))
          if (Buffer.isBuffer(image[column])) replace(sheet, name, image[column].toString('base64'));
      defaultReportLayers(sheet);
      remove(sheet, 'references');
      content(sheet).push(
        element(
          'references',
          (
            await query(client, section.reference, {
              sheet_id: integerField(sheet, definition ? 'defSheetId' : 'repSheetId'),
            })
          ).rows.map((row) => rowElement('reference', row)),
        ),
      );
      await clusterPermissions(client, section, sheet, actor, definition, forceReadOnly);
    }
    if (lock && !definition && !copy && readOnly < 1) {
      await client.query('BEGIN');
      try {
        const strict = setting('LOCK_SETTING', 'REPORT_STRICT_LOCK') === '1';
        if (!strict)
          await client.query('DELETE FROM rep_lock WHERE rep_top_id=$1 AND (user_id=$2 OR sys_regist_term=$3)', [
            topId,
            actor.userId,
            actor.terminalId,
          ]);
        await client.query(
          `INSERT INTO rep_lock (rep_top_id,user_id,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time) VALUES ($1,$2,$3,$2,now(),$3,$2,now())`,
          [topId, actor.userId, actor.terminalId],
        );
        await client.query('COMMIT');
      } catch {
        await client.query('ROLLBACK');
        return clientError(1010);
      }
    }
    replace(top, 'thumbnail', Buffer.isBuffer(data.thumbnail_file) ? data.thumbnail_file.toString('base64') : '');
    const download: ReportDownload = { xml: serialize(document), topId, definition };
    if (copy) {
      // ReportBiz snapshots copy binaries at top download without locking the source report.
      download.binaries = {};
      for (const sheet of children(must(top, 'sheets'), 'sheet'))
        download.binaries[field(sheet, 'sheetNo')] = (
          await readReportSheetBinaries(client, actor, topId, sheet)
        ).toString('base64');
    }
    return download;
  } finally {
    client.release();
  }
}

export function reportDownloadTop(download: ReportDownload, background = true): string {
  const document = root(download.xml),
    top = must(document, 'top');
  must(top, 'sheets').sheets = [];
  if (!background) replace(top, 'backgroundImage', '');
  return serialize(document);
}
export function reportDownloadSheet(
  download: ReportDownload | undefined,
  topId: string,
  sheetNo: string,
  definition: boolean,
  background = true,
): string {
  if (!download || download.definition !== definition || integer(topId) !== download.topId) return clientError(2);
  const sheet = children(must(must(root(download.xml), 'top'), 'sheets'), 'sheet').find(
    (sheet) => field(sheet, 'sheetNo') === sheetNo,
  );
  if (!sheet) return clientError(8);
  replace(sheet, 'inputImage', '');
  replace(sheet, 'thumbnail', '');
  if (!background) replace(sheet, 'backgroundImage', '');
  return serialize(element('conmas', [sheet]));
}
export async function reportSheetBinaries(
  db: pg.Pool,
  actor: ReportActor,
  download: ReportDownload | undefined,
  topId: string,
  sheetNo: string,
): Promise<Buffer | string> {
  if (!download || download.definition || download.topId !== integer(topId)) return clientError(2);
  const sheet = children(must(must(root(download.xml), 'top'), 'sheets'), 'sheet').find(
    (sheet) => field(sheet, 'sheetNo') === sheetNo,
  );
  if (!sheet) return clientError(8);
  if (download.binaries?.[sheetNo] !== undefined) return Buffer.from(download.binaries[sheetNo], 'base64');
  const client = await db.connect();
  try {
    return await readReportSheetBinaries(client, actor, download.topId, sheet);
  } finally {
    client.release();
  }
}
async function readReportSheetBinaries(
  client: pg.PoolClient,
  actor: ReportActor,
  topId: number,
  sheet: XmlNode,
): Promise<Buffer> {
  const sheetNo = field(sheet, 'sheetNo');
  const entries: { name: string; data: Buffer; date: Date }[] = [];
  const add = (name: string, data: unknown) => {
    if (Buffer.isBuffer(data)) entries.push({ name, data, date: new Date() });
  };
  const sql = queries();
  const clusters = (await query(client, sql.getImage.clusterImage, { top_id: topId })).rows.filter(
    (row) => String(row.sheet_no) === sheetNo,
  );
  for (const node of children(must(sheet, 'clusters'), 'cluster')) {
    if (!binaryTypes.includes(field(node, 'type'))) continue;
    const row = clusters.find((row) => String(row.cluster_id) === field(node, 'clusterId'));
    if (!row) continue;
    const prefix = 'cluster_' + field(node, 'clusterId');
    if (['FixedText', 'FreeDraw'].includes(row.cluster_type)) {
      const windows = actor.platform === 'Windows';
      if (windows ? row.binary_file_type === 'Windows' : !row.binary_file_type || row.binary_file_type === 'iOS')
        add(prefix + '_value', row[windows ? 'binary_file_win' : 'binary_file']);
      if (row.cluster_type === 'FreeDraw') add(prefix + '_displayValue', row.image_file);
    } else
      add(
        prefix + (row.cluster_type === 'AudioRecording' ? '_sound' : '_value'),
        row.cluster_type === 'AudioRecording' ? row.recording_file : row.image_file,
      );
  }
  const layers = (await query(client, sql.getImage.layerImage, { top_id: topId })).rows.filter(
    (row) => String(row.sheet_no) === sheetNo,
  );
  for (const row of layers) {
    add('layer_' + row.layer_id + '_value', row.binary_file);
    add('layer_' + row.layer_id + '_displayValue', row.image_file);
  }
  if (!entries.length) add('empty', Buffer.alloc(0));
  return zipBuffer(entries);
}

export async function getReportFreeDraw(
  db: pg.Pool,
  actor: ReportActor,
  repTopId: string,
  fdSheetNo?: string,
  fileType?: string,
): Promise<string | Buffer> {
  const id = integer(repTopId);
  if (id === undefined) return clientError(2);
  const role = (
    await db.query(
      `SELECT MAX(role_rep_read) AS role FROM rep_role WHERE rep_top_id=$1 AND group_id IN (SELECT group_id FROM mst_group_affiation WHERE user_id=$2)`,
      [id, actor.userId],
    )
  ).rows[0];
  if (!(Number(role?.role) > 0)) return clientError(3);
  if (fdSheetNo === undefined) {
    const row = (await db.query('SELECT fd_sheet_info FROM rep_top WHERE rep_top_id=$1 AND deleted=0', [id])).rows[0];
    if (!row) return clientError(8);
    return row.fd_sheet_info ? serialize(root(row.fd_sheet_info)) : clientError(8);
  }
  const number = integer(fdSheetNo);
  if (number === undefined || !['pdf', 'irfd'].includes(fileType ?? '')) return clientError(2);
  const row = (
    await db.query(
      `SELECT ${fileType === 'pdf' ? 'pdf_file' : 'irfd_file'} AS data FROM rep_fd_sheet WHERE top_id=$1 AND fd_sheet_no=$2`,
      [id, number],
    )
  ).rows[0];
  return Buffer.isBuffer(row?.data) ? row.data : clientError(8);
}
