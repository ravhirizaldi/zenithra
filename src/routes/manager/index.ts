import type { Express, RequestHandler } from 'express';
import type pg from 'pg';
import type { RenderPage } from '../../services/manager/page.js';
import { registerIndexController } from '../../controllers/manager/system/index.js';
import { registerSystemRoutes } from './system.js';
import { registerCatalogController } from '../../controllers/manager/catalog/index.js';
import { registerLabelController } from '../../controllers/manager/labels/index.js';
import { registerManagerLibraryController } from '../../controllers/manager/library/index.js';
import { registerManagerOutputController } from '../../controllers/manager/data-output/index.js';
import { registerDocumentController } from '../../controllers/manager/documents/index.js';

export function registerManagerRoutes(
  app: Express,
  database: pg.Pool | null,
  authEnabled: boolean,
  page: RenderPage,
  requireAuth: RequestHandler,
): void {
  registerDocumentController(app, database, authEnabled, page, requireAuth);
  registerLabelController(app, database, authEnabled, page, requireAuth);
  registerManagerLibraryController(app, database, authEnabled, page, requireAuth);
  registerManagerOutputController(app, database, authEnabled, page, requireAuth);
  registerSystemRoutes(app, database, page, requireAuth);
  registerCatalogController(app, database, page, requireAuth);
  registerIndexController(app, database, authEnabled, page, requireAuth);
}
