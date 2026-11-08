import type { Express } from 'express';
import type pg from 'pg';
import { base } from '../../../config/manager.js';
import { documentFdSheet, documentMedia, documentMediaActions } from '../../../models/manager/documents/media.js';
import { documentViewSource } from '../../../services/manager/documents.js';
import { LabelValidationError } from '../../../models/manager/labels/index.js';

export function registerDocumentMedia(app: Express, db: pg.Pool) {
  app.get(`${base}/InputReport/DetailsFdSheet`, async (req, res) => {
    if (req.get('X-Requested-With') !== 'XMLHttpRequest') return res.send('');
    try {
      const sheet = await documentFdSheet(db, req.query, req.session?.userId ?? '');
      if (!sheet) return res.status(403).send('Role authority is insufficient.');
      return res.render('manager/documents/fd-sheet', { base, ...(await documentViewSource()), ...sheet });
    } catch (error) {
      if (!(error instanceof LabelValidationError)) throw error;
      return res.status(400).send(error.message);
    }
  });
  for (const action of documentMediaActions)
    app.get(`${base}/InputReport/${action}`, async (req, res) => {
      try {
        const media = await documentMedia(db, action, req.query, req.session?.userId ?? '');
        if (!media) return res.sendStatus(404);
        if (media.name) res.attachment(media.name);
        return res.set('X-Content-Type-Options', 'nosniff').set('Content-Type', media.type).send(media.data);
      } catch (error) {
        if (!(error instanceof LabelValidationError)) throw error;
        return res.status(400).send(error.message);
      }
    });
}
