import type { Express, RequestHandler } from 'express';
import type pg from 'pg';
import { base } from '../../../config/manager.js';
import type { RenderPage } from '../../../services/manager/page.js';
import { catalogDetail, catalogFilters, listCatalog } from '../../../models/manager/catalog/index.js';

export function registerCatalogController(
  app: Express,
  database: pg.Pool | null,
  page: RenderPage,
  requireAuth: RequestHandler,
): void {
  for (const [kind, route, active, title, idKey] of [
    ['form', 'DefReport', 'DefReport', 'Forms', 'defTopId'],
  ] as const) {
    app.get([`${base}/${route}`, `${base}/${route}/Index`], requireAuth, async (req, res) => {
      const catalog = database ? await listCatalog(database, kind, catalogFilters(req.query)) : null;
      return page(res, { active, section: '', login: false, title, catalog, userName: req.session?.userName });
    });
    app.get(`${base}/${route}/Details`, requireAuth, async (req, res) => {
      if (!database) return res.status(503).type('text/plain').send('Database is not configured.');
      const id = Number(req.query[idKey]);
      if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).type('text/plain').send('Invalid record ID.');
      const detail = await catalogDetail(database, kind, id);
      if (!detail) return res.status(404).type('text/plain').send('Record not found.');
      return page(res, {
        active,
        section: '',
        login: false,
        title: detail.top.name,
        detail,
        userName: req.session?.userName,
      });
    });
  }
}
