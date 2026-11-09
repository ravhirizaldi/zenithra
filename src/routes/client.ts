import { Router, type Express } from 'express';
import type session from 'express-session';
import type pg from 'pg';
import { clientBase, clientConfiguration } from '../config/client.js';
import { clientSession } from '../middleware/client-session.js';
import { clientAccountAction, clientParameter } from '../controllers/client-account.js';
import { clientDefinitionAction } from '../controllers/client-definitions.js';
import { clientReportAction } from '../controllers/client-reports.js';
import { clientFileAction } from '../controllers/client-files.js';
import { clientVoiceAction } from '../controllers/client-voice.js';
import { clientCatalogAction } from '../controllers/client-catalog.js';
import { clientGeneralAction } from '../controllers/client-general.js';
import { clientError } from '../services/client-xml.js';
import { clientUploadBody } from '../middleware/client-upload.js';
import { clientTestAction } from '../controllers/client-test.js';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { productionBuild } from '../config/build.js';
import { root } from '../config/manager.js';
import { minifyHtml } from '../services/html-minify.js';
import { requestFailure } from '../middleware/request-log.js';

export function registerClientRoutes(app: Express, db: pg.Pool | null, store?: session.Store): void {
  const router = Router();
  router.use(clientSession(db, store));
  router.use((req, res, next) => {
    // Windows binary decoders recognize XML failures by this exact legacy media type.
    res.type('text/xml').set('Cache-Control', 'no-store');
    // Native clients have no anti-forgery form field; reject browser cross-site requests instead.
    if (
      req.get('sec-fetch-site') === 'cross-site' ||
      (req.get('origin') && req.get('origin') !== `${req.protocol}://${req.get('host')}`)
    ) {
      res.status(403).send(clientError(3));
      return;
    }
    next();
  });
  for (const path of ['Error.htm', 'Test/Test.htm', 'Test/system.htm'])
    router.all('/Rests/' + path, async (req, res) => {
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.set('Allow', 'GET, HEAD').status(405).end();
        return;
      }
      // Only these project-owned pages are public; production builds contain minified copies.
      const file = join(root, productionBuild ? 'dist/public' : 'public', 'ConMasWeb/Rests', path);
      if (!productionBuild && app.get('env') === 'production') {
        const html = await minifyHtml(await readFile(file, 'utf8'));
        res.type('html').send(html);
      } else {
        res.type('html').sendFile(file);
      }
    });
  router.use(clientUploadBody);
  router.all(['/Rests/:handler', '/Rests/Test/:handler'], async (req, res) => {
    const handler = (req.path.toLowerCase().startsWith('/rests/test/') ? 'Test/' : '') + req.params.handler;
    if (!handler.toLowerCase().endsWith('.aspx')) {
      res.status(404).send(clientError(1));
      return;
    }
    const configuration = clientConfiguration();
    const dispatcher = handler.toLowerCase() === 'conmasireporter.aspx';
    const directName = handler.slice(0, -5);
    const command = dispatcher
      ? clientParameter(req, 'command')
      : [...configuration.commands, ...configuration.directHandlers].find(
          (name) => name.toLowerCase() === directName.toLowerCase(),
        );
    if (!command) {
      if (dispatcher) res.redirect(`${clientBase}/Rests/Error.htm`);
      else res.status(404).send(clientError(1));
      return;
    }
    if (!dispatcher && (await clientTestAction(db, command, req, res))) return;
    if (!db) {
      res.status(503).send(clientError(-1, 'The local client database is not configured.'));
      return;
    }
    if (!dispatcher && command === 'GeneralProcess') {
      await clientGeneralAction(db, req, res);
      return;
    }
    if (!dispatcher && configuration.directHandlers.has(command)) {
      res.status(501).send(clientError(-1, `The ${command} REST handler has not been migrated.`));
      return;
    }
    if (!configuration.commands.has(command)) {
      res.send(clientError(1));
      return;
    }
    if (await clientAccountAction(db, command, req, res)) return;
    if (await clientDefinitionAction(db, command, req, res)) return;
    if (await clientReportAction(db, command, req, res)) return;
    if (await clientFileAction(db, command, req, res)) return;
    if (await clientVoiceAction(db, command, req, res)) return;
    if (await clientCatalogAction(db, command, req, res)) return;
    res.status(501).send(clientError(-1, `The ${command} client command has not been migrated.`));
  });
  router.use((_req, res) => {
    res.status(404).send(clientError(1));
  });
  router.use((error: Error, _req: unknown, res: import('express').Response, _next: unknown) => {
    requestFailure(res, error);
    console.error('Client request failed:', error.name);
    res.status(503).send(clientError(-1, 'server error.'));
  });
  app.use(clientBase, router);
}
