import ejs from 'ejs';
import { minify } from 'html-minifier-terser';

function preservesSpacing(attrs: { name: string; value: string }[] = []) {
  return attrs.some(
    (attr) =>
      attr.name.toLowerCase() === 'style' &&
      /(?:^|;)\s*white-space\s*:\s*(?:pre(?:-wrap|-line)?|break-spaces)(?:\s*!important)?\s*(?:;|$)/i.test(attr.value),
  );
}

export function minifyHtml(html: string) {
  let failed = false;
  const options = {
    collapseWhitespace: true,
    conservativeCollapse: true,
    keepClosingSlash: true,
    // EJS escapes event-handler quotes; decode before JS parsing, then safely re-escape HTML.
    decodeEntities: true,
    quoteCharacter: '"',
    removeComments: true,
    ignoreCustomComments: [/^!/, /@license|@preserve/i],
    // The parser propagates these rules to nested elements, unlike fragment regexes.
    canCollapseWhitespace: (
      tag: string,
      attrs: { name: string; value: string }[],
      original: (tag: string) => boolean,
    ) => original(tag) && !preservesSpacing(attrs),
    canTrimWhitespace: (tag: string, attrs: { name: string; value: string }[], original: (tag: string) => boolean) =>
      original(tag) && !preservesSpacing(attrs),
    minifyCSS: true,
    minifyJS: { keep_fnames: true, keep_classnames: true, format: { comments: /@license|@preserve|^!/ } },
    log: (message: unknown) => {
      // Inline JS/CSS failures otherwise silently fall back to their unminified input.
      if (typeof message !== 'string' || !/^minified in: \d+ms$/.test(message)) failed = true;
    },
  };
  return minify(html, options)
    .then((output) => {
      if (failed) throw new Error('HTML minification failed.');
      return output;
    })
    .catch(() => {
      throw Object.assign(new Error('HTML minification failed.'), { code: 'HTML_MINIFICATION_FAILED' });
    });
}

export function createHtmlViewEngine(minifyOutput: boolean) {
  return (filename: string, data: ejs.Data, callback: (error: Error | null, html?: string) => void) => {
    ejs
      .renderFile(filename, data)
      .then((html) => (minifyOutput ? minifyHtml(html) : html))
      .then(
        (html) => callback(null, html),
        (error: Error) => callback(error),
      );
  };
}
