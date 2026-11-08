import type pg from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { clientSettingsDirectory, readLicenseFields } from '../shared/license-counts.js';
import { clientConfiguration } from '../config/client.js';
import {
  type XmlNode,
  tag,
  content,
  children,
  child,
  must,
  value,
  field,
  optionalField,
  integer,
  integerField,
  element,
  set,
  remove,
  replace,
  root,
  serialize,
} from './client-definition-xml.js';
import { saveDefinitionNumbering } from './client-definition-numbering.js';
import { checkDefinitionBinder } from './client-definition-binder.js';
import { DefinitionTableError, saveDefinitionTables } from './client-definition-tables.js';

export interface DefinitionActor {
  userId: string;
  terminalId: string;
  cultureName?: string;
  client?: string;
}
const queryParser = new XMLParser({ parseTagValue: false });
export function rowElement(name: string, row: Record<string, unknown>): XmlNode {
  return element(
    name,
    Object.entries(row)
      .filter(([, item]) => item !== null && item !== undefined)
      .map(([key, item]) => element(key, Buffer.isBuffer(item) ? item.toString('base64') : String(item))),
  );
}
export function queryDocument(file: string): Record<string, unknown> {
  const directory = clientSettingsDirectory();
  if (!directory) throw new Error('Client settings directory is unavailable.');
  return queryParser.parse(readFileSync(join(directory, file), 'utf8')).query;
}
const queryFile = (file: string) => queryDocument(file).baseQuery as Record<string, Record<string, string>>;
export async function query(client: pg.PoolClient, text: string, params: Record<string, unknown>) {
  const values: unknown[] = [];
  const positions = new Map<string, number>();
  // Installed queries contain named parameters inside comments; only bind SQL tokens, not comments/literals/casts.
  text = text.replace(
    /'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\r\n]*|\/\*[\s\S]*?\*\/|(?<!:):([A-Za-z_]\w*)/g,
    (token: string, name?: string) => {
      if (!name) return token;
      if (!Object.hasOwn(params, name)) throw new Error('Missing client query parameter: ' + name);
      if (!positions.has(name)) {
        values.push(params[name]);
        positions.set(name, values.length);
      }
      return '$' + positions.get(name);
    },
  );
  return client.query(text, values);
}
function validate(actor: DefinitionActor, topId: number): void {
  if (!actor.userId || !actor.terminalId || !Number.isInteger(topId) || topId < -2147483648 || topId > 2147483647)
    throw new Error('Invalid definition request.');
}
function errorXml(code: number, remark?: string): string {
  return serialize(
    element('conmas', [
      element('error', [
        element('code', String(code)),
        element('remarks', remark === undefined ? [] : [element('remark', remark)]),
      ]),
    ]),
  );
}
function validVersion(target: string, requested: string): boolean {
  const parse = (text: string) =>
    text
      .split('.')
      .map((part) =>
        /^[+-]?\d+$/.test(part.trim()) && Number(part) >= -2147483648 && Number(part) <= 2147483647
          ? Number(part)
          : NaN,
      );
  const a = parse(target),
    b = parse(requested);
  if ([...a, ...b].some(Number.isNaN)) return false;
  for (let index = 0; index < a.length; index++) {
    if (b[index] === undefined || b[index] < a[index]) return false;
    if (b[index] > a[index]) return true;
  }
  return true;
}
function dateText(item: unknown, culture = 'en-US'): string {
  if (!(item instanceof Date)) return String(item);
  const pad = (number: number) => String(number).padStart(2, '0');
  const time = `${pad(item.getMinutes())}:${pad(item.getSeconds())}`;
  if (culture === 'en-US' || culture === 'en')
    return `${item.getMonth() + 1}/${item.getDate()}/${item.getFullYear()} ${item.getHours() % 12 || 12}:${time} ${item.getHours() < 12 ? 'AM' : 'PM'}`;
  if (culture === 'ja-JP' || culture === 'ja')
    return `${item.getFullYear()}/${pad(item.getMonth() + 1)}/${pad(item.getDate())} ${item.getHours()}:${time}`;
  // shortcut: only the installed en-US default and ja-JP DateTime.ToString formats are ported; add verified formats before other locales receive dated definitions.
  throw new Error('Definition date culture is not implemented.');
}
async function approveMode(client: pg.PoolClient): Promise<boolean> {
  return (
    (
      await client.query(
        "SELECT com_value FROM mst_common WHERE com_key='DEFINITION_SETTING' AND com_name='APPROVE_MODE' ORDER BY com_index LIMIT 1",
      )
    ).rows[0]?.com_value === '1'
  );
}
async function deleteOwnedLock(client: pg.PoolClient, actor: DefinitionActor, topId: number): Promise<void> {
  // ReportBase.ExecuteUnlock releases this user's lock OR this terminal's lock, never another terminal's unrelated lock.
  await client.query('DELETE FROM def_lock WHERE def_top_id=$1 AND (user_id=$2 OR sys_regist_term=$3)', [
    topId,
    actor.userId,
    actor.terminalId,
  ]);
}
async function acquireLock(client: pg.PoolClient, actor: DefinitionActor, topId: number): Promise<boolean> {
  await client.query('BEGIN');
  try {
    await deleteOwnedLock(client, actor, topId);
    await client.query(
      `INSERT INTO def_lock (def_top_id,user_id,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time)
      VALUES ($1,$2,$3,$2,$4,$3,$2,$4)`,
      [topId, actor.userId, actor.terminalId, new Date()],
    );
    await client.query('COMMIT');
    return true;
  } catch {
    await client.query('ROLLBACK');
    return false;
  }
}

// Designer RequestDefinition -> DefinitionBiz.GetDefinition (2793-3305), not ReportBiz.GetDefinitionData.
// The controller must authenticate the ConMasWeb session and run CheckTerminal before invoking these models.
export async function getDefinitionData(
  db: pg.Pool,
  actor: DefinitionActor,
  topId: number,
  designerVersion?: string,
): Promise<string> {
  validate(actor, topId);
  const queries = queryFile('DefinitionBiz.xml');
  const client = await db.connect();
  try {
    const images = (await query(client, queries.getImage.top, { top_id: topId })).rows[0];
    if (images && (!Buffer.isBuffer(images.thumbnail_file) || !Buffer.isBuffer(images.background_image_file)))
      throw new Error('Definition image binary is unavailable.');
    const data = (await query(client, queries.getData.xmlData, { top_id: topId, user_id: actor.userId })).rows[0];
    if (!data || !images) throw new Error('Definition not found.');
    if (data.designer_version && designerVersion && !validVersion(data.designer_version, designerVersion))
      return errorXml(19001, data.designer_display_version ?? '');
    const xml = root(data.xml_data),
      top = must(xml, 'top');
    // Legacy uses role_update only here; role_read is checked by GetDefinitionDetail, not by this endpoint.
    let readOnly = 1 - Number(data.role_update);
    let definitionFile = child(top, 'definitionFile');
    if (!definitionFile) {
      definitionFile = element(
        'definitionFile',
        ['type', 'name', 'value'].map((name) => element(name)),
      );
      content(top).push(definitionFile);
    } else if (field(definitionFile, 'type')) {
      if (!Buffer.isBuffer(data.def_file)) throw new Error('Definition file binary is unavailable.');
      set(must(definitionFile, 'value'), data.def_file.toString('base64'));
    }
    for (const [name, column] of [
      ['thumbnail', 'thumbnail_file'],
      ['backgroundImage', 'background_image_file'],
    ]) {
      set(must(top, name), images[column].toString('base64'));
    }
    replace(top, 'isReportCopy', String(data.report_copy_enable ?? '') || '1');
    replace(top, 'mobileEditType', String(data.mobile_edit_type ?? '') || '0');
    const fields: Record<string, string> = {
      useApplicantLock: 'use_applicant_lock',
      useInputHistory: 'use_input_history',
      useChangeReason: 'use_change_reason',
      useInitInputJudge: 'use_init_input_judge',
      noNeedToFillOutType: 'no_need_to_fill_type',
      noNeedToFillOutString: 'no_need_to_fill_string',
      useExclusiveMode: 'use_exclusive_mode',
      useExclusiveModeManager: 'use_exclusive_mode_manager',
      useStartTime: 'use_start_date',
      useEndTime: 'use_end_date',
      isSortReport: 'is_sort_report',
      journalizingDefTopId: 'journalizing_def_top_id',
      requiredCheckMode: 'required_check_mode',
      requiredSaveMode: 'required_save_mode',
      useIdentification: 'use_identification',
    };
    for (let index = 1; index <= 5; index++) fields['systemKey' + index] = 'system_key' + index;
    for (const [name, column] of Object.entries(fields)) {
      remove(top, name);
      if (data[column] !== null && data[column] !== undefined && String(data[column]) !== '')
        content(top).push(element(name, dateText(data[column], actor.cultureName || 'en-US')));
    }
    remove(top, 'useInitInputJudgeParameters');
    if (data.use_init_input_judge_parameters) content(top).push(root(data.use_init_input_judge_parameters));
    // Preserve legacy RemoveAll+Add: if already present, these two fields deliberately retain a second empty/default element.
    for (const [name, column, fallback] of [
      ['editMail', 'edit_mail', ''],
      ['calculateMode', 'calculate_mode', '0'],
    ]) {
      const existing = child(top, name);
      if (existing) {
        existing[name] = [];
        delete existing[':@'];
      }
      content(top).push(element(name, fallback));
      if (data[column] !== null && data[column] !== undefined && String(data[column]) !== '')
        set(must(top, name), String(data[column]));
    }
    if (!child(top, 'noNeedToFillOutMode')) content(top).push(element('noNeedToFillOutMode', '0'));
    const numbering = (
      await client.query('SELECT def_top_org,auto_numbering_rev_no FROM def_top WHERE def_top_id=$1', [
        integerField(top, 'defTopId'),
      ])
    ).rows[0];
    if (!numbering) throw new Error('Definition numbering metadata is unavailable.');
    const sequence = child(top, 'autoNumberingSequenceHasCreated');
    if (sequence) set(sequence, numbering.auto_numbering_rev_no === null ? '0' : '1');
    else
      content(top).push(
        element('autoNumberingSequenceHasCreated', numbering.auto_numbering_rev_no === null ? '0' : '1'),
      );
    const labels = must(top, 'labels');
    labels.labels = (await query(client, queries.getData.label, { top_id: topId })).rows.map((row) =>
      rowElement('label', row),
    );
    delete labels[':@'];
    for (const sheet of children(must(top, 'sheets'), 'sheet')) {
      const sheetId = integerField(sheet, 'defSheetId');
      const references = must(sheet, 'references');
      references.references = (await query(client, queries.getData.reference, { sheet_id: sheetId })).rows.map((row) =>
        rowElement('reference', row),
      );
      delete references[':@'];
      const clusters = children(must(sheet, 'clusters'), 'cluster');
      for (const cluster of clusters) {
        const management = child(cluster, 'management');
        if (management) remove(management, 'authority');
      }
      const roles = (await query(client, queries.getData.clusterRole, { sheet_id: sheetId })).rows;
      for (const row of roles) {
        const cluster = clusters.find((item) => field(item, 'clusterId') === String(row.cluster_id));
        if (!cluster) throw new Error('Definition cluster role has no matching cluster.');
        let management = child(cluster, 'management');
        if (!management) {
          management = element('management', [
            element('authority'),
            element(
              'mail',
              ['apply', 'approve', 'remand', 'change'].map((name) => element(name)),
            ),
          ]);
          content(cluster).push(management);
        }
        if (!child(management, 'authority')) content(management).push(element('authority'));
        const group = element('groupId', String(row.group_id));
        group[':@'] = { '@_roleType': String(row.role_type) };
        content(must(management, 'authority')).push(group);
      }
      const custom = (
        await client.query(
          "SELECT cl.cluster_id FROM def_top top INNER JOIN def_sheet sh ON top.def_top_id=sh.def_top_id INNER JOIN def_cluster cl ON sh.def_sheet_id=cl.def_sheet_id WHERE cl.cluster_type='SelectMaster' AND sh.def_sheet_id=$1",
          [sheetId],
        )
      ).rows;
      for (const row of custom) {
        const cluster = clusters.find((item) => field(item, 'clusterId') === String(row.cluster_id));
        const master = cluster && child(cluster, 'userCustomMaster');
        const id = master && child(master, 'masterTableId');
        if (!master || !id || (child(master, 'masterKey') && value(must(master, 'masterKey')))) continue;
        const masterId = integer(value(id));
        if (masterId === undefined) continue;
        const record = (
          await client.query(
            'SELECT mst.master_key FROM mst_custom_table mst WHERE NOT EXISTS (SELECT 1 FROM custom_table_delete del WHERE mst.master_id=del.master_id) AND mst.master_id=$1',
            [masterId],
          )
        ).rows[0];
        if (record) replace(master, 'masterKey', record.master_key ?? '');
      }
    }
    let locked = '0';
    if (await approveMode(client)) {
      const approval = (await client.query('SELECT def_approve_status FROM def_top WHERE def_top_id=$1', [topId]))
        .rows[0];
      if (Number(approval?.def_approve_status) === 2 && field(top, 'publicStatus') === '1') {
        locked = '2';
        readOnly = 1;
      }
    }
    set(must(top, 'locked'), locked);
    set(must(top, 'readOnly'), String(readOnly));
    if (readOnly < 1 && !(await acquireLock(client, actor, topId))) set(must(top, 'locked'), '1');
    return serialize(xml);
  } finally {
    client.release();
  }
}

// LibraryDetailBase selects definition-update versus report-create permission by client type.
export async function getDefinitionDetail(db: pg.Pool, actor: DefinitionActor, topId: number): Promise<string> {
  return getLibraryDetail(db, actor, topId, false);
}
export async function getReportDetail(db: pg.Pool, actor: DefinitionActor, topId: number): Promise<string> {
  return getLibraryDetail(db, actor, topId, true);
}
async function getLibraryDetail(db: pg.Pool, actor: DefinitionActor, topId: number, report: boolean): Promise<string> {
  validate(actor, topId);
  const queries = queryFile(report ? 'ReportDetailBiz.xml' : 'DefinitionDetailBiz.xml') as unknown as Record<
    string,
    string
  >;
  const client = await db.connect();
  try {
    const data = (await query(client, queries.report, { topId })).rows[0];
    if (!data) return '<conmas/>';
    const strict =
      report &&
      (
        await client.query(
          "SELECT com_value FROM mst_common WHERE com_key='LOCK_SETTING' AND com_name='REPORT_STRICT_LOCK' ORDER BY com_index LIMIT 1",
        )
      ).rows[0]?.com_value === '1';
    const statement = queries[
      actor.client && actor.client !== 'Designer' ? 'checkRportCreate' : 'checkUpdatable'
    ].replace('{0}', strict ? '' : 'AND rep_lock.user_id <> :user_id');
    const permissions = (await query(client, statement, { topId, user_id: actor.userId })).rows[0];
    if (String(permissions.role_read) === '0') return errorXml(3);
    data.thumbnail = Buffer.isBuffer(data.thumbnail_file) ? data.thumbnail_file.toString('base64') : '';
    delete data.thumbnail_file;
    data.readOnly = String(permissions.role_update) === '0' ? '1' : '0';
    data.locked = String(permissions.locked);
    const definitionThumbnail = data.def_thumbnail_file;
    if (Buffer.isBuffer(definitionThumbnail) && definitionThumbnail.length) delete data.def_thumbnail_file;
    const detail = rowElement('detailInfo', data),
      xml = element('conmas', [detail]);
    for (const [name, statement, item] of [
      ['labels', 'label', 'label'],
      ['clusters', 'cluster', 'cluster'],
      ['approval', 'approve', 'cluster'],
    ]) {
      content(detail).push(
        element(
          name,
          (await query(client, queries[statement], { topId })).rows.map((row) => rowElement(item, row)),
        ),
      );
    }
    const stored = (await query(client, queries.getXmlData, { top_id: topId })).rows[0];
    if (stored) {
      const copy = child(must(root(stored.xml_data), 'top'), 'reportCopyType');
      if (copy) content(detail).push(copy);
    }
    if (report) {
      if (String(permissions.locked) === '1') {
        const lock = (await query(client, queries.selectLock, { top_id: topId })).rows[0];
        content(detail).push(
          element('lockedUserName', lock?.user_name ?? ''),
          element('lockedUserId', lock?.user_id ?? ''),
        );
      }
      if (
        actor.userId !== 'conmasadmin' &&
        Number(
          Object.values((await query(client, queries.checkClusterRole, { topId, user_id: actor.userId })).rows[0])[0],
        ) > 0
      ) {
        replace(detail, 'hide', '1');
        if (Buffer.isBuffer(definitionThumbnail)) replace(detail, 'thumbnail', definitionThumbnail.toString('base64'));
      }
    } else if (await approveMode(client)) {
      const approval = (
        await client.query('SELECT def_approve_status,def_approver_comment FROM def_top WHERE def_top_id=$1', [topId])
      ).rows[0];
      if (Number(approval?.def_approve_status) === 3)
        content(detail).push(element('remandComment', approval.def_approver_comment ?? ''));
    }
    return serialize(xml);
  } finally {
    client.release();
  }
}

export async function unlockDefinition(db: pg.Pool, actor: DefinitionActor, topId: number): Promise<string> {
  validate(actor, topId);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    try {
      await deleteOwnedLock(client, actor, topId);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    return errorXml(0);
  } finally {
    client.release();
  }
}

export async function getDefinitionList(
  db: pg.Pool,
  actor: DefinitionActor,
  params: Record<string, unknown>,
): Promise<string> {
  return getLibraryList(db, actor, params, false);
}
export async function getReportList(
  db: pg.Pool,
  actor: DefinitionActor,
  params: Record<string, unknown>,
): Promise<string> {
  return getLibraryList(db, actor, params, true);
}

// Both clients use LibraryListBase; keep its filters in one place, with each original query file.
async function getLibraryList(
  db: pg.Pool,
  actor: DefinitionActor,
  params: Record<string, unknown>,
  report: boolean,
): Promise<string> {
  validate(actor, -1);
  if (String(params.urlSchemeMode ?? '') !== '') throw new Error('Definition list request mode is not implemented.');
  const tablet = actor.client === 'iPad';
  const document = queryDocument(report ? 'ReportListBiz.xml' : 'DefinitionListBiz.xml');
  const base = document.baseQuery as Record<string, string>;
  const variables = document.variables as Record<string, Record<string, unknown>>;
  const orderBy = document.orderBy as Record<string, string>;
  const int = (name: string, fallback: number) => integer(String(params[name] ?? '')) ?? fallback;
  const bool = (name: string, fallback: boolean) =>
    /^(true|false)$/i.test(String(params[name] ?? '').trim())
      ? String(params[name]).trim().toLowerCase() === 'true'
      : fallback;
  let labelId = int('labelId', -1);
  const topId = int('topId', -1),
    publicStatus = int('publicStatus', -1),
    editStatus = int('editStatus', -1);
  let targetLabel = bool('itemTargetLabel', true),
    targetSheet = bool('itemTargetSheet', true),
    targetSet = bool('itemTargetSet', true);
  const word = String(params.word ?? ''),
    targets = ['Name', 'Remarks', 'Id'].filter((name) => bool('wordTarget' + name, false));
  let targetValue = bool('wordTargetValue', false);
  if (!report && targetValue && !targets.includes('Name') && !targets.includes('Remarks'))
    return '<conmas><items/></conmas>';
  const halfWidth = (text: string) =>
    text
      .replace(/[！＃＄％＆（）＊＋，－．／０-９：；＜＝＞？＠Ａ-Ｚ［］＾＿｀ａ-ｚ｛｜｝～]/g, (character) =>
        String.fromCharCode(character.charCodeAt(0) - 65248),
      )
      .replaceAll('\u3000', ' ');
  const words = halfWidth(word)
    .replace(/(\s)\1{1,}/g, ' ')
    .trim()
    .split(' ');
  const values: Record<string, unknown> = {
    labelId,
    top_id: topId,
    publicStatus,
    editStatus,
    user_id: actor.userId,
    wordMatch: word,
    expire: new Date(),
  };
  words.forEach((item, index) => {
    values['word_' + index] = '%%' + halfWidth(item) + '%%';
  });
  for (let index = 1; index <= 5; index++) values['systemKey' + index] = params['systemKey' + index];
  const sortId = String(params.sortId ?? '') || 'default',
    sortType = params.sortId ? String(params.sortType ?? '') : '';
  const ordering = orderBy['sort' + sortId + sortType];
  if (!ordering) throw new Error('Invalid definition list sort.');
  const client = await db.connect();
  try {
    const settings = (
      await client.query(
        "SELECT com_key,com_name,com_value FROM mst_common WHERE com_key IN ('LABEL_SETTING','SEARCH_SETTING','IPAD_SETTING') ORDER BY com_index",
      )
    ).rows;
    const setting = (name: string, key = 'LABEL_SETTING') =>
      settings.find((row) => row.com_key === key && row.com_name === name)?.com_value ?? '';
    if (
      report &&
      ['2', '3', '5'].includes(String(editStatus)) &&
      actor.client !== 'API' &&
      setting('DISPLAY_REPORTS_AWAITING_APPROVAL_WITHOUT_LABELS', 'IPAD_SETTING') === '1'
    ) {
      labelId = -9;
      values.labelId = labelId;
      targetLabel = false;
    }
    if (report && setting('CLUSTER_VALUE_FILTER', 'SEARCH_SETTING') !== '1') targetValue = false;
    const labelOnly = targetLabel && !targetSheet && !targetSet;
    if (
      tablet &&
      word &&
      ((!targetLabel && !targetSet && !targetSheet) ||
        (!targets.length && !targetValue) ||
        (targets.includes('Id') && integer(word) === undefined) ||
        (labelOnly &&
          (targets.includes('Id') || (targetValue && !targets.includes('Name') && !targets.includes('Remarks')))))
    )
      return '<conmas><items/></conmas>';
    const layerSearch =
      tablet &&
      !!word &&
      (targetSheet || targetSet) &&
      (!targets.includes('Name') || setting('LABEL_MODE_TARGET_NAME', 'SEARCH_SETTING') === '1') &&
      (!targetValue || setting('LABEL_MODE_TARGET_INPUT_VALUE', 'SEARCH_SETTING') === '1') &&
      (!targets.includes('Remarks') || setting('LABEL_MODE_TARGET_REMARKS', 'SEARCH_SETTING') === '1');
    const recursiveLabels =
      ((tablet && setting('LABEL_LAYER_SEARCH_MODE_FOR_TABLET', 'SEARCH_SETTING') === '1') ||
        (actor.client === 'API' && setting('LABEL_LAYER_SEARCH_MODE_FOR_API', 'SEARCH_SETTING') === '1')) &&
      !!word;
    if (layerSearch && !recursiveLabels) targetLabel = false;
    if (!targetLabel && !targetSheet && !targetSet && !bool('itemTargetBook', true)) {
      targetSheet = true;
      targetSet = true;
    }
    const groups = report
      ? (await client.query('SELECT group_id FROM mst_group_affiation WHERE user_id=$1', [actor.userId])).rows
      : [];
    groups.forEach((row, index) => {
      values['group_' + index] = row.group_id;
    });
    const groupSql = groups.length ? groups.map((_, index) => ':group_' + index).join(',') : 'NULL';
    const expand = (text: string) =>
      text
        .replaceAll('{groupIdList}', groupSql)
        .replaceAll(
          '{REP_CLUSTER}',
          setting('APPROVE_MODE', 'SEARCH_SETTING') === '1' ? 'rep_cluster_approval' : 'rep_cluster',
        )
        .replaceAll(
          '{REP_CLUSTER_ROLE}',
          setting('APPROVE_MODE', 'SEARCH_SETTING') === '1' ? 'rep_cluster_role_approval' : 'rep_cluster_role',
        );
    const edit =
      report && ![2, 3, 5].includes(editStatus) && editStatus >= 0
        ? String(variables.report.editStatus)
        : String(variables.report['editStatus' + editStatus] ?? '');
    const parts: string[] = [];
    for (const type of [
      targetLabel ? 'label' : '',
      targetSheet || (report && targetSet) ? 'sheet' : '',
      !report && targetSet ? 'set' : '',
    ].filter(Boolean)) {
      const source = variables[type === 'label' ? 'label' : 'report'];
      const layers = source.layer as Record<string, string>;
      const replacements: Record<string, string> = {};
      replacements.layer =
        layers[
          (labelId < 0 && topId > 0) || labelId === -9
            ? 'none'
            : labelId < 0
              ? layerSearch && type !== 'label'
                ? 'tops'
                : 'top'
              : layerSearch && type !== 'label'
                ? 'childs'
                : 'child'
        ];
      if (type === 'label') {
        replacements.labelRole = actor.userId === 'conmasadmin' ? '' : String(source.labelRole);
        const hiddenEdit = [0, 1, 4].includes(editStatus) ? ' AND edit_refer_status = ' + editStatus : edit;
        replacements.hiddenMode =
          setting('MODE') === '1'
            ? String(source.hiddenMode)
                .replace('{0}', hiddenEdit)
                .replace('{1}', publicStatus >= 0 ? ' AND public_status = :publicStatus' : '')
            : '';
      } else {
        replacements.publicStatus = publicStatus > -1 ? String(source.publicStatus) : '';
        if (report) {
          replacements.current = bool('history', false) ? '' : String(source.current);
          replacements.reportType =
            targetSheet && targetSet
              ? ' AND report_type IN (1,2)'
              : targetSheet
                ? ' AND report_type = 1'
                : ' AND report_type = 2';
          replacements.registUpdateTime = '';
          for (const [name, column, operator] of [
            ['registTimeFrom', 'sys_regist_time', '>='],
            ['registTimeTo', 'sys_regist_time', '<='],
            ['updateTimeFrom', 'sys_update_time', '>='],
            ['updateTimeTo', 'sys_update_time', '<='],
          ]) {
            const text = String(params[name] ?? ''),
              date = text ? new Date(text) : undefined;
            if (date && !Number.isNaN(date.getTime())) {
              values[name] = date;
              replacements.registUpdateTime += ` AND ${column} ${operator} :${name}`;
            }
          }
          const definitions = String(params.definition ?? '')
            .split(',')
            .map(integer)
            .filter((id) => id !== undefined && id !== -1);
          definitions.forEach((id, index) => {
            values['definition_' + index] = id;
          });
          const ids = definitions.map((_, index) => ':definition_' + index).join(',');
          replacements.definition = ids
            ? ` AND (rep_top.def_top_id IN (${ids})${bool('definitionHistory', false) ? ` OR EXISTS (SELECT 1 FROM def_top WHERE def_top.def_top_id=rep_top.def_top_id AND def_top.def_top_org IN (SELECT def_top_org FROM def_top WHERE def_top_id IN (${ids})))` : ''})`
            : '';
          values.auto_numbering_value = params.autoNumberingValue;
          replacements.autoNumberingValue = params.autoNumberingValue
            ? " AND replace(auto_numbering_value, '{SAVE_COUNT}', coalesce(auto_numbering_display_save_count, '')) = :auto_numbering_value"
            : '';
        } else
          replacements.topId =
            topId === -1 && !bool('history', false) ? String(source.current) : topId !== -1 ? String(source.topId) : '';
        replacements.editStatus = edit;
        replacements.expireStart = tablet && publicStatus === 1 ? String(source.expireStart ?? '') : '';
        replacements.expireEnd = tablet ? String(source.expireEnd ?? '') : '';
        replacements.systemKey = Array.from({ length: 5 }, (_, index) => index + 1)
          .filter((index) => params['systemKey' + index] !== undefined && String(params['systemKey' + index]) !== '')
          .map((index) => ` AND system_key${index} = :systemKey${index}`)
          .join('');
      }
      let search = '';
      const searchTemplates = source.word as Record<string, string>;
      for (const name of ['Name', 'Value', 'Remarks']) {
        if (!word || (name === 'Value' ? !targetValue || !searchTemplates.clusterValue : !targets.includes(name)))
          continue;
        if (search) search += ' OR ';
        const template = searchTemplates[name === 'Name' ? 'name' : name === 'Value' ? 'clusterValue' : 'remarks'];
        search +=
          '(1=1' + words.map((_, index) => ' AND (' + template.replaceAll('{0}', String(index)) + ')').join('') + ')';
      }
      // Legacy appends the ID clause without OR; mixed ID/text choices can therefore raise the original SQL error.
      if (word && targets.includes('Id')) {
        if (!searchTemplates.id) throw new Error('Definition label ID search is unsupported by the source query.');
        search += searchTemplates.id;
      }
      replacements.word = search ? ' AND (' + search + ')' : '';
      let statement = base[type];
      if (type === 'label' && recursiveLabels) {
        const table = report ? 'mst_label_rep' : 'mst_label_def';
        replacements.layer = 'WHERE 1=1';
        statement = statement
          .replace(
            'FROM ' + table,
            `FROM (WITH RECURSIVE r AS (
          SELECT 0 AS level,'000_' || lpad(cast(diplay_number as varchar),10,'0') AS sort_key,${table}.* FROM ${table} WHERE ${labelId < 0 ? 'upper_label_id IS NULL' : 'mst_label_id=:labelId'}
          UNION ALL SELECT r.level+1,r.sort_key || '_' || lpad(cast(r.level+1 as varchar),3,'0') || '_' || lpad(cast(l.diplay_number as varchar),10,'0'),l.* FROM ${table} l JOIN r ON r.mst_label_id=l.upper_label_id)
          SELECT DISTINCT * FROM r ORDER BY sort_key) ${table}`,
          )
          .replace(',label_name         AS "name"', ',label_name_path         AS "name"')
          .replace(',\'\' AS "labelTreeOrder"', ',sort_key AS "labelTreeOrder"');
      }
      parts.push(
        expand(
          statement.replace(/\{(\w+)\}/g, (_, name: string) => {
            if (name === 'SAVE_COUNT') return '{SAVE_COUNT}';
            if (name === 'groupIdList') return groupSql;
            if (!(name in replacements)) throw new Error('Unimplemented definition list query variable: ' + name);
            return replacements[name];
          }),
        ),
      );
    }
    if (!parts.length) return '<conmas><items/></conmas>';
    const rows = (await query(client, parts.join(' UNION ALL ') + ' ' + ordering, values)).rows;
    if (!report && tablet && publicStatus === 2) {
      const minute = new Date();
      minute.setSeconds(0, 0);
      const reserved = rows.filter((row) => row.use_start_date && new Date(row.use_start_date) > minute);
      if (reserved.length) {
        reserved.forEach((row, index) => {
          values['reserved_' + index] = row.itemId;
        });
        const midnight = new Date();
        midnight.setHours(0, 0, 0, 0);
        values.current_time = midnight;
        const previous = (
          await query(
            client,
            String(document.getReservedDefListQuery).replace(
              '{0}',
              reserved.map((_, index) => ':reserved_' + index).join(','),
            ),
            values,
          )
        ).rows;
        for (const row of reserved) {
          const old = previous.find((item) => String(item.itemOrg) === String(row.itemOrg));
          if (!old) rows.splice(rows.indexOf(row), 1);
          else
            for (const name of [
              'itemId',
              'name',
              'dispRemarks',
              'registTime',
              'updateTime',
              'mobileSave',
              'revNo',
              'isReportCopy',
              'isSortReport',
              'mobileEditType',
            ])
              row[name] = old[name];
        }
      }
    }
    if (setting('SORT_TYPE') === '1') {
      const labels = rows.filter((row) => Number(row.type) === 0),
        reports = rows.filter((row) => Number(row.type) !== 0);
      // shortcut: Intl collation is not proven identical to .NET across locales; verify localized ordering before claiming that parity.
      const collator = new Intl.Collator(actor.cultureName || 'en-US');
      const secondary = sortId === '1' ? 'registTime' : sortId === '2' ? 'updateTime' : 'itemId';
      labels.sort(
        (a, b) =>
          (collator.compare(a.name ?? '', b.name ?? '') ||
            (secondary === 'itemId'
              ? Number(a.itemId) - Number(b.itemId)
              : collator.compare(a[secondary] ?? '', b[secondary] ?? ''))) * (sortType === 'desc' ? -1 : 1),
      );
      rows.splice(0, rows.length, ...labels, ...reports);
    }
    const configuration = clientConfiguration();
    for (const row of rows) {
      delete row.labelTreeOrder;
      if (!actor.client || actor.client === 'Designer') {
        if (row.designerVersion === '') row.designerVersion = configuration.designerVersion;
        if (row.designerDisplayVersion === '') row.designerDisplayVersion = configuration.designerDisplayVersion;
      } else {
        delete row.designerVersion;
        delete row.designerDisplayVersion;
      }
    }
    return serialize(
      element('conmas', [
        element(
          'items',
          rows.map((row) => rowElement('item', row)),
        ),
      ]),
    );
  } finally {
    client.release();
  }
}

export class DefinitionUploadUnsupported extends Error {}
export function definitionQuotaExceeded(quotaText: string | undefined, count: number): boolean {
  // LicenseManager ignores an absent or non-int32 Definition field.
  const quota = quotaText === undefined ? undefined : integer(quotaText);
  return quota !== undefined && quota <= count;
}
function uploadInteger(node: XmlNode, name: string, fallback?: number | null): number | null {
  if (fallback !== undefined && !optionalField(node, name)) return fallback;
  return integerField(node, name);
}
function takeBinary(node: XmlNode, name: string): Buffer {
  const text = field(node, name).replace(/[ \t\r\n]/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text))
    throw new Error('Invalid definition binary.');
  set(must(node, name), '');
  return Buffer.from(text, 'base64');
}
function uploadRemarks(node: XmlNode, prefix: string, names = true): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (let index = 1; index <= 10; index++) {
    result[`${prefix}_remarks${index}`] = field(node, 'remarksValue' + index);
    if (names) result[`${prefix}_remarks_name${index}`] = field(node, 'remarksName' + index);
  }
  return result;
}
function uploadValidation(top: XmlNode, clusters: XmlNode[]): string | undefined {
  const tables = child(top, 'tables') ? children(must(top, 'tables'), 'table') : [];
  const pin = clusters.some((cluster) => field(cluster, 'type') === 'DrawingImage');
  const detail = clusters.some((cluster) => optionalField(cluster, 'remarksValue1') === '{ir_detail}');
  if (pin && tables.length) return errorXml(1011, 'exist pin and table.');
  if (pin && detail) return errorXml(1012, 'exist pin and detail.');
  if (
    !pin &&
    detail &&
    tables.some((table) => clusters.some((cluster) => optionalField(cluster, 'remarksValue2') === field(table, 'no')))
  )
    return errorXml(1021, 'duplicate table num in table and detail.');
  const work = optionalField(top, 'workReportType');
  if (!work) return;
  const type = integer(work);
  if (type === undefined || type < 0 || type > 3) return errorXml(2, "'workReportType' is invalid.");
  if (type === 1) {
    const daily = optionalField(top, 'dailyReportCluster');
    if (!daily) return errorXml(2, "'dailyReportCluster' is required.");
    const pair = daily.split(',').map(integer);
    if (pair.length !== 2 || pair.some((value) => value === undefined))
      return errorXml(2, "'dailyReportCluster' is invalid.");
    const cluster = clusters.find(
      (cluster) => field(cluster, 'sheetNo') === String(pair[0]) && field(cluster, 'clusterId') === String(pair[1]),
    );
    if (!cluster) return errorXml(2, "cluster specified in 'dailyReportCluster' is not exists.");
    if (!['Date', 'CalendarDate'].includes(field(cluster, 'type')))
      return errorXml(2, "type of cluster specified in 'dailyReportCluster' must be 'Date' or 'CalendarDate'.");
  } else if (type === 2 || type === 3) {
    const number = integer(optionalField(top, 'workReportTableNo'));
    if (number === undefined) return errorXml(2, "'workReportTableNo' is required.");
    const table = tables.find((table) => field(table, 'no') === String(number));
    if (!table) return errorXml(2, "table specified in 'workReportTableNo' is not exists.");
    const columns = child(table, 'columns'),
      rows = child(table, 'rows');
    if (!columns || !children(columns, 'column').some((column) => field(column, 'type').toLowerCase() === 'date'))
      return errorXml(3011, "table specified in 'workReportTableNo' must have date row.");
    if ((rows ? children(rows, 'row').length : 0) < (type === 2 ? 7 : 31))
      return errorXml(
        type === 2 ? 3021 : 3022,
        `table specified in 'workReportTableNo' must have at least ${type === 2 ? 7 : 31} rows.`,
      );
  }
}
function uploadTop(top: XmlNode, binary: Record<string, unknown>): Record<string, unknown> {
  const params: Record<string, unknown> = {
    ...binary,
    ...uploadRemarks(top, 'top'),
    def_top_name: field(top, 'defTopName'),
  };
  for (const [column, name] of Object.entries({
    report_type: 'reportType',
    def_sheet_count: 'sheetCount',
    auto_gen: 'autoGen',
    public_status: 'publicStatus',
    mobile_save: 'mobileSave',
    auto_select_gen: 'autoSelectGen',
    remarks_edit: 'remarksEditable',
  }))
    params[column] = integerField(top, name);
  const numbers: [string, string, number | null][] = [
    ['finish_output', 'finishOutput', 1],
    ['edit_output', 'editOutput', 1],
    ['mobile_report_save', 'mobileReportSave', 1],
    ['image_size', 'imageSize', null],
    ['excel_output', 'excelOutput', 1],
    ['can_send_mail_as_attachment', 'canSendMailAsAttachment', 1],
    ['can_open_as_pdf', 'canOpenAsPdf', 0],
    ['report_copy_enable', 'isReportCopy', 1],
    ['mobile_edit_type', 'mobileEditType', 0],
    ['use_applicant_lock', 'useApplicantLock', 0],
    ['use_input_history', 'useInputHistory', 0],
    ['use_change_reason', 'useChangeReason', 0],
    ['use_init_input_judge', 'useInitInputJudge', 0],
    ['use_exclusive_mode', 'useExclusiveMode', 0],
    ['use_exclusive_mode_manager', 'useExclusiveModeManager', 0],
    ['no_need_to_fill_type', 'noNeedToFillOutType', 0],
    ['required_check_mode', 'requiredCheckMode', 0],
    ['required_save_mode', 'requiredSaveMode', 0],
    ['calculate_mode', 'calculateMode', 0],
    ['is_sort_report', 'isSortReport', 0],
    ['journalizing_def_top_id', 'journalizingDefTopId', 0],
    ['use_identification', 'useIdentification', null],
  ];
  for (const [column, name, fallback] of numbers) params[column] = uploadInteger(top, name, fallback);
  for (const [column, name] of Object.entries({
    complete_Mail: 'completeMail',
    edit_mail: 'editMail',
    no_need_to_fill_string: 'noNeedToFillOutString',
  }))
    params[column] = optionalField(top, name);
  params.pic_original_resolution = optionalField(top, 'picOriginalResolution') || '0';
  for (let index = 1; index <= 5; index++) params['system_key' + index] = optionalField(top, 'systemKey' + index);
  for (const name of ['finishOutputFiles', 'editOutputFiles', 'useInitInputJudgeParameters']) {
    const column =
      name === 'finishOutputFiles'
        ? 'finish_output_files'
        : name === 'editOutputFiles'
          ? 'edit_output_files'
          : 'use_init_input_judge_parameters';
    params[column] = child(top, name) ? serialize(must(top, name)) : '';
  }
  for (const [column, name] of [
    ['designer_version', 'designerVersion'],
    ['designer_display_version', 'designerDisplayVersion'],
  ]) {
    params[column] = child(top, name) ? field(top, name) : null;
    remove(top, name);
  }
  params.work_report_type = optionalField(top, 'workReportType') || null;
  params.update_definition_app = optionalField(top, 'updateDefinitionApp') || null;
  params.cooperation_table = child(top, 'cooperationTable') && field(top, 'cooperationTable') !== '0' ? 1 : 0;
  return params;
}

// DefinitionBiz.Regist/Entry/Replace: success is returned only after all supported relational and binary writes commit.
export async function registerDefinition(
  db: pg.Pool,
  actor: DefinitionActor,
  xml: string,
  approveType = '',
): Promise<string> {
  validate(actor, 0);
  const document = root(xml),
    top = must(document, 'top');
  if (tag(document) !== 'conmas') throw new Error('Invalid definition XML root.');
  const sheets = children(must(top, 'sheets'), 'sheet').sort((a, b) =>
    field(a, 'sheetNo') < field(b, 'sheetNo') ? -1 : field(a, 'sheetNo') > field(b, 'sheetNo') ? 1 : 0,
  );
  const clusters = sheets.flatMap((sheet) => children(must(sheet, 'clusters'), 'cluster'));
  const invalid = uploadValidation(top, clusters);
  if (invalid) return invalid;
  // shortcut: approval notifications remain unported; refuse applications until their side effects are implemented.
  if (approveType === '1')
    throw new DefinitionUploadUnsupported('Definition approval-application saving has not been migrated.');
  const oldText = field(top, 'defTopId'),
    oldId = oldText ? integer(oldText) : undefined;
  if (oldText && oldId === undefined) throw new Error('Invalid definition ID.');
  const queries = queryFile('DefinitionBiz.xml');
  const client = await db.connect();
  const run = (text: string, params: Record<string, unknown>) => query(client, text.replace(/;+\s*$/, ''), params);
  try {
    await client.query('BEGIN');
    // Serialize lineage/current/quota decisions; this never resets existing IDs or sequences.
    await client.query('LOCK TABLE def_top,def_current IN SHARE ROW EXCLUSIVE MODE');
    const settings = new Map<string, string>(
      (
        await client.query(
          "SELECT com_key,com_name,com_value FROM mst_common WHERE com_key IN ('SYSTEM_ROLE_SETTING','OUTPUT_SETTING') ORDER BY com_index",
        )
      ).rows.map((row) => [row.com_key + '/' + row.com_name, row.com_value ?? '']),
    );
    const temporaryXml = settings.get('OUTPUT_SETTING/TMP_XML')?.trim().toLowerCase() ?? 'false';
    if (!['true', 'false'].includes(temporaryXml)) throw new Error('Invalid definition temporary-XML setting.');
    if (temporaryXml === 'true')
      throw new DefinitionUploadUnsupported('Definition temporary-XML output has not been migrated.');
    if (
      child(top, 'tables') &&
      children(must(top, 'tables'), 'table').length &&
      (
        await client.query(
          "SELECT com_value FROM mst_common WHERE com_key='COOPERATION_TABLE_SETTING' AND com_name='REGIST_IMMEDIATELY' ORDER BY com_index LIMIT 1",
        )
      ).rows[0]?.com_value === '0'
    )
      throw new DefinitionUploadUnsupported('Deferred definition table generation has not been migrated.');
    if (
      optionalField(top, 'cooperationTable') &&
      optionalField(top, 'cooperationTable') !== '0' &&
      clusters.some((cluster) => field(cluster, 'type') === 'DrawingImage')
    )
      throw new DefinitionUploadUnsupported('Deferred pin table generation has not been migrated.');
    const old =
      oldId === undefined
        ? undefined
        : (await client.query('SELECT * FROM def_top WHERE def_top_id=$1 FOR UPDATE', [oldId])).rows[0];
    if (oldId === undefined) {
      const role = (await run(queries.other.checkCreateRole, { user_id: actor.userId })).rows[0];
      if (!(Number(role?.role_create) > 0)) {
        await client.query('ROLLBACK');
        return errorXml(3);
      }
    } else {
      const role = (await run(queries.other.checkUpdatable, { def_top_id: oldId, user_id: actor.userId })).rows[0];
      if (!old || !role) {
        await client.query('ROLLBACK');
        return errorXml(3);
      }
    }
    if (field(top, 'publicStatus') === '2' && (await approveMode(client))) {
      const role = (
        await client.query(
          'SELECT MAX(role_def_approve) AS approval FROM mst_group WHERE group_id IN (SELECT group_id FROM mst_group_affiation WHERE user_id=$1)',
          [actor.userId],
        )
      ).rows[0];
      if (String(role?.approval) !== '1') {
        await client.query('ROLLBACK');
        return errorXml(1003);
      }
    }
    if (oldId === undefined) {
      const quotaText = readLicenseFields().get('Definition');
      if (
        quotaText !== undefined &&
        definitionQuotaExceeded(
          quotaText,
          Number((await client.query('SELECT COUNT(1) AS count FROM def_current')).rows[0].count),
        )
      ) {
        await client.query('ROLLBACK');
        return errorXml(11050, 'definition license error.');
      }
    }
    const current = old
      ? (await client.query('SELECT 1 FROM def_current WHERE def_top_id=$1', [oldId])).rowCount! > 0
      : false;
    const boundary = new Date();
    boundary.setMinutes(boundary.getMinutes() + 1, 0, 0);
    const reserved =
      current &&
      Number(old?.public_status) === 2 &&
      old?.use_start_date instanceof Date &&
      old.use_start_date >= boundary;
    const replaceExisting =
      !!old &&
      ((reserved && field(top, 'publicStatus') === '2') || (current && !reserved && Number(old.public_status) !== 2));
    const origin = old ? Number(old.def_top_org ?? oldId) : undefined;
    if (origin !== undefined) {
      if (!child(top, 'management')) {
        const previous = child(must(root(old.xml_data), 'top'), 'management');
        if (previous) content(top).push(previous);
      }
    }
    const now = new Date(),
      pad = (n: number) => String(n).padStart(2, '0');
    const date = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const topId = replaceExisting
      ? oldId!
      : Number((await client.query("SELECT nextval('def_top_def_top_id_seq') AS id")).rows[0].id);
    const orgId = origin ?? topId;
    const rev = replaceExisting
      ? Number(old.rev_no)
      : old
        ? Number(
            (await client.query('SELECT MAX(rev_no) AS rev FROM def_top WHERE def_top_org=$1', [orgId])).rows[0].rev,
          ) + 1
        : 1;
    set(must(top, 'defTopId'), String(topId));
    if (!replaceExisting) {
      set(must(top, 'registTime'), date);
      set(must(top, 'registUser'), actor.userId);
    }
    set(must(top, 'updateTime'), date);
    set(must(top, 'updateUser'), actor.userId);
    replace(top, 'serverVersion', clientConfiguration().serverVersion);
    const audit = {
      sys_regist_term: actor.terminalId,
      sys_regist_user: actor.userId,
      sys_regist_time: now,
      sys_update_term: actor.terminalId,
      sys_update_user: actor.userId,
      sys_update_time: now,
    };
    const topBinary = {
      thumbnail_file: takeBinary(top, 'thumbnail'),
      background_image_file: takeBinary(top, 'backgroundImage'),
    };
    if (!child(top, 'definitionFile'))
      content(top).push(
        element(
          'definitionFile',
          ['type', 'name', 'value'].map((name) => element(name)),
        ),
      );
    const file = must(top, 'definitionFile');
    const params = uploadTop(top, {
      ...topBinary,
      def_file_type: field(file, 'type'),
      def_file_name: field(file, 'name'),
      def_file: takeBinary(file, 'value'),
    });
    const approvalColumns = [
      'def_approve_status',
      'def_applicant',
      'def_applicant_name',
      'def_applicant_comment',
      'def_applicant_date',
      'def_approver',
      'def_approver_name',
      'def_approver_comment',
      'def_approver_date',
    ];
    for (const name of approvalColumns)
      params[name] = replaceExisting
        ? (old[name] ?? (name.endsWith('date') || name === 'def_approve_status' ? null : ''))
        : null;
    const savedSheets: { node: XmlNode; params: Record<string, unknown>; existing: boolean; previousId?: number }[] =
      [];
    for (const sheet of sheets) {
      const previousText = field(sheet, 'defSheetId'),
        previousId = previousText ? integerField(sheet, 'defSheetId') : undefined;
      const existing = replaceExisting && previousId !== undefined;
      if (
        old &&
        previousId !== undefined &&
        !(await client.query('SELECT 1 FROM def_sheet WHERE def_sheet_id=$1 AND def_top_id=$2', [previousId, oldId]))
          .rowCount
      )
        throw new Error('Definition sheet does not belong to the saved definition.');
      const id = existing
        ? previousId!
        : Number((await client.query("SELECT nextval('def_sheet_def_sheet_id_seq') AS id")).rows[0].id);
      if (!replaceExisting && old) replace(sheet, 'defSheetIdOrg', previousText);
      else if (!old) remove(sheet, 'defSheetIdOrg');
      set(must(sheet, 'defSheetId'), String(id));
      savedSheets.push({
        node: sheet,
        existing,
        previousId,
        params: {
          ...audit,
          ...uploadRemarks(sheet, 'sheet'),
          def_sheet_id: id,
          def_top_id: topId,
          def_sheet_no: integerField(sheet, 'sheetNo'),
          def_sheet_name: field(sheet, 'defSheetName'),
          auto_select_gen: integerField(sheet, 'autoSelectGen'),
          thumbnail_file: takeBinary(sheet, 'thumbnail'),
          background_image_file: takeBinary(sheet, 'backgroundImage'),
          xml_data: '',
          import_image: uploadInteger(sheet, 'importImage', 1),
          copy_disable: uploadInteger(sheet, 'copyDisable', 0),
        },
      });
    }
    const writeTop = () =>
      run(queries.top[replaceExisting ? 'update' : 'insert'], {
        ...audit,
        ...params,
        def_top_id: topId,
        def_top_org: orgId,
        rev_no: rev,
        server_version: clientConfiguration().serverVersion,
        xml_data: serialize(document),
      });
    if (!replaceExisting) {
      await writeTop();
      if (old) {
        await run(queries.top.copyTop, { def_top_id: topId, before_top_id: oldId });
        await client.query(
          `INSERT INTO def_top_option (def_top_id,pdf_fontsize_deduction,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time)
          SELECT $1,pdf_fontsize_deduction,$3,$4,$5,$3,$4,$5 FROM def_top_option WHERE def_top_id=$2`,
          [topId, oldId, actor.terminalId, actor.userId, now],
        );
        for (const [section, action] of [
          ['label', 'copy'],
          ['label', 'copyRep'],
          ['role', 'copy'],
          ['reportDocument', 'copy'],
          ['reportMaster', 'copy'],
          ['externalOutput', 'copy'],
          ['externalOutputFolder', 'copy'],
        ])
          await run(queries[section][action], { ...audit, def_top_id: topId, def_top_org: oldId });
      } else {
        const setting = (name: string) => settings.get('SYSTEM_ROLE_SETTING/' + name) || '0';
        const def = setting('DEF'),
          rep = setting('REP'),
          mode = setting('AUTO_TYPE');
        const roleParams = { ...audit, def_top_id: topId, user_id: actor.userId, admin_group: -999 };
        if (setting('ENABLE') !== '0' && def !== '0' && rep !== '0') {
          const defMode = integer(def),
            repMode = integer(rep);
          if (defMode === undefined || repMode === undefined) throw new Error('Invalid definition role mode.');
          const action = ['', 'insert', 'insertGroupUpper', 'insertGroupOver', 'insertGroupMarge'][
            Math.max(defMode, repMode)
          ];
          if (action) await run(queries.role[action], roleParams);
          for (const [scope, value] of [
            ['Def', def],
            ['Rep', rep],
          ]) {
            const where =
              value === '1'
                ? queries.role.whereGropOnly
                : value === '2'
                  ? queries.role.whereGroupUpper
                  : scope === 'Rep' && value === '3'
                    ? queries.role.whereGroupOver
                    : scope === 'Rep' && value === '4'
                      ? ' ( SELECT 1 )'
                      : undefined;
            if (!where) continue;
            await run(
              queries.role[`updateEnable${scope}Role${mode === '1' ? 'Type1' : ''}`].replace('{0}', where),
              roleParams,
            );
            if (value !== '4')
              await run(
                queries.role[`updateDisable${scope}Role${scope === 'Def' && mode === '1' ? 'Type1' : ''}`].replace(
                  '{0}',
                  where,
                ),
                roleParams,
              );
          }
          const defaultRep = integer(setting('REP_DEFAULT'));
          if (defaultRep !== undefined && defaultRep > 0 && defaultRep <= 3)
            await run(queries.role.reportRoleSetting, { def_top_id: topId, role_create_mode: defaultRep });
        } else
          await run(
            queries.role[clientConfiguration().defaultRoleMode === 'UserGroup' ? 'insert' : 'insertAll'],
            roleParams,
          );
      }
      await client.query(
        `INSERT INTO def_role (def_top_id,group_id,role_def_read,role_def_update,role_def_delete,role_rep_create,role_rep_read,role_rep_update,role_rep_delete,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time)
        SELECT $1,-999,1,1,1,1,1,1,1,$2,$3,$4,$2,$3,$4 WHERE NOT EXISTS (SELECT 1 FROM def_role WHERE def_top_id=$1 AND group_id=-999)`,
        [topId, actor.terminalId, actor.userId, now],
      );
    }
    for (const sheet of savedSheets) {
      await run(queries.sheet[sheet.existing ? 'update' : 'insert'], sheet.params);
      await run(queries.cluster.delete, sheet.params);
      for (const cluster of children(must(sheet.node, 'clusters'), 'cluster')) {
        if (!child(cluster, 'remarksValue1'))
          for (let index = 1; index <= 10; index++) content(cluster).push(element('remarksValue' + index));
        if (!child(cluster, 'management')) content(cluster).push(element('management'));
        const management = must(cluster, 'management');
        if (!child(management, 'mail')) content(management).push(element('mail'));
        const mail = must(management, 'mail');
        const values: Record<string, unknown> = {
          ...audit,
          ...uploadRemarks(cluster, 'cluster', false),
          def_sheet_id: sheet.params.def_sheet_id,
          cluster_id: integerField(cluster, 'clusterId'),
        };
        for (const [column, name] of Object.entries({
          cluster_name: 'name',
          cluster_type: 'type',
          input_parameter: 'inputParameters',
          left_position: 'left',
          right_position: 'right',
          top_position: 'top',
          bottom_position: 'bottom',
        }))
          values[column] = field(cluster, name);
        if (!child(cluster, 'cellAddress')) content(cluster).push(element('cellAddress'));
        values.cell_addr = field(cluster, 'cellAddress');
        for (const name of ['apply', 'approve', 'remand', 'change']) {
          if (!child(mail, name)) content(mail).push(element(name));
          values[name + '_mail'] = field(mail, name);
        }
        await run(queries.cluster.insert, values);
        const authority = child(management, 'authority');
        if (authority)
          for (const group of children(authority, 'groupId')) {
            const groupId = integer(value(group));
            if (groupId === undefined) throw new Error('Invalid cluster authority.');
            if (!(await client.query('SELECT 1 FROM mst_group WHERE group_id=$1', [groupId])).rowCount) continue;
            const roleType = (group[':@'] as Record<string, string> | undefined)?.['@_roleType'];
            await run(
              queries.clusterRole[!roleType || roleType === '0' ? 'insert' : 'insertRefer'].replace(/;\s*$/, '') +
                ' ON CONFLICT DO NOTHING',
              { ...values, group_id: groupId },
            );
          }
      }
      if (!sheet.existing) {
        if (old && sheet.previousId !== undefined)
          await run(queries.reference.copy, { ...sheet.params, def_sheet_id_org: sheet.previousId });
        else
          for (let index = 1; index <= 10; index++)
            await run(queries.reference.insert, { ...sheet.params, reference_id: index });
      }
    }
    if (replaceExisting) {
      if (savedSheets.length)
        await client.query('DELETE FROM def_sheet WHERE def_top_id=$1 AND NOT (def_sheet_id=ANY($2::int[]))', [
          topId,
          savedSheets.map((sheet) => sheet.params.def_sheet_id),
        ]);
      await writeTop();
    }
    if (!replaceExisting || field(top, 'publicStatus') === '2') {
      const previousCurrent = (
        await client.query(
          'SELECT cur.def_top_id,top.public_status FROM def_current cur LEFT JOIN def_top top ON cur.def_top_id=top.def_top_id WHERE cur.def_top_org=$1 AND cur.def_top_id<>$2',
          [orgId, topId],
        )
      ).rows;
      await run(queries.top.deleteCurrent, { def_top_org: orgId });
      await run(queries.top.insertCurrent, { def_top_org: orgId, def_top_id: topId });
      if (!replaceExisting && field(top, 'publicStatus') !== '2') {
        const published = previousCurrent.find((row) => Number(row.public_status) === 2);
        if (published) await run(queries.top.insertCurrent, { def_top_org: orgId, def_top_id: published.def_top_id });
      }
    }
    const grammar = child(document, 'grammar');
    if (grammar)
      await client.query(
        `INSERT INTO def_grammar (def_top_id,xml_data,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time)
      VALUES ($1,$2,$3,$4,$5,$3,$4,$5) ON CONFLICT (def_top_id) DO UPDATE SET xml_data=EXCLUDED.xml_data,sys_update_term=EXCLUDED.sys_update_term,sys_update_user=EXCLUDED.sys_update_user,sys_update_time=EXCLUDED.sys_update_time`,
        [topId, serialize(grammar), actor.terminalId, actor.userId, now],
      );
    await saveDefinitionNumbering(client, top, topId, orgId, actor.userId, now);
    await saveDefinitionTables(client, top, topId, orgId, reserved);
    await checkDefinitionBinder(client, top, topId, orgId, actor.userId, actor.terminalId, now);
    await deleteOwnedLock(client, actor, oldId ?? topId);
    await client.query('COMMIT');
    return errorXml(0);
  } catch (error) {
    await client.query('ROLLBACK');
    if (error instanceof DefinitionTableError) return errorXml(error.code, error.message);
    throw error;
  } finally {
    client.release();
  }
}
