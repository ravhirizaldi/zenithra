import type pg from 'pg';
import { hostname } from 'node:os';
import { labelChecked, labelInteger, labelString, LabelValidationError } from '../labels/index.js';
import { documentDate, type DocumentSettings } from './index.js';
import { taskList } from '../common/tasks.js';

const taskFields = [
  'start_date',
  'end_date',
  'FromTime',
  'ToTime',
  'task_name',
  'task_remark',
  'order_comment',
  'work_comment',
  ...Array.from({ length: 10 }, (_, i) => 'comment_label' + (i + 1)),
  ...Array.from({ length: 8 }, (_, i) => 'comment_value' + (i + 3)),
];
export function documentTaskState(input: Record<string, unknown> = {}) {
  const today = new Date(),
    pad = (n: number) => String(n).padStart(2, '0');
  const record = Object.fromEntries(taskFields.map((name) => [name, labelString(input['SchData.' + name])]));
  if (input['SchData.start_date'] === undefined)
    record.start_date = `${today.getFullYear()}/${pad(today.getMonth() + 1)}/${pad(today.getDate())}`;
  if (input['SchData.FromTime'] === undefined) record.FromTime = '00:00';
  const list = (key: string) => [
    ...new Set(
      (Array.isArray(input[key]) ? input[key] : input[key] === undefined ? [] : [input[key]]).map(labelString),
    ),
  ];
  return {
    record,
    taskId: labelInteger(input['SchData.task_id'], -1),
    users: list('SelectUsers'),
    groups: list('SelectGroups'),
    group: labelString(input.SchGroupId),
    search: labelString(input.UserSearch),
    autoDownload: labelChecked(input['SchData.auto_download']),
    inputType: labelChecked(input['SchData.input_type']),
    reports: labelString(input.SelectRepTask),
    closed: labelString(input.RegistTackClosed) || '0',
  };
}
export type DocumentTaskState = ReturnType<typeof documentTaskState>;

export async function documentTaskPeople(
  db: Pick<pg.Pool, 'query'>,
  state: DocumentTaskState,
  actor: string,
  initial = false,
  allUsers = false,
) {
  const groups = (
    await db.query(
      `SELECT DISTINCT g.group_id,g.group_name,EXISTS (SELECT 1 FROM mst_group_affiation a WHERE a.group_id=g.group_id AND a.user_id=$1) AS own
    FROM mst_group g JOIN mst_group_affiation a USING(group_id) WHERE g.group_id>0 ORDER BY g.group_id`,
      [actor],
    )
  ).rows;
  if (initial) {
    state.group = String(groups.find((row) => row.own)?.group_id ?? groups[0]?.group_id ?? '');
    state.users = actor === 'conmasadmin' ? [] : [actor];
  }
  if (!groups.some((row) => String(row.group_id) === state.group)) state.group = String(groups[0]?.group_id ?? '');
  const users = (
    await db.query(`SELECT user_id,user_name FROM mst_user WHERE user_id<>'conmasadmin'
    AND (use_start_time IS NULL OR use_start_time<=CURRENT_DATE)
    AND (use_end_time IS NULL OR use_end_time>=CURRENT_DATE + INTERVAL '1 day' - INTERVAL '1 second')
    ORDER BY user_id`)
  ).rows;
  const candidates = (
    await db.query(
      `SELECT u.user_id,u.user_name FROM mst_user u WHERE u.user_id<>'conmasadmin'
    AND (u.use_start_time IS NULL OR u.use_start_time<=CURRENT_DATE)
    AND (u.use_end_time IS NULL OR u.use_end_time>=CURRENT_DATE + INTERVAL '1 day' - INTERVAL '1 second')
    AND (u.user_id ILIKE $1 OR u.user_name ILIKE $1)
    AND ($2::text='' OR EXISTS (SELECT 1 FROM mst_group_affiation a WHERE a.user_id=u.user_id AND a.group_id::text=$2))
    ORDER BY u.user_id`,
      ['%' + state.search + '%', allUsers ? '' : state.group],
    )
  ).rows;
  return { groups, users, candidates: candidates.filter((row) => !state.users.includes(row.user_id)) };
}

export async function documentRegistTask(db: pg.Pool, state: DocumentTaskState, actor: string) {
  const record = state.record;
  if (!record.task_name) throw new LabelValidationError('SchData.task_id', 'Required');
  const clock = /^(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
  if (!clock.test(record.FromTime.trim())) throw new LabelValidationError('SchData.FromTime', 'InvalidError');
  if ((record.end_date && !clock.test(record.ToTime.trim())) || (!record.end_date && record.ToTime))
    throw new LabelValidationError('SchData.end_date', 'InvalidError');
  const date = (name: 'start_date' | 'end_date', time: string) => {
    try {
      return documentDate(record[name], time);
    } catch (error) {
      if (!(error instanceof LabelValidationError)) throw error;
      throw new LabelValidationError('SchData.' + name, 'InvalidError');
    }
  };
  const start = date('start_date', record.FromTime),
    end = date('end_date', record.ToTime);
  if (!start || (end && start > end)) throw new LabelValidationError('SchData.start_date', 'InvalidError');
  if ((!state.users.length && !state.groups.length) || (state.users.length && state.groups.length))
    throw new LabelValidationError('SelectUsers', 'Select users or a group.');
  const ids = [...new Set(state.reports.split(',').map((id) => labelInteger(id)))];
  if (ids.some((id) => id <= 0)) throw new LabelValidationError('SelectRepTask', 'Select valid reports.');
  const groups = state.groups.map((id) => labelInteger(id));
  if (groups.some((id) => id <= 0)) throw new LabelValidationError('SelectGroups', 'Select valid groups.');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const permission = (
      await client.query(
        `SELECT MAX(role_schedule_create) AS allowed FROM mst_group WHERE group_id IN
      (SELECT group_id FROM mst_group_affiation WHERE user_id=$1)`,
        [actor],
      )
    ).rows[0]?.allowed;
    if (String(permission) !== '1') throw new LabelValidationError('SelectRepTask', 'Role authority is insufficient.');
    const reports = (
      await client.query(
        `SELECT t.rep_top_id,t.public_status,t.edit_refer_status FROM rep_top t
      WHERE t.rep_top_id=ANY($1::int[]) AND t.deleted=0
      AND EXISTS (SELECT 1 FROM rep_role r JOIN mst_group_affiation a USING(group_id)
        WHERE r.rep_top_id=t.rep_top_id AND (r.role_rep_read>0 OR r.role_rep_update>0) AND a.user_id=$2)
      ORDER BY t.rep_top_id FOR UPDATE OF t`,
        [ids, actor],
      )
    ).rows;
    if (reports.length !== ids.length)
      throw new LabelValidationError('SelectRepTask', 'A selected report is unavailable.');
    if (reports.some((row) => String(row.public_status) !== '2' || !['0', '1'].includes(String(row.edit_refer_status))))
      throw new LabelValidationError('SelectRepTask', 'ErrorSelectRepTask');
    const people = await documentTaskPeople(client, state, actor);
    if (
      state.users.some((id) => !people.users.some((row) => row.user_id === id)) ||
      groups.some((id) => !people.groups.some((row) => row.group_id === id))
    )
      throw new LabelValidationError('SelectUsers', 'A selected worker is unavailable.');
    if (
      state.taskId > 0 &&
      !(await client.query('SELECT 1 FROM mst_task WHERE task_id=$1 FOR SHARE', [state.taskId])).rowCount
    )
      throw new LabelValidationError('SchData.task_id', 'A selected task is unavailable.');
    let confirm = false;
    for (const id of ids) {
      const previous = (
        await client.query(
          `SELECT s.start_date::date=$2::date AS same_day,
        ARRAY(SELECT u.user_id FROM rep_schedule_user u WHERE u.schedule_id=s.schedule_id) AS users,
        ARRAY(SELECT g.group_id FROM rep_schedule_group g WHERE g.schedule_id=s.schedule_id) AS groups
        FROM rep_schedule s WHERE s.rep_top_id=$1`,
          [id, record.start_date],
        )
      ).rows;
      if (state.groups.length ? previous.some((row) => row.users.length) : previous.some((row) => row.groups.length))
        throw new LabelValidationError(
          'SelectRepTask',
          state.groups.length ? 'FromIsScheduledUser' : 'FromIsScheduledGroup',
        );
      if (
        previous.some(
          (row) =>
            row.same_day &&
            (state.groups.length ? row.groups.length : row.users.some((id: string) => state.users.includes(id))),
        )
      )
        throw new LabelValidationError('SelectRepTask', 'FromIsScheduledDay');
      if (state.closed !== '2' && previous.some((row) => (state.groups.length ? row.groups.length : row.users.length)))
        confirm = true;
    }
    if (confirm) {
      await client.query('ROLLBACK');
      return false;
    }
    const webhook = (
      await client.query(
        "SELECT com_value FROM mst_common WHERE com_key='WEBHOOK' AND com_name='WEBHOOK_VALID_ENABLE' ORDER BY com_index LIMIT 1",
      )
    ).rows[0]?.com_value;
    // shortcut: retained direct settings also block disabled notifications, relax after strict delivery is migrated.
    const direct = (
      await client.query(
        "SELECT 1 FROM mst_direct WHERE key='Setting' AND xml_data IS NOT NULL AND xml_data<>'' LIMIT 1",
      )
    ).rowCount;
    if (String(webhook) === '1' || direct)
      throw new LabelValidationError(
        'SelectRepTask',
        'Schedule notifications have not been migrated. No changes were saved.',
      );
    const audit = {
      sys_regist_term: hostname(),
      sys_regist_user: actor,
      sys_regist_time: new Date(),
      sys_update_term: hostname(),
      sys_update_user: actor,
      sys_update_time: new Date(),
    };
    for (const id of ids) {
      const data = {
        ...Object.fromEntries(
          taskFields
            .filter((name) => !['FromTime', 'ToTime'].includes(name))
            .map((name) => [name, record[name] || null]),
        ),
        rep_top_id: id,
        task_id: state.taskId > 0 ? state.taskId : null,
        start_time: record.FromTime,
        end_time: record.ToTime || null,
        finish_status: null,
        auto_download: Number(state.autoDownload),
        report_type: 0,
        input_type: Number(state.inputType),
        start_type: 0,
        ...audit,
      };
      const columns = Object.keys(data);
      const saved = (
        await client.query(
          `INSERT INTO rep_schedule (${columns.join(',')}) VALUES (${columns.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING schedule_id`,
          Object.values(data),
        )
      ).rows[0];
      const workerColumns = ['schedule_id', state.groups.length ? 'group_id' : 'user_id', ...Object.keys(audit)];
      for (const worker of state.groups.length ? groups : state.users)
        await client.query(
          `INSERT INTO ${state.groups.length ? 'rep_schedule_group' : 'rep_schedule_user'} (${workerColumns.join(',')}) VALUES (${workerColumns.map((_, i) => '$' + (i + 1)).join(',')})`,
          [saved.schedule_id, worker, ...Object.values(audit)],
        );
    }
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function documentTaskList(
  db: Pick<pg.Pool, 'query'>,
  input: Record<string, unknown>,
  settings: DocumentSettings,
) {
  const pageIndex = labelInteger(input.pageIndex, 0),
    pageSize = labelInteger(input.pageSize, settings.pageSize) || settings.pageSize;
  if (pageIndex < 0 || pageSize <= 0) throw new LabelValidationError('pageIndex', 'Invalid task page.');
  const searchName = labelString(input.searchName),
    searchRemark = labelString(input.searchRemark);
  const { rows, total } = await taskList(db, { searchName, searchRemark, pageIndex, pageSize });
  return {
    rows,
    total,
    pages: Math.ceil(total / pageSize),
    pageIndex,
    pageSize,
    searchName,
    searchRemark,
    pageSizes: settings.pageSizes,
  };
}
