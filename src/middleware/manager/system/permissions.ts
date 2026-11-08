import type pg from 'pg';

export type SystemPermissionScope = 'system' | 'data' | 'user' | 'group' | 'terminal' | 'customTable';
export type SystemPermissionAction = 'read' | 'edit' | 'create' | 'delete';
export type SystemPermissionMap = Record<SystemPermissionScope, Record<SystemPermissionAction, boolean>> & {
  systemTab: boolean;
};

type RoleColumn =
  | 'role_mst_read'
  | 'role_mst_update'
  | 'role_mst_create'
  | 'role_mst_delete'
  | 'role_mst_user_read'
  | 'role_mst_user_update'
  | 'role_mst_user_create'
  | 'role_mst_user_delete'
  | 'role_mst_terminal_read'
  | 'role_mst_terminal_update'
  | 'role_mst_terminal_create'
  | 'role_mst_terminal_delete'
  | 'role_mst_system_read'
  | 'role_mst_system_update'
  | 'role_mst_system_create'
  | 'role_mst_system_delete'
  | 'role_mst_data_read'
  | 'role_mst_data_update'
  | 'role_mst_data_create'
  | 'role_mst_data_delete'
  | 'role_custom_table_read'
  | 'role_custom_table_update';

type RoleBits = Partial<Record<RoleColumn, string | number | null>>;

const roleColumns: readonly RoleColumn[] = [
  'role_mst_read',
  'role_mst_update',
  'role_mst_create',
  'role_mst_delete',
  'role_mst_user_read',
  'role_mst_user_update',
  'role_mst_user_create',
  'role_mst_user_delete',
  'role_mst_terminal_read',
  'role_mst_terminal_update',
  'role_mst_terminal_create',
  'role_mst_terminal_delete',
  'role_mst_system_read',
  'role_mst_system_update',
  'role_mst_system_create',
  'role_mst_system_delete',
  'role_mst_data_read',
  'role_mst_data_update',
  'role_mst_data_create',
  'role_mst_data_delete',
  'role_custom_table_read',
  'role_custom_table_update',
];
const roleSelect = roleColumns.map((column) => `MAX(grp.${column}) AS ${column}`).join(', ');

const genericColumn: Record<SystemPermissionAction, RoleColumn> = {
  read: 'role_mst_read',
  edit: 'role_mst_update',
  create: 'role_mst_create',
  delete: 'role_mst_delete',
};

const actionSuffix: Record<SystemPermissionAction, string> = {
  read: 'read',
  edit: 'update',
  create: 'create',
  delete: 'delete',
};

const scopePrefix: Record<SystemPermissionScope, string | undefined> = {
  system: 'role_mst_system',
  data: 'role_mst_data',
  user: 'role_mst_user',
  group: undefined,
  terminal: 'role_mst_terminal',
  customTable: undefined,
};

async function loadRoleBits(db: pg.Pool, userId: string): Promise<RoleBits | null> {
  if (!userId) return null;
  const result = await db.query(
    `SELECT ${roleSelect} FROM mst_group grp
     WHERE grp.group_id IN (SELECT group_id FROM mst_group_affiation WHERE user_id = $1)`,
    [userId],
  );
  return (result.rows[0] as RoleBits | undefined) ?? null;
}

function granted(roles: RoleBits, column: RoleColumn): boolean {
  return String(roles[column] ?? '') === '1';
}

export async function systemPermissionMap(db: pg.Pool, userId: string): Promise<SystemPermissionMap> {
  const roles = (await loadRoleBits(db, userId)) ?? {};
  const hasPermission = (scope: SystemPermissionScope, action: SystemPermissionAction): boolean => {
    if (scope === 'customTable') {
      const update = granted(roles, 'role_custom_table_update');
      return action === 'read' ? granted(roles, 'role_custom_table_read') || update : action === 'edit' && update;
    }
    const specificPrefix = scopePrefix[scope];
    return (
      granted(roles, genericColumn[action]) ||
      (specificPrefix !== undefined && granted(roles, `${specificPrefix}_${actionSuffix[action]}` as RoleColumn))
    );
  };
  const permissionsFor = (scope: SystemPermissionScope): Record<SystemPermissionAction, boolean> => ({
    read: hasPermission(scope, 'read'),
    edit: hasPermission(scope, 'edit'),
    create: hasPermission(scope, 'create'),
    delete: hasPermission(scope, 'delete'),
  });
  return {
    system: permissionsFor('system'),
    data: permissionsFor('data'),
    user: permissionsFor('user'),
    group: permissionsFor('group'),
    terminal: permissionsFor('terminal'),
    customTable: permissionsFor('customTable'),
    systemTab:
      granted(roles, 'role_mst_read') ||
      granted(roles, 'role_mst_user_read') ||
      granted(roles, 'role_mst_terminal_read') ||
      granted(roles, 'role_mst_system_read') ||
      granted(roles, 'role_mst_data_read'),
  };
}

export async function hasSystemPermission(
  db: pg.Pool,
  userId: string,
  scope: SystemPermissionScope,
  action: SystemPermissionAction,
): Promise<boolean> {
  return (await systemPermissionMap(db, userId))[scope][action];
}

export async function hasSystemTabAccess(db: pg.Pool, userId: string): Promise<boolean> {
  return (await systemPermissionMap(db, userId)).systemTab;
}
