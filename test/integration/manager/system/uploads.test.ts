import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import type pg from 'pg';
import { registerSystemUploads, safeUploadFileName } from '../../../../src/controllers/manager/system/uploads.js';

test('upload names use safe basenames', () => {
  assert.equal(safeUploadFileName('C:\\reference\\manual.zip'), 'manual.zip');
  assert.equal(safeUploadFileName('../manual.zip'), 'manual.zip');
  assert.equal(safeUploadFileName('\0'), '');
});

test('upload routes stay blocked without approved license status', async () => {
  const routes: Array<{ method: string; path: string; handler: RequestHandler }> = [];
  const app = {
    get(path: string, handler: RequestHandler) {
      routes.push({ method: 'GET', path, handler });
      return this;
    },
    post(path: string, handler: RequestHandler) {
      routes.push({ method: 'POST', path, handler });
      return this;
    },
  } as unknown as Express;
  const rendered: Record<string, unknown>[] = [];
  registerSystemUploads(app, {} as pg.Pool, (_res, data) => {
    rendered.push(data);
  });

  assert.deepEqual(
    routes.map(({ method, path }) => [method, path]),
    [
      ['GET', '/ConMasManager/System/UploadList'],
      ['POST', '/ConMasManager/System/UploadList'],
      ['GET', '/ConMasManager/System/CreateUpload'],
      ['POST', '/ConMasManager/System/CreateUpload'],
    ],
  );
  for (const route of routes) {
    let statusCode = 200;
    const res = {
      locals: { userName: 'test' },
      status(code: number) {
        statusCode = code;
        return this;
      },
    } as unknown as Response;
    await route.handler({} as Request, res, (() => {}) as NextFunction);
    assert.equal(statusCode, 503);
    const page = rendered[rendered.length - 1]?.systemUploadsPage as { mode: string; errors: string[] } | undefined;
    assert.equal(page?.mode, 'denied');
    assert.match(page?.errors[0] ?? '', /License information is unavailable/);
  }
});
