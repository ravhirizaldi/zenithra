import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import sharp from 'sharp';
import {
  PDFDocument,
  PDFArray,
  PDFDict,
  PDFName,
  PDFRawStream,
  decodePDFRawStream,
  StandardFonts,
  degrees,
  rgb,
} from 'pdf-lib';
import { renderDocumentPdf, documentPdfTextLayout } from '../../../../src/services/manager/documents/pdf.js';
import { documentPdfOptions, type DocumentPdfData, type PdfRow } from '../../../../src/models/manager/documents/pdf.js';

async function fixture(): Promise<DocumentPdfData> {
  const background = await PDFDocument.create();
  for (const width of [300, 400])
    background.addPage([width, 600]).drawRectangle({ x: 0, y: 590, width, height: 10, color: rgb(0.2, 0.2, 0.2) });
  return {
    preview: { repTopId: 1, defTopId: 100, sheetNo: -1, clusterId: -1, ...documentPdfOptions({}) },
    top: {
      background_image_file: Buffer.from(await background.save()),
      display_sheet_number: '1,3',
      rep_sheet_count: 2,
      no_need_to_fill_type: 0,
      xml_data: '<conmas><top/></conmas>',
    },
    sheets: [
      { rep_sheet_no: 1, sheet_no_org: 1 },
      { rep_sheet_no: 3, sheet_no_org: 3 },
    ],
    clusters: [],
    layers: [],
    freeDraw: [],
    history: [],
    settings: {},
    locale: 'en-US',
  };
}
function cluster(input: PdfRow = {}): PdfRow {
  return {
    rep_sheet_id: 11,
    rep_sheet_no: 1,
    cluster_id: 1,
    cluster_type: 'Text',
    input_parameter: 'FontSize=14;Align=Left;VerticalAlignment=0',
    left_position: 0.1,
    top_position: 0.1,
    right_position: 0.9,
    bottom_position: 0.2,
    input_value: 'visible',
    display_value: 'visible',
    cluster_role: '1',
    recording_file_length: 0,
    ...input,
  };
}
function operators(pdf: PDFDocument, index = 0) {
  const contents = pdf.getPage(index).node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => pdf.context.lookup(ref)) : [contents];
  return streams
    .map((stream) =>
      stream instanceof PDFRawStream ? Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1') : '',
    )
    .join('\n');
}
const hex = (text: string) => Buffer.from(text, 'latin1').toString('hex').toUpperCase();

test('populated report overlays stored display values, preserves backgrounds, masks restricted clusters and omits invisible values', async () => {
  const data = await fixture();
  data.clusters = [
    cluster(),
    cluster({ cluster_id: 2, cluster_role: '2', input_value: 'restricted-input', display_value: 'restricted-display' }),
    cluster({ cluster_id: 3, input_parameter: 'Visible=0', display_value: 'not-for-output' }),
  ];
  const pdf = await PDFDocument.load(await renderDocumentPdf(data));
  assert.equal(pdf.getPageCount(), 2);
  const content = operators(pdf);
  assert.match(content, new RegExp(hex('visible')));
  for (const hidden of ['restricted-input', 'restricted-display', 'not-for-output'])
    assert(!content.includes(hex(hidden)));
  assert.match(content, /1 0 0 1 0 590 cm/);
  assert.match(content, /0\.75 0\.75 0\.75 rg/);
  assert.match(content, /Do/);
  assert.equal(pdf.getPage(1).getWidth(), 400);
});

test('sparse sheet selection and added-sheet original mapping preserve page geometry and insert only whole-report FreeDraw', async () => {
  const data = await fixture();
  data.preview.sheetNo = 3;
  let pdf = await PDFDocument.load(await renderDocumentPdf(data));
  assert.equal(pdf.getPageCount(), 1);
  assert.equal(pdf.getPage(0).getWidth(), 400);
  data.preview.sheetNo = -1;
  data.top.display_sheet_number = '1,3,4';
  data.sheets = [
    { rep_sheet_no: 1, sheet_no_org: 1 },
    { rep_sheet_no: 3, sheet_no_org: 2 },
    { rep_sheet_no: 4, sheet_no_org: 1 },
  ];
  const fd = await PDFDocument.create();
  fd.addPage([120, 180]);
  fd.addPage([90, 90]);
  data.freeDraw = [{ sheet_index: 2, pdf_file: Buffer.from(await fd.save()) }];
  pdf = await PDFDocument.load(await renderDocumentPdf(data));
  assert.deepEqual(
    pdf.getPages().map((p) => p.getWidth()),
    [300, 120, 400, 300],
  );
  data.top.display_sheet_number = '1,9';
  await assert.rejects(renderDocumentPdf(data), /PDF data is invalid/);
});

test('empty display order uses sequential backgrounds and ignores unused original-sheet markers', async () => {
  for (const display of [null, '']) {
    const data = await fixture();
    data.top.display_sheet_number = display;
    data.sheets = [
      { rep_sheet_no: 1, sheet_no_org: 0 },
      { rep_sheet_no: 2, sheet_no_org: 0 },
    ];
    data.clusters = [cluster(), cluster({ rep_sheet_no: 2, display_value: 'second-page' })];
    let pdf = await PDFDocument.load(await renderDocumentPdf(data));
    assert.deepEqual(
      pdf.getPages().map((page) => page.getWidth()),
      [300, 400],
    );
    assert.match(operators(pdf), new RegExp(hex('visible')));
    assert.match(operators(pdf, 1), new RegExp(hex('second-page')));
    data.preview.sheetNo = 2;
    pdf = await PDFDocument.load(await renderDocumentPdf(data));
    assert.equal(pdf.getPageCount(), 1);
    assert.equal(pdf.getPage(0).getWidth(), 400);
    assert.match(operators(pdf), new RegExp(hex('second-page')));
    assert.doesNotMatch(operators(pdf), new RegExp(hex('visible')));
    data.top.display_sheet_number = '1,2';
    await assert.rejects(renderDocumentPdf(data), /PDF data is invalid/);
  }
});

test('all four crop/rotation transforms put overlays in the visible upright coordinate system', async () => {
  for (const rotation of [0, 90, 180, 270]) {
    const data = await fixture(),
      background = await PDFDocument.create(),
      page = background.addPage([300, 600]);
    page.setCropBox(20, 30, 200, 400);
    page.setRotation(degrees(rotation));
    data.top.background_image_file = Buffer.from(await background.save());
    data.top.display_sheet_number = '1';
    data.clusters = [cluster()];
    const pdf = await PDFDocument.load(await renderDocumentPdf(data));
    assert.equal(pdf.getPage(0).getRotation().angle, rotation);
    const matrix =
      rotation === 0
        ? '1 0 0 1 20 430 cm'
        : rotation === 90
          ? '0 1 -1 0 20 30 cm'
          : rotation === 180
            ? '-1 0 0 -1 220 30 cm'
            : '0 -1 1 0 220 430 cm';
    assert(operators(pdf).includes(matrix));
  }
});

test('text fitting follows alignment, wrapping, source deduction and explicitly disabled auto-size overflow', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica);
  const rect = { x: 10, y: 20, width: 60, height: 30 };
  const fitted = documentPdfTextLayout(
    font,
    'A long stored value',
    rect,
    { FontSize: '20', Align: 'Right', VerticalAlignment: '2' },
    2,
  );
  assert(fitted.size < 20);
  assert(fitted.lines.every((l) => font.widthOfTextAtSize(l.value, fitted.size) <= 60));
  assert.equal(fitted.lines[0].x, 70 - font.widthOfTextAtSize(fitted.lines[0].value, fitted.size));
  const wrapped = documentPdfTextLayout(font, 'A long\nsecond line', rect, {
    FontSize: '14',
    Lines: '2',
    Punctuation: '2',
  });
  assert(wrapped.lines.length >= 2);
  const overflow = documentPdfTextLayout(font, 'A long stored value', rect, {
    FontSize: '20',
    EnableAutoFontSize: '0',
  });
  assert.equal(overflow.size, 20);
  assert(overflow.lines.length > 1);
});

test('images/signatures/approval/audio/check/choice/numeric/audit/action writers produce populated output', async () => {
  const data = await fixture();
  const image = await sharp({ create: { width: 20, height: 10, channels: 4, background: '#123456' } })
    .png()
    .toBuffer();
  data.top.regist_name = 'Registrar';
  data.top.regist_time = '2026-11-10 12:30:00';
  data.clusters = [
    ...['Image', 'FreeText', 'FixedText', 'FreeDraw', 'DrawingImage'].map((type, i) =>
      cluster({ cluster_id: i + 1, cluster_type: type, image_file: image }),
    ),
    cluster({ cluster_id: 6, cluster_type: 'Approve', input_value: '4', approval_sign: image.toString('base64') }),
    cluster({ cluster_id: 7, cluster_type: 'Approve', input_value: '2' }),
    cluster({ cluster_id: 8, cluster_type: 'Create', input_value: '3' }),
    cluster({ cluster_id: 9, cluster_type: 'Inspect', input_value: '4' }),
    cluster({
      cluster_id: 10,
      cluster_type: 'Check',
      input_value: 'TRUE',
      input_parameter: 'Marker=CheckBox;LineColor=255,0,0',
    }),
    cluster({
      cluster_id: 11,
      cluster_type: 'MultipleChoiceNumber',
      display_value: 'choice',
      input_parameter: 'Labels=choice;Markers=FillOval;Colors=0,,0,,0;LineColors=255,,0,,0;BrushColors= ;LineWidths=2',
    }),
    cluster({
      cluster_id: 12,
      cluster_type: 'Numeric',
      input_value: '11',
      display_value: 'threshold',
      input_parameter:
        'AllowMaxCanUse=1;AllowMaxValue=10;AllowMaxFontColor=255,0,0;AllowMaxFontSize=12;AllowMaxBackgroundColor=255,255,0',
    }),
    cluster({ cluster_id: 13, cluster_type: 'Registration', input_parameter: 'DisplayUserName=UserName' }),
    cluster({ cluster_id: 14, cluster_type: 'RegistrationDate', input_parameter: 'DateFormat=yyyy-MM-dd HH:mm' }),
    cluster({
      cluster_id: 15,
      cluster_type: 'Action',
      input_parameter: 'OutputVisible=1;ButtonMode=1;BackgroundColor=0,255,0;DisplayString=Action;ButtonFontSize=14',
    }),
    cluster({ cluster_id: 16, cluster_type: 'AudioRecording' }),
    cluster({
      cluster_id: 17,
      cluster_type: 'AudioRecording',
      recording_file_length: 3,
      input_parameter: 'DisplayMode=1;RecordedMessage=Recorded;RecordedFontSize=14;RecordedColor=255,0,0',
    }),
  ];
  data.settings.PDF_FREE_DRAW_FORMAT = 'JPEG';
  const content = operators(await PDFDocument.load(await renderDocumentPdf(data)));
  for (const value of ['choice', 'threshold', 'Registrar', '2026-11-10 12:30', 'Action', 'Recorded'])
    assert(content.includes(hex(value)), value);
  assert.match(content, /1 0 0 rg/);
  assert.match(content, /1 1 0 rg/);
  assert.match(content, /Do/);
});

test('all no-need-to-fill marks, selected cluster frames, layer selection and initial-input comparison are rendered', async () => {
  for (const type of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const data = await fixture();
    data.top.no_need_to_fill_type = type;
    data.clusters = [cluster({ display_value: '', input_value: '', verified: '1' })];
    assert((await renderDocumentPdf(data)).subarray(0, 4).equals(Buffer.from('%PDF')));
  }
  const data = await fixture();
  data.preview.isClusterLine = true;
  data.preview.clusterId = 1;
  data.preview.isInitJudgeDisplay = true;
  data.preview.isLayer = true;
  data.top.use_init_input_judge_parameters = '<judge><format><color>0,255,0</color></format></judge>';
  data.clusters = [cluster()];
  data.history = [{ rep_sheet_id: 11, cluster_id: 1, init_history_input: 1, input_value: 'old' }];
  const image = await sharp({ create: { width: 10, height: 10, channels: 4, background: '#fff' } })
    .png()
    .toBuffer();
  data.layers = [{ rep_sheet_no: 1, image_file: image }];
  let content = operators(await PDFDocument.load(await renderDocumentPdf(data)));
  assert.match(content, /0 1 0 RG/);
  assert.match(content, /Do/);
  data.settings.INITIAL_VALUE_CHANGE_DISPLAY_TYPE = '1';
  data.history = [
    { rep_sheet_id: 11, cluster_id: 1, init_history_input: 1, input_value: '', verified: '1' },
    { rep_sheet_id: 11, cluster_id: 1, init_history_input: 0, input_value: 'visible', verified: '0' },
  ];
  content = operators(await PDFDocument.load(await renderDocumentPdf(data)));
  assert.doesNotMatch(content, /0 1 0 RG/);
});

test('unmigrated trail output, malformed geometry and missing glyphs fail before returning a PDF', async () => {
  const data = await fixture();
  data.top.xml_data = '<conmas><top><trailOutput>1</trailOutput></top></conmas>';
  await assert.rejects(renderDocumentPdf(data), /requires PDF output/);
  data.clusters = [cluster({ display_value: '\u{10FFFF}' })];
  data.top.xml_data = '<conmas><top/></conmas>';
  await assert.rejects(renderDocumentPdf(data), /font that supports/);
  data.clusters = [cluster({ left_position: null })];
  await assert.rejects(renderDocumentPdf(data), /PDF data is invalid/);
});

test('DrawingImage pins preserve background coordinates, all eight direction glyphs and cluster access', async () => {
  const data = await fixture();
  data.clusters = [cluster({ cluster_type: 'DrawingImage' })];
  const detail = (shape: number, direction: number) =>
    `<pinDetail><pinPointForBackground>0.2,0.3</pinPointForBackground><connectPointForBackground>0.8,0.7</connectPointForBackground><pinColor>0,255,0</pinColor><pinShape>${shape}</pinShape><pinDirection>${direction}</pinDirection></pinDetail>`;
  const xml = (pins: string) =>
    `<conmas><top><sheets><sheet><sheetNo>1</sheetNo><clusters><cluster><clusterId>1</clusterId><pin>${pins}</pin></cluster></clusters></sheet></sheets></top></conmas>`;
  data.top.xml_data = xml(
    detail(0, 0) + Array.from({ length: 8 }, (_, i) => detail(1, i + 1)).join('') + '<pinDetail/>',
  );
  let content = operators(await PDFDocument.load(await renderDocumentPdf(data)));
  assert.match(content, /60 -180 m\s+240 -420 l/);
  assert.equal(content.match(/0 1 1 rg/g)?.length, 8);
  assert.equal(content.match(/0\.3 w/g)?.length, 8);
  data.clusters[0].cluster_role = '2';
  content = operators(await PDFDocument.load(await renderDocumentPdf(data)));
  assert.doesNotMatch(content, /0 1 1 rg|60 -180 m/);
  data.clusters[0].cluster_role = '1';
  data.top.xml_data = xml(detail(1, 1).replace('0.2,0.3', 'NaN,0.3'));
  await assert.rejects(renderDocumentPdf(data), /PDF data is invalid/);
});

test('numeric reference gates use source XML presence, not recalculated values or JavaScript-only numeric syntax', async () => {
  const data = await fixture();
  data.clusters = [
    cluster({
      cluster_type: 'Numeric',
      input_value: '11',
      input_parameter: 'AllowMaxCanUse=1;AllowMaxValue=10;AllowMaxCluster=S1C2;AllowMaxFontColor=255,0,0',
    }),
  ];
  const xml = (parameter: string, value: string) =>
    `<conmas><top><sheets><sheet><sheetNo>1</sheetNo><clusters><cluster><clusterId>1</clusterId><inputParameters>${parameter}</inputParameters></cluster><cluster><clusterId>2</clusterId><value>${value}</value></cluster></clusters></sheet></sheets></top></conmas>`;
  for (const [parameter, value, expected] of [
    ['AllowMaxValue=10', '999', true],
    ['AllowMaxValue=', '1', true],
    ['', '1', false],
    ['AllowMaxValue=10', '', false],
  ] as const) {
    data.top.xml_data = xml(parameter, value);
    const content = operators(await PDFDocument.load(await renderDocumentPdf(data)));
    assert.equal(/1 0 0 rg/.test(content), expected);
  }
  data.top.xml_data = null;
  assert.match(operators(await PDFDocument.load(await renderDocumentPdf(data))), /1 0 0 rg/);
  data.clusters[0].input_value = '0x20';
  assert.doesNotMatch(operators(await PDFDocument.load(await renderDocumentPdf(data))), /1 0 0 rg/);
});

test('FixedText and FreeDraw initial baselines retain their source-specific empty-binary rules', async () => {
  const data = await fixture();
  data.preview.isInitJudgeDisplay = true;
  data.settings.INITIAL_VALUE_CHANGE_DISPLAY_TYPE = '1';
  data.clusters = [cluster({ cluster_type: 'FixedText', binary_file_length: 8 })];
  data.history = [
    { rep_sheet_id: 11, cluster_id: 1, init_history_input: 1, binary_file_length: 0, verified: '0' },
    { rep_sheet_id: 11, cluster_id: 1, init_history_input: 0, binary_file_length: 8, verified: '0' },
  ];
  assert.doesNotMatch(operators(await PDFDocument.load(await renderDocumentPdf(data))), /1 0 0 RG/);
  data.clusters = [
    cluster({
      cluster_type: 'FreeDraw',
      binary_file_type: 'Windows',
      binary_file_length: 9,
      binary_file_length_win: 8,
    }),
  ];
  data.history = [
    {
      rep_sheet_id: 11,
      cluster_id: 1,
      init_history_input: 1,
      binary_file_type: 'Windows',
      binary_file_length: 9,
      binary_file_length_win: 0,
      verified: '1',
    },
    {
      rep_sheet_id: 11,
      cluster_id: 1,
      init_history_input: 0,
      binary_file_type: 'Windows',
      binary_file_length: 9,
      binary_file_length_win: 8,
      verified: '0',
    },
  ];
  assert.match(operators(await PDFDocument.load(await renderDocumentPdf(data))), /1 0 0 RG/);
  data.history[0].binary_file_length = 0;
  assert.doesNotMatch(operators(await PDFDocument.load(await renderDocumentPdf(data))), /1 0 0 RG/);
});

test('six bundled original bitmap resources are valid PNGs; no .NET object is used at runtime', async () => {
  for (const name of [
    'invisible',
    'approveImage',
    'applicantImage',
    'remandImage',
    'AudioRecordingEmpty',
    'AudioRecordingDone',
  ]) {
    const image = await readFile(`public/report-pdf/${name}.png`);
    assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const metadata = await sharp(image).metadata();
    assert(metadata.width && metadata.height);
  }
});

const cjkFont = process.platform === 'win32' ? 'C:/Windows/Fonts/msgothic.ttc' : '/mnt/c/Windows/Fonts/msgothic.ttc';
const latinFont = process.platform === 'win32' ? 'C:/Windows/Fonts/arial.ttf' : '/mnt/c/Windows/Fonts/arial.ttf';
test(
  'English PDF retains configured Latin fonts and falls back for Unicode labels without losing glyphs',
  { skip: !existsSync(cjkFont) || !existsSync(latinFont) },
  async () => {
    for (const configured of ['', latinFont]) {
      const data = await fixture();
      data.settings.FONT_FILE_PATH = configured;
      data.clusters = [
        cluster({ display_value: 'Latin label' }),
        cluster({ cluster_id: 2, display_value: '漢字', input_parameter: 'Weight=Bold' }),
      ];
      const pdf = await PDFDocument.load(await renderDocumentPdf(data));
      const objects = pdf.context.enumerateIndirectObjects().map(([, object]) => object);
      const names = objects
        .filter((object) => object instanceof PDFDict && object.has(PDFName.of('BaseFont')))
        .map((object) => (object as PDFDict).get(PDFName.of('BaseFont'))?.toString())
        .join(' ');
      assert.match(names, configured ? /Arial/ : /Helvetica/);
      assert.match(names, /Gothic/i);
      assert.match(operators(pdf), /2 Tr/);
      const streams = objects
        .filter((object) => object instanceof PDFRawStream)
        .map((object) => Buffer.from(decodePDFRawStream(object as PDFRawStream).decode()).toString('latin1'));
      assert(streams.some((stream) => /6F22/i.test(stream) && /5B57/i.test(stream)));
      data.clusters.push(cluster({ cluster_id: 3, display_value: '\u{10FFFF}' }));
      await assert.rejects(renderDocumentPdf(data), /font that supports/);
    }
  },
);
test(
  'installed TTC face renders Unicode with embedded glyph maps and synthetic bold/italic styles',
  { skip: !existsSync(cjkFont) },
  async () => {
    const data = await fixture();
    data.settings.FONT_FILE_PATH = cjkFont + ',0';
    data.clusters = ['Normal', 'Bold', 'Italic'].map((weight, index) =>
      cluster({ cluster_id: index + 1, display_value: '漢字', input_parameter: 'Weight=' + weight }),
    );
    const pdf = await PDFDocument.load(await renderDocumentPdf(data));
    const content = operators(pdf);
    assert.match(content, /2 Tr/);
    const maps = pdf.context
      .enumerateIndirectObjects()
      .filter(([, object]) => object instanceof PDFRawStream)
      .map(([, object]) => Buffer.from(decodePDFRawStream(object as PDFRawStream).decode()).toString('latin1'));
    assert(maps.some((map) => /6F22/i.test(map) && /5B57/i.test(map)));
  },
);
