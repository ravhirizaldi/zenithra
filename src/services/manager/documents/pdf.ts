import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fontkit from '@pdf-lib/fontkit';
import sharp from 'sharp';
import {
  PDFDocument,
  StandardFonts,
  rgb,
  pushGraphicsState,
  popGraphicsState,
  concatTransformationMatrix,
  degrees,
  setLineWidth,
  setTextRenderingMode,
  setStrokingColor,
  TextRenderingMode,
  type PDFFont,
  type PDFPage,
  type RGB,
} from 'pdf-lib';
import { root as projectRoot } from '../../../config/manager.js';
import { text as pageText } from '../../../config/manager/documents/resources.js';
import { LabelValidationError } from '../../../models/manager/labels/index.js';
import type { DocumentPdfData, PdfRow } from '../../../models/manager/documents/pdf.js';
import { reportNameDate } from '../../../models/client-report-name.js';
import { ReportUnsupported } from '../../../models/client-reports.js';
import { child, children, optionalField, root, type XmlNode } from '../../../models/client-definition-xml.js';

type Rect = { x: number; y: number; width: number; height: number };
const invalid = () => new LabelValidationError('pdf', pageText['The report PDF data is invalid.']);
const pending = () =>
  new LabelValidationError('pending', pageText['This report requires PDF output that has not been migrated.']);
const text = (value: unknown) => String(value ?? '');
const truth = (value: unknown) => /^(true|1)$/i.test(text(value));
const bytes = (value: unknown) => (Buffer.isBuffer(value) ? value : Buffer.alloc(0));
const number = (value: unknown) => {
  if (value === null || value === undefined || text(value).trim() === '' || !Number.isFinite(Number(value)))
    throw invalid();
  return Number(value);
};
function parameters(value: unknown) {
  const result: Record<string, string> = {};
  for (const part of text(value).split(';')) {
    const [key, value] = part.split('=');
    if (value) result[key] = value;
  }
  return result;
}
function items(value = '') {
  const result: string[] = [];
  let item = '';
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== ',') item += value[i];
    else if (i === value.length - 1) break;
    else if (value[i + 1] === ',') {
      item += ',';
      i++;
    } else {
      result.push(item);
      item = '';
    }
  }
  if (item) result.push(item);
  return result;
}
function color(value = '0,0,0'): RGB {
  const parts = value.split(',').map(number);
  if (parts.length !== 3 || parts.some((v) => v < 0 || v > 255)) throw invalid();
  return rgb(parts[0] / 255, parts[1] / 255, parts[2] / 255);
}
function inset(rect: Rect, width: number, height: number): Rect {
  return { x: rect.x + (rect.width - width) / 2, y: rect.y + (rect.height - height) / 2, width, height };
}
function line(page: PDFPage, x1: number, y1: number, x2: number, y2: number, c = rgb(0, 0, 0), thickness = 2) {
  page.drawLine({ start: { x: x1, y: -y1 }, end: { x: x2, y: -y2 }, color: c, thickness });
}
function rectangle(page: PDFPage, rect: Rect, c: RGB, fill = false, thickness = 2) {
  page.drawRectangle({
    x: rect.x,
    y: -rect.y - rect.height,
    width: rect.width,
    height: rect.height,
    ...(fill ? { color: c } : { borderColor: c, borderWidth: thickness }),
  });
}
function ellipse(page: PDFPage, rect: Rect, c: RGB, thickness: number, fill?: RGB) {
  page.drawEllipse({
    x: rect.x + rect.width / 2,
    y: -rect.y - rect.height / 2,
    xScale: rect.width / 2,
    yScale: rect.height / 2,
    borderColor: c,
    borderWidth: thickness,
    ...(fill ? { color: fill } : {}),
  });
}

async function fonts(pdf: PDFDocument, path: string, locale: string) {
  const fallbackName = locale === 'zh-TW' ? 'msjh.ttc' : locale === 'zh-CN' ? 'simsun.ttc' : 'msgothic.ttc';
  const fallbackPath = join(process.platform === 'win32' ? 'C:/Windows/Fonts' : '/mnt/c/Windows/Fonts', fallbackName);
  let fontData: Buffer | undefined;
  if (path) {
    let source = path.replace(/,\d+$/, '');
    if (source.startsWith('file:')) source = fileURLToPath(source);
    if (process.platform !== 'win32' && /^[a-z]:[\\/]/i.test(source))
      source = '/mnt/' + source[0].toLowerCase() + source.slice(2).replaceAll('\\', '/');
    if (!isAbsolute(source)) throw invalid();
    try {
      fontData = await readFile(source);
    } catch {
      /* The source falls back when the configured font is unavailable. */
    }
  }
  if (!fontData && /^(ja-JP|zh-TW|zh-CN)$/i.test(locale)) {
    try {
      fontData = await readFile(fallbackPath);
    } catch {
      throw new LabelValidationError('pending', pageText['Configure a PDF font that supports all report characters.']);
    }
  }
  const embedded = new Map<string, PDFFont>();
  const embed = async (data: Buffer, index: number) => {
    const parsed: unknown = fontkit.create(data);
    const collection = parsed as { fonts?: fontkit.Font[] };
    const selected = collection.fonts ? collection.fonts[index] : (parsed as fontkit.Font);
    if (!selected) throw invalid();
    pdf.registerFontkit({ create: () => selected });
    return pdf.embedFont(data, { subset: true });
  };
  if (fontData) embedded.set('Normal', await embed(fontData, Number(path.match(/,(\d+)$/)?.[1] ?? 0)));
  let fallback: PDFFont | undefined;
  const supports = (font: PDFFont, value: string) => {
    const supported = new Set(font.getCharacterSet());
    return [...value].every((c) => supported.has(c.codePointAt(0)!));
  };
  return async (weight: string, value: string) => {
    const name =
      weight === 'Bold'
        ? StandardFonts.HelveticaBold
        : weight === 'Italic'
          ? StandardFonts.HelveticaOblique
          : StandardFonts.Helvetica;
    let font = embedded.get(fontData ? 'Normal' : name) ?? (await pdf.embedFont(name));
    embedded.set(fontData ? 'Normal' : name, font);
    if (!supports(font, value)) {
      if (!fallback) {
        let data: Buffer;
        try {
          data = await readFile(fallbackPath);
        } catch {
          throw new LabelValidationError(
            'pending',
            pageText['Configure a PDF font that supports all report characters.'],
          );
        }
        fallback = await embed(data, 0);
      }
      if (!supports(fallback, value))
        throw new LabelValidationError(
          'pending',
          pageText['Configure a PDF font that supports all report characters.'],
        );
      font = fallback;
    }
    return { font, custom: Boolean(fontData) || font === fallback };
  };
}

export function documentPdfTextLayout(
  font: PDFFont,
  value: string,
  rect: Rect,
  p: Record<string, string>,
  deduction = 2,
) {
  const count = p.Lines ? number(p.Lines) : 1;
  const auto = (p.EnableAutoFontSize ?? '1') === '1';
  const wrap = count > 1 || p.Punctuation === '2' || p.FontPriority === '1' || !auto;
  const maxLines =
    p.Punctuation === '2' || p.FontPriority === '1' ? Infinity : p.FontPriority === '2' ? 1 : Math.max(1, count);
  let size = Math.max(3, Math.min(200, Math.floor(number(p.FontSize ?? 14))));
  let lines: string[] = [];
  const split = () => {
    lines = [];
    for (const paragraph of value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')) {
      if (!wrap) {
        lines.push(paragraph);
        continue;
      }
      let current = '';
      for (const word of paragraph.split(/(\s+)/)) {
        if (font.widthOfTextAtSize(current + word, size) <= rect.width) {
          current += word;
          continue;
        }
        if (current) {
          lines.push(current.trimEnd());
          current = '';
        }
        for (const char of word) {
          if (current && font.widthOfTextAtSize(current + char, size) > rect.width) {
            lines.push(current);
            current = '';
          }
          current += char;
        }
      }
      lines.push(current);
    }
  };
  for (;;) {
    split();
    if (
      !auto ||
      size <= 1 ||
      (lines.length <= maxLines &&
        lines.length * font.heightAtSize(size) <= rect.height &&
        lines.every((v) => font.widthOfTextAtSize(v, size) <= rect.width))
    )
      break;
    size = Math.max(1, size - deduction);
  }
  const lineHeight = font.heightAtSize(size),
    height = lineHeight * lines.length;
  const available = !auto ? Math.max(rect.height, height) : rect.height;
  const vertical = p.VerticalAlignment ?? (count >= 2 ? '0' : '1');
  const offset = vertical === '2' ? available - height : vertical === '1' ? (available - height) / 2 : 0;
  return {
    size,
    lineHeight,
    lines: lines.map((value, index) => ({
      value,
      x:
        rect.x +
        (p.Align === 'Right'
          ? rect.width - font.widthOfTextAtSize(value, size)
          : p.Align === 'Center'
            ? (rect.width - font.widthOfTextAtSize(value, size)) / 2
            : 0),
      y: -rect.y - offset - index * lineHeight - font.heightAtSize(size, { descender: false }),
    })),
  };
}

function marker(page: PDFPage, rect: Rect, name: string, c: RGB, width: number, fill?: RGB) {
  const stroke = Math.floor(width);
  const small = inset(rect, Math.min(rect.width, rect.height) * 0.8, Math.min(rect.width, rect.height) * 0.8);
  const oval = inset(rect, rect.width * 0.8, rect.height * 0.8);
  if (name === 'CheckBox') rectangle(page, small, c, false, 1.5);
  switch (name) {
    case 'Circle':
      ellipse(page, small, c, 1.5);
      break;
    case 'Oval':
      ellipse(page, oval, c, 1.5);
      break;
    case 'FillOval':
      ellipse(page, oval, c, stroke, fill);
      break;
    case 'FillRect': {
      const inner = inset(rect, rect.width - width, rect.height - width);
      if (fill) rectangle(page, inner, fill, true);
      rectangle(page, inner, c, false, stroke);
      break;
    }
    case 'Check':
    case 'CheckBox':
      line(
        page,
        small.x + small.width * 0.15,
        small.y + small.height / 2,
        small.x + small.width * 0.4,
        small.y + small.height * 0.875,
        c,
        2.5,
      );
      line(
        page,
        small.x + small.width * 0.4,
        small.y + small.height * 0.875,
        small.x + small.width * 0.875,
        small.y + small.height * 0.125,
        c,
        2.5,
      );
      break;
    case 'HorizontalLine':
      line(page, rect.x, rect.y + rect.height / 2, rect.x + rect.width, rect.y + rect.height / 2, c, stroke);
      break;
    case 'HorizontalDouble':
      for (const offset of [-0.1, 0.1])
        line(
          page,
          rect.x,
          rect.y + rect.height * (0.5 + offset),
          rect.x + rect.width,
          rect.y + rect.height * (0.5 + offset),
          c,
          stroke,
        );
      break;
    case 'Cross':
    case 'StretchCross': {
      const r = name === 'Cross' ? small : oval;
      line(page, r.x, r.y, r.x + r.width, r.y + r.height, c, stroke);
      line(page, r.x + r.width, r.y, r.x, r.y + r.height, c, stroke);
      break;
    }
    case '':
      break;
    default:
      break;
  }
}

function verified(c: PdfRow) {
  if (text(c.verified) !== '1') return false;
  switch (c.cluster_type) {
    case 'AudioRecording':
    case 'DrawingImage':
    case 'Registration':
    case 'RegistrationDate':
    case 'LatestUpdate':
    case 'LatestUpdateDate':
      return false;
    case 'Action':
      return parameters(c.input_parameter).OutputVisible === '1' && !text(c.display_value);
    case 'Approve':
    case 'Create':
    case 'Inspect':
      return !text(c.input_value) || c.input_value === '0';
    case 'Check':
      return text(c.input_value).toUpperCase() !== 'TRUE' && text(c.display_value).toUpperCase() !== 'TRUE';
    case 'Image':
    case 'FreeText':
    case 'FixedText':
    case 'FreeDraw':
      return text(c.is_hidden) !== '1' && !bytes(c.image_file).length;
    default:
      return !text(c.display_value);
  }
}

function changed(c: PdfRow, data: DocumentPdfData) {
  const history = data.history.filter(
    (h) => number(h.rep_sheet_id) === number(c.rep_sheet_id) && number(h.cluster_id) === number(c.cluster_id),
  );
  let initial = history.filter((h) => text(h.init_history_input) === '1');
  let key = 'input_value';
  switch (c.cluster_type) {
    case 'Registration':
    case 'RegistrationDate':
    case 'LatestUpdate':
    case 'LatestUpdateDate':
    case 'Action':
      return false;
    case 'MultipleChoiceNumber':
      key = 'display_value';
      break;
    case 'Image':
    case 'FreeText':
    case 'DrawingImage':
      key = 'image_file_length';
      break;
    case 'FixedText':
      key = 'binary_file_length';
      break;
    case 'AudioRecording':
      key = 'recording_file_length';
      break;
    case 'FreeDraw':
      key = c.binary_file_type === 'Windows' ? 'binary_file_length_win' : 'binary_file_length';
      break;
    case 'Approve':
    case 'Create':
    case 'Inspect':
      return (
        initial.length > 0 &&
        history
          .filter((h) => h.input_value === '4')
          .slice(0, 1)
          .some((h) => text(h.input_approval_value) !== text(c.input_approval_value))
      );
  }
  const current = key === 'image_file_length' ? bytes(c.image_file).length : c[key];
  if (
    data.settings.INITIAL_VALUE_CHANGE_DISPLAY_TYPE === '1' &&
    initial.some((h) =>
      c.cluster_type === 'FixedText'
        ? text(h.binary_file_length) === '0'
        : text(h.verified) === '1' &&
          (c.cluster_type === 'FreeDraw'
            ? text(h.binary_file_length) === '0' && text(h.binary_file_length_win) === '0'
            : ['Image', 'FreeText', 'DrawingImage', 'AudioRecording'].includes(text(c.cluster_type))
              ? text(h[key]) === '0'
              : text(h[key]) === ''),
    )
  ) {
    initial = history
      .filter(
        (h) =>
          h.init_history_input !== null &&
          h.init_history_input !== undefined &&
          text(h.init_history_input) !== '1' &&
          h.verified !== null &&
          h.verified !== undefined &&
          text(h.verified) !== '1',
      )
      .slice(0, 1);
  }
  return initial.some(
    (h) =>
      text(h[key]) !== text(current) ||
      (c.cluster_type === 'FreeDraw' && text(h.binary_file_type) !== text(c.binary_file_type)),
  );
}

function xmlCluster(top: XmlNode | undefined, sheetNo: number, clusterId: number) {
  const sheets = top && child(top, 'sheets');
  const sheet =
    sheets &&
    children(sheets, 'sheet').find(
      (s) => Number(optionalField(s, 'sheetNo') || optionalField(s, 'repSheetNo')) === sheetNo,
    );
  const clusters = sheet && child(sheet, 'clusters');
  return (
    clusters &&
    children(clusters, 'cluster').find(
      (c) => Number(optionalField(c, 'clusterId') || optionalField(c, 'id')) === clusterId,
    )
  );
}

function drawPins(page: PDFPage, cluster: XmlNode | undefined, width: number, height: number) {
  const pin = cluster && child(cluster, 'pin');
  if (!pin) return;
  const polygon = (points: number[][], x: number, y: number, fill: RGB, border = fill, thickness = 1) =>
    page.drawSvgPath('M ' + points.map((point) => point.join(' ')).join(' L ') + ' Z', {
      x,
      y: -y,
      color: fill,
      borderColor: border,
      borderWidth: thickness,
    });
  // Original direction glyphs are asymmetric; preserve their measured offsets rather than rotate one approximation.
  const directions: Record<string, number[][]> = {
    '1': [
      [0.7, 8],
      [0.7, 4],
      [1.5, 4],
      [0, 2.3],
      [-1.5, 4],
      [-0.7, 4],
      [-0.7, 8],
    ],
    '2': [
      [6.9, 6.3],
      [4.4, 3.2],
      [5, 2.7],
      [2.7, 2.5],
      [2.8, 4.6],
      [3.3, 4.1],
      [5.8, 7.2],
    ],
    '3': [
      [8, 0.7],
      [4, 0.7],
      [4, 1.5],
      [2.3, 0],
      [4, -1.5],
      [4, -0.7],
      [8, -0.7],
    ],
    '4': [
      [5.8, -7.2],
      [3.3, -4.1],
      [2.7, -4.6],
      [2.8, -2.5],
      [5, -2.7],
      [4.4, -3.2],
      [6.9, -6.3],
    ],
    '5': [
      [0.7, -8],
      [0.7, -4],
      [1.5, -4],
      [0, -2.3],
      [-1.5, -4],
      [-0.7, -4],
      [-0.7, -8],
    ],
    '6': [
      [-6.9, -6.3],
      [-4.4, -3.2],
      [-5, -2.7],
      [-2.7, -2.5],
      [-2.8, -4.6],
      [-3.3, -4.1],
      [-5.8, -7.2],
    ],
    '7': [
      [-8, 0.7],
      [-4, 0.7],
      [-4, 1.5],
      [-2.3, 0],
      [-4, -1.5],
      [-4, -0.7],
      [-8, -0.7],
    ],
    '8': [
      [-5.8, 7.2],
      [-3.3, 4.1],
      [-2.7, 4.6],
      [-2.8, 2.5],
      [-5, 2.7],
      [-4.4, 3.2],
      [-6.9, 6.3],
    ],
  };
  for (const detail of children(pin, 'pinDetail')) {
    const start = optionalField(detail, 'pinPointForBackground'),
      end = optionalField(detail, 'connectPointForBackground');
    if (!start || !end) continue;
    const coordinates = [start, end].map((value) => value.split(',').map(number));
    if (coordinates.some((point) => point.length !== 2 || point.some((value) => value < 0 || value > 1)))
      throw invalid();
    const x = coordinates[0][0] * width,
      y = coordinates[0][1] * height;
    const fill = color(optionalField(detail, 'pinColor'));
    line(page, x, y, coordinates[1][0] * width, coordinates[1][1] * height, fill, 1);
    if (optionalField(detail, 'pinShape') !== '1')
      ellipse(page, { x: x - 2.5, y: y - 2.5, width: 5, height: 5 }, fill, 1, fill);
    else {
      polygon(
        [
          [-1.2, -1.2],
          [1.2, -1.2],
          [0, 1.2],
        ],
        x,
        y,
        fill,
      );
      const direction = directions[optionalField(detail, 'pinDirection')];
      if (direction) polygon(direction, x, y, rgb(0, 1, 1), rgb(0, 0, 0), 0.3);
    }
  }
}

export async function renderDocumentPdf(data: DocumentPdfData): Promise<Buffer> {
  const { preview, top } = data;
  const xmlTop = text(top.xml_data) ? child(root(text(top.xml_data)), 'top') : undefined;
  if (preview.sheetNo === -1 && xmlTop && optionalField(xmlTop, 'trailOutput') === '1') throw pending();
  if (!bytes(top.background_image_file).length) throw invalid();
  const original = await PDFDocument.load(bytes(top.background_image_file));
  const pdf = await PDFDocument.create();
  const display = text(top.display_sheet_number)
    ? text(top.display_sheet_number).split(',').map(number)
    : Array.from({ length: number(top.rep_sheet_count) }, (_, i) => i + 1);
  if (
    !display.length ||
    display.some((n) => !Number.isInteger(n) || n <= 0) ||
    new Set(display).size !== display.length
  )
    throw invalid();
  // Original-sheet remapping applies only when the report supplies an explicit display order.
  const added =
    Boolean(text(top.display_sheet_number)) &&
    data.sheets.some((s) => number(s.rep_sheet_no) !== number(s.sheet_no_org));
  const indices = added
    ? display.map((n) => {
        const sheet = data.sheets.find((s) => number(s.rep_sheet_no) === n);
        if (!sheet) throw invalid();
        return number(sheet.sheet_no_org) - 1;
      })
    : display.map((_, i) => i);
  if (
    (!added && original.getPageCount() !== display.length) ||
    indices.some((i) => !Number.isInteger(i) || i < 0 || i >= original.getPageCount())
  )
    throw invalid();
  const selected = preview.sheetNo === -1 ? display.map((_, i) => i) : [display.indexOf(preview.sheetNo)];
  if (selected.some((i) => i < 0)) throw invalid();
  const getFont = await fonts(pdf, data.settings.FONT_FILE_PATH ?? '', data.locale);
  const deduction = Number(top.pdf_fontsize_deduction) > 0 ? number(top.pdf_fontsize_deduction) : 2;
  const drawText = async (page: PDFPage, rect: Rect, value: string, p: Record<string, string>) => {
    if (!value) return;
    const normalized = value.replaceAll('\t', ' ').replaceAll('\r\n', '\n').replaceAll('\r', '\n');
    const { font, custom } = await getFont(p.Weight ?? 'Normal', normalized.replaceAll('\n', ''));
    const layout = documentPdfTextLayout(font, normalized, rect, p, deduction);
    page.pushOperators(pushGraphicsState());
    // Custom faces use synthetic styles; never substitute a Latin font for Unicode report values.
    if (custom && p.Weight === 'Bold')
      page.pushOperators(
        setTextRenderingMode(TextRenderingMode.FillAndOutline),
        setLineWidth(layout.size * 0.03),
        setStrokingColor(color(p.Color)),
      );
    for (const item of layout.lines)
      if (item.value)
        page.drawText(item.value, {
          x: item.x,
          y: item.y,
          size: layout.size,
          font,
          color: color(p.Color),
          ...(custom && p.Weight === 'Italic' ? { xSkew: degrees(12) } : {}),
        });
    page.pushOperators(popGraphicsState());
  };
  const image = async (page: PDFPage, rect: Rect, source: Buffer, resize = true, jpeg = false) => {
    if (!source.length) return;
    const converted = jpeg
      ? await sharp(source).flatten({ background: '#fff' }).jpeg().toBuffer()
      : await sharp(source).png().toBuffer();
    const embedded = jpeg ? await pdf.embedJpg(converted) : await pdf.embedPng(converted);
    const scale =
      resize || embedded.width > rect.width || embedded.height > rect.height
        ? Math.min(rect.width / embedded.width, rect.height / embedded.height)
        : 1;
    const r = inset(rect, embedded.width * scale, embedded.height * scale);
    page.drawImage(embedded, { x: r.x, y: -r.y - r.height, width: r.width, height: r.height });
  };
  const resource = async (page: PDFPage, rect: Rect, name: string) =>
    image(page, rect, await readFile(join(projectRoot, 'public/report-pdf', name + '.png')), false);
  for (const index of selected) {
    const [page] = await pdf.copyPages(original, [indices[index]]);
    pdf.addPage(page);
    const crop = page.getCropBox(),
      rotation = ((page.getRotation().angle % 360) + 360) % 360;
    if (![0, 90, 180, 270].includes(rotation)) throw invalid();
    const width = rotation % 180 ? crop.height : crop.width,
      height = rotation % 180 ? crop.width : crop.height;
    // Draw upright in the visible, rotated crop box; inherited background geometry is left unchanged.
    const matrix =
      rotation === 90
        ? [0, 1, -1, 0, crop.x, crop.y]
        : rotation === 180
          ? [-1, 0, 0, -1, crop.x + crop.width, crop.y]
          : rotation === 270
            ? [0, -1, 1, 0, crop.x + crop.width, crop.y + crop.height]
            : [1, 0, 0, 1, crop.x, crop.y + crop.height];
    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]),
    );
    const sheetNo = display[index];
    for (const c of data.clusters.filter((c) => number(c.rep_sheet_no) === sheetNo)) {
      const left = number(c.left_position),
        right = number(c.right_position),
        t = number(c.top_position),
        bottom = number(c.bottom_position);
      if ([left, right, t, bottom].some((n) => n < 0 || n > 1) || right <= left || bottom <= t) throw invalid();
      const rect = { x: left * width, y: t * height, width: (right - left) * width, height: (bottom - t) * height };
      let p = parameters(c.input_parameter);
      const visible = !/^(false|0)$/i.test(p.Visible ?? '');
      if (visible && c.cluster_role === '2') {
        rectangle(page, rect, rgb(0.75, 0.75, 0.75), true);
        await resource(page, rect, 'invisible');
        continue;
      }
      if (visible && verified(c)) {
        const type = Number(top.no_need_to_fill_type ?? 0),
          x = rect.x,
          y = rect.y,
          w = rect.width,
          h = rect.height;
        if (type === 0) line(page, x + w / 4, y + h / 2, x + (w * 3) / 4, y + h / 2);
        else if (type === 1) line(page, x + w, y, x, y + h);
        else if (type === 2) line(page, x, y, x + w, y + h);
        else if (type === 3) {
          line(page, x, y, x + w, y + h);
          line(page, x + w, y, x, y + h);
        } else if (type === 4 || type === 5)
          marker(page, rect, type === 4 ? 'HorizontalLine' : 'HorizontalDouble', rgb(0, 0, 0), 2);
        else if (type === 6 || type === 7)
          await drawText(page, rect, type === 6 ? 'N/A' : '-', {
            FontSize: String(Math.min(w, h) * 0.5),
            Align: 'Center',
            Weight: 'Bold',
          });
      } else if (visible) {
        switch (c.cluster_type) {
          case 'Approve':
          case 'Create':
          case 'Inspect':
            if (c.input_value === '4' && text(c.approval_sign)) {
              const sign = text(c.approval_sign);
              if (!/^[A-Za-z0-9+/]+={0,2}$/.test(sign)) throw invalid();
              await image(page, rect, Buffer.from(sign, 'base64'), false);
            } else if (['2', '3', '4'].includes(text(c.input_value)))
              await resource(
                page,
                rect,
                c.input_value === '2' ? 'applicantImage' : c.input_value === '3' ? 'remandImage' : 'approveImage',
              );
            break;
          case 'Image':
          case 'FreeText':
          case 'FixedText':
          case 'FreeDraw':
          case 'DrawingImage': {
            if (text(c.is_hidden) !== '1' || c.cluster_type === 'DrawingImage')
              await image(
                page,
                rect,
                bytes(c.image_file),
                true,
                c.cluster_type === 'FreeDraw' && data.settings.PDF_FREE_DRAW_FORMAT === 'JPEG',
              );
            if (c.cluster_type === 'DrawingImage')
              drawPins(page, xmlCluster(xmlTop, sheetNo, number(c.cluster_id)), width, height);
            break;
          }
          case 'Check': {
            const name = p.Marker ?? '',
              c1 = color(p.LineColor);
            if (truth(c.input_value))
              marker(
                page,
                rect,
                name,
                c1,
                Math.min(7, Math.max(0, number(p.LineWidth ?? 2))) / 2,
                !p.BrushColor || p.BrushColor === ' ' ? undefined : color(p.BrushColor),
              );
            else if (name === 'CheckBox')
              rectangle(
                page,
                inset(rect, Math.min(rect.width, rect.height) * 0.8, Math.min(rect.width, rect.height) * 0.8),
                c1,
                false,
                1.5,
              );
            break;
          }
          case 'MultipleChoiceNumber': {
            const value = text(c.display_value),
              i = items(p.Labels).indexOf(value);
            if (i < 0 || !value) break;
            const markers = items(p.Markers),
              colors = items(p.Colors),
              lineColors = items(p.LineColors),
              brushes = items(p.BrushColors),
              widths = items(p.LineWidths);
            if (
              [markers, colors, lineColors, brushes, widths].every((a) => i < a.length) &&
              ['FillOval', 'FillRect', 'HorizontalLine'].includes(markers[i])
            )
              marker(
                page,
                rect,
                markers[i],
                color(lineColors[i]),
                number(widths[i]) / 2,
                brushes[i] === ' ' ? undefined : color(brushes[i]),
              );
            await drawText(page, inset(rect, rect.width * 0.8, rect.height * 0.8), value, {
              ...p,
              Color: colors[i] ?? p.Color,
            });
            break;
          }
          case 'AudioRecording': {
            const recorded = number(c.recording_file_length) > 0;
            if (!p.DisplayMode || p.DisplayMode === '0')
              await resource(page, rect, recorded ? 'AudioRecordingDone' : 'AudioRecordingEmpty');
            else {
              if (recorded)
                p = {
                  ...p,
                  FontSize: p.RecordedFontSize,
                  Color: p.RecordedColor,
                  Weight: p.RecordedWeight,
                  Align: p.RecordedAlign,
                  VerticalAlignment: p.RecordedVerticalAlignment,
                  BackgroundColor: p.RecordedBackgroundColor,
                };
              if (p.BackgroundColor && p.BackgroundColor !== 'NoFill')
                rectangle(page, rect, color(p.BackgroundColor), true);
              await drawText(page, rect, (recorded ? p.RecordedMessage : p.Message) ?? '', p);
            }
            break;
          }
          case 'Action':
            if (p.OutputVisible !== '1') break;
            if (text(c.display_value) && c.display_value === p.FinishMessage)
              await drawText(page, rect, text(c.display_value), p);
            else {
              if (p.ButtonMode === '1' && p.BackgroundColor && p.BackgroundColor !== 'NoFill')
                page.drawSvgPath(
                  `M 2.5 0 H ${rect.width - 2.5} A 2.5 2.5 0 0 1 ${rect.width} 2.5 V ${rect.height - 2.5} A 2.5 2.5 0 0 1 ${rect.width - 2.5} ${rect.height} H 2.5 A 2.5 2.5 0 0 1 0 ${rect.height - 2.5} V 2.5 A 2.5 2.5 0 0 1 2.5 0 Z`,
                  { x: rect.x, y: -rect.y, color: color(p.BackgroundColor) },
                );
              await drawText(page, rect, p.DisplayString ?? '', {
                ...p,
                FontSize: p.ButtonFontSize ?? '3',
                Color: p.ButtonFontColor,
                Weight: p.ButtonWeight,
                Align: p.ButtonFontAlign,
                Lines: p.ButtonLines,
                VerticalAlignment: p.ButtonFontVerticalAlignment,
                FontPriority: p.ButtonFontPriority,
              });
            }
            break;
          case 'Registration':
          case 'LatestUpdate': {
            const registered = c.cluster_type === 'Registration',
              id = text(top[registered ? 'sys_regist_user' : 'sys_update_user']),
              name = text(top[registered ? 'regist_name' : 'update_name']);
            await drawText(
              page,
              rect,
              p.DisplayUserName === 'UserIDandName' ? id + ':' + name : p.DisplayUserName === 'UserID' ? id : name,
              p,
            );
            break;
          }
          case 'RegistrationDate':
          case 'LatestUpdateDate': {
            const value = text(top[c.cluster_type === 'RegistrationDate' ? 'regist_time' : 'update_time']);
            if (!value) break;
            const date = new Date(value.replace(' ', 'T'));
            if (!Number.isFinite(date.getTime())) throw invalid();
            let formatted: string;
            try {
              formatted = reportNameDate(
                date,
                (p.DateFormat ?? 'yyyy/MM/dd').replaceAll('(ccc)', '(ddd)'),
                data.locale,
              );
            } catch (error) {
              if (error instanceof ReportUnsupported) throw pending();
              throw error;
            }
            await drawText(page, rect, formatted, p);
            break;
          }
          default:
            if (
              ['Numeric', 'InputNumeric', 'NumberHours', 'Calculate', 'TimeCalculate'].includes(text(c.cluster_type)) &&
              text(c.display_value) &&
              text(c.input_value)
            ) {
              for (const limit of ['AllowMin', 'AllowMax']) {
                if (!truth(p[limit + 'CanUse'])) continue;
                if (p[limit + 'Cluster'] && xmlTop) {
                  const reference = p[limit + 'Cluster'];
                  const sheet = Number(reference.match(/S+(\d+)/)?.[1] ?? sheetNo);
                  const id = Number(reference.match(/C+(\d+)/)?.[1]);
                  const target = xmlCluster(xmlTop, sheet, id),
                    current = xmlCluster(xmlTop, sheetNo, number(c.cluster_id));
                  if (
                    !target ||
                    !optionalField(target, 'value') ||
                    (current &&
                      !optionalField(current, 'inputParameters')
                        .split(';')
                        .some((part) => part.includes('=') && part.split('=')[0] === limit + 'Value'))
                  )
                    continue;
                }
                const raw = text(c.input_value).replaceAll(',', '').trim();
                let value = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw) ? Number(raw) : NaN;
                if (['NumberHours', 'TimeCalculate'].includes(text(c.cluster_type)) && p.TimeUnit === 'Hour')
                  value /= 60;
                const threshold = Number(p[limit + 'Value'] ?? 0);
                if (
                  Number.isFinite(value) &&
                  Number.isFinite(threshold) &&
                  (limit === 'AllowMin' ? value < threshold : value > threshold)
                ) {
                  if (p[limit + 'BackgroundColor'] && p[limit + 'BackgroundColor'] !== 'NoFill')
                    rectangle(page, rect, color(p[limit + 'BackgroundColor']), true);
                  p = {
                    ...p,
                    Color: p[limit + 'FontColor'],
                    FontSize: p[limit + 'FontSize'],
                    Weight: p[limit + 'FontWeight'],
                  };
                  break;
                }
              }
            }
            await drawText(page, rect, text(c.display_value), p);
        }
      }
      if (preview.isInitJudgeDisplay && changed(c, data)) {
        let c1 = rgb(1, 0, 0);
        if (text(top.use_init_input_judge_parameters)) {
          const format = child(root(text(top.use_init_input_judge_parameters)), 'format');
          if (format && optionalField(format, 'color')) c1 = color(optionalField(format, 'color'));
        }
        rectangle(page, rect, c1, false, 3);
      }
      if (preview.isClusterLine && (preview.clusterId === -1 || preview.clusterId === number(c.cluster_id))) {
        rectangle(page, rect, rgb(188 / 255, 151 / 255, 16 / 255));
        if (preview.clusterId === -1)
          await drawText(page, rect, text(c.cluster_id), {
            ...p,
            Align: 'Center',
            VerticalAlignment: '1',
            Weight: 'Bold',
            Color: '188,151,16',
            Lines: '1',
            Punctuation: '',
            FontPriority: '',
          });
      }
    }
    for (const layer of data.layers.filter((l) => number(l.rep_sheet_no) === sheetNo)) {
      const embedded = await pdf.embedPng(await sharp(bytes(layer.image_file)).png().toBuffer());
      page.drawImage(embedded, { x: 0, y: -height, width, height });
    }
    page.pushOperators(popGraphicsState());
  }
  for (const row of data.freeDraw) {
    const source = await PDFDocument.load(bytes(row.pdf_file));
    if (!source.getPageCount()) throw invalid();
    const [page] = await pdf.copyPages(source, [0]);
    pdf.insertPage(Math.min(number(row.sheet_index) - 1, pdf.getPageCount()), page);
  }
  return Buffer.from(await pdf.save());
}
