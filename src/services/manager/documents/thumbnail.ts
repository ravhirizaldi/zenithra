import childProcess from 'node:child_process';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { ReportUnsupported } from '../../../models/client-reports.js';

export async function documentThumbnail(pdf: Buffer, pixels: number): Promise<Buffer> {
  if (!Number.isInteger(pixels) || pixels < 350 || pixels > 1000) pixels = 350;
  const page = (await PDFDocument.load(pdf)).getPage(0);
  let { width, height } = page.getSize();
  if (Math.abs(page.getRotation().angle % 180) === 90) [width, height] = [height, width];
  const scale = pixels / Math.max(width, height);
  width = Math.max(1, Math.round(width * scale));
  height = Math.max(1, Math.round(height * scale));
  // Ghostscript is a host prerequisite; no shell, files, network or original client binaries are involved.
  const image = await new Promise<Buffer>((resolve, reject) => {
    const child = childProcess.execFile(
      process.platform === 'win32' ? 'gswin64c' : 'gs',
      [
        '-q',
        '-dSAFER',
        '-dBATCH',
        '-dNOPAUSE',
        '-dFirstPage=1',
        '-dLastPage=1',
        '-sDEVICE=png16m',
        '-dTextAlphaBits=4',
        '-dGraphicsAlphaBits=4',
        '-r72',
        '-dFIXEDMEDIA',
        '-dPDFFitPage',
        `-g${width}x${height}`,
        '-sOutputFile=%stdout',
        '-f',
        '-',
      ],
      { encoding: 'buffer', timeout: 15000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) reject(new ReportUnsupported('Report thumbnail rendering is unavailable.', 'report_thumbnail'));
        else resolve(stdout);
      },
    );
    child.stdin?.on('error', () => {
      /* The completion callback reports renderer failures without input or process details. */
    });
    child.stdin?.end(pdf);
  });
  return sharp(image).png().toBuffer();
}
