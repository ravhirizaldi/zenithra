import { Router, type Express, type Response } from 'express';
import type session from 'express-session';
import type pg from 'pg';
import { join } from 'node:path';
import { apiBase, apiConfiguration } from '../config/api.js';
import { apiSession } from '../middleware/api-session.js';
import { createNativeUploadBody } from '../middleware/client-upload.js';
import { apiAccountAction } from '../controllers/api-account.js';
import { clientParameter } from '../controllers/client-account.js';
import { generalApiAction } from '../controllers/client-general.js';
import { apiEntitlements } from '../models/api-account.js';
import { apiDataAction } from '../controllers/api-data.js';
import { clientError } from '../services/client-xml.js';
import { requestFailure } from '../middleware/request-log.js';

export function apiRequestError(error: Error, _req: unknown, res: Response, _next: unknown): void {
  requestFailure(res, error);
  res.status(503).type('text/xml').set('Cache-Control', 'no-store').send(clientError(-1, 'server error.'));
}

export function registerApiRoutes(app: Express, db: pg.Pool | null, store?: session.Store): void {
  const router = Router();
  router.use(apiSession(db, store));
  router.use((req, res, next) => {
    res.type('text/xml').set('Cache-Control', 'no-store');
    if (
      req.get('sec-fetch-site') === 'cross-site' ||
      (req.get('origin') && req.get('origin') !== `${req.protocol}://${req.get('host')}`)
    ) {
      res.status(403).send(clientError(3));
      return;
    }
    next();
  });
  for (const path of ['Error.htm', 'Test/Test.htm', 'Test/js/jquery-1.7.1.min.js'])
    router.all('/Rests/' + path, (req, res) => {
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.set('Allow', 'GET, HEAD').status(405).end();
        return;
      }
      res
        .type(path.endsWith('.js') ? 'application/javascript' : 'html')
        .sendFile(join('/mnt/c/Users/DELL/CONMASSERVER/ConMasAPI/Rests', path));
    });
  router.use(createNativeUploadBody(apiConfiguration().maxRequestBytes, (req) => Boolean(req.session.apiAccount)));
  router.all('/Rests/:handler', async (req, res) => {
    const configuration = apiConfiguration(),
      direct = configuration.directHandlers;
    const requested = String(req.params.handler);
    if (!requested.toLowerCase().endsWith('.aspx')) {
      res.status(404).send(clientError(1));
      return;
    }
    let handler = [...direct].find((name) => name.toLowerCase() === requested.slice(0, -5).toLowerCase());
    if (!handler) {
      res.status(404).send(clientError(1));
      return;
    }
    if (handler === 'APIExecute') {
      const command = clientParameter(req, 'command');
      if (!command) {
        res.redirect(`${apiBase}/Rests/Error.htm`);
        return;
      }
      if (configuration.executeType === '0' && !req.session.apiAccount?.freeDrawOnly) {
        res.status(501).send(clientError(-1, 'API general command dispatch has not been migrated.'));
        return;
      }
      if (
        (configuration.executeType === '2' || req.session.apiAccount?.freeDrawOnly) &&
        !configuration.freeDrawCommands.has(command)
      ) {
        res.send(clientError(1));
        return;
      }
      handler = configuration.commands.get(command);
      if (!handler) {
        res.send(clientError(1));
        return;
      }
      const license = apiEntitlements();
      if (
        command !== 'Login' &&
        !(
          license.api ||
          (['GetMotionboardCloudLog', 'ExecuteMotionboardCloud'].includes(command) && license.motionboard)
        )
      ) {
        res.send(clientError(11050));
        return;
      }
      if (!direct.has(handler)) {
        res.status(501).send(clientError(-1, 'The installed API mapping target is missing.'));
        return;
      }
    }
    if (!apiEntitlements().notExpired) {
      res.send(clientError(-1, 'Expiration'));
      return;
    }
    if (configuration.tokenCheck) {
      res.status(501).send(clientError(-1, 'API token licensing has not been migrated.'));
      return;
    }
    if (!db) {
      res.status(503).send(clientError(-1, 'The local API database is not configured.'));
      return;
    }
    if (await apiAccountAction(db, handler, req, res)) return;
    if (handler === 'GeneralProcess') {
      await generalApiAction(db, req.session.apiAccount?.userId, req, res);
      return;
    }
    if (handler === 'FollowLogin') {
      res.status(501).send(clientError(-1, 'API FollowLogin authentication has not been migrated.'));
      return;
    }
    if (!req.session.apiAccount) {
      res.send(clientError(5, 'no session.'));
      return;
    }
    if (await apiDataAction(db, handler, req, res)) return;
    res.status(501).send(clientError(-1, `The ${handler} ConMasAPI handler has not been migrated.`));
  });
  router.use((_req, res) => {
    res.status(404).send(clientError(1));
  });
  router.use(apiRequestError);
  app.use(apiBase, router);
}
