import { text as pageText } from '../../../config/manager/system/resources.js';
import type { Express, Request, Response } from 'express';
import type pg from 'pg';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { randomBytes } from 'node:crypto';
import nodemailer from 'nodemailer';
import { hasSystemPermission } from '../../../middleware/manager/system/permissions.js';
import { licenseStatus } from '../../../shared/license-counts.js';

export type MailXml = Record<string, unknown> & {
  smtp?: Record<string, string>;
  notification?: Record<string, string>;
  oauth?: MailXml;
  send?: Record<string, MailXml>;
  form?: MailXml;
  formQuery?: string | Record<string, unknown>;
  legend?: MailXml;
  error?: { message?: unknown };
};
type Xml = MailXml;
type MailSession = {
  userId?: string;
  userName?: string;
  localSessonKey?: string;
  mailNotice?: string;
  mailOAuthError?: string;
  mailOAuthGoogleState?: string;
  mailOAuthMicrosoftState?: string;
};
export const mailLicensePrerequisite = 'Role authority is insufficient.';
export type MailDocument = { mail: Xml };

const root = '/ConMasManager/System';
const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: false,
  isArray: (name) => ['template', 'name', 'subject', 'body', 'address', 'param'].includes(name),
});
const builder = new XMLBuilder({ ignoreAttributes: false, format: true });
export const mailTypes = [
  'Apply',
  'Remand',
  'Approve',
  'Edit',
  'Complete',
  'Change',
  'Terminal',
  'TerminalApprove',
  'DefApply',
  'DefRemand',
  'DefApprove',
];
export const notificationFields = [
  'apply',
  'remand',
  'approve',
  'edit',
  'complete',
  'change',
  'terminal',
  'terminal_approve',
  'def_apply',
  'def_remand',
  'def_approve',
];
export const mailFields = [
  ['ManagerRoot', 'ManagerRoot'],
  ['server', 'Server'],
  ['port', 'Port No.'],
  ['user', 'User'],
  ['OAuthProvider', 'Provider'],
  ['OAuthClientId', 'Client ID'],
  ['OAuthClientSecret', 'Client secret'],
  ['OAuthTenantId', 'Tenant ID'],
];

const en = {
  basicTitle: 'Basic Setting',
  mailTitle: 'Basic Setting',
  editMailTitle: 'Edit e-mail basic setting',
  edit: 'Edit',
  add: 'Add',
  cancel: 'Cancel',
  fix: 'Registration',
  default: 'Default',
  priority: 'Priority',
  listTemplateName: 'Name of template',
  listSubject: 'Title',
  listDefault: 'Default',
  listPriority: 'Priority',
  listToNotify: 'Notification',
  listNotNotify: 'Without notification',
  listToUse: 'Use',
  listNotUse: 'Do not use',
  user: 'User',
  pass: 'Password',
  newPassword: 'New PW',
  confirmPassword: 'New PW for confirmation',
  templateName: 'Name of template',
  subject: 'Title',
  body: 'Text',
  templateFieldName: 'Name of template',
  templateFieldSubject: 'Title',
  templateFieldBody: 'Text',
  server: 'Server',
  port: 'Port No.',
  provider: 'Provider',
  clientId: 'Client ID',
  clientSecret: 'Client secret',
  tenantId: 'Tenant ID',
  status: 'Status',
  authenticated: 'Authenticated',
  unauthenticated: 'Unauthenticated',
  ssl: 'SSL',
  smtpAuthentication: 'SMTP authentication',
  signature: 'Signature',
  toNotify: 'Notification',
  notNotify: 'Without notification',
  toUse: 'Use',
  notUse: 'Do not use',
  toUseSSL: 'Without SSL',
  notUseSSL: 'With SSL',
  testMailAddress: 'E-mail address for Test sending',
  testMailAddressRequired: 'Please enter the e-mail address for Test sending',
  testSend: 'Test e-mail sending',
  createTestSend: 'Test e-mail sending',
  editTestSend: 'Test e-mail sending',
  defaultTemp: 'Default template',
  defaultTempNote: 'In case e-mail template has not been set for each cluster, use this template.',
  editDefaultTempNote: 'In case e-mail template has not been set for each cluster, use this template.',
  replaceList: 'List of data permutation',
  replaceCode: 'Code',
  replaceName: 'Description',
  send: 'Destination address',
  createSend: 'Destination address',
  editSend: 'Destination address',
  detailsSend: 'Destination address',
  detailsTemplate: 'Details of template',
  createTemplate: 'Register template',
  editTemplate: 'Edit template',
  delete: 'Delete',
  deleteMailMessage: 'Delete the e-mail template. Are you sure you want to delete it?',
  roleError: 'Role authority is insufficient.',
  serverError: 'Server error has been occurred.',
  required: 'Please enter {0}.',
  integer: '{0} should be an integer value.',
  invalidPort: 'Cannot use 465',
  passwordMismatch: 'New PW and PW for confirmation are unmatched.',
  spellMiss: '{0} does not exist.',
  testSendFailed: 'Failed to send a test e-mail.',
  oauthFailed: 'OAuth authorization processing failed',
  updateSuccess: 'E-mail setting update has been completed.',
  deleteSuccess: 'E-mail setting has been deleted.',
  invalidMailType: 'Invalid notification type.',
  templateNotFound: 'Template not found.',
  notification_apply: 'Application',
  notification_remand: 'Rejection',
  notification_approve: 'Approval',
  notification_edit: 'Save in editing',
  notification_complete: 'Completion',
  notification_change: 'Change',
  notification_terminal: 'Device application',
  notification_terminal_approve: 'Device approval',
  notification_def_apply: 'Form application',
  notification_def_remand: 'Form rejection',
  notification_def_approve: 'Form approval',
  groupApply: 'Template for Apply Notification',
  groupRemand: 'Template for Reject Notification',
  groupApprove: 'Template for Approval Notification',
  groupEdit: 'Template for notification of saving in editing',
  groupComplete: 'Template for Completion Notification',
  groupChange: 'Template for Change Notification',
  groupTerminal: 'Template for notification of device registration',
  groupTerminalApprove: 'Device unverified notification template setting',
  groupDefApply: 'Template for notification of applying form',
  groupDefRemand: 'Template for notification of rejecting form',
  groupDefApprove: 'Template for notification of approving form',
  legend_user_id: 'User ID',
  legend_user_name: 'User name',
  legend_url: 'URL',
  legend_applicant: 'Applicant ID',
  legend_applicant_name: 'Applicant name',
  legend_applicant_time: 'Application date',
  legend_applicant_comment: 'Comment for apply',
  legend_terminal_id: 'Device ID',
  legend_terminal_physical_id: 'Device ID',
  legend_terminal_name: 'Device name',
  legend_def_top_id: 'Form ID',
  legend_def_top_name: 'Form name',
  legend_def_applicant: 'Applicant ID of form',
  legend_def_applicant_name: 'Name of applicant',
  legend_def_applicant_date: 'Date of applying form',
  legend_def_applicant_comment: 'Applying comment',
  legend_def_approver: 'Approver ID',
  legend_def_approver_name: 'Name of approver',
  legend_def_approver_date: 'Date of approval',
  legend_def_approver_comment: 'Approving comment',
  legend_sys_update_time: 'Last update date and time',
  legend_def_url: 'URL',
  legend_rep_url: 'URL',
  legend_rep_create_role: 'User having authority of issuing',
  legend_login_user: 'Log-in user',
  sendType_direct: 'Direct input',
  sendType_applicant: 'Apply',
  sendType_login_user: 'Log-in user',
  sendType_def_applicant: 'Applicant of form',
  sendType_def_approver: 'Approver of form',
  sendType_def_update_role: 'User having authority of editing form',
  sendType_rep_create_role: 'User having authority of issuing',
  legend_top_remarks1: 'Remarks information 1',
  legend_top_remarks2: 'Remarks information 2',
  legend_top_remarks3: 'Remarks information 3',
  legend_top_remarks4: 'Remarks information 4',
  legend_top_remarks5: 'Remarks information 5',
  legend_top_remarks6: 'Remarks information 6',
  legend_top_remarks7: 'Remarks information 7',
  legend_top_remarks8: 'Remarks information 8',
  legend_top_remarks9: 'Remarks information 9',
  legend_top_remarks10: 'Remarks information 10',
};

const localizedLabels: Record<string, Partial<typeof en>> = {
  ja: {
    basicTitle: 'メール基本設定',
    mailTitle: 'メール基本設定',
    editMailTitle: 'メール基本設定編集',
    edit: '編集',
    add: '追加',
    cancel: 'キャンセル',
    fix: '登録',
    default: 'デフォルト',
    priority: '優先度',
    listTemplateName: 'テンプレート名',
    listSubject: '件名',
    listDefault: 'デフォルト',
    listPriority: '優先度',
    listToNotify: '通知する',
    listNotNotify: '通知しない',
    listToUse: '使用する',
    listNotUse: '使用しない',
    templateName: 'テンプレート名称',
    subject: '件名',
    body: '本文',
    server: 'サーバー',
    port: 'ポート番号',
    user: 'ユーザー',
    templateFieldName: 'テンプレート名称',
    templateFieldSubject: '件名',
    templateFieldBody: '本文',
    pass: 'パスワード',
    newPassword: '新しいパスワード',
    confirmPassword: '新しいパスワードの確認入力',
    provider: 'プロバイダー',
    clientId: 'クライアントID',
    clientSecret: 'クライアントシークレット',
    tenantId: 'テナントID',
    status: 'ステータス',
    authenticated: '認証済み',
    unauthenticated: '未認証',
    ssl: 'SSL',
    smtpAuthentication: 'SMTP認証',
    signature: '署名',
    toNotify: '通知する',
    notNotify: '通知しない',
    toUse: '使用する',
    notUse: '使用しない',
    toUseSSL: 'SSLを使用する',
    notUseSSL: 'SSLを使用しない',
    testMailAddress: 'テスト送信先メールアドレス',
    testMailAddressRequired: 'テスト送信先メールアドレスを入力してください。',
    testSend: 'テスト送信',
    createTestSend: 'テスト送信',
    editTestSend: 'テスト送信',
    defaultTemp: 'デフォルトテンプレート',
    defaultTempNote: '各クラスターのメールテンプレートが未設定の場合、このテンプレートを使用する',
    editDefaultTempNote: '各クラスターのメールテンプレートが未設定の場合、このテンプレートを使用する',
    replaceList: 'データ置き換え一覧',
    replaceCode: 'コード',
    replaceName: '内容',
    send: '送信先',
    createSend: '送信先',
    editSend: '送信先',
    detailsSend: '送信先',
    detailsTemplate: 'テンプレート詳細',
    createTemplate: 'テンプレート登録',
    editTemplate: 'テンプレート編集',
    delete: '削除',
    deleteMailMessage: 'メールテンプレートを削除します。よろしいですか？',
    roleError: '権限が不足しています。',
    serverError: 'サーバーエラーが発生しました。',
    required: '{0}を入力してください。',
    integer: '{0}は整数で入力してください。',
    invalidPort: '465は使用できません',
    passwordMismatch: '新しいパスワードと確認用パスワードが一致しません。',
    spellMiss: '{0}は存在しません。',
    testSendFailed: 'テストメール送信が失敗しました。',
    oauthFailed: 'OAuth認可処理に失敗しました。',
    updateSuccess: 'メール設定を更新しました。',
    deleteSuccess: 'メール設定を削除しました。',
    invalidMailType: '通知種別が無効です。',
    templateNotFound: 'テンプレートが見つかりません。',
    notification_apply: '申請通知',
    notification_remand: '差戻通知',
    notification_approve: '承認通知',
    notification_edit: '編集保存通知',
    notification_complete: '完了通知',
    notification_change: '変更通知',
    notification_terminal: '端末申請通知',
    notification_terminal_approve: '端末承認通知',
    notification_def_apply: '定義申請通知',
    notification_def_remand: '定義差戻通知',
    notification_def_approve: '定義承認通知',
    groupApply: '申請通知テンプレート設定',
    groupRemand: '差戻通知テンプレート設定',
    groupApprove: '承認通知テンプレート設定',
    groupEdit: '編集保存通知テンプレート設定',
    groupComplete: '完了通知テンプレート設定',
    groupChange: '変更通知テンプレート設定',
    groupTerminal: '端末申請通知テンプレート設定',
    groupTerminalApprove: '端末承認通知テンプレート設定',
    groupDefApply: '定義申請通知テンプレート設定',
    groupDefRemand: '定義差戻通知テンプレート設定',
    groupDefApprove: '定義承認通知テンプレート設定',
    legend_user_id: 'ユーザーID',
    legend_user_name: 'ユーザー名称',
    legend_url: 'URL',
    legend_applicant: '申請者ID',
    legend_applicant_name: '申請者名称',
    legend_applicant_time: '申請日',
    legend_applicant_comment: '申請コメント',
    legend_terminal_id: '端末ID',
    legend_terminal_physical_id: '端末物理ID',
    legend_terminal_name: '端末名称',
    legend_def_top_id: '定義ID',
    legend_def_top_name: '定義名称',
    legend_def_applicant: '定義申請者ID',
    legend_def_applicant_name: '定義申請者名',
    legend_def_applicant_date: '定義申請日時',
    legend_def_applicant_comment: '定義申請コメント',
    legend_def_approver: '定義承認者ID',
    legend_def_approver_name: '定義承認者名',
    legend_def_approver_date: '定義承認日時',
    legend_def_approver_comment: '定義承認コメント',
    legend_sys_update_time: '更新日時',
    legend_def_url: 'URL',
    legend_rep_url: 'URL',
    legend_rep_create_role: '起票権限保有者',
    legend_login_user: 'ログインユーザー',
    sendType_direct: '直接入力',
    sendType_applicant: '申請',
    sendType_login_user: 'ログインユーザー',
    sendType_def_applicant: '定義申請者',
    sendType_def_approver: '定義承認者',
    sendType_def_update_role: '定義編集権限保有者',
    sendType_rep_create_role: '起票権限保有者',
    legend_top_remarks1: '備考情報1',
    legend_top_remarks2: '備考情報2',
    legend_top_remarks3: '備考情報3',
    legend_top_remarks4: '備考情報4',
    legend_top_remarks5: '備考情報5',
    legend_top_remarks6: '備考情報6',
    legend_top_remarks7: '備考情報7',
    legend_top_remarks8: '備考情報8',
    legend_top_remarks9: '備考情報9',
    legend_top_remarks10: '備考情報10',
  },
  'zh-CN': {
    basicTitle: '邮件基本设定',
    mailTitle: '邮件基本设定',
    editMailTitle: '编辑邮件基本设定',
    edit: '编辑',
    add: '追加',
    cancel: '取消',
    fix: '登录',
    default: '默认',
    priority: '优先度',
    listTemplateName: '模板名称',
    listSubject: '件名',
    listDefault: '默认',
    listPriority: '优先度',
    listToNotify: '通知',
    listNotNotify: '不通知',
    listToUse: '使用',
    listNotUse: '不使用',
    templateName: '模板名称',
    subject: '件名',
    body: '本文',
    server: '服务器',
    port: '端口号码',
    user: '用户',
    templateFieldName: '模板名称',
    templateFieldSubject: '件名',
    templateFieldBody: '本文',
    pass: '密码',
    newPassword: '新密码',
    confirmPassword: '确认密码',
    provider: '提供商',
    clientId: '客户端ID',
    clientSecret: '客户端密钥',
    tenantId: '租户ID',
    status: '状态',
    authenticated: '已认证',
    unauthenticated: '未认证',
    ssl: 'SSL',
    smtpAuthentication: 'SMTP认证',
    signature: '签名',
    toNotify: '通知',
    notNotify: '不通知',
    toUse: '使用',
    notUse: '不使用',
    toUseSSL: '使用SSL',
    notUseSSL: '不使用SSL',
    testMailAddress: '测试邮件地址',
    testMailAddressRequired: '请输入测试邮件地址',
    testSend: '测试发送',
    createTestSend: '测试送信 ',
    editTestSend: '测试发送邮件',
    defaultTemp: '默认模板',
    defaultTempNote: '各功能区的邮件模板未设定的情况下，使用这模板。',
    editDefaultTempNote: '各功能区的邮件模板未设定的情况下，使用该模板。',
    replaceList: '数据替换一览',
    replaceCode: '编码',
    replaceName: '内容',
    send: '发送地址',
    createSend: '发送地址',
    editSend: '邮件地址',
    detailsSend: '送信地址',
    detailsTemplate: '详细模板',
    createTemplate: '模板登录',
    editTemplate: '编辑模板',
    delete: '删除',
    deleteMailMessage: '确实要删除邮件模板吗？',
    roleError: '权限不足',
    serverError: '服务器发生了错误。',
    required: '请输入{0}。',
    integer: '{0}应为整数。',
    invalidPort: '不能使用465',
    passwordMismatch: '新密码和确认密码不一致。',
    spellMiss: '不存在{0}。',
    testSendFailed: '测试邮件发送失败。',
    oauthFailed: 'OAuth认证处理失败。',
    updateSuccess: '电子邮件设定已更新。',
    deleteSuccess: '已删除电子邮件设定。',
    invalidMailType: '通知类型无效。',
    templateNotFound: '未找到模板。',
    notification_apply: '申请通知',
    notification_remand: '退回通知',
    notification_approve: '审核通知',
    notification_edit: '编辑保存通知',
    notification_complete: '完成通知',
    notification_change: '变更通知',
    notification_terminal: '终端申请通知',
    notification_terminal_approve: '终端审核通知',
    notification_def_apply: '定义申请通知',
    notification_def_remand: '定义退回通知',
    notification_def_approve: '定义审核通知',
    groupApply: '申请通知模板设定',
    groupRemand: '退回通知模板设定',
    groupApprove: '审核通知模板设定',
    groupEdit: '编辑保存通知模板设定',
    groupComplete: '完成通知模板设定',
    groupChange: '变更通知模板设定',
    groupTerminal: '终端申请通知模板设置',
    groupTerminalApprove: '终端审核通知模板设置',
    groupDefApply: '定义申请通知模板设置',
    groupDefRemand: '定义退回通知模板设置',
    groupDefApprove: '定义审核通知模板设置',
    legend_user_id: '用户编码',
    legend_user_name: '用户名称',
    legend_url: 'URL',
    legend_applicant: '申请者编码',
    legend_applicant_name: '申请者名称',
    legend_applicant_time: '申请日',
    legend_applicant_comment: '申请备注',
    legend_terminal_id: '终端编码',
    legend_terminal_physical_id: '终端物理编码',
    legend_terminal_name: '终端名称',
    legend_def_top_id: '定义编码',
    legend_def_top_name: '定义名称',
    legend_def_applicant: '定义申请者ID',
    legend_def_applicant_name: '定义申请者名称',
    legend_def_applicant_date: '定义申请日期',
    legend_def_applicant_comment: '定义申请批注',
    legend_def_approver: '定义审核者ID',
    legend_def_approver_name: '定义审核者名称',
    legend_def_approver_date: '定义审核日期',
    legend_def_approver_comment: '定义审核批注',
    legend_sys_update_time: '更新时间',
    legend_def_url: 'URL',
    legend_rep_url: 'URL',
    legend_rep_create_role: '持有起票权限者',
    legend_login_user: '登录用户',
    sendType_direct: '直接输入',
    sendType_applicant: '申请',
    sendType_login_user: '登录用户',
    sendType_def_applicant: '定义申请者',
    sendType_def_approver: '定义审核者',
    sendType_def_update_role: '持有定义编辑权限者',
    sendType_rep_create_role: '持有起票权限者',
    legend_top_remarks1: '备注信息1',
    legend_top_remarks2: '备注信息2',
    legend_top_remarks3: '备注信息3',
    legend_top_remarks4: '备注信息4',
    legend_top_remarks5: '备注信息5',
    legend_top_remarks6: '备注信息6',
    legend_top_remarks7: '备注信息7',
    legend_top_remarks8: '备注信息8',
    legend_top_remarks9: '备注信息9',
    legend_top_remarks10: '备注信息10',
  },
  'zh-TW': {
    basicTitle: '郵件基本設定',
    mailTitle: '郵件基本設定',
    editMailTitle: '編輯郵件基本設定',
    edit: '編輯',
    add: '追加',
    cancel: '取消',
    fix: '登錄',
    default: '預設',
    priority: '優先度',
    listTemplateName: '範本名稱',
    listSubject: '件名',
    listDefault: '默認',
    listPriority: '優先度',
    listToNotify: '通知',
    listNotNotify: '不通知',
    listToUse: '使用',
    listNotUse: '不使用',
    templateName: '範本名稱',
    subject: '件名',
    body: '本文',
    server: '伺服器',
    port: '埠號碼',
    user: '用戶',
    pass: '密碼',
    newPassword: '新密碼',
    confirmPassword: '確認密碼',
    provider: '提供者',
    clientId: '用戶端ID',
    templateFieldName: '範本名稱',
    templateFieldSubject: '件名',
    templateFieldBody: '本文',
    clientSecret: '終端密鑰',
    tenantId: '租戶ID',
    status: '狀態',
    authenticated: '已認證',
    unauthenticated: '未認證',
    ssl: 'SSL',
    smtpAuthentication: 'SMTP驗證',
    signature: '簽名',
    toNotify: '通知',
    notNotify: '不通知',
    toUse: '使用',
    notUse: '不使用',
    toUseSSL: '使用SSL',
    notUseSSL: '不使用SSL',
    testMailAddress: '測試郵件地址',
    testMailAddressRequired: '請輸入測試郵件地址',
    testSend: '測試發送',
    createTestSend: '測試發送',
    editTestSend: '測試發送',
    defaultTemp: '預設範本',
    defaultTempNote: '各功能區的郵件範本未設定的情況下，使用該範本。',
    editDefaultTempNote: '各功能區的郵件範本未設定的情況下，使用該範本。',
    replaceList: '資料替換一覽',
    replaceCode: '編碼',
    replaceName: '內容',
    send: '發送地址',
    createSend: '發送地址',
    editSend: '發送地址',
    detailsSend: '發送地址',
    detailsTemplate: '範本詳細内容',
    createTemplate: '範本登錄',
    editTemplate: '編輯範本',
    delete: '刪除',
    deleteMailMessage: '確定要刪除郵件範本嗎？',
    roleError: '權限不足',
    serverError: '伺服器發生了錯誤。',
    required: '請輸入{0}。',
    integer: '{0}應為整數。',
    invalidPort: '不能使用465',
    passwordMismatch: '新密碼與確認密碼不一致。',
    spellMiss: '{0}不存在。',
    testSendFailed: '測試郵件發送失敗。',
    oauthFailed: 'OAuth認證處理失敗。',
    updateSuccess: '已更新郵件設定。',
    deleteSuccess: '已刪除郵件設定。',
    invalidMailType: '通知類型無效。',
    templateNotFound: '找不到範本。',
    notification_apply: '申請通知',
    notification_remand: '退回通知',
    notification_approve: '核准通知',
    notification_edit: '編輯保存通知',
    notification_complete: '完成通知',
    notification_change: '變更通知',
    notification_terminal: '裝置申請通知',
    notification_terminal_approve: '裝置核准通知',
    notification_def_apply: '定義申請通知',
    notification_def_remand: '定義退回通知',
    notification_def_approve: '定義核准通知',
    groupApply: '申請通知範本設定',
    groupRemand: '退回通知範本設定',
    groupApprove: '核准通知範本設定',
    groupEdit: '編輯保存通知範本設定',
    groupComplete: '完成通知範本設定',
    groupChange: '變更通知範本設定',
    groupTerminal: '裝置申請通知範本設置',
    groupTerminalApprove: '裝置核准通知範本設定',
    groupDefApply: '定義申請通知範本設置',
    groupDefRemand: '定義退回通知範本設置',
    groupDefApprove: '定義核准通知範本設置',
    legend_user_id: '用戶編碼',
    legend_user_name: '用戶名稱',
    legend_url: 'URL',
    legend_applicant: '申請者編碼',
    legend_applicant_name: '申請者名稱',
    legend_applicant_time: '申請日',
    legend_applicant_comment: '申請備註',
    legend_terminal_id: '裝置編碼',
    legend_terminal_physical_id: '裝置ID',
    legend_terminal_name: '裝置名稱',
    legend_def_top_id: '定義編碼',
    legend_def_top_name: '定義名稱',
    legend_def_applicant: '定義申請者編碼',
    legend_def_applicant_name: '定義申請者名稱',
    legend_def_applicant_date: '定義申請日期',
    legend_def_applicant_comment: '定義申請備注',
    legend_def_approver: '定義核准者編碼',
    legend_def_approver_name: '定義核准者名稱',
    legend_def_approver_date: '定義核准日期',
    legend_def_approver_comment: '定義核准備注',
    legend_sys_update_time: '更新時間',
    legend_def_url: 'URL',
    legend_rep_url: 'URL',
    legend_rep_create_role: '擁有製作報表權限者',
    legend_login_user: '登錄用戶',
    sendType_direct: '直接輸入',
    sendType_applicant: '申請',
    sendType_login_user: '登錄用戶',
    sendType_def_applicant: '定義申請者',
    sendType_def_approver: '定義核准者',
    sendType_def_update_role: '定義編輯權限擁有者',
    sendType_rep_create_role: '擁有製作報表權限者',
    legend_top_remarks1: '備註資訊1',
    legend_top_remarks2: '備註資訊2',
    legend_top_remarks3: '備註資訊3',
    legend_top_remarks4: '備註資訊4',
    legend_top_remarks5: '備註資訊5',
    legend_top_remarks6: '備註資訊6',
    legend_top_remarks7: '備註資訊7',
    legend_top_remarks8: '備註資訊8',
    legend_top_remarks9: '備註資訊9',
    legend_top_remarks10: '備註資訊10',
  },
};

export type MailLabels = typeof en;
export function mailStrings(locale: string): MailLabels {
  const language = locale === 'ja-JP' ? 'ja' : locale;
  return { ...en, ...(localizedLabels[language] ?? {}) };
}

export function parseMailXml(source: string): MailDocument {
  const document = parser.parse(source) as MailDocument;
  if (!document.mail || typeof document.mail !== 'object')
    throw new Error(pageText['Mail XML has an invalid structure.']);
  return document;
}

export function serializeMailXml(document: MailDocument): string {
  return builder.build(document);
}

const entries = (value: unknown): Xml[] =>
  Array.isArray(value) ? value : value && typeof value === 'object' ? [value as Xml] : [];
const text = (body: Record<string, unknown>, key: string): string => {
  const value = body[key];
  if (Array.isArray(value)) return value.some((item) => String(item) === 'true') ? 'true' : String(value.at(-1) ?? '');
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
};
const checked = (body: Record<string, unknown>, key: string): boolean => text(body, key) === 'true';
const localized = (values: unknown, locale: string): string => {
  const rows = entries(values);
  const row = rows.find((item) => item['@_locale'] === locale) ?? rows[0];
  return String(row?.['#text'] ?? '');
};

export function currentMailLocale(db: pg.Pool, req: Request): Promise<string> {
  return db
    .query<{ com_value: string }>('SELECT com_value FROM mst_common WHERE com_key = $1 ORDER BY com_index', ['LOCALE'])
    .then((result) => {
      const supported = result.rows
        .map((row) => row.com_value)
        .filter((value): value is string => typeof value === 'string' && value !== '');
      const session = (req as Request & { session?: MailSession }).session;
      if (session?.localSessonKey && (!supported.length || supported.includes(session.localSessonKey)))
        return session.localSessonKey;
      const accepted = req.acceptsLanguages();
      const languages = Array.isArray(accepted) ? accepted : accepted ? [accepted] : [];
      const locale =
        languages
          .map(
            (language) =>
              supported.find((item) => item.toLowerCase() === language.toLowerCase()) ??
              supported.find((item) => item.toLowerCase().startsWith(`${language.toLowerCase()}-`)),
          )
          .find(Boolean) ?? (supported.includes('en-US') ? 'en-US' : (supported[0] ?? 'en-US'));
      if (session) session.localSessonKey = locale;
      return locale;
    });
}

export function templateModel(node: Xml, defaultId: string, locale = 'en-US'): Xml {
  const addresses = (field: string) =>
    entries(node.send?.[field]?.address).map((item) => ({ type: item['@_type'], value: item['#text'] ?? '' }));
  return {
    id: node['@_id'],
    name: localized(node.name, locale),
    subject: localized(node.form?.subject, locale),
    body: localized(node.form?.body, locale),
    priority: node['@_priority'] ?? 'Normal',
    defaultTemp: node['@_id'] === defaultId,
    tos: addresses('to'),
    ccs: addresses('cc'),
    bccs: addresses('bcc'),
  };
}

export function mailModel(document: MailDocument): Record<string, string | boolean> {
  const mail = document.mail;
  const oauth = mail.oauth as Xml | undefined;
  const smtp = mail.smtp as Xml | undefined;
  const model: Record<string, string | boolean> = {
    ManagerRoot: String(mail.managerRoot ?? ''),
    server: String(smtp?.server ?? ''),
    port: String(smtp?.port ?? ''),
    user: String(smtp?.user ?? ''),
    pass: String(smtp?.pass ?? ''),
    ssl: smtp?.ssl === 'true',
    signature: String(mail.signature ?? ''),
    UseOAuth: Boolean(oauth),
    OAuthProvider: String(oauth?.provider ?? 'google'),
    OAuthClientId: String(oauth?.clientId ?? ''),
    OAuthClientSecret: String(oauth?.clientSecret ?? ''),
    OAuthTenantId: String(oauth?.tenantId ?? ''),
    OAuthUser: String(oauth?.user ?? ''),
    IsOAuthAuthenticated: Boolean(oauth?.user),
  };
  for (const name of notificationFields)
    model[`notification_${name}`] = mail.notification?.[name.replaceAll('_', '')] === 'true';
  return model;
}

function mailValidation(body: Record<string, unknown>, labels: MailLabels) {
  const fieldErrors: Record<string, string> = {};
  const required = (key: string, label: string) => {
    if (!text(body, key)) fieldErrors[key] = labels.required.replace('{0}', label);
  };
  if (checked(body, 'mailBase.UseOAuth')) {
    required('mailBase.OAuthClientId', labels.clientId);
    required('mailBase.OAuthClientSecret', 'クライアントシークレット');
    if (text(body, 'mailBase.OAuthProvider') === 'microsoft') required('mailBase.OAuthTenantId', 'テナントID');
  } else {
    required('mailBase.server', labels.server);
    const port = text(body, 'mailBase.port');
    if (!port) required('mailBase.port', labels.port);
    else if (
      !/^[+-]?\d+$/.test(port.trim()) ||
      !Number.isSafeInteger(Number(port)) ||
      Number(port) < -2147483648 ||
      Number(port) > 2147483647
    ) {
      fieldErrors['mailBase.port'] = labels.integer.replace('{0}', labels.port);
    } else if (Number(port) === 465) fieldErrors['mailBase.port'] = labels.invalidPort;
    required('mailBase.user', labels.user);
    if (
      (text(body, 'new_pass') || text(body, 'confirm_pass')) &&
      text(body, 'new_pass') !== text(body, 'confirm_pass')
    ) {
      fieldErrors.confirm_pass = labels.passwordMismatch;
    }
  }
  return fieldErrors;
}

export function validateMail(body: Record<string, unknown>): string {
  return Object.values(mailValidation(body, mailStrings('en-US')))[0] ?? '';
}

export function updateMail(document: MailDocument, body: Record<string, unknown>): MailDocument {
  const mail = document.mail;
  mail.smtp ??= {};
  mail.notification ??= {};
  mail.managerRoot = text(body, 'mailBase.ManagerRoot');
  for (const field of ['server', 'port', 'user']) mail.smtp[field] = text(body, `mailBase.${field}`);
  if (text(body, 'new_pass')) mail.smtp.pass = text(body, 'new_pass');
  mail.smtp.ssl = checked(body, 'mailBase.ssl') ? 'true' : 'false';
  delete mail.oauth;
  if (checked(body, 'mailBase.UseOAuth')) {
    mail.oauth = {
      provider: text(body, 'mailBase.OAuthProvider'),
      clientId: text(body, 'mailBase.OAuthClientId'),
      clientSecret: text(body, 'mailBase.OAuthClientSecret'),
    };
    if (text(body, 'mailBase.OAuthProvider') === 'microsoft')
      mail.oauth.tenantId = text(body, 'mailBase.OAuthTenantId');
  }
  mail.signature = text(body, 'mailBase.signature');
  for (const name of notificationFields)
    mail.notification[name.replaceAll('_', '')] = checked(body, `mailBase.notification_${name}`) ? 'true' : 'false';
  return document;
}

function session(req: Request): MailSession | undefined {
  return (req as Request & { session?: MailSession }).session;
}

async function mailDocument(db: pg.Pool, file = 'Mail.xml'): Promise<MailDocument> {
  const row = (await db.query<{ xml_data: string }>('SELECT xml_data FROM mst_mail WHERE mail_file_name = $1', [file]))
    .rows[0];
  if (!row?.xml_data) throw new Error(`${file} is missing from mst_mail.`);
  return parseMailXml(row.xml_data);
}

async function saveMailDocument(db: pg.Pool, document: MailDocument, userId: string, term: string): Promise<void> {
  await db.query(
    'UPDATE mst_mail SET xml_data = $1, sys_update_user = $2, sys_update_term = $3, sys_update_time = now() WHERE mail_file_name = $4',
    [serializeMailXml(document), userId, term, 'Mail.xml'],
  );
}

function formatLocalDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function errorChain(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      if (current.message) messages.push(current.message);
      current = current.cause;
    } else {
      messages.push(String(current));
      break;
    }
  }
  return messages.join(' ==> ');
}

async function oauthAccessToken(db: pg.Pool, document: MailDocument, userId: string, term: string): Promise<string> {
  const oauth = document.mail.oauth as Xml | undefined;
  const token = oauth?.token as Xml | undefined;
  const failure = 'アクセストークンの取得に失敗しました。メール通知設定でOAuthの登録をしてください。';
  if (!oauth || !token?.refreshToken) throw new Error(failure);
  const expiresAt = Date.parse(String(token.expiresOn ?? ''));
  if (typeof token.accessToken === 'string' && Number.isFinite(expiresAt) && expiresAt > Date.now() + 5 * 60_000)
    return token.accessToken;
  const provider = String(oauth.provider ?? '');
  const tenant = encodeURIComponent(String(oauth.tenantId ?? ''));
  const endpoint =
    provider === 'google'
      ? 'https://oauth2.googleapis.com/token'
      : `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
  let refreshed: Xml;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      body: new URLSearchParams({
        client_id: String(oauth.clientId ?? ''),
        client_secret: String(oauth.clientSecret ?? ''),
        refresh_token: String(token.refreshToken),
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(30_000),
    });
    refreshed = (await response.json()) as Xml;
    if (!response.ok || typeof refreshed.access_token !== 'string' || !Number.isFinite(Number(refreshed.expires_in))) {
      throw new Error(errorChain(refreshed.error_description ?? refreshed.error ?? response.statusText));
    }
  } catch (error) {
    delete oauth.token;
    delete oauth.user;
    await saveMailDocument(db, document, userId, term);
    throw new Error(failure, { cause: error });
  }
  token.accessToken = refreshed.access_token;
  token.expiresOn = formatLocalDate(new Date(Date.now() + Number(refreshed.expires_in) * 1000));
  if (typeof refreshed.refresh_token === 'string') token.refreshToken = refreshed.refresh_token;
  await saveMailDocument(db, document, userId, term);
  return token.accessToken as string;
}

async function mimeMessage(from: string, to: string, subject: string, body: string, priority: string): Promise<string> {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  try {
    const result = await transport.sendMail({
      from,
      to,
      subject,
      text: body,
      priority: priority.toLowerCase() as 'high' | 'normal' | 'low',
    });
    if (Buffer.isBuffer(result.message)) return result.message.toString('base64url');
    const chunks: Uint8Array[] = [];
    for await (const chunk of result.message) chunks.push(chunk);
    return Buffer.concat(chunks).toString('base64url');
  } finally {
    transport.close();
  }
}

export async function sendSystemMail(
  db: pg.Pool,
  document: MailDocument,
  message: { subject: string; body: string; priority: string; to: string[] },
  userId: string,
  term: string,
): Promise<void> {
  const mail = document.mail;
  const subject = message.subject.replace(/[\r\n]/g, ' ');
  if (!mail.oauth) {
    const smtp = mail.smtp as NonNullable<MailXml['smtp']>;
    const transport = nodemailer.createTransport({
      host: smtp.server,
      port: Number(smtp.port),
      secure: false,
      requireTLS: smtp.ssl === 'true',
      auth: { user: smtp.user, pass: smtp.pass },
      connectionTimeout: 30_000,
    });
    try {
      await transport.sendMail({
        from: smtp.user,
        to: message.to,
        subject,
        text: message.body,
        priority: message.priority.toLowerCase() as 'high' | 'normal' | 'low',
      });
    } finally {
      transport.close();
    }
    return;
  }
  const provider = String(mail.oauth.provider ?? '');
  const accessToken = await oauthAccessToken(db, document, userId, term);
  if (provider === 'google') {
    const raw = await mimeMessage(
      String(mail.oauth.user ?? ''),
      message.to.join(','),
      subject,
      message.body,
      message.priority,
    );
    const response = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(String(mail.oauth.user ?? ''))}/messages/send`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ raw }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
    return;
  }
  if (provider !== 'microsoft') throw new Error(`Unsupported OAuth mail provider: ${provider}`);
  const response = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject,
        importance: message.priority.toLowerCase(),
        body: { contentType: pageText['Text'], content: message.body },
        toRecipients: message.to.map((address) => ({ emailAddress: { address } })),
      },
      saveToSentItems: false,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 202) throw new Error(`${response.status} ${await response.text()}`);
}

export function registerMail(
  app: Express,
  db: pg.Pool,
  render: (res: Response, data: Record<string, unknown>) => unknown,
) {
  const display = (res: Response, mode: string, locale: string, values: Record<string, unknown> = {}) => {
    const labels = mailStrings(locale);
    return render(res, {
      active: 'System',
      section: 'MailList',
      login: false,
      title: labels.basicTitle,
      userName: res.locals.userName,
      mailPage: { mode, locale, labels, notificationFields, ...values },
    });
  };
  const gate = async (
    req: Request,
    res: Response,
    locale: string,
    action: 'read' | 'edit' | 'create' | 'delete',
  ): Promise<boolean> => {
    if (!(await hasSystemPermission(db, session(req)?.userId ?? '', 'system', action))) {
      display(res.status(403), 'denied', locale, { errors: [mailStrings(locale).roleError] });
      return false;
    }
    try {
      if (!licenseStatus().freeDrawOnly) return true;
    } catch {
      display(res.status(503), 'denied', locale, { errors: ['License information is unavailable.'] });
      return false;
    }
    display(res.status(403), 'denied', locale, { errors: [mailLicensePrerequisite] });
    return false;
  };
  const mailListData = async (locale: string) => {
    const document = await mailDocument(db);
    const model = mailModel(document);
    const labels = mailStrings(locale);
    const groups = [];
    const groupKeys: Record<string, string> = {
      Apply: 'groupApply',
      Remand: 'groupRemand',
      Approve: 'groupApprove',
      Edit: 'groupEdit',
      Complete: 'groupComplete',
      Change: 'groupChange',
      Terminal: 'groupTerminal',
      TerminalApprove: 'groupTerminalApprove',
      DefApply: 'groupDefApply',
      DefRemand: 'groupDefRemand',
      DefApprove: 'groupDefApprove',
    };
    for (const type of mailTypes) {
      const templates = await mailDocument(db, `Mail${type}.xml`);
      groups.push({
        type,
        title: labels[groupKeys[type] as keyof MailLabels],
        defaultId: String(templates.mail['@_default'] ?? ''),
        templates: entries(templates.mail.template).map((node) =>
          templateModel(node, String(templates.mail['@_default'] ?? ''), locale),
        ),
      });
    }
    return { document, model, groups };
  };

  app.get(`${root}/MailList`, async (req, res) => {
    const locale = await currentMailLocale(db, req);
    if (!(await gate(req, res, locale, 'read'))) return;
    try {
      const data = await mailListData(locale);
      const messages = [session(req)?.mailOAuthError, session(req)?.mailNotice].filter((value): value is string =>
        Boolean(value),
      );
      delete session(req)?.mailOAuthError;
      delete session(req)?.mailNotice;
      return display(res, 'list', locale, {
        model: data.model,
        groups: data.groups,
        canEdit: await hasSystemPermission(db, session(req)?.userId ?? '', 'system', 'edit'),
        canCreate: await hasSystemPermission(db, session(req)?.userId ?? '', 'system', 'create'),
        messages,
      });
    } catch {
      return display(res, 'denied', locale, { errors: [mailStrings(locale).serverError] });
    }
  });

  app.get(`${root}/EditMailBase`, async (req, res) => {
    const locale = await currentMailLocale(db, req);
    if (!(await gate(req, res, locale, 'edit'))) return;
    try {
      return display(res, 'edit', locale, {
        model: mailModel(await mailDocument(db)),
        autocomplete: await autocompleteSetting(db),
      });
    } catch {
      return display(res, 'edit', locale, { model: {}, fieldErrors: {}, errors: [mailStrings(locale).serverError] });
    }
  });

  app.post(`${root}/EditMailBase`, async (req, res) => {
    const locale = await currentMailLocale(db, req);
    if (!(await gate(req, res, locale, 'edit'))) return;
    const labels = mailStrings(locale);
    try {
      const document = await mailDocument(db);
      const fieldErrors = mailValidation(req.body, labels);
      const model = mailModel(document);
      for (const key of Object.keys(model)) {
        const formKey = `mailBase.${key}`;
        if (formKey in req.body)
          model[key] = typeof model[key] === 'boolean' ? checked(req.body, formKey) : text(req.body, formKey);
      }
      model.signature = text(req.body, 'mailBase.signature');
      const autocomplete = await autocompleteSetting(db);
      if (Object.keys(fieldErrors).length)
        return display(res, 'edit', locale, { model, fieldErrors, errors: [], autocomplete });
      updateMail(document, req.body);
      const userId = session(req)?.userId ?? '';
      await saveMailDocument(db, document, userId, req.ip ?? '');
      if (checked(req.body, 'mailBase.UseOAuth')) {
        const action =
          text(req.body, 'mailBase.OAuthProvider') === 'microsoft' ? 'MailOAuthMicrosoft' : 'MailOAuthGoogle';
        return res.redirect(`${root}/${action}`);
      }
      if (session(req)) session(req)!.mailNotice = labels.updateSuccess;
      return res.redirect(`${root}/MailList`);
    } catch {
      return display(res, 'edit', locale, {
        model: Object.fromEntries(
          Object.keys(req.body).map((key) => [key.replace(/^mailBase\./, ''), text(req.body, key)]),
        ),
        fieldErrors: {},
        errors: [labels.serverError],
        autocomplete: await autocompleteSetting(db),
      });
    }
  });

  for (const provider of ['google', 'microsoft'] as const) {
    const action = provider === 'google' ? 'MailOAuthGoogle' : 'MailOAuthMicrosoft';
    const stateKey = provider === 'google' ? 'mailOAuthGoogleState' : 'mailOAuthMicrosoftState';
    app.get(`${root}/${action}`, async (req, res) => {
      const locale = await currentMailLocale(db, req);
      const labels = mailStrings(locale);
      if (!(await hasSystemPermission(db, session(req)?.userId ?? '', 'system', 'edit'))) {
        if (session(req)) session(req)!.mailOAuthError = labels.roleError;
        return res.redirect(`${root}/MailList`);
      }
      try {
        const document = await mailDocument(db);
        const oauth = document.mail.oauth as Xml | undefined;
        if (!oauth || oauth.provider !== provider) throw new Error(pageText['Configure this OAuth provider first.']);
        const error = typeof req.query.error === 'string' ? req.query.error : '';
        if (error)
          throw new Error(
            provider === 'microsoft' && typeof req.query.error_description === 'string'
              ? `${error}: ${req.query.error_description}`
              : error,
          );
        const redirectUri = `${req.protocol}://${req.get('host')}${root}/${action}`;
        const tenant = encodeURIComponent(String(oauth.tenantId ?? ''));
        const code = typeof req.query.code === 'string' ? req.query.code : '';
        if (!code) {
          const state = randomBytes(32).toString('hex');
          if (session(req)) session(req)![stateKey] = state;
          const authorize = new URL(
            provider === 'google'
              ? 'https://accounts.google.com/o/oauth2/v2/auth'
              : `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
          );
          const query = new URLSearchParams();
          query.set('client_id', String(oauth.clientId));
          query.set('response_type', 'code');
          query.set('redirect_uri', redirectUri);
          if (provider === 'google') {
            query.set(
              'scope',
              'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/userinfo.email',
            );
            query.set('access_type', 'offline');
          } else {
            query.set('response_mode', 'query');
            query.set('scope', 'email offline_access openid Mail.Send User.Read');
          }
          query.set('state', state);
          query.set('prompt', 'consent');
          authorize.search = query.toString();
          return res.redirect(authorize.toString());
        }
        const expectedState = session(req)?.[stateKey];
        if (!expectedState || req.query.state !== expectedState) throw new Error(pageText['CSRF token mismatch.']);
        delete session(req)?.[stateKey];
        const tokenEndpoint =
          provider === 'google'
            ? 'https://oauth2.googleapis.com/token'
            : `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
        const tokenResponse = await fetch(tokenEndpoint, {
          method: 'POST',
          body: new URLSearchParams({
            client_id: String(oauth.clientId),
            client_secret: String(oauth.clientSecret),
            code,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
          }),
          signal: AbortSignal.timeout(30_000),
        });
        const token = (await tokenResponse.json()) as Xml;
        if (
          !tokenResponse.ok ||
          typeof token.access_token !== 'string' ||
          typeof token.refresh_token !== 'string' ||
          !Number.isFinite(Number(token.expires_in))
        ) {
          throw new Error(String(token.error_description ?? token.error ?? tokenResponse.statusText));
        }
        const userEndpoint =
          provider === 'google'
            ? 'https://www.googleapis.com/oauth2/v1/userinfo'
            : 'https://graph.microsoft.com/v1.0/me?$select=mail';
        const userResponse = await fetch(userEndpoint, {
          headers: { authorization: `Bearer ${token.access_token}` },
          signal: AbortSignal.timeout(30_000),
        });
        const user = (await userResponse.json()) as Xml;
        const address = user[provider === 'google' ? 'email' : 'mail'];
        if (!userResponse.ok || typeof address !== 'string')
          throw new Error(String(user.error?.message ?? userResponse.statusText));
        oauth.user = address;
        oauth.token = {
          accessToken: token.access_token,
          refreshToken: token.refresh_token,
          expiresOn: formatLocalDate(new Date(Date.now() + Number(token.expires_in) * 1000)),
        };
        await saveMailDocument(db, document, session(req)?.userId ?? '', req.ip ?? '');
        return res.redirect(`${root}/MailList`);
      } catch (error) {
        if (session(req)) session(req)!.mailOAuthError = `${labels.oauthFailed} ${errorChain(error)}`;
        return res.redirect(`${root}/MailList`);
      }
    });
  }
}

async function autocompleteSetting(db: pg.Pool): Promise<'on' | 'off'> {
  const row = (
    await db.query<{ com_value: string }>(
      'SELECT com_value FROM mst_common WHERE com_key = $1 AND com_name = $2 ORDER BY com_index LIMIT 1',
      ['SYSTEM', 'AUTOCOMPLETE'],
    )
  ).rows[0];
  return row?.com_value === '0' ? 'off' : 'on';
}
