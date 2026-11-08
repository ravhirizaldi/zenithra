import type pg from 'pg';
import { hostname } from 'node:os';
import {
  type XmlNode,
  child,
  children,
  must,
  field,
  optionalField,
  integer,
  integerField,
  root,
  serialize,
} from './client-definition-xml.js';

function flag(node: XmlNode, name: string, required = false): boolean {
  const text = required ? field(node, name) : optionalField(node, name);
  if ((text && !['0', '1'].includes(text)) || (required && !text)) throw new Error('Invalid numbering flag: ' + name);
  return text === '1';
}
function formatValid(format: string): void {
  if (!format || (format.length === 1 && !'dDfFgGMmOoRrsStTuUyY'.includes(format)))
    throw new Error('Invalid numbering date format.');
  let quote = '';
  for (let i = 0; i < format.length; i++) {
    const char = format[i];
    if (char === '\\') {
      if (++i === format.length) throw new Error('Invalid numbering date format.');
    } else if (quote) {
      if (char === quote) quote = '';
    } else if (char === "'" || char === '"') quote = char;
    else if (char === '%' && (++i === format.length || format[i] === '%'))
      throw new Error('Invalid numbering date format.');
  }
  if (quote || /f{8}|F{8}/.test(format)) throw new Error('Invalid numbering date format.');
}
function readNumbering(node: XmlNode, top?: XmlNode) {
  const start = integerField(node, 'startValue'),
    increment = integerField(node, 'increment'),
    digit = integerField(node, 'digit');
  const zero = flag(node, 'zeroPadding', true),
    timing = field(node, 'numberingTiming'),
    cycle = flag(node, 'numberingCyclicEnabled');
  const reedit = flag(node, 'numberingForReeditFromComplete');
  const useSave = flag(node, 'useSaveCount'),
    save = useSave ? child(node, 'saveCount') : undefined;
  const saveDigit = save && optionalField(save, 'digit') ? integerField(save, 'digit') : null;
  const saveZero = save ? flag(save, 'zeroPadding') : false;
  const parts = children(node, 'part').map((part) => ({
    id: integerField(part, 'partId'),
    type: field(part, 'type'),
    value: field(part, 'value'),
  }));
  if (top) {
    const max = 10 ** digit - 1;
    if (
      digit < 1 ||
      digit > 9 ||
      start < 1 ||
      start > max ||
      increment < 1 ||
      increment > max ||
      !['0', '1', '2'].includes(timing) ||
      parts.filter((part) => part.type === 'autoNumber').length !== 1
    )
      throw new Error('Invalid numbering range or timing.');
    for (const part of parts) {
      if (
        part.id < 1 ||
        ![
          'report',
          'date',
          'dateTime',
          'time',
          'user',
          'inputValue',
          'displayValue',
          'value',
          'autoNumber',
          'saveCount',
        ].includes(part.type)
      )
        throw new Error('Invalid numbering part.');
      if (part.type === 'report' && (!part.value || !child(top, part.value)))
        throw new Error('Invalid numbering report field.');
      if (['date', 'dateTime', 'time'].includes(part.type)) formatValid(part.value);
      if (['user', 'value'].includes(part.type) && !part.value) throw new Error('Missing numbering part value.');
      if (['inputValue', 'displayValue'].includes(part.type)) {
        const pair = part.value.split(',');
        const sheet = children(must(top, 'sheets'), 'sheet').find((sheet) => field(sheet, 'sheetNo') === pair[0]);
        if (
          pair.length < 2 ||
          pair.slice(0, 2).some((text) => integer(text) === undefined) ||
          !sheet ||
          !children(must(sheet, 'clusters'), 'cluster').some((cluster) => field(cluster, 'clusterId') === pair[1])
        )
          throw new Error('Invalid numbering cluster.');
      }
    }
    // Legacy only checks the save-count/part relation when useSaveCount is explicitly supplied.
    if (
      optionalField(node, 'useSaveCount') &&
      (useSave
        ? timing === '1' || !parts.some((part) => part.type === 'saveCount')
        : parts.some((part) => part.type === 'saveCount'))
    )
      throw new Error('Invalid numbering save-count timing or part.');
    if ((saveDigit !== null && saveDigit < 1) || (saveZero && saveDigit === null))
      throw new Error('Invalid numbering save-count format.');
  }
  return { start, increment, digit, zero, timing, cycle, reedit, useSave, saveDigit, saveZero, parts };
}

function dateValue(text: string): Date {
  const match = /^(?:(\d{4})[/-](\d{1,2})[/-](\d{1,2})|(\d{1,2})\/(\d{1,2})\/(\d{4}))$/.exec(text.trim());
  if (!match) throw new Error('Invalid numbering reset date.');
  const year = Number(match[1] ?? match[6]),
    month = Number(match[2] ?? match[4]),
    day = Number(match[3] ?? match[5]);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  if (year < 1 || year > 9999 || date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day)
    throw new Error('Invalid numbering reset date.');
  return date;
}
function readReset(node: XmlNode) {
  if (optionalField(node, 'useReset') !== '1' || !child(node, 'reset')) return null;
  const reset = must(node, 'reset'),
    type = integerField(reset, 'termType');
  const start = field(reset, 'startDate'),
    time = field(reset, 'executeTime');
  const date = dateValue(start),
    clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(AM|PM))?$/i.exec(time.trim());
  if (!clock) throw new Error('Invalid numbering reset time.');
  let hour = Number(clock[1]);
  if (clock[4]) {
    if (hour < 1 || hour > 12) throw new Error('Invalid numbering reset time.');
    hour = (hour % 12) + (clock[4].toUpperCase() === 'PM' ? 12 : 0);
  }
  if (hour > 23 || Number(clock[2]) > 59 || Number(clock[3] ?? 0) > 59)
    throw new Error('Invalid numbering reset time.');
  const interval = type === 1 || type === 2 ? integerField(reset, 'interval') : null;
  const week =
    type === 2
      ? field(reset, 'week')
          .split(',')
          .map((text) => {
            const num = integer(text);
            if (num === undefined) throw new Error('Invalid numbering reset week.');
            return num;
          })
      : [];
  const month =
    type === 3
      ? field(reset, 'month')
          .split(',')
          .map((text) => {
            const num = integer(text);
            if (num === undefined || num < 1 || num > 12) throw new Error('Invalid numbering reset month.');
            return num;
          })
      : [];
  const day = type === 3 ? integerField(reset, 'day') : null;
  if (
    ![1, 2, 3].includes(type) ||
    (interval !== null && (interval < 1 || interval > (type === 1 ? 999 : 99))) ||
    (day !== null && (day < 1 || day > 31) && day !== 99)
  )
    throw new Error('Invalid numbering reset rule.');
  return { type, start, time, interval, week, month, day, date };
}
function resetSignature(reset: ReturnType<typeof readReset>): string {
  return JSON.stringify(
    reset && [
      reset.type,
      reset.start,
      reset.time,
      reset.interval,
      [...reset.week].sort(),
      [...reset.month].sort(),
      reset.day,
    ],
  );
}
export function nextDefinitionReset(node: XmlNode, now: Date): Date | null {
  const reset = readReset(node);
  if (!reset) return null;
  const date = new Date(reset.date),
    clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(AM|PM))?$/i.exec(reset.time.trim())!;
  let hour = Number(clock[1]);
  if (clock[4]) hour = (hour % 12) + (clock[4].toUpperCase() === 'PM' ? 12 : 0);
  date.setHours(hour, Number(clock[2]), Number(clock[3] ?? 0), 0);
  if (reset.type === 2) while (date.getDay() !== 1) date.setDate(date.getDate() - 1);
  // Bound malformed/unreachable calendars instead of reproducing legacy's unbounded loop.
  for (let attempts = 0; attempts < 3660000; attempts++) {
    if (reset.type === 1 && date >= now) return date;
    if (reset.type === 2) {
      for (let day = 0; day < 7; day++) {
        const candidate = new Date(date);
        candidate.setDate(candidate.getDate() + day);
        if (reset.week.includes(candidate.getDay()) && candidate >= reset.date && candidate > now) return candidate;
      }
      date.setDate(date.getDate() + 7 * reset.interval!);
    } else if (reset.type === 3) {
      const last = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
      if (
        date >= now &&
        reset.month.includes(date.getMonth() + 1) &&
        date.getDate() === (reset.day === 99 ? last : reset.day)
      )
        return date;
      date.setDate(date.getDate() + 1);
    } else date.setDate(date.getDate() + reset.interval!);
    if (date.getFullYear() > 9999) break;
  }
  throw new Error('Numbering reset calendar has no reachable date.');
}

// DefinitionBiz.RepAutoNumberingSequence; caller owns the definition transaction/lineage lock.
export async function saveDefinitionNumbering(
  client: pg.PoolClient,
  top: XmlNode,
  topId: number,
  orgId: number,
  userId: string,
  now: Date,
): Promise<void> {
  if (
    optionalField(top, 'useAutoNumbering') !== '1' ||
    !child(top, 'autoNumbering') ||
    ![1, 2].includes(integerField(top, 'publicStatus'))
  )
    return;
  const node = must(top, 'autoNumbering'),
    rule = readNumbering(node, top),
    reset = readReset(node);
  const current = (
    await client.query(
      'SELECT * FROM def_auto_numbering_reset_setting WHERE def_top_org=$1 ORDER BY auto_numbering_rev_no DESC LIMIT 1 FOR UPDATE',
      [orgId],
    )
  ).rows[0];
  const oldNode = current ? root(current.auto_numbering_setting) : undefined,
    previous = oldNode ? readNumbering(oldNode) : undefined;
  const signature = (rule: ReturnType<typeof readNumbering>) =>
    JSON.stringify({ ...rule, reedit: undefined, parts: [...rule.parts].sort((a, b) => a.id - b.id) });
  const changed = !previous || signature(rule) !== signature(previous);
  const revision = current ? Number(current.auto_numbering_rev_no) + (changed ? 1 : 0) : 1;
  let action = '';
  const xml = serialize(node),
    term = hostname();
  if (changed) {
    // Temporary fixtures create temporary sequences; never shadow/reset a restored public sequence.
    const temporary = (
      await client.query("SELECT relpersistence='t' AS temporary FROM pg_class WHERE oid='def_top'::regclass")
    ).rows[0].temporary;
    const name = `rep_auto_numbering_${orgId}_${revision}`;
    if (!Number.isSafeInteger(orgId) || orgId < 1 || !Number.isSafeInteger(revision) || revision < 1)
      throw new Error('Invalid numbering sequence identity.');
    await client.query(
      `CREATE ${temporary ? 'TEMPORARY' : ''} SEQUENCE ${name} INCREMENT BY ${rule.increment} MINVALUE ${rule.start} MAXVALUE ${10 ** rule.digit - 1} START WITH ${rule.start} ${rule.cycle ? 'CYCLE' : 'NO CYCLE'} OWNED BY NONE`,
    );
    await client.query(
      `INSERT INTO def_auto_numbering_reset_setting (def_top_org,auto_numbering_rev_no,auto_numbering_setting,next_reset_time,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$5,$6,$7)`,
      [orgId, revision, xml, nextDefinitionReset(node, now), term, userId, now],
    );
    action = revision === 1 ? 'CREATE_RULE' : 'UPDATE_RULE';
  } else if (resetSignature(reset) !== resetSignature(readReset(oldNode!))) {
    await client.query(
      `UPDATE def_auto_numbering_reset_setting SET auto_numbering_setting=$3,next_reset_time=$4,sys_update_term=$5,sys_update_user=$6,sys_update_time=$7 WHERE def_top_org=$1 AND auto_numbering_rev_no=$2`,
      [orgId, revision, xml, nextDefinitionReset(node, now), term, userId, now],
    );
    action = 'UPDATE_RESET_RULE';
  } else if (rule.reedit !== previous!.reedit) action = 'UPDATE_NUMBERING_FOR_REEDIT';
  if (action)
    await client.query(
      `INSERT INTO log_auto_numbering (log_id,def_top_id,def_top_org,auto_numbering_rev_no,action,auto_numbering_setting,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time)
    VALUES (to_char($8::timestamp,'YYYYMMDDHH24MISS') || lpad(nextval('log_auto_numbering_seq')::text,20,'0'),$1,$2,$3,$4,$5,$6,$7,$8,$6,$7,$8)`,
      [topId, orgId, revision, action, xml, term, userId, now],
    );
  await client.query('UPDATE def_top SET auto_numbering_rev_no=$2 WHERE def_top_id=$1', [topId, revision]);
}
