import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { request } from 'node:http';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import express, { type ErrorRequestHandler } from 'express';
import { maxSystemUploadBytes, systemUploadBody } from '../../../../src/middleware/manager/system/upload-body.js';

test('System multipart uploads stream past the old 4 MiB limit and remove private temporary files', async () => {
  const app = express();
  let paths: string[] = [];
  app.post('/', systemUploadBody, (req, res) => {
    const files = Object.values(req.files ?? {}).flat();
    paths = files.map((file) => file.path);
    res.json(files.map((file) => ({ size: file.size, inMemory: Buffer.isBuffer(file.buffer) })));
  });
  const errorHandler: ErrorRequestHandler = (_error, _req, res, _next) => {
    res.sendStatus(400);
  };
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    const root = `http://127.0.0.1:${address.port}`;
    const body = new FormData();
    body.set('file1', new Blob([Buffer.alloc(5 * 1024 * 1024, 0x61)]), 'large.bin');
    body.set('file2', new Blob(['b']), 'small.bin');
    const response = await fetch(root, { method: 'POST', body });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [
      { size: 5 * 1024 * 1024, inMemory: false },
      { size: 1, inMemory: false },
    ]);
    for (let attempt = 0; attempt < 20; attempt++) {
      if (
        (
          await Promise.all(
            paths.map((path) =>
              access(path).then(
                () => false,
                () => true,
              ),
            ),
          )
        ).every(Boolean)
      )
        break;
      await setTimeout(10);
    }
    for (const path of paths) await assert.rejects(access(path));
    const invalid = new FormData();
    invalid.set('file99', new Blob(['no']), 'invalid.bin');
    assert.equal((await fetch(root, { method: 'POST', body: invalid })).status, 400);
    const status = await new Promise<number>((resolve, reject) => {
      const call = request(
        root,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'multipart/form-data; boundary=fixture',
            'Content-Length': String(maxSystemUploadBytes + 1),
          },
        },
        (response) => {
          response.resume();
          response.once('end', () => resolve(response.statusCode!));
        },
      );
      call.on('error', reject);
      call.end();
    });
    assert.equal(status, 413);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
