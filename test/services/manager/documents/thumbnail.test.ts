import assert from 'node:assert/strict';
import { test } from 'node:test';
import childProcess, { type ChildProcess } from 'node:child_process';
import sharp from 'sharp';
import { PDFDocument, rgb } from 'pdf-lib';
import { documentThumbnail } from '../../../../src/services/manager/documents/thumbnail.js';
import { ReportUnsupported } from '../../../../src/models/client-reports.js';

test('generated report thumbnails use the populated first PDF page, source pixel range and portrait/landscape aspect', async () => {
  for (const [width, height, pixels] of [
    [200, 400, 350],
    [400, 200, 600],
    [200, 400, 0],
  ]) {
    const pdf = await PDFDocument.create();
    pdf.addPage([width, height]).drawRectangle({ x: 0, y: 0, width, height, color: rgb(1, 0, 0) });
    pdf.addPage([100, 100]);
    const image = await documentThumbnail(Buffer.from(await pdf.save()), pixels);
    const metadata = await sharp(image).metadata();
    const longest = pixels || 350;
    assert.equal(metadata.width, width > height ? longest : longest / 2);
    assert.equal(metadata.height, height > width ? longest : longest / 2);
    const { data } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([...data.subarray(0, 3)], [255, 0, 0]);
  }
});

test('a missing thumbnail renderer produces a safe explicit failure instead of stale-thumbnail success', async (t) => {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 400]);
  const data = Buffer.from(await pdf.save());
  t.mock.method(childProcess, 'execFile', (...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error, stdout: Buffer) => void;
    callback(Object.assign(new Error('Fixture renderer unavailable'), { code: 'ENOENT' }), Buffer.alloc(0));
    return { stdin: null } as ChildProcess;
  });
  await assert.rejects(
    documentThumbnail(data, 350),
    (error) =>
      error instanceof ReportUnsupported &&
      error.code === 'report_thumbnail' &&
      error.message === 'Report thumbnail rendering is unavailable.',
  );
});
