import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { Request, RequestHandler } from 'express';
import multer from 'multer';
import { maxSystemUploadBytes } from './manager/system/upload-body.js';
import { clientError } from '../services/client-xml.js';
import { requestFailure } from './request-log.js';
import { clientParameter } from '../controllers/client-account.js';

// Designer uses Files[0]; tablet controllers select named XML/binary parts from all files.
export function createNativeUploadBody(
  maxRequestBytes: number,
  authenticated: (req: Request) => boolean,
): RequestHandler {
  const parser = multer({
    storage: multer.diskStorage({
      destination: tmpdir(),
      filename: (_req, _file, done) => done(null, 'conmas-client-upload-' + randomUUID()),
    }),
    limits: { fileSize: maxRequestBytes, fields: 1000 },
  }).any();

  return (req, res, next) => {
    if (!req.is('multipart/form-data')) {
      next();
      return;
    }
    if (!authenticated(req)) {
      res.send(clientError(5, 'no session.'));
      return;
    }
    const tooLarge = () =>
      res
        .status(413)
        .send(
          clientError(
            -1,
            maxRequestBytes === maxSystemUploadBytes
              ? 'The upload exceeds the 1 GB request size limit.'
              : 'The upload exceeds the API request size limit.',
          ),
        );
    if (Number(req.headers['content-length']) > maxRequestBytes) {
      tooLarge();
      return;
    }
    let received = 0,
      exceeded = false;
    const count = (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxRequestBytes && !exceeded) {
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
          files.filter((file) => file.path).map((file) => rm(file.path, { force: true }).catch(() => {})),
        );
      };
      if (error) {
        requestFailure(res, error);
        cleanup();
        if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
          tooLarge();
          return;
        }
        res.send(clientError(-1, 'server error.'));
        return;
      }
      res.once('finish', cleanup);
      res.once('close', cleanup);
      req.file = files[0];
      next();
    });
  };
}

const anonymousTest = (req: Request) => /^\/rests\/test\/(gettest|posttest|uploadtest)\.aspx$/i.test(req.path);
const putLog = (req: Request) =>
  /^\/rests\/putlog\.aspx$/i.test(req.path) ||
  (/^\/rests\/conmasireporter\.aspx$/i.test(req.path) && clientParameter(req, 'command') === 'PutLog');
const parseClientUpload = createNativeUploadBody(
  maxSystemUploadBytes,
  (req) =>
    Boolean(req.session.clientAccount) ||
    anonymousTest(req) ||
    putLog(req) ||
    /^\/rests\/conmasireporter\.aspx$/i.test(req.path),
);
export const clientUploadBody: RequestHandler = (req, res, next) => {
  parseClientUpload(req, res, (error) => {
    if (error) return next(error);
    // A multipart dispatcher can carry command in its form; only PutLog may continue anonymously.
    if (req.is('multipart/form-data') && !req.session.clientAccount && !anonymousTest(req) && !putLog(req)) {
      res.send(clientError(5, 'no session.'));
      return;
    }
    next();
  });
};
