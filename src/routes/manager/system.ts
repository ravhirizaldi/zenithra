import type { Express, RequestHandler } from 'express';
import type pg from 'pg';
import type { RenderPage } from '../../services/manager/page.js';
import { registerSystemController } from '../../controllers/manager/system/index.js';
import { registerCommon } from '../../controllers/manager/system/common.js';
import { registerAdmin } from '../../controllers/manager/system/admin.js';
import { registerTasks } from '../../controllers/manager/system/tasks.js';
import { registerMail } from '../../controllers/manager/system/mail.js';
import { registerMailTemplates } from '../../controllers/manager/system/mail-templates.js';
import { registerMailLogs } from '../../controllers/manager/system/mail-logs.js';
import { registerUsers } from '../../controllers/manager/system/users.js';
import { registerGroups } from '../../controllers/manager/system/groups.js';
import { registerDevices } from '../../controllers/manager/system/devices.js';
import { registerUserAccountLog } from '../../controllers/manager/system/user-account-log.js';
import { registerSystemMaintenance } from '../../controllers/manager/system/maintenance.js';
import { registerSystemLocks } from '../../controllers/manager/system/locks.js';
import { registerMbCloud } from '../../controllers/manager/system/mbcloud.js';
import { registerSystemData } from '../../controllers/manager/system/data.js';
import { registerSystemUploads } from '../../controllers/manager/system/uploads.js';
import { registerEdgeOcr } from '../../controllers/manager/system/edge-ocr.js';
import { registerSystemLogs } from '../../controllers/manager/system/logs.js';
import { registerIrfd } from '../../controllers/manager/system/irfd.js';
import { registerDirect } from '../../controllers/manager/system/direct.js';
import { registerWebhook } from '../../controllers/manager/system/webhook.js';
import { registerIwpro } from '../../controllers/manager/system/iwpro.js';
import { registerSystemFiles } from '../../controllers/manager/system/files.js';
import { registerSystemLicense } from '../../controllers/manager/system/license.js';
import { registerCloudCredentials } from '../../controllers/manager/system/cloud-credentials.js';
import { registerMeId } from '../../controllers/manager/system/meid.js';

export function registerSystemRoutes(
  app: Express,
  database: pg.Pool | null,
  page: RenderPage,
  requireAuth: RequestHandler,
): void {
  if (database) registerCommon(app, database, page);
  if (database) registerAdmin(app, database, page);
  if (database) registerTasks(app, database, page);
  if (database) registerMail(app, database, page);
  if (database) registerMailTemplates(app, database, page);
  if (database) registerMailLogs(app, database, page);
  if (database) registerUsers(app, database, page);
  if (database) registerGroups(app, database, page);
  if (database) registerDevices(app, database, page);
  if (database) registerUserAccountLog(app, database, page);
  if (database) registerSystemMaintenance(app, database, page);
  if (database) registerSystemLocks(app, database, page);
  if (database) registerMbCloud(app, database, page);
  if (database) registerSystemData(app, database, page);
  if (database) registerSystemUploads(app, database, page);
  if (database) registerEdgeOcr(app, database, page);
  if (database) registerSystemLogs(app, database, page);
  if (database) registerIrfd(app, database, page);
  if (database) registerSystemFiles(app, database, page);
  if (database) registerSystemLicense(app, database, page);
  if (database) registerCloudCredentials(app, database, page);
  if (database) registerMeId(app, database, page);
  if (database) registerDirect(app, database, page);
  if (database) registerWebhook(app, database, page);
  if (database) registerIwpro(app, database, page);
  registerSystemController(app, database, page, requireAuth);
}
