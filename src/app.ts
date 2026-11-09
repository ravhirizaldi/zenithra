import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import pg from 'pg';
import type session from 'express-session';
import { base, root } from './config/manager.js';
import { productionBuild } from './config/build.js';
import { configureSession, requireSession } from './middleware/manager/session.js';
import { registerSystemMiddleware } from './middleware/manager/system.js';
import { registerAccountController } from './controllers/manager/account/index.js';
import { registerManagerRoutes } from './routes/manager/index.js';
import { createPageRenderer } from './services/manager/page.js';
import { registerClientRoutes } from './routes/client.js';
import { requestFailure, requestLog } from './middleware/request-log.js';
import { clientBase } from './config/client.js';
import { clientError } from './services/client-xml.js';
import { apiBase } from './config/api.js';
import { apiRequestError, registerApiRoutes } from './routes/api.js';
import { managerResourceLocals } from './config/manager/resources.js';
import { createHtmlViewEngine } from './services/html-minify.js';
import type { ConsoleRequest } from './services/server-console.js';

export function createApp(
  database: pg.Pool | null = process.env.DATABASE_URL
    ? new pg.Pool({ connectionString: process.env.DATABASE_URL })
    : null,
  enableAuth = true,
  sessionStore?: session.Store,
  onRequest?: (entry: ConsoleRequest) => void,
) {
  const app = express();
  const authEnabled = enableAuth;
  app.disable('x-powered-by');
  app.engine('ejs', createHtmlViewEngine(productionBuild || app.get('env') === 'production'));
  app.set('view engine', 'ejs');
  app.set('views', path.join(root, 'src/views'));
  Object.assign(app.locals, managerResourceLocals);
  app.use(requestLog(undefined, onRequest));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(apiBase, apiRequestError);
  app.use(clientBase, (error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    requestFailure(res, error);
    res.status(503).type('text/xml').set('Cache-Control', 'no-store').send(clientError(-1, 'server error.'));
  });
  registerClientRoutes(app, database);
  registerApiRoutes(app, database);
  configureSession(app, database, authEnabled, sessionStore);
  const publicRoot = path.join(root, productionBuild ? 'dist/public' : 'public');
  app.use(`${base}/Content`, express.static(path.join(publicRoot, 'Content'), { fallthrough: false }));
  app.use(`${base}/Scripts`, express.static(path.join(publicRoot, 'Scripts'), { fallthrough: false }));
  app.use(`${base}/branding`, express.static(path.join(publicRoot, 'branding'), { fallthrough: false }));
  app.use(`${base}/preview.css`, express.static(path.join(publicRoot, 'preview.css'), { fallthrough: false }));
  app.use(
    `${base}/manager-theme.css`,
    express.static(path.join(publicRoot, 'manager-theme.css'), { fallthrough: false }),
  );
  app.get('/', (_req, res) => res.redirect(`${base}/`));
  const page = createPageRenderer(authEnabled, Boolean(database));
  const requireAuth = requireSession(authEnabled);
  registerAccountController(app, database, authEnabled, page);
  registerSystemMiddleware(app, database, authEnabled, requireAuth);
  registerManagerRoutes(app, database, authEnabled, page, requireAuth);
  app.use(`${base}`, (_req, res) =>
    res.status(404).type('text/plain').send('This Manager route has not been migrated.'),
  );
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    requestFailure(res, error);
    console.error('Manager request failed:', error.name);
    res.status(503).type('text/plain').send('The local Manager request failed.');
  });
  return app;
}
