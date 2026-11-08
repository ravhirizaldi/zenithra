import { base } from '../../../config/manager.js';
import type {
  SystemPermissionAction,
  SystemPermissionMap,
  SystemPermissionScope,
} from '../../../middleware/manager/system/permissions.js';

export type SystemMenuEntry = {
  href?: string;
  id?: string;
  key?: string;
  label: string;
  activeSections?: string[];
  children?: SystemMenuEntry[];
};

export type SystemMenuFlags = {
  directLinked: boolean;
  webhookLinked: boolean;
  uploadEnabled: boolean;
  backupLogEnabled: boolean;
  backupImageEnabled: boolean;
  autoOutputEnabled: boolean;
  serverLogEnabled: boolean;
  licenseUploadEnabled: boolean;
  hasFreeDrawLicense: boolean;
  freeDrawOnly: boolean;
};

export function firstSystemMenuHref(items: SystemMenuEntry[]): string | undefined {
  for (const item of items) {
    if (item.href) return item.href;
    const nested = firstSystemMenuHref(item.children ?? []);
    if (nested) return nested;
  }
  return undefined;
}

export function systemMenuFor(
  userId: string,
  permissions: SystemPermissionMap,
  flags: SystemMenuFlags,
): SystemMenuEntry[] {
  const can = (scope: SystemPermissionScope, action: SystemPermissionAction) =>
    userId === 'conmasadmin' || permissions[scope][action];
  const link = (
    id: string,
    key: string,
    label: string,
    route: string,
    children: SystemMenuEntry[] = [],
    activeSections: string[] = [],
  ): SystemMenuEntry => ({
    id,
    key,
    label,
    href: `${base}/System/${route}`,
    activeSections,
    children,
  });
  const items: SystemMenuEntry[] = [];

  if (can('user', 'read')) {
    const children: SystemMenuEntry[] = [];
    if (can('data', 'read') && flags.directLinked && !flags.freeDrawOnly) {
      children.push(
        link(
          'userDirectFunction',
          'UserDirectList',
          'Direct linkage',
          'UserDirectList',
          [],
          ['DetailsUserDirect', 'EditUserDirect'],
        ),
      );
    }
    if (can('data', 'read')) {
      children.push(
        link(
          'userAccountOperationLogFunction',
          'UserAccountOperationLog',
          'User Account Log',
          'UserAccountOperationLog',
        ),
      );
    }
    items.push(
      link('userFunction', 'UserList', 'Users', 'UserList', children, [
        'DetailsUser',
        'CreateUser',
        'EditUser',
        'GetStamp',
      ]),
    );
  }
  if (can('group', 'read')) {
    items.push(
      link(
        'groupFunction',
        'GroupList',
        'Groups',
        'GroupList',
        [],
        ['DetailsGroup', 'CreateGroup', 'EditGroup', 'EditDefaultRole', 'EditFdRole'],
      ),
    );
    if (flags.hasFreeDrawLicense)
      items.push(
        link(
          'irfdFunction',
          'IrfdTemplateList',
          'i-Repo FreeDraw template',
          'IrfdTemplateList',
          [],
          ['EditIrfdTemplate'],
        ),
      );
  }
  if (can('terminal', 'read')) {
    items.push(link('termFunction', 'TermList', 'Devices', 'TermList', [], ['DetailsTerm', 'CreateTerm', 'EditTerm']));
  }

  if (can('system', 'read')) {
    if (!flags.freeDrawOnly) {
      items.push(
        link(
          'mailFunction',
          'MailList',
          'Notification Settings',
          'MailList',
          [link('mailtLogFunction', 'MailSendLog', 'Transmission history', 'MailSendLog')],
          ['EditMailBase'],
        ),
      );
      const directChildren = flags.directLinked
        ? [link('directLogFunction', 'DirectSendLog', 'Transmission history', 'DirectSendLog')]
        : [];
      items.push(
        link('directFunction', 'DirectChat', 'Direct notice setting', 'DirectChat', directChildren, [
          'EditDirectSetting',
          'EditDirectNotification',
          'EditDirectTemplate',
          'DetailsDirectTemplate',
        ]),
      );
      if (flags.webhookLinked) {
        items.push(
          link(
            'webhookFunction',
            'WebhookList',
            'Webhook notice setting',
            'WebhookList',
            [link('webhookLogFunction', 'WebhookSendLog', 'Transmission history', 'WebhookSendLog')],
            ['WebhookChat', 'EditWebhookSetting', 'EditWebhookSettingGeneral', 'EditWebhookNotification'],
          ),
        );
      }
    }
    items.push(link('comFunction', 'ComList', 'Common Master', 'ComList', [], ['DetailsCom', 'CreateCom', 'EditCom']));
  }

  if (can('data', 'read') && !flags.freeDrawOnly) {
    if (flags.uploadEnabled) {
      items.push(link('uploadFunction', 'UploadList', 'File Upload', 'UploadList', [], ['CreateUpload']));
    }
    items.push(link('taskFunction', 'TaskList', 'Task manager', 'TaskList', [], ['EditTask']));
  }
  if (can('group', 'read') && !flags.freeDrawOnly) {
    items.push(link('dataInputFunction', 'DataInput', 'Data import', 'DataInput'));
    items.push(link('dataOutputFunction', 'DataOutput', 'Data Export', 'DataOutput'));
  }

  if (can('data', 'read')) {
    if (!flags.freeDrawOnly) items.push(link('lockManageFunction', 'LockManagement', 'Batch unlock', 'LockManagement'));
    const loginHistory = link(
      'opeartionLogFunction',
      'OperationLog',
      'Login history',
      'OperationLog',
      can('data', 'delete')
        ? [link('deleteOperationLogFunction', 'DeleteOperationLog', 'Log deletion', 'DeleteOperationLog')]
        : [],
    );
    const definitionHistory = link(
      'definitionFormOperationLogFunction',
      'DefinitionFormOperationLog',
      'Form operation history',
      'DefinitionFormOperationLog',
      can('data', 'delete')
        ? [
            link(
              'deleteDefinitionFormOperationLogFunction',
              'DeleteDefinitionFormOperationLog',
              'Log deletion',
              'DeleteDefinitionFormOperationLog',
            ),
          ]
        : [],
    );
    const inputHistory = link(
      'inputReportOperationLogFunction',
      'InputReportOperationLog',
      'Input document operation history',
      'InputReportOperationLog',
      can('data', 'delete')
        ? [
            link(
              'deleteInputReportOperationLogFunction',
              'DeleteInputReportOperationLog',
              'Log deletion',
              'DeleteInputReportOperationLog',
            ),
          ]
        : [],
    );
    items.push({
      label: 'Operation log',
      children: flags.freeDrawOnly ? [loginHistory] : [loginHistory, definitionHistory, inputHistory],
    });
    if (can('data', 'delete') && can('customTable', 'edit') && !flags.freeDrawOnly) {
      items.push(
        link(
          'customMasterMaintenanceFunction',
          'CustomMasterMaintenance',
          'Custom master maintenance',
          'CustomMasterMaintenance',
        ),
      );
    }
    if (!flags.freeDrawOnly)
      items.push({
        label: 'Voice recognition common dictionary',
        children: [link('voiceCommonGrammarFunction', 'VoiceCommonGrammar', 'Common operation', 'VoiceCommonGrammar')],
      });
    if (!flags.freeDrawOnly && (flags.backupLogEnabled || flags.backupImageEnabled)) {
      const children: SystemMenuEntry[] = [];
      if (flags.backupLogEnabled) children.push(link('backupLogFunction', 'BackupLog', 'Log', 'BackupFile?type=0'));
      if (flags.backupImageEnabled)
        children.push(link('backupImageFunction', 'BackupImage', 'Image', 'BackupFile?type=1'));
      items.push({ label: 'Backup file', children });
    }
    if (flags.autoOutputEnabled && !flags.freeDrawOnly) {
      items.push(
        link('autoOutputFileFunction', 'AutoOutputFile', 'Automatic output file', 'AutoOutputFile?currentPath='),
      );
    }
  }

  if (can('system', 'read')) {
    if (flags.serverLogEnabled && !flags.freeDrawOnly) {
      items.push(link('serverLogFileFunction', 'ServerLogFile', 'Server log', 'ServerLogFile?rootPath='));
    }
    const licenseChildren = flags.licenseUploadEnabled
      ? [link('uploadLicenseFunction', 'UploadLicense', 'Update', 'UploadLicense')]
      : [];
    items.push(link('licenseFunction', 'DetailsLicense', 'License', 'DetailsLicense', licenseChildren));
  }
  return items;
}
