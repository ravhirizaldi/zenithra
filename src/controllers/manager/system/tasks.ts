import type { Express, Request, Response } from 'express';
import type pg from 'pg';
import { hostname } from 'node:os';
import { hasSystemPermission } from '../../../middleware/manager/system/permissions.js';
import { licenseStatus } from '../../../shared/license-counts.js';
import { taskList } from '../../../models/manager/common/tasks.js';

type TaskPageSize = { value: number; text: string };
type TaskRecord = Record<string, unknown> & {
  task_id: number;
  task_name: string;
  task_remark: string | null;
  display_number: number;
};

const root = '/ConMasManager/System';
const roleError = 'Role authority is insufficient.';
const fallbackPageSizes = [10, 20, 50, 100];

function formString(value: unknown): string {
  if (typeof value === 'string') return value;
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : '';
}

function integer(value: unknown): number | null {
  const text = formString(value).trim();
  if (!/^[+-]?\d+$/.test(text)) return null;
  const result = Number(text);
  return Number.isSafeInteger(result) ? result : null;
}

function validTaskId(id: number | null): id is number {
  return id === -1 || (id !== null && id > 0 && id <= 2147483647);
}

export function registerTasks(
  app: Express,
  db: pg.Pool,
  render: (res: Response, data: Record<string, unknown>) => unknown,
) {
  const show = (res: Response, taskPage: Record<string, unknown>) =>
    render(res, {
      active: 'System',
      section: 'TaskList',
      login: false,
      title: 'Task manager',
      userName: res.locals.userName,
      taskPage,
    });
  const showEdit = (
    res: Response,
    record: Record<string, unknown>,
    error: string,
    canWrite: boolean,
    canDelete: boolean,
  ) => show(res, { mode: 'edit', record, error, canWrite, canDelete });
  const emptyTask = (task_id = -1): TaskRecord => ({ task_id, task_name: '', task_remark: '', display_number: 0 });

  const list = async (req: Request, res: Response) => {
    const userId = req.session?.userId ?? '';
    const [canRead, canCreate, canDelete] = await Promise.all([
      hasSystemPermission(db, userId, 'data', 'read'),
      hasSystemPermission(db, userId, 'data', 'create'),
      hasSystemPermission(db, userId, 'data', 'delete'),
    ]);
    if (!canRead)
      return show(res.status(403), {
        mode: 'list',
        canRead: false,
        canCreate: false,
        canDelete: false,
        error: '',
        rows: [],
        total: 0,
        pageIndex: 0,
        pageSize: 20,
        pageSizes: [],
        searchName: '',
        searchRemark: '',
        pages: 0,
      });

    const query = req.method === 'POST' ? req.body : req.query;
    const searchName = formString(query.searchName);
    const searchRemark = formString(query.searchRemark);
    const selected = req.method === 'POST' ? formString(req.body.chkFiles) : '';
    let error = '';
    let status = 200;
    if (selected) {
      if (!canDelete) {
        error = roleError;
        status = 403;
      } else {
        const ids = selected.split(',').map((value) => integer(value));
        if (ids.some((id) => id === null || id <= 0 || id > 2147483647))
          return res.status(400).send('Invalid task selection.');
        await db.query('DELETE FROM mst_task WHERE task_id = ANY($1::int[])', [ids]);
      }
    }

    const [sizeRows, defaultRow] = await Promise.all([
      db.query<{ com_value: string; com_name: string }>(
        'SELECT com_value,com_name FROM mst_common WHERE com_key=$1 ORDER BY com_index',
        ['PAGE_SIZE'],
      ),
      db.query<{ com_value: string }>(
        "SELECT com_value FROM mst_common WHERE com_key='DEFAULT_PAGE_SIZE' ORDER BY com_index LIMIT 1",
      ),
    ]);
    const configuredSizes = sizeRows.rows
      .map((row) => ({ value: integer(row.com_value), text: row.com_name || row.com_value }))
      .filter((option): option is TaskPageSize => option.value !== null && option.value > 0);
    const pageSizes = configuredSizes.length
      ? configuredSizes
      : fallbackPageSizes.map((value) => ({ value, text: String(value) }));
    const configuredDefault = integer(defaultRow.rows[0]?.com_value);
    const defaultPageSize = pageSizes.some((option) => option.value === configuredDefault)
      ? configuredDefault!
      : pageSizes.some((option) => option.value === 20)
        ? 20
        : (pageSizes[0]?.value ?? 20);
    const requestedPageSize = integer(query.pageSize);
    const pageSize = pageSizes.some((option) => option.value === requestedPageSize)
      ? requestedPageSize!
      : defaultPageSize;
    const requestedPageIndex = integer(query.pageIndex);
    const pageIndexInput =
      requestedPageIndex !== null && requestedPageIndex >= 0 ? Math.min(requestedPageIndex, 10000) : 0;
    const pageIndex = pageIndexInput;
    const { rows, total } = await taskList(db, { searchName, searchRemark, pageIndex, pageSize });
    const pages = Math.ceil(total / pageSize);
    return show(status === 403 ? res.status(status) : res, {
      mode: 'list',
      canRead: true,
      canCreate,
      canDelete,
      error,
      rows,
      total,
      pageIndex,
      pageSize,
      pageSizes,
      searchName,
      searchRemark,
      pages,
    });
  };
  app.use([`${root}/TaskList`, `${root}/EditTask`], (_req, res, next) => {
    try {
      if (!licenseStatus().freeDrawOnly) return next();
      return res.status(403).type('text/plain').send(roleError);
    } catch {
      return res.status(503).type('text/plain').send('License information is unavailable.');
    }
  });

  app.get(`${root}/TaskList`, list);
  app.post(`${root}/TaskList`, list);
  app.get(`${root}/EditTask`, async (req, res) => {
    const id = integer(req.query.id);
    if (!validTaskId(id)) return res.status(400).send('Invalid task ID.');
    const userId = req.session?.userId ?? '';
    const canWrite = await hasSystemPermission(db, userId, 'data', id === -1 ? 'create' : 'edit');
    if (!canWrite) return showEdit(res.status(403), emptyTask(id), '', false, false);
    const record =
      id === -1
        ? emptyTask()
        : (
            await db.query<TaskRecord>(
              "SELECT task_id,task_name,coalesce(task_remark,'') AS task_remark,coalesce(display_number,0) AS display_number FROM mst_task WHERE task_id=$1",
              [id],
            )
          ).rows[0];
    if (!record) return res.status(404).send('Task not found.');
    const canDelete = id !== -1 && (await hasSystemPermission(db, userId, 'data', 'delete'));
    return showEdit(res, record, '', true, canDelete);
  });
  app.post(`${root}/EditTask`, async (req, res) => {
    const id = integer(req.body['Task.task_id']);
    if (!validTaskId(id)) return res.status(400).send('Invalid task ID.');
    const isDelete = formString(req.body.isDelete).toLowerCase() === 'true';
    const action = isDelete ? 'delete' : id === -1 ? 'create' : 'edit';
    const userId = req.session?.userId ?? '';
    const canWrite = await hasSystemPermission(db, userId, 'data', action);
    if (!canWrite) return showEdit(res.status(403), emptyTask(id), '', false, false);

    const taskName = formString(req.body['Task.task_name']);
    const taskRemark = formString(req.body['Task.task_remark']);
    const displayNumber = formString(req.body['Task.diplay_number']);
    const record = { task_id: id, task_name: taskName, task_remark: taskRemark, display_number: displayNumber };
    const parsedNumber = integer(displayNumber);
    const error = !taskName.trim()
      ? 'Task name is required.'
      : parsedNumber === null || parsedNumber < -2147483648 || parsedNumber > 2147483647
        ? 'Task view order must be an integer.'
        : '';
    if (error)
      return showEdit(res, record, error, true, id !== -1 && (await hasSystemPermission(db, userId, 'data', 'delete')));
    if (isDelete) {
      await db.query('DELETE FROM mst_task WHERE task_id=$1', [id]);
      return res.redirect(`${root}/TaskList`);
    }

    const values = [taskName, taskRemark, parsedNumber, hostname(), req.session?.userId ?? ''];
    if (id === -1) {
      await db.query(
        'INSERT INTO mst_task (task_name,task_remark,display_number,sys_regist_term,sys_regist_user,sys_update_term,sys_update_user) VALUES ($1,$2,$3,$4,$5,$4,$5)',
        values,
      );
    } else {
      await db.query(
        'UPDATE mst_task SET task_name=$1,task_remark=$2,display_number=$3,sys_update_term=$4,sys_update_user=$5,sys_update_time=now() WHERE task_id=$6',
        [...values, id],
      );
    }
    return res.redirect(`${root}/TaskList`);
  });
}
