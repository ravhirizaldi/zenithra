import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';
import { minify } from 'terser';
import { root } from '../src/config/manager.js';
import { minifyHtml } from '../src/services/html-minify.js';

export async function minifyAssets(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) {
      await minifyAssets(from, to);
    } else if (entry.isFile() && extname(entry.name).toLowerCase() !== '.map') {
      const extension = extname(entry.name).toLowerCase();
      if (extension === '.js') {
        const input = await readFile(from, 'utf8');
        const header = input.match(/^(?:\s*(?:\/\/[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/))*/)?.[0] ?? '';
        // Classic scripts share window; do not inject esbuild's global name-preservation helpers.
        const { code } = await minify(input.slice(header.length), {
          keep_fnames: true,
          keep_classnames: true,
          format: { comments: /@license|@preserve|^!/ },
        });
        if (typeof code !== 'string') throw new Error('JavaScript minification failed.');
        const notices = header.replace(/^\s*\/\/[#@]\s*sourceMappingURL=.*$/gm, '').trim();
        await writeFile(to, (notices ? notices + '\n' : '') + code + '\n');
      } else if (extension === '.css') {
        const { code } = await transform(await readFile(from, 'utf8'), {
          loader: 'css',
          minify: true,
          legalComments: 'eof',
          sourcemap: false,
          logLevel: 'silent',
        });
        await writeFile(to, code);
      } else if (extension === '.html' || extension === '.htm') {
        await writeFile(to, await minifyHtml(await readFile(from, 'utf8')));
      } else {
        await copyFile(from, to);
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await minifyAssets(join(root, 'public'), join(root, 'dist/public'));
  } catch {
    console.error('Production assets could not be minified.');
    process.exitCode = 1;
  }
}
