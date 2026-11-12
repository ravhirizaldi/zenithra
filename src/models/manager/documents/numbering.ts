import type pg from 'pg';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  child,
  children,
  field,
  integer,
  integerField,
  must,
  optionalField,
  replace,
  root,
  serialize,
  type XmlNode,
} from '../../client-definition-xml.js';
import { reportNameDate } from '../../client-report-name.js';
import { reportNumberingClusters } from '../../client-report-numbering.js';
import { LabelValidationError } from '../labels/index.js';
import { text as pageText } from '../../../config/manager/documents/resources.js';
import { documentDetail } from './details.js';
import { documentRefreshThumbnail } from './thumbnail.js';

type Database = Pick<pg.Pool, 'query'>;
const invalid = () =>
  new LabelValidationError('IsComplete', pageText['Invalid automatic-numbering settings. No changes were saved.']);
const int = (node: XmlNode, name: string, min: number, max: number) => {
  const value = integer(optionalField(node, name));
  if (value === undefined || value < min || value > max) throw invalid();
  return value;
};
const flag = (node: XmlNode, name: string, required = false) => {
  const value = optionalField(node, name);
  if ((required || value) && !['0', '1'].includes(value)) throw invalid();
  return value === '1';
};

export function nextNumberReset(reset: XmlNode, previous: Date, now: Date): Date {
  const type = int(reset, 'termType', 1, 3),
    result = new Date(previous);
  const interval = type !== 3 ? int(reset, 'interval', 1, type === 1 ? 999 : 99) : 0;
  const list = (name: string, min: number, max: number) =>
    field(reset, name)
      .split(',')
      .map((raw) => {
        const value = integer(raw);
        if (value === undefined || value < min || value > max) throw invalid();
        return value;
      });
  const days = type === 2 ? list('week', 0, 6) : [];
  const months = type === 3 ? list('month', 1, 12) : [];
  const day = type === 3 ? int(reset, 'day', 1, 99) : 0;
  if (day > 31 && day !== 99) throw invalid();
  if (!Number.isFinite(result.getTime()) || !Number.isFinite(now.getTime())) throw invalid();
  const advance = (days: number) => {
    result.setDate(result.getDate() + days);
    if (result.getFullYear() > 9999) throw invalid();
  };
  if (type === 1) {
    while (result < now) advance(interval);
  } else if (type === 2) {
    const start = /^([0-9]{4})[/-]([0-9]{1,2})[/-]([0-9]{1,2})$/.exec(field(reset, 'startDate'));
    if (!start) throw invalid();
    const startDate = new Date(Number(start[1]), Number(start[2]) - 1, Number(start[3]));
    startDate.setFullYear(Number(start[1]));
    if (
      Number(start[1]) < 1 ||
      startDate.getFullYear() !== Number(start[1]) ||
      startDate.getMonth() !== Number(start[2]) - 1 ||
      startDate.getDate() !== Number(start[3])
    )
      throw invalid();
    while (result.getDay() !== 1) advance(-1);
    for (;;) {
      for (let offset = 0; offset < 7; offset++) {
        if (days.includes(result.getDay()) && result >= startDate && result > now) return result;
        if (offset < 6) advance(1);
      }
      advance(7 * interval - 6);
    }
  } else {
    if (day !== 99 && !months.some((month) => new Date(2000, month, 0).getDate() >= day)) throw invalid();
    while (
      result < now ||
      !months.includes(result.getMonth() + 1) ||
      result.getDate() !== (day === 99 ? new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate() : day)
    )
      advance(1);
  }
  return result;
}

export function numberingParts(top: XmlNode, settings: XmlNode, now: Date, number: string, locale = 'en-US'): string {
  const digit = int(settings, 'digit', 1, 9),
    maximum = 10 ** digit - 1;
  int(settings, 'startValue', 1, maximum);
  int(settings, 'increment', 1, maximum);
  const padded = flag(settings, 'zeroPadding', true);
  flag(settings, 'numberingCyclicEnabled');
  flag(settings, 'numberingForReeditFromComplete');
  const timing = int(settings, 'numberingTiming', 0, 2),
    saveCount = flag(settings, 'useSaveCount');
  const parts = children(settings, 'part').sort((a, b) => integerField(a, 'partId') - integerField(b, 'partId'));
  if (
    !parts.length ||
    parts.filter((part) => field(part, 'type') === 'autoNumber').length !== 1 ||
    (saveCount && (timing === 1 || !parts.some((part) => field(part, 'type') === 'saveCount'))) ||
    (!saveCount && parts.some((part) => field(part, 'type') === 'saveCount'))
  )
    throw invalid();
  return parts
    .map((part) => {
      int(part, 'partId', 1, 2147483647);
      const type = field(part, 'type'),
        value = field(part, 'value');
      if (type === 'autoNumber') return padded ? number.padStart(digit, '0') : number;
      if (type === 'value') {
        if (!value) throw invalid();
        return value;
      }
      if (type === 'saveCount') return '{SAVE_COUNT}';
      if (type === 'report') return field(top, value);
      if (type === 'user') {
        if (!value) throw invalid();
        return optionalField(top, value === 'id' ? 'registUser' : 'registUserName');
      }
      if (['date', 'dateTime', 'time'].includes(type)) return reportNameDate(now, value, locale);
      if (type === 'inputValue' || type === 'displayValue') {
        const [sheetNo, clusterId] = value.split(',');
        const sheet = children(must(top, 'sheets'), 'sheet').find((node) => optionalField(node, 'sheetNo') === sheetNo);
        const cluster =
          sheet &&
          children(must(sheet, 'clusters'), 'cluster').find((node) => optionalField(node, 'clusterId') === clusterId);
        if (!cluster) throw invalid();
        return field(cluster, type === 'inputValue' ? 'value' : 'displayValue');
      }
      throw invalid();
    })
    .join('');
}

// Native create/update follow ReportBiz; Manager Basic/sheet/manual/copy retain their distinct issuance rules.
export async function documentSaveNumbering(
  db: Database,
  id: number,
  top: XmlNode,
  user: string,
  now: Date,
  locale: string,
  mode: 'basic' | 'sheet' | 'manual' | 'copy' | 'create' | 'update' = 'basic',
  terminal = hostname(),
) {
  const changed = new Set<string>();
  const settings = optionalField(top, 'useAutoNumbering') === '1' ? child(top, 'autoNumbering') : undefined;
  if (!settings) return { changed, regenerateName: false, refreshThumbnail: false, columns: null };
  const targets = reportNumberingClusters(top),
    native = mode === 'create' || mode === 'update';
  const nameParts = child(top, 'nameParts');
  const regenerateName =
    optionalField(settings, 'useSaveCount') === '1' &&
    !!nameParts &&
    children(nameParts, 'part').some(
      (part) =>
        ['inputValue', 'displayValue'].includes(optionalField(part, 'type')) &&
        targets.some(
          ({ sheet, cluster }) =>
            optionalField(part, 'value') ===
            optionalField(sheet, 'sheetNo') + ',' + optionalField(cluster, 'clusterId'),
        ),
    );
  const saved = (
    await db.query(
      'SELECT auto_numbering_value,auto_numbering_message,auto_numbering_save_count FROM rep_top WHERE rep_top_id=$1',
      [id],
    )
  ).rows[0];
  const timing = int(settings, 'numberingTiming', 0, 2),
    finalSave = timing === 1;
  const inherit = timing === 2 || optionalField(settings, 'numberingForReeditFromComplete') === '1';
  const issue =
    mode === 'manual' ||
    (mode === 'copy'
      ? !inherit && timing === 0
      : ((mode === 'create' && timing === 0) || (finalSave && optionalField(top, 'editStatus') === '4')) &&
        !saved.auto_numbering_value);
  const useCount = flag(settings, 'useSaveCount');
  const refreshThumbnail =
    native &&
    ((mode === 'create' && timing === 0) || (finalSave && optionalField(top, 'editStatus') === '4')) &&
    targets.some(({ sheet }) => integerField(sheet, 'sheetNo') === 1);
  if (!native && !issue && mode !== 'copy' && (mode !== 'sheet' || (!finalSave && !useCount)))
    return { changed, regenerateName, refreshThumbnail, columns: null };
  numberingParts(top, settings, now, '0', locale);
  let value = String(saved.auto_numbering_value ?? ''),
    count = Number(saved.auto_numbering_save_count ?? 0);
  if (mode === 'copy' && !inherit) {
    value = '';
    count = 0;
  }
  if (!Number.isSafeInteger(count) || count < 0 || count > 2147483647) throw invalid();
  const saveSettings = useCount ? child(settings, 'saveCount') : undefined,
    digits = saveSettings ? optionalField(saveSettings, 'digit') : '';
  const padding = saveSettings ? flag(saveSettings, 'zeroPadding') : false;
  if (padding && !digits) throw invalid();
  const maximumCount = digits && saveSettings ? 10 ** int(saveSettings, 'digit', 1, 9) - 1 : 2147483647;
  if ((native || mode === 'sheet' || mode === 'copy') && useCount && count < maximumCount) count++;
  const displayCount = digits && padding ? String(count).padStart(Number(digits), '0') : String(count);
  if (
    targets.length &&
    (
      await db.query(
        "SELECT 1 FROM mst_common WHERE com_key='HISTORY_SETTING' AND com_name='ENABLE' AND com_value IN ('1','2') UNION ALL SELECT 1 FROM rep_top WHERE rep_top_id=$1 AND use_input_history IN (1,2)",
        [id],
      )
    ).rowCount &&
    !(
      await db.query(
        `SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='rep_cluster'::regclass
    AND NOT t.tgisinternal AND t.tgenabled IN ('O','A') AND p.proname='func_rep_cluster_trigger' AND (t.tgtype::int & 21)=21`,
      )
    ).rowCount
  )
    throw new LabelValidationError(
      'pending',
      pageText['Report history trigger is unavailable. No changes were saved.'],
    );
  if (issue) {
    const definition = (
      await db.query('SELECT def_top_org,auto_numbering_rev_no FROM def_top WHERE def_top_id=$1', [
        integerField(top, 'defTopId'),
      ])
    ).rows[0];
    const org = integer(optionalField(top, 'defTopOrg')) ?? Number(definition?.def_top_org),
      revision = Number(definition?.auto_numbering_rev_no);
    if (!Number.isSafeInteger(org) || org < 1 || !Number.isSafeInteger(revision) || revision < 1) throw invalid();
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['auto-numbering:' + org + ':' + revision]);
    const privateOnly = (
      await db.query("SELECT relpersistence='t' AS private FROM pg_class WHERE oid='def_top'::regclass")
    ).rows[0].private;
    const sequence = (privateOnly ? 'pg_temp.' : '') + 'rep_auto_numbering_' + org + '_' + revision;
    const reset = (
      await db.query(
        'SELECT auto_numbering_setting,next_reset_time FROM def_auto_numbering_reset_setting WHERE def_top_org=$1 AND auto_numbering_rev_no=$2 FOR UPDATE',
        [org, revision],
      )
    ).rows[0];
    if (reset?.next_reset_time && reset.next_reset_time < now) {
      const resetSettings = root(reset.auto_numbering_setting),
        resetRule = must(resetSettings, 'reset');
      const next = nextNumberReset(resetRule, reset.next_reset_time, now);
      await db.query('SELECT setval($1::regclass,$2,false)', [
        sequence,
        int(resetSettings, 'startValue', 1, 999999999),
      ]);
      await db.query(
        'UPDATE def_auto_numbering_reset_setting SET next_reset_time=$3,sys_update_term=$4,sys_update_user=$5,sys_update_time=$6 WHERE def_top_org=$1 AND auto_numbering_rev_no=$2',
        [org, revision, next, hostname(), user, now],
      );
      await db.query(
        `INSERT INTO log_auto_numbering(log_id,def_top_id,def_top_org,auto_numbering_rev_no,action,auto_numbering_setting,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time)
    VALUES($1,NULL,$2,$3,'AUTO_RESET',$4,$5,$6,$7,$5,$6,$7)`,
        [randomUUID().replaceAll('-', ''), org, revision, serialize(settings), hostname(), user, now],
      );
    }
    const state = (await db.query(`SELECT last_value,is_called FROM ${sequence}`)).rows[0];
    if (
      !flag(settings, 'numberingCyclicEnabled') &&
      state.is_called &&
      BigInt(state.last_value) + BigInt(integerField(settings, 'increment')) >
        BigInt(10 ** integerField(settings, 'digit') - 1)
    )
      throw new LabelValidationError(
        'IsComplete',
        pageText['The automatic-numbering sequence has reached its maximum. No changes were saved.'],
      );
    const number = String((await db.query('SELECT nextval($1::regclass) AS value', [sequence])).rows[0].value);
    value = numberingParts(top, settings, now, number, locale);
  }
  const columns = {
    auto_numbering_value: value || null,
    auto_numbering_message: issue || (mode === 'copy' && !inherit) ? null : saved.auto_numbering_message,
    auto_numbering_save_count: count || null,
    auto_numbering_display_save_count: displayCount,
  };
  // ReportBiz persists these columns with its final top update, avoiding extra audit-trigger events.
  if (!native)
    await db.query(
      'UPDATE rep_top SET auto_numbering_value=$2,auto_numbering_message=$5,auto_numbering_save_count=$3,auto_numbering_display_save_count=$4 WHERE rep_top_id=$1',
      [
        id,
        columns.auto_numbering_value,
        columns.auto_numbering_save_count,
        displayCount,
        columns.auto_numbering_message,
      ],
    );
  if ((!value && mode !== 'copy') || (mode === 'update' && !finalSave && !useCount))
    return { changed, regenerateName, refreshThumbnail, columns };
  for (const { sheet, cluster } of targets) {
    const sheetId = integerField(sheet, 'repSheetId'),
      clusterId = integerField(cluster, 'clusterId');
    const result = await db.query(
      `UPDATE rep_cluster SET input_value=$3,display_value=$3,sys_update_term=$4,sys_update_user=$5,sys_update_time=$6 WHERE rep_sheet_id=$1 AND cluster_id=$2 AND EXISTS(SELECT 1 FROM rep_sheet WHERE rep_sheet_id=$1 AND rep_top_id=$7)`,
      [sheetId, clusterId, value.replaceAll('{SAVE_COUNT}', displayCount), terminal, user, now, id],
    );
    if (result.rowCount !== 1) throw invalid();
    replace(cluster, 'value', value.replaceAll('{SAVE_COUNT}', displayCount));
    replace(cluster, 'displayValue', value.replaceAll('{SAVE_COUNT}', displayCount));
    replace(cluster, 'readOnly', '1');
    changed.add(integerField(sheet, 'sheetNo') + ',' + clusterId);
  }
  for (const sheet of new Set(targets.map((target) => target.sheet)))
    await db.query('UPDATE rep_sheet SET xml_data=$2 WHERE rep_sheet_id=$1', [
      integerField(sheet, 'repSheetId'),
      serialize(sheet),
    ]);
  return { changed, regenerateName, refreshThumbnail, columns };
}

export async function documentManualNumber(db: pg.Pool, id: number, definition: number, user: string, locale: string) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query('SELECT xml_data,def_top_id FROM rep_top WHERE rep_top_id=$1 FOR UPDATE', [id]))
      .rows[0];
    const report = await documentDetail(client, id, user, true);
    const roles = (
      await client.query(
        `SELECT MAX(g.role_rep_update_manager)=1 AS update,MAX(g.role_rep_super_manager)=1 AS super
      FROM mst_group g JOIN mst_group_affiation a USING(group_id) WHERE a.user_id=$1`,
        [user],
      )
    ).rows[0];
    if (!row || !report || !roles.update || !roles.super)
      throw new LabelValidationError('access', pageText['Role authority is insufficient.']);
    const xml = root(row.xml_data),
      top = must(xml, 'top');
    if (
      definition !== Number(row.def_top_id) ||
      integerField(top, 'repTopId') !== id ||
      integerField(top, 'defTopId') !== definition
    )
      throw new LabelValidationError('', pageText['Report XML identity differs.']);
    if (optionalField(top, 'useAutoNumbering') !== '1' || !child(top, 'autoNumbering')) throw invalid();
    const now = new Date();
    await documentSaveNumbering(client, id, top, user, now, locale, 'manual');
    await client.query(
      `UPDATE rep_top SET xml_data=$2,sys_update_term=$3,sys_update_user=$4,sys_update_time=$5,
      sys_update_user_name=(SELECT user_name FROM mst_user WHERE user_id=$4) WHERE rep_top_id=$1`,
      [id, serialize(xml), hostname(), user, now],
    );
    await documentRefreshThumbnail(client, id, definition, user, locale);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
