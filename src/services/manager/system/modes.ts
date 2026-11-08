const systemModes = [
  'user',
  'group',
  'term',
  'mail',
  'upload',
  'com',
  'dataInput',
  'dataOutput',
  'task',
  'lockManage',
  'opeartionLog',
  'userAccountOpeartionLog',
  'license',
  'voiceCommonGrammar',
  'direct',
  'directLog',
  'userDirect',
  'webhook',
  'webhookLog',
  'googleCredentials',
  'box',
  'bim360',
  'irfd',
  'mbCloud',
  'mbCloudLog',
  'mailLog',
  'edgeOCR',
] as const;
export const systemIndexTargets: Record<string, string> = {
  user: 'UserList',
  group: 'GroupList',
  term: 'TermList',
  mail: 'MailList',
  upload: 'UploadList',
  com: 'ComList',
  dataInput: 'DataInput',
  dataOutput: 'DataOutput',
  task: 'TaskList',
  lockManage: 'LockManagement',
  operationLog: 'OperationLog',
  userAccountOperationLog: 'UserAccountOperationLog',
  license: 'DetailsLicense',
  voiceCommonGrammar: 'VoiceCommonGrammar',
  direct: 'DirectChat',
  directLog: 'DirectSendLog',
  userDirect: 'UserDirectList',
  webhook: 'WebhookList',
  webhookLog: 'WebhookSendLog',
  googleCredentials: 'GoogleCredentialSetting',
  box: 'BoxCredentialSetting',
  bim360: 'Bim360CredentialSetting',
  irfd: 'IrfdTemplateList',
  mbCloud: 'MbCloudSetting',
  mbCloudLog: 'MbCloudSendLog',
  mailLog: 'MailSendLog',
  edgeOCR: 'EdgeOCRCredentialSetting',
};

export function normalizeSystemMode(value: unknown): string {
  const raw = typeof value === 'string' ? value : '';
  const mode = /^\d+$/.test(raw) ? (systemModes[Number(raw)] ?? '') : raw;
  return mode === 'opeartionLog'
    ? 'operationLog'
    : mode === 'userAccountOpeartionLog'
      ? 'userAccountOperationLog'
      : mode;
}
