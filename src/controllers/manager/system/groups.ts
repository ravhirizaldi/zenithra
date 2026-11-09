import { text as pageText } from '../../../config/manager/system/resources.js';
import type { Express, Request, Response } from 'express';
import type pg from 'pg';
import { licenseStatus } from '../../../shared/license-counts.js';
import { hostname } from 'node:os';
import { groupPermissions } from '../../../shared/group-permissions.js';
import { syncGroupRoles } from '../../../sync-group-roles.js';

type Row = Record<string, unknown>;
type Render = (res: Response, data: Record<string, unknown>) => unknown;
type GroupFeatures = { groupKeyMode: boolean; definitionMode: boolean; freeDraw: boolean; freeDrawOnly: boolean };
type GroupRecord = Row & {
  group_id: number;
  group_name: string;
  upper_group_id: number;
  group_id_path: string;
  group_name_path: string;
  upper_group_name_path: string;
  group_remarks: string;
  systemKey: string;
  IrfdTemplateId: number;
};

const root = '/ConMasManager/System';
const fallbackPageSizes = [10, 20, 50, 100];
const permissionGroups = [
  {
    title: pageText['System'],
    columns: [
      { field: 'role_mst_read', label: pageText['Refer'] },
      { field: 'role_mst_create', label: pageText['Issue'] },
      { field: 'role_mst_update', label: pageText['Edit'] },
      { field: 'role_mst_delete', label: pageText['Delete'] },
    ],
  },
  {
    title: pageText['Users'],
    columns: [
      { field: 'role_mst_user_read', label: pageText['Refer'] },
      { field: 'role_mst_user_create', label: pageText['Issue'] },
      { field: 'role_mst_user_update', label: pageText['Edit'] },
      { field: 'role_mst_user_delete', label: pageText['Delete'] },
    ],
  },
  {
    title: pageText['Devices'],
    columns: [
      { field: 'role_mst_terminal_read', label: pageText['Refer'] },
      { field: 'role_mst_terminal_update', label: pageText['Edit'] },
      { field: 'role_mst_terminal_delete', label: pageText['Delete'] },
    ],
  },
  {
    title: pageText['System Settings'],
    columns: [
      { field: 'role_mst_system_read', label: pageText['Refer'] },
      { field: 'role_mst_system_create', label: pageText['Issue'] },
      { field: 'role_mst_system_update', label: pageText['Edit'] },
      { field: 'role_mst_system_delete', label: pageText['Delete'] },
    ],
  },
  {
    title: pageText['Data administration'],
    columns: [
      { field: 'role_mst_data_read', label: pageText['Refer'] },
      { field: 'role_mst_data_create', label: pageText['Issue'] },
      { field: 'role_mst_data_update', label: pageText['Edit'] },
      { field: 'role_mst_data_delete', label: pageText['Delete'] },
    ],
  },
  {
    title: pageText['Forms'],
    columns: [
      { field: 'role_def_read_manager', label: pageText['Refer'] },
      { field: 'role_def_update_manager', label: pageText['Edit'] },
      { field: 'role_def_delete_manager', label: pageText['Delete'] },
    ],
  },
  {
    title: pageText['Documents'],
    columns: [
      { field: 'role_rep_read_manager', label: pageText['Refer'] },
      { field: 'role_rep_update_manager', label: pageText['Edit'] },
      { field: 'role_rep_delete_manager', label: pageText['Delete'] },
      { field: 'role_rep_super_manager', label: pageText['Management'] },
    ],
  },
  {
    title: pageText['Data Output'],
    rowspan: 2,
    columns: [{ field: 'role_data_output', label: pageText['Data Output'] }],
  },
  {
    title: pageText['Doc. Import'],
    rowspan: 2,
    columns: [{ field: 'role_auto_generate', label: pageText['Doc. Import'] }],
  },
  {
    title: pageText['Labels'],
    columns: [
      { field: 'role_label_read_manager', label: pageText['Refer'] },
      { field: 'role_label_create_manager', label: pageText['Issue'] },
      { field: 'role_label_update_manager', label: pageText['Edit'] },
      { field: 'role_label_delete_manager', label: pageText['Delete'] },
    ],
  },
  {
    title: pageText['Library'],
    columns: [
      { field: 'role_library_read', label: pageText['Refer'] },
      { field: 'role_library_create', label: pageText['Confirm'] },
      { field: 'role_library_update', label: pageText['Edit'] },
      { field: 'role_library_delete', label: pageText['Delete'] },
    ],
  },
  {
    title: pageText['Schedule'],
    columns: [
      { field: 'role_schedule_read', label: pageText['Refer'] },
      { field: 'role_schedule_create', label: pageText['Issue'] },
      { field: 'role_schedule_update', label: pageText['Edit'] },
      { field: 'role_schedule_delete', label: pageText['Delete'] },
    ],
  },
  {
    title: pageText['Master'],
    columns: [
      { field: 'role_custom_read', label: pageText['Refer'] },
      { field: 'role_custom_mentenance', label: pageText['Maintenance'] },
    ],
  },
  {
    title: pageText['Custom menu'],
    columns: [
      { field: 'role_custom_menu_read', label: pageText['Refer'] },
      { field: 'role_custom_menu_update', label: pageText['Maintenance'] },
    ],
  },
  {
    title: pageText['Binder'],
    columns: [
      { field: 'role_binder_read', label: pageText['Refer'] },
      { field: 'role_binder_update', label: pageText['Setting'] },
      { field: 'role_binder_delete', label: pageText['Delete'] },
    ],
  },
];
const designerColumns = [
  { field: 'role_def_create', label: pageText['New'] },
  { field: 'role_def_approve', label: pageText['Release'] },
];
const defaultDefinitionColumns = [
  { field: 'role_def_read', label: pageText['Refer'] },
  { field: 'role_def_update', label: pageText['Edit'] },
  { field: 'role_def_delete', label: pageText['Delete'] },
  { field: 'role_rep_read', label: pageText['Refer'] },
  { field: 'role_rep_create', label: pageText['Issue'] },
  { field: 'role_rep_update', label: pageText['Edit'] },
  { field: 'role_rep_delete', label: pageText['Delete'] },
];
const freeDrawColumns = [
  { field: 'role_irfd_read', label: pageText['Refer'] },
  { field: 'role_irfd_update', label: pageText['Edit'] },
];

const input = (req: Request, key: string): string => {
  const value = req.body?.[key];
  return typeof value === 'string' ? value : '';
};
const queryString = (value: unknown): string => (typeof value === 'string' ? value : '');
const requestParam = (req: Request, key: string): unknown =>
  req.method === 'POST' ? (req.body?.[key] ?? req.query[key]) : req.query[key];
const boolValue = (value: unknown): boolean => value === true || value === 1 || value === '1' || value === 'true';
const safePageNumber = (value: unknown, fallback: number, min: number, max: number): number => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : fallback;
};
const selectedValues = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return typeof value === 'string' ? [value] : [];
};
const fullwidthSlashes = (value: string): string => value.replaceAll('/', '／');
const likePattern = (value: string): string =>
  '%' + value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_') + '%';

function permissionLayout(features: GroupFeatures) {
  const system = permissionGroups.slice(0, 5);
  const manager = features.freeDrawOnly ? permissionGroups.slice(9, 11) : permissionGroups.slice(5);
  const designer = features.freeDrawOnly ? [] : designerColumns.slice(0, features.definitionMode ? 2 : 1);
  const defaultDefinition = features.freeDrawOnly ? [] : defaultDefinitionColumns;
  const freeDraw = features.freeDraw ? freeDrawColumns : [];
  return { system, manager, designer, defaultDefinition, freeDraw };
}

async function loadFeatures(db: pg.Pool): Promise<GroupFeatures> {
  const rows = (
    await db.query(
      "SELECT com_key,com_name,com_value FROM mst_common WHERE (com_key='API_MODE' AND com_name='MST_GROUP_KEY_MODE') OR (com_key='DEFINITION_SETTING' AND com_name='APPROVE_MODE')",
    )
  ).rows;
  const value = (key: string, name: string) =>
    String(rows.find((row) => row.com_key === key && row.com_name === name)?.com_value ?? '0');
  const license = licenseStatus();
  return {
    groupKeyMode: value('API_MODE', 'MST_GROUP_KEY_MODE') === '1',
    definitionMode: value('DEFINITION_SETTING', 'APPROVE_MODE') === '1',
    freeDraw: license.freeDraw,
    freeDrawOnly: license.freeDrawOnly,
  };
}

async function loadGroup(db: pg.Pool, id: number): Promise<GroupRecord | undefined> {
  const result = await db.query(
    "SELECT g.*, coalesce(parent.group_name_path,'') AS upper_group_name_path, " +
      "coalesce(template.template_name,'') AS irfd_template_name " +
      'FROM mst_group g LEFT JOIN mst_group parent ON parent.group_id=g.upper_group_id ' +
      'LEFT JOIN mst_irfd_template template ON template.template_id=g.irfd_template_id WHERE g.group_id=$1',
    [id],
  );
  return result.rows[0] as GroupRecord | undefined;
}

async function loadTemplates(db: pg.Pool): Promise<Row[]> {
  return (await db.query('SELECT template_id,template_name FROM mst_irfd_template ORDER BY template_id')).rows;
}

async function loadPageSizes(db: pg.Pool): Promise<number[]> {
  const rows = (await db.query("SELECT com_value FROM mst_common WHERE com_key='PAGE_SIZE' ORDER BY com_index")).rows;
  const values = rows.map((row) => Number(row.com_value)).filter((value) => Number.isSafeInteger(value) && value > 0);
  return values.length ? values : fallbackPageSizes;
}

async function loadDefaultPageSize(db: pg.Pool, sizes: number[]): Promise<number> {
  const value = Number(
    (await db.query("SELECT com_value FROM mst_common WHERE com_key='DEFAULT_PAGE_SIZE' ORDER BY com_index LIMIT 1"))
      .rows[0]?.com_value ?? 20,
  );
  return sizes.includes(value) ? value : sizes.includes(20) ? 20 : (sizes[0] ?? 20);
}

async function loadParents(db: pg.Pool, exceptId?: number): Promise<Row[]> {
  const groups = await db.query(
    'SELECT group_id,group_id_path,group_name_path FROM mst_group WHERE group_id > -999 ORDER BY group_name_path,group_id',
  );
  return groups.rows.filter((group) => {
    if (exceptId === undefined) return true;
    return Number(group.group_id) !== exceptId && !String(group.group_id_path).split('/').includes(String(exceptId));
  });
}

async function loadUsers(db: pg.Pool, groupId?: number): Promise<Row[]> {
  const args = groupId === undefined ? [] : [groupId];
  const groupJoin =
    groupId === undefined ? '' : 'LEFT JOIN mst_group_affiation a ON a.user_id=u.user_id AND a.group_id=$1';
  const checked = groupId === undefined ? 'false' : '(a.user_id IS NOT NULL)';
  const dates =
    groupId === undefined
      ? "'' AS use_start_time,'' AS use_end_time"
      : 'CASE WHEN ' +
        checked +
        " THEN coalesce(to_char(a.use_start_time,'YYYY/MM/DD HH24:MI'),'') ELSE '' END AS use_start_time, " +
        'CASE WHEN ' +
        checked +
        " THEN coalesce(to_char(a.use_end_time,'YYYY/MM/DD HH24:MI'),'') ELSE '' END AS use_end_time";
  return (
    await db.query(
      "SELECT u.user_id,u.user_name,coalesce(u.e_mail,'') AS e_mail," +
        checked +
        ' AS chk,' +
        dates +
        ' FROM mst_user u ' +
        groupJoin +
        " WHERE u.user_id <> 'conmasadmin' ORDER BY u.user_id",
      args,
    )
  ).rows;
}

async function loadDetailsUsers(db: pg.Pool, groupId: number): Promise<Row[]> {
  return (
    await db.query(
      "SELECT u.user_id,u.user_name,coalesce(u.e_mail,'') AS e_mail, " +
        "coalesce(to_char(a.use_start_time,'YYYY/MM/DD HH24:MI'),'') AS use_start_time, " +
        "coalesce(to_char(a.use_end_time,'YYYY/MM/DD HH24:MI'),'') AS use_end_time " +
        'FROM mst_group_affiation a INNER JOIN mst_user u ON u.user_id=a.user_id ' +
        'WHERE a.group_id=$1 ORDER BY u.user_id',
      [groupId],
    )
  ).rows;
}

async function loadDescendants(db: pg.Pool, group: GroupRecord): Promise<Row[]> {
  return (
    await db.query(
      "SELECT group_id,group_name_path FROM mst_group WHERE group_id_path LIKE $1 || '/%' ORDER BY group_id_path",
      [group.group_id_path],
    )
  ).rows;
}

async function loadRoleSettings(db: pg.Pool): Promise<Record<string, string>> {
  const rows = (
    await db.query(
      'SELECT com_key,com_name,com_value FROM mst_common ' +
        "WHERE (com_key='SYSTEM_ROLE_SETTING' AND com_name IN ('ENABLE','DEF','REP','REP_DEFAULT','AUTO_TYPE')) " +
        "OR (com_key='LIBRARY' AND com_name='FD_DEFAULT_ROLE')",
    )
  ).rows;
  const setting = (key: string, name: string, fallback = '0') =>
    String(rows.find((row) => row.com_key === key && row.com_name === name)?.com_value ?? fallback);
  return {
    enable: setting('SYSTEM_ROLE_SETTING', 'ENABLE'),
    definition: setting('SYSTEM_ROLE_SETTING', 'DEF'),
    report: setting('SYSTEM_ROLE_SETTING', 'REP'),
    defaultReport: setting('SYSTEM_ROLE_SETTING', 'REP_DEFAULT'),
    autoType: setting('SYSTEM_ROLE_SETTING', 'AUTO_TYPE'),
    freeDraw: setting('LIBRARY', 'FD_DEFAULT_ROLE', '1'),
  };
}

function roleSettingLabels(settings: Record<string, string>) {
  const definitionModes = [
    'No settings.',
    'User group that the user who created the form belonging to only can edit.',
    'User group that the user who created the form belonging to and the upper groups can only edit.',
  ];
  const reportModes = [
    'No settings.',
    'User group that the user who created the form belonging to only can create.',
    'User group that the user who created the form belonging to and the upper groups can only create.',
    'User group that the user who created the form belonging to and the upper or lower groups can only create.',
    'Available to create by all users.',
  ];
  const defaultReportModes =
    settings.autoType === '1'
      ? [
          'Same as setting of the form.',
          'Allocate authority only for the group that the user belongs to.',
          'Allocate authority for the groups that the user belongs to and its upper groups.',
          'User group that the user who created document belonging to, and the upper or lower groups only.',
        ]
      : [
          'User group that the user who created document newly belonging to, other same level groups and those upper groups only can refer and edit.',
          'User group that the user who created document newly belonging to only can refer and edit.',
          'User group that the user who created document newly belonging to, and the upper groups only can refer and edit.',
          'User group that the user who created document newly belonging to and the upper or lower groups only can refer and edit.',
        ];
  const at = (values: string[], value: string, fallback = '') => values[Number(value)] ?? fallback;
  const fdModes: Record<string, string> = {
    '1': 'Only the group to which the user who newly created a document belongs.',
    '2': 'Only the group to which the user who newly created a document belongs and its upper groups.',
    '3': 'Only the group to which the user who newly created a document belongs and its upper and lower groups.',
    '4': 'Follow the default i-Repo FreeDraw authorities',
  };
  return {
    enabledName: settings.enable === '1' ? 'Valid' : 'Invalid',
    autoTypeName: settings.autoType === '1' ? 'Set with default form rights of group management' : 'Auto setting',
    definitionName: at(definitionModes, settings.definition, 'No settings.'),
    reportName: at(reportModes, settings.report, 'No settings.'),
    defaultReportName: at(defaultReportModes, settings.defaultReport, ''),
    fdName: fdModes[settings.freeDraw] ?? '',
    autoHeading: 'Auto. setting mode for user group authority at creating form on Designer.',
    freeDrawHeading: 'Authority setting for newly saved documents from i-Repo FreeDraw',
    autoFlagLabel: 'Valid or invalid for mode',
    autoTypeLabel: 'Authorization setting type',
    definitionAutoLabel: 'Authorization group for forms',
    definitionDefaultLabel: 'Edit authority for created form',
    reportAutoLabel: 'Authorization group for input documents',
    reportDefaultLabel: 'Authority to create new document from the form on iPad',
    defaultReportAutoLabel: 'Authority group settings when the document is issued.',
    defaultReportDefaultLabel: 'Authority for viewing and editing on iPad.',
    fdLabel: 'Groups to apply i-Repo FreeDraw authority',
  };
}

async function renderGroupPage(res: Response, render: Render, mode: string, values: Record<string, unknown> = {}) {
  const features = values.features as GroupFeatures | undefined;
  const resolvedFeatures = features ?? {
    groupKeyMode: false,
    definitionMode: false,
    freeDraw: false,
    freeDrawOnly: false,
  };
  return render(res, {
    active: 'System',
    section: 'GroupList',
    login: false,
    title:
      mode === 'create'
        ? pageText['Register new group']
        : mode === 'edit'
          ? pageText['Edit group']
          : mode === 'details'
            ? pageText['Group reference']
            : pageText['Groups'],
    systemGroupPage: {
      mode,
      indexUrl: root + '/GroupList',
      features: resolvedFeatures,
      layout: permissionLayout(resolvedFeatures),
      ...values,
    },
  });
}

async function renderForm(
  db: pg.Pool,
  res: Response,
  render: Render,
  mode: 'create' | 'edit',
  group: Row,
  error = '',
  selectedIds?: string[],
) {
  const features = await loadFeatures(db);
  const id = Number(group.group_id ?? 0);
  const [parents, users, templates, userPageSizes] = await Promise.all([
    loadParents(db, mode === 'edit' ? id : undefined),
    loadUsers(db, mode === 'edit' ? id : undefined),
    features.freeDraw ? loadTemplates(db) : Promise.resolve([]),
    loadPageSizes(db),
  ]);
  const userPageSize = await loadDefaultPageSize(db, userPageSizes);
  const selected = new Set(
    selectedIds ?? users.filter((user) => boolValue(user.chk)).map((user) => String(user.user_id)),
  );
  for (const permission of groupPermissions) {
    const field = permission[1];
    if (!(field in group)) group[field] = mode === 'create';
  }
  return renderGroupPage(res, render, mode, {
    group,
    parents,
    users,
    templates,
    selectedIds: [...selected],
    error,
    userPageSizes,
    userPageSize,
    features,
    layout: permissionLayout(features),
  });
}

async function details(db: pg.Pool, res: Response, render: Render, group: GroupRecord, error = '') {
  const features = await loadFeatures(db);
  const [users, descendants] = await Promise.all([loadDetailsUsers(db, group.group_id), loadDescendants(db, group)]);
  return renderGroupPage(res, render, 'details', {
    group,
    users,
    descendants,
    error,
    features,
    layout: permissionLayout(features),
  });
}

async function pageList(db: pg.Pool, req: Request, res: Response, render: Render) {
  const features = await loadFeatures(db);
  const searchId = queryString(requestParam(req, 'searchId') ?? requestParam(req, 'GroupSearchData.GroupId')).trim();
  const searchName = queryString(requestParam(req, 'searchName') ?? requestParam(req, 'GroupSearchData.GroupName'))
    .trim()
    .slice(0, 100);
  const sizes = await loadPageSizes(db);
  const defaultPageSize = await loadDefaultPageSize(db, sizes);
  const requestedPageSize = Number(requestParam(req, 'pageSize'));
  const pageSize = sizes.includes(requestedPageSize) ? requestedPageSize : defaultPageSize;
  const pageIndexInput = safePageNumber(requestParam(req, 'pageIndex'), 0, 0, 100000);
  const conditions = ['g.group_id > -999'];
  const parameters: unknown[] = [];
  if (/^-?\d+$/.test(searchId)) {
    parameters.push(Number(searchId));
    conditions.push('g.group_id=$' + parameters.length);
  }
  if (searchName) {
    parameters.push(likePattern(searchName));
    conditions.push('g.group_name_path ILIKE $' + parameters.length);
  }
  const where = conditions.join(' AND ');
  const total = Number(
    (await db.query('SELECT count(*) AS total FROM mst_group g WHERE ' + where, parameters)).rows[0]?.total ?? 0,
  );
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const pageIndex = Math.min(pageIndexInput, pages - 1);
  const listParameters = [...parameters, pageSize, pageIndex * pageSize];
  const groups = (
    await db.query(
      "SELECT g.*, coalesce(parent.group_name_path,'') AS upper_group_name_path, " +
        "coalesce(template.template_name,'') AS irfd_template_name " +
        'FROM mst_group g LEFT JOIN mst_group parent ON parent.group_id=g.upper_group_id ' +
        'LEFT JOIN mst_irfd_template template ON template.template_id=g.irfd_template_id ' +
        'WHERE ' +
        where +
        ' ORDER BY g.group_name_path,g.group_id LIMIT $' +
        (parameters.length + 1) +
        ' OFFSET $' +
        (parameters.length + 2),
      listParameters,
    )
  ).rows;
  const settings = await loadRoleSettings(db);
  return render(res, {
    active: 'System',
    section: 'GroupList',
    login: false,
    title: pageText['Groups'],
    systemGroupPage: {
      mode: 'list',
      indexUrl: root + '/GroupList',
      groups,
      total,
      searchId,
      searchName,
      pageIndex,
      pageSize,
      pageSizes: sizes,
      pages,
      features,
      layout: permissionLayout(features),
      settings,
      settingLabels: roleSettingLabels(settings),
    },
  });
}

function parseForm(req: Request, existing: Row | undefined, create: boolean) {
  const values: Row = {
    group_id: create ? 0 : Number(input(req, 'mst_group.group_id')),
    group_name: fullwidthSlashes(input(req, 'mst_group.group_name').trim()),
    upper_group_id: Number(input(req, 'mst_group.upper_group_id') || -1),
    systemKey: input(req, 'mst_group.systemKey').trim() || null,
    group_remarks: input(req, 'mst_group.group_remarks'),
    IrfdTemplateId: Number(input(req, 'mst_group.IrfdTemplateId') || 1),
  };
  for (const [, field] of groupPermissions) values[field] = input(req, 'mst_group.' + field) === '1';
  if (!create && existing) values.group_id = Number(existing.group_id);
  return values;
}

async function validateGroup(db: pg.Pool, group: Row, features: GroupFeatures, existingId?: number): Promise<string> {
  if (typeof group.group_name !== 'string' || !group.group_name.trim()) return 'Please enter Group Name.';
  const parentId = Number(group.upper_group_id);
  if (!Number.isInteger(parentId) || parentId < -1) return 'Select a valid parent group.';
  if (!features.groupKeyMode) group.systemKey = null;
  if (parentId === -1) return '';
  const parent = await db.query('SELECT group_id_path FROM mst_group WHERE group_id=$1 AND group_id > -999', [
    parentId,
  ]);
  if (!parent.rowCount) return 'The selected parent group does not exist.';
  if (existingId !== undefined) {
    if (parentId === existingId) return 'A group cannot be its own parent.';
    if (String(parent.rows[0].group_id_path).split('/').includes(String(existingId)))
      return 'A group cannot be moved beneath one of its descendants.';
  }
  return '';
}

async function saveGroup(db: pg.Pool, req: Request, group: Row, members: string[], create: boolean): Promise<number> {
  const id = Number(group.group_id);
  const parentId = Number(group.upper_group_id);
  const client = await db.connect();
  const actor = req.session.userId ?? '';
  const term = req.ip ?? hostname();
  try {
    await client.query('BEGIN');
    let groupId = id;
    let old: Row | undefined;
    if (create) {
      groupId = Number((await client.query("SELECT nextval('mst_group_group_id_seq') AS id")).rows[0].id);
    } else {
      old = (
        await client.query(
          'SELECT group_id_path,group_name_path,upper_group_id FROM mst_group WHERE group_id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (!old) throw new Error(pageText['The group no longer exists.']);
    }
    let parentIdPath = '';
    let parentNamePath = '';
    if (parentId !== -1) {
      const parent = (
        await client.query(
          'SELECT group_id_path,group_name_path FROM mst_group WHERE group_id=$1 AND group_id > -999',
          [parentId],
        )
      ).rows[0];
      if (!parent) throw new Error(pageText['The selected parent group does not exist.']);
      parentIdPath = String(parent.group_id_path);
      parentNamePath = String(parent.group_name_path);
    }
    const groupIdPath = parentId === -1 ? String(groupId) : parentIdPath + '/' + groupId;
    const groupNamePath = parentId === -1 ? String(group.group_name) : parentNamePath + '/' + String(group.group_name);
    const columns = groupPermissions.map((item) => item[0]);
    const permissionValues = groupPermissions.map((item) => (boolValue(group[item[1]]) ? 1 : 0));
    if (create) {
      const insertColumns = [
        'group_id',
        'group_name',
        'upper_group_id',
        'group_id_path',
        'group_name_path',
        ...columns,
        'group_remarks',
        'irfd_template_id',
        'deleted',
        'sys_regist_term',
        'sys_regist_user',
        'sys_regist_time',
        'sys_update_term',
        'sys_update_user',
        'sys_update_time',
        'system_key',
      ];
      const insertValues: unknown[] = [
        groupId,
        group.group_name,
        parentId === -1 ? null : parentId,
        groupIdPath,
        groupNamePath,
        ...permissionValues,
        group.group_remarks,
        Math.max(1, Number(group.IrfdTemplateId) || 1),
        0,
        term,
        actor,
        new Date(),
        term,
        actor,
        new Date(),
        group.systemKey,
      ];
      const placeholders = insertValues.map((_, index) => '$' + (index + 1));
      await client.query(
        'INSERT INTO mst_group (' + insertColumns.join(',') + ') VALUES (' + placeholders.join(',') + ')',
        insertValues,
      );
      if (parentId !== -1) await syncGroupRoles(client, groupId, parentId, actor);
    } else {
      const assignments = ['group_name=$1', 'upper_group_id=$2', 'group_id_path=$3', 'group_name_path=$4'];
      const updateValues: unknown[] = [group.group_name, parentId === -1 ? null : parentId, groupIdPath, groupNamePath];
      for (let index = 0; index < columns.length; index++) {
        updateValues.push(permissionValues[index]);
        assignments.push(columns[index] + '=$' + updateValues.length);
      }
      updateValues.push(
        group.group_remarks,
        Math.max(1, Number(group.IrfdTemplateId) || 1),
        group.systemKey,
        term,
        actor,
        groupId,
      );
      assignments.push('group_remarks=$' + (updateValues.length - 5));
      assignments.push('irfd_template_id=$' + (updateValues.length - 4));
      assignments.push('system_key=$' + (updateValues.length - 3));
      assignments.push('sys_update_term=$' + (updateValues.length - 2));
      assignments.push('sys_update_user=$' + (updateValues.length - 1));
      assignments.push('sys_update_time=now()');
      await client.query(
        'UPDATE mst_group SET ' + assignments.join(',') + ' WHERE group_id=$' + updateValues.length,
        updateValues,
      );
      await client.query(
        'UPDATE mst_group SET group_id_path=$1 || substring(group_id_path from length($2)+1), ' +
          "group_name_path=$3 || substring(group_name_path from length($4)+1) WHERE group_id_path LIKE $2 || '/%'",
        [groupIdPath, old?.group_id_path, groupNamePath, old?.group_name_path],
      );
      if (parentId !== -1 && Number(old?.upper_group_id ?? -1) !== parentId)
        await syncGroupRoles(client, groupId, parentId, actor);
    }
    await client.query('DELETE FROM mst_group_affiation WHERE group_id=$1', [groupId]);
    const validUsers = await client.query('SELECT user_id FROM mst_user WHERE user_id <> $1 AND user_id=ANY($2)', [
      'conmasadmin',
      members,
    ]);
    for (const user of validUsers.rows) {
      await client.query(
        'INSERT INTO mst_group_affiation ' +
          '(group_id,user_id,use_start_time,use_end_time,group_admin,sys_regist_term,sys_regist_user,sys_regist_time,sys_update_term,sys_update_user,sys_update_time) ' +
          'VALUES($1,$2,NULL,NULL,0,$3,$4,now(),$3,$4,now())',
        [groupId, user.user_id, term, actor],
      );
    }
    await client.query('COMMIT');
    return groupId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function loadMemberIds(db: pg.Pool, groupId: number): Promise<string[]> {
  return (
    await db.query('SELECT user_id FROM mst_group_affiation WHERE group_id=$1 ORDER BY user_id', [groupId])
  ).rows.map((row) => String(row.user_id));
}

async function updateCommon(db: pg.Pool, values: Array<[string, string, string]>) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const [key, name, value] of values)
      await client.query('UPDATE mst_common SET com_value=$3 WHERE com_key=$1 AND com_name=$2', [key, name, value]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function registerGroups(app: Express, db: pg.Pool, render: Render) {
  app.get(root + '/GroupList', async (req, res) => {
    try {
      return await pageList(db, req, res, render);
    } catch {
      return res.status(500).send(pageText['Unable to load groups.']);
    }
  });
  app.post(root + '/GroupList', async (req, res) => {
    try {
      return await pageList(db, req, res, render);
    } catch {
      return res.status(500).send(pageText['Unable to load groups.']);
    }
  });

  app.get(root + '/DetailsGroup', async (req, res) => {
    const id = safePageNumber(req.query.id, -1, 1, 2147483647);
    const group = id > 0 ? await loadGroup(db, id) : undefined;
    if (!group) return res.status(404).send(pageText['Group not found.']);
    return details(db, res, render, group);
  });

  app.post(root + '/DetailsGroup', async (req, res) => {
    const id = safePageNumber(req.body['mst_group.group_id'], -1, 1, 2147483647);
    const group = id > 0 ? await loadGroup(db, id) : undefined;
    if (!group) return res.status(404).send(pageText['Group not found.']);
    if (input(req, 'act') !== 'delete') return res.redirect(root + '/DetailsGroup?id=' + id);
    try {
      await db.query('DELETE FROM mst_group WHERE group_id=$1', [id]);
      return res.redirect(root + '/GroupList');
    } catch {
      const refreshed = await loadGroup(db, id);
      if (!refreshed) return res.redirect(root + '/GroupList');
      res.status(409);
      return details(db, res, render, refreshed, 'This group could not be deleted while it is still in use.');
    }
  });

  app.get(root + '/CreateGroup', async (_req, res) => {
    const group: Row = {
      group_id: 0,
      group_name: '',
      upper_group_id: -1,
      systemKey: '',
      group_remarks: '',
      IrfdTemplateId: 1,
    };
    for (const [, field] of groupPermissions) group[field] = true;
    return renderForm(db, res, render, 'create', group, '', []);
  });

  app.get(root + '/EditGroup', async (req, res) => {
    const id = safePageNumber(req.query.id, -1, 1, 2147483647);
    const group = id > 0 ? await loadGroup(db, id) : undefined;
    if (!group) return res.status(404).send(pageText['Group not found.']);
    const members = await loadMemberIds(db, id);
    return renderForm(db, res, render, 'edit', group, '', members);
  });

  for (const mode of ['create', 'edit'] as const) {
    app.post(root + (mode === 'create' ? '/CreateGroup' : '/EditGroup'), async (req, res) => {
      const create = mode === 'create';
      const requestedId = Number(input(req, 'mst_group.group_id'));
      const existing = create
        ? undefined
        : Number.isSafeInteger(requestedId)
          ? await loadGroup(db, requestedId)
          : undefined;
      if (!create && !existing) return res.status(404).send(pageText['Group not found.']);
      const group = parseForm(req, existing, create);
      const features = await loadFeatures(db);
      const members = selectedValues(req.body.members);
      const error = await validateGroup(db, group, features, create ? undefined : Number(existing?.group_id));
      if (error) return renderForm(db, res.status(400), render, mode, group, error, members);
      try {
        const groupId = await saveGroup(db, req, group, members, create);
        return res.redirect(root + '/DetailsGroup?id=' + groupId);
      } catch (cause) {
        const dbError = cause as { code?: string };
        if (dbError.code === '23505')
          return renderForm(db, res.status(409), render, mode, group, 'The group key is already in use.', members);
        if (dbError.code === '23503')
          return renderForm(
            db,
            res.status(409),
            render,
            mode,
            group,
            'The group is still referenced by other records.',
            members,
          );
        throw cause;
      }
    });
  }

  app.get(root + '/EditDefaultRole', async (_req, res) => {
    const features = await loadFeatures(db);
    const settings = await loadRoleSettings(db);
    return renderGroupPage(res, render, 'default-role', { features, settings });
  });
  app.post(root + '/EditDefaultRole', async (req, res) => {
    const allowed = (name: string, values: string[], fallback: string) =>
      values.includes(input(req, name)) ? input(req, name) : fallback;
    const autoType = allowed('SystemRoleModeAutoType', ['0', '1'], '0');
    const defaultField = autoType === '1' ? 'DefaultRepCreateRoleMode1' : 'DefaultRepCreateRoleMode0';
    await updateCommon(db, [
      ['SYSTEM_ROLE_SETTING', 'DEF', allowed('SystemDefRoleMode', ['0', '1', '2'], '0')],
      ['SYSTEM_ROLE_SETTING', 'REP', allowed('SystemRepRoleMode', ['0', '1', '2', '3', '4'], '0')],
      ['SYSTEM_ROLE_SETTING', 'ENABLE', input(req, 'IsAutoGroupSetting') === '1' ? '1' : '0'],
      ['SYSTEM_ROLE_SETTING', 'REP_DEFAULT', allowed(defaultField, ['0', '1', '2', '3'], '0')],
      ['SYSTEM_ROLE_SETTING', 'AUTO_TYPE', autoType],
    ]);
    return res.redirect(root + '/GroupList');
  });
  app.get(root + '/EditFdRole', async (_req, res) => {
    const features = await loadFeatures(db);
    const settings = await loadRoleSettings(db);
    return renderGroupPage(res, render, 'fd-role', { features, settings });
  });
  app.post(root + '/EditFdRole', async (req, res) => {
    const value = ['0', '1', '2', '3', '4'].includes(input(req, 'DefaultFdRoleMode'))
      ? input(req, 'DefaultFdRoleMode')
      : '1';
    await updateCommon(db, [['LIBRARY', 'FD_DEFAULT_ROLE', value]]);
    return res.redirect(root + '/GroupList');
  });
}
