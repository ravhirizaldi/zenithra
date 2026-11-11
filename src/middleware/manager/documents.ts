import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { RequestHandler } from 'express';
import multer from 'multer';
import { text as pageText } from '../../config/manager/documents/resources.js';

const maximum = 1_000_000_000;
const parser = multer({
  storage: multer.diskStorage({
    destination: tmpdir(),
    filename: (_req, _file, done) => done(null, 'conmas-document-upload-' + randomUUID()),
  }),
  limits: { fileSize: maximum, files: 100, fields: 10000 },
  fileFilter: (req, file, done) =>
    (req.path.endsWith('/UploadInnerExcel') ? file.fieldname === 'patchedExcel' : /^[1-9]\d{0,9}$/.test(file.fieldname))
      ? done(null, true)
      : done(new multer.MulterError('LIMIT_UNEXPECTED_FILE')),
}).any();

export const documentUploadBody: RequestHandler = (req, res, next) => {
  if (!req.is('multipart/form-data')) return next();
  const failure = (status: number) =>
    res.status(status).send(pageText['Invalid or oversized sheet upload. No changes were saved.']);
  if (Number(req.headers['content-length']) > maximum) return void failure(413);
  let received = 0,
    exceeded = false;
  const count = (chunk: Buffer) => {
    received += chunk.length;
    if (received > maximum && !exceeded) {
      exceeded = true;
      req.emit('error', new multer.MulterError('LIMIT_FILE_SIZE'));
    }
  };
  req.on('data', count);
  parser(req, res, (error) => {
    req.off('data', count);
    const files = Array.isArray(req.files) ? req.files : Object.values(req.files ?? {}).flat();
    const cleanup = () => {
      void Promise.all(
        files.map((file) =>
          rm(file.path, { force: true }).catch(() => {
            /* Cleanup must not alter the save result. */
          }),
        ),
      );
    };
    res.once('finish', cleanup);
    res.once('close', cleanup);
    if (error) {
      cleanup();
      return void failure(error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE' ? 413 : 400);
    }
    next();
  });
};
