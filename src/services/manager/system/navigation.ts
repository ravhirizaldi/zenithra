import { text as pageText } from '../../../config/manager/system/resources.js';
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
          pageText['Direct linkage'],
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
          pageText['User Account Log'],
          'UserAccountOperationLog',
        ),
      );
    }
    items.push(
      link('userFunction', 'UserList', pageText['Users'], 'UserList', children, [
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
        pageText['Groups'],
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
          pageText['i-Repo FreeDraw template'],
          'IrfdTemplateList',
          [],
          ['EditIrfdTemplate'],
        ),
      );
  }
  if (can('terminal', 'read')) {
    items.push(
      link('termFunction', 'TermList', pageText['Devices'], 'TermList', [], ['DetailsTerm', 'CreateTerm', 'EditTerm']),
    );
  }

  if (can('system', 'read')) {
    if (!flags.freeDrawOnly) {
      items.push(
        link(
          'mailFunction',
          'MailList',
          pageText['Notification Settings'],
          'MailList',
          [link('mailtLogFunction', 'MailSendLog', pageText['Transmission history'], 'MailSendLog')],
          ['EditMailBase'],
        ),
      );
      const directChildren = flags.directLinked
        ? [link('directLogFunction', 'DirectSendLog', pageText['Transmission history'], 'DirectSendLog')]
        : [];
      items.push(
        link('directFunction', 'DirectChat', pageText['Direct notice setting'], 'DirectChat', directChildren, [
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
            pageText['Webhook notice setting'],
            'WebhookList',
            [link('webhookLogFunction', 'WebhookSendLog', pageText['Transmission history'], 'WebhookSendLog')],
            ['WebhookChat', 'EditWebhookSetting', 'EditWebhookSettingGeneral', 'EditWebhookNotification'],
          ),
        );
      }
    }
    items.push(
      link('comFunction', 'ComList', pageText['Common Master'], 'ComList', [], ['DetailsCom', 'CreateCom', 'EditCom']),
    );
  }

  if (can('data', 'read') && !flags.freeDrawOnly) {
    if (flags.uploadEnabled) {
      items.push(link('uploadFunction', 'UploadList', pageText['File Upload'], 'UploadList', [], ['CreateUpload']));
    }
    items.push(link('taskFunction', 'TaskList', pageText['Task manager'], 'TaskList', [], ['EditTask']));
  }
  if (can('group', 'read') && !flags.freeDrawOnly) {
    items.push(link('dataInputFunction', 'DataInput', pageText['Data import'], 'DataInput'));
    items.push(link('dataOutputFunction', 'DataOutput', pageText['Data Export'], 'DataOutput'));
  }

  if (can('data', 'read')) {
    if (!flags.freeDrawOnly)
      items.push(link('lockManageFunction', 'LockManagement', pageText['Batch unlock'], 'LockManagement'));
    const loginHistory = link(
      'opeartionLogFunction',
      'OperationLog',
      pageText['Login history'],
      'OperationLog',
      can('data', 'delete')
        ? [link('deleteOperationLogFunction', 'DeleteOperationLog', pageText['Log deletion'], 'DeleteOperationLog')]
        : [],
    );
    const definitionHistory = link(
      'definitionFormOperationLogFunction',
      'DefinitionFormOperationLog',
      pageText['Form operation history'],
      'DefinitionFormOperationLog',
      can('data', 'delete')
        ? [
            link(
              'deleteDefinitionFormOperationLogFunction',
              'DeleteDefinitionFormOperationLog',
              pageText['Log deletion'],
              'DeleteDefinitionFormOperationLog',
            ),
          ]
        : [],
    );
    const inputHistory = link(
      'inputReportOperationLogFunction',
      'InputReportOperationLog',
      pageText['Input document operation history'],
      'InputReportOperationLog',
      can('data', 'delete')
        ? [
            link(
              'deleteInputReportOperationLogFunction',
              'DeleteInputReportOperationLog',
              pageText['Log deletion'],
              'DeleteInputReportOperationLog',
            ),
          ]
        : [],
    );
    items.push({
      label: pageText['Operation log'],
      children: flags.freeDrawOnly ? [loginHistory] : [loginHistory, definitionHistory, inputHistory],
    });
    if (can('data', 'delete') && can('customTable', 'edit') && !flags.freeDrawOnly) {
      items.push(
        link(
          'customMasterMaintenanceFunction',
          'CustomMasterMaintenance',
          pageText['Custom master maintenance'],
          'CustomMasterMaintenance',
        ),
      );
    }
    if (!flags.freeDrawOnly)
      items.push({
        label: pageText['Voice recognition common dictionary'],
        children: [
          link('voiceCommonGrammarFunction', 'VoiceCommonGrammar', pageText['Common operation'], 'VoiceCommonGrammar'),
        ],
      });
    if (!flags.freeDrawOnly && (flags.backupLogEnabled || flags.backupImageEnabled)) {
      const children: SystemMenuEntry[] = [];
      if (flags.backupLogEnabled)
        children.push(link('backupLogFunction', 'BackupLog', pageText['Log'], 'BackupFile?type=0'));
      if (flags.backupImageEnabled)
        children.push(link('backupImageFunction', 'BackupImage', pageText['Image'], 'BackupFile?type=1'));
      items.push({ label: pageText['Backup file'], children });
    }
    if (flags.autoOutputEnabled && !flags.freeDrawOnly) {
      items.push(
        link(
          'autoOutputFileFunction',
          'AutoOutputFile',
          pageText['Automatic output file'],
          'AutoOutputFile?currentPath=',
        ),
      );
    }
  }

  if (can('system', 'read')) {
    if (flags.serverLogEnabled && !flags.freeDrawOnly) {
      items.push(link('serverLogFileFunction', 'ServerLogFile', pageText['Server log'], 'ServerLogFile?rootPath='));
    }
    const licenseChildren = flags.licenseUploadEnabled
      ? [link('uploadLicenseFunction', 'UploadLicense', pageText['Update'], 'UploadLicense')]
      : [];
    items.push(link('licenseFunction', 'DetailsLicense', pageText['License'], 'DetailsLicense', licenseChildren));
  }
  return items;
}
