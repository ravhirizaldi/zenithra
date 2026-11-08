import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { RequestHandler } from 'express';
import multer from 'multer';

export const maxSystemUploadBytes = 1_000_000_000;
const parser = multer({
  storage: multer.diskStorage({
    destination: tmpdir(),
    filename: (_req, _file, done) => done(null, 'conmas-system-upload-' + randomUUID()),
  }),
  limits: { fileSize: maxSystemUploadBytes, files: 10, fields: 1000 },
}).fields(Array.from({ length: 10 }, (_, index) => ({ name: 'file' + (index + 1), maxCount: 1 })));

export const systemUploadBody: RequestHandler = (req, res, next) => {
  const tooLarge = () => res.status(413).send('The upload exceeds the 1 GB request size limit.');
  if (Number(req.headers['content-length']) > maxSystemUploadBytes) {
    tooLarge();
    return;
  }
  let received = 0,
    exceeded = false;
  const count = (chunk: Buffer) => {
    received += chunk.length;
    if (received > maxSystemUploadBytes && !exceeded) {
      exceeded = true;
      req.emit('error', new multer.MulterError('LIMIT_FILE_SIZE'));
    }
  };
  req.on('data', count);
  parser(req, res, (error) => {
    req.off('data', count);
    const files = Array.isArray(req.files) ? req.files : Object.values(req.files ?? {}).flat();
    const cleanup = () => {
      void Promise.all(files.filter((file) => file.path).map((file) => rm(file.path, { force: true }).catch(() => {})));
    };
    if (error) {
      cleanup();
      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        tooLarge();
        return;
      }
      next(error);
      return;
    }
    res.once('finish', cleanup);
    res.once('close', cleanup);
    req.file = files[0];
    next();
  });
};
