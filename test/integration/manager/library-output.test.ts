import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Script } from 'node:vm';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import sharp from 'sharp';
import { createApp } from '../../helpers/app.js';
import { legacyPassword } from '../../../src/shared/legacy-auth.js';
import { labelModes } from '../../../src/models/manager/labels/index.js';
import {
  changeLibraryDocuments,
  libraryBinary,
  libraryDocument,
  libraryInput,
  libraryList,
  libraryMode,
  libraryModes,
  LibraryPendingError,
  libraryIrfdContent,
  managerLibraryPermissions,
  managerTabAllowed,
  saveLibraryDocument,
  type LibraryFile,
} from '../../../src/models/manager/library/index.js';
import { irfdAttachments, irfdImageLocation, irfdImagePreview, irfdLocation } from '../../../src/shared/irfd.js';
import {
  outputAuthorize,
  outputCsvFiles,
  outputLayoutInput,
  outputLayouts,
  outputList,
  outputSelection,
  saveOutputLayout,
} from '../../../src/models/manager/data-output/index.js';

const enabled = { skip: !process.env.DATABASE_URL };
async function fixture(run: (db: pg.Pool, client: pg.PoolClient, directory: string) => Promise<void>) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }),
    client = await pool.connect();
  const db = {
    query: client.query.bind(client),
    connect: async () => ({ query: client.query.bind(client), release() {} }),
  } as unknown as pg.Pool;
  const directory = await mkdtemp('/tmp/opencode/manager-library-output-');
  try {
    await client.query('CREATE TEMP SEQUENCE mst_document_document_id_seq START 100');
    assert.equal(
      (
        await client.query(
          "SELECT 'mst_document_document_id_seq'::regclass::oid='pg_temp.mst_document_document_id_seq'::regclass::oid AS private",
        )
      ).rows[0].private,
      true,
    );
    const tables = new Set([
      'mst_user',
      'mst_group',
      'mst_group_affiation',
      'mst_common',
      'document_lock',
      'rep_lock',
      'user_lock',
      'mst_common_document',
      'mst_report_document',
      'mst_image_document',
      'common_document_irfd',
      'common_document_irfd_role',
      'def_report_document',
      'rep_report_document',
      'def_top',
      'rep_top',
      'def_role',
      'rep_role',
      'def_current',
      'rep_current',
      'def_label',
      'rep_label',
      'rep_sheet',
      'rep_cluster',
      'rep_layer',
      'def_sheet',
      'data_output_layout',
      'log_library_refer',
      'log_library_download',
    ]);
    for (const mode of Object.values(labelModes)) {
      tables.add(mode.table);
      tables.add(mode.role);
    }
    for (const category of Object.values(libraryModes)) {
      tables.add(`mst_${category}_document_role`);
      tables.add(`${category}_document_label`);
    }
    for (const table of tables) await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    await client.query(`INSERT INTO pg_temp.mst_group (group_id,group_name,group_name_path,role_library_read,role_library_create,role_library_update,role_library_delete,role_data_output,
      role_label_read_manager,role_label_create_manager,role_label_update_manager,role_label_delete_manager)
      VALUES (10,'A','A',1,1,1,1,1,1,1,1,1),(20,'B','B',0,0,0,0,0,0,0,0,0),(-999,'Hidden','Hidden',0,0,0,0,0,0,0,0,0);
      INSERT INTO pg_temp.mst_group_affiation (user_id,group_id) VALUES ('fixture',10),('conmasadmin',10),('denied',20);
      INSERT INTO pg_temp.mst_user (user_id,user_name,use_start_time,use_end_time) VALUES ('fixture','Fixture','2020-01-01','2038-01-01'),('conmasadmin','Admin','2020-01-01','2038-01-01');
      INSERT INTO pg_temp.mst_common (com_key,com_name,com_index,com_value) VALUES ('LIBRARY','FILE_LOCATION',0,'0'),('DEFAULT_PAGE_SIZE','DEFAULT',0,'2')`);
    await client.query(
      "INSERT INTO pg_temp.mst_common (com_key,com_name,com_index,com_value) VALUES ('LIBRARY','BASE_FOLDER',0,$1)",
      [directory],
    );
    await client.query("UPDATE pg_temp.mst_user SET password=$1 WHERE user_id='conmasadmin'", [
      legacyPassword('conmasadmin', 'fixture-password', process.env.CONMAS_LEGACY_KEY ?? 'fixture-key'),
    ]);
    await run(db, client, directory);
  } finally {
    client.release();
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
}
const input = (name = 'File', id = 0, storage = 0): Record<string, unknown> => ({
  'Document.document_id': String(id),
  'Document.document_name': name,
  'Document.document_save_kbn': String(storage),
  'Document.document_type': 'OTHERS',
  'Document.document_type_url': 'URL',
  'Document.document_path': 'https://example.invalid/reference',
  'Document.document_mobile_save': '1',
  'Document.IsOtherAppOpen': '1',
  'Document.Remarks': 'Notes',
});
const options = { create: true, labels: [], roles: { '10': { read: true, edit: false } }, noRoles: false };
function scripts(html: string) {
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi))
    if (match[1].trim()) new Script(match[1]);
}

function varint(value: bigint | number) {
  let n = BigInt.asUintN(64, BigInt(value));
  const bytes = [];
  do {
    const byte = Number(n & 127n);
    n >>= 7n;
    bytes.push(byte | (n ? 128 : 0));
  } while (n);
  return Buffer.from(bytes);
}
function protoBytes(field: number, data: Buffer | string) {
  const bytes = typeof data === 'string' ? Buffer.from(data) : data;
  return Buffer.concat([varint(field * 8 + 2), varint(bytes.length), bytes]);
}
function irfdFixture(items: { data: Buffer | string; name: string; format: string; pageNumber: number }[]) {
  return Buffer.concat([
    protoBytes(1, 'opaque drawing bytes'),
    ...items.map((item) =>
      protoBytes(
        2,
        Buffer.concat([
          protoBytes(1, item.data),
          protoBytes(2, item.name),
          protoBytes(3, item.format),
          varint(32),
          varint(item.pageNumber),
        ]),
      ),
    ),
  ]);
}
function gpsFixture(little = true, ns = 'S', ew = 'W') {
  const tiff = Buffer.alloc(160);
  const u16 = (value: number, offset: number) =>
    little ? tiff.writeUInt16LE(value, offset) : tiff.writeUInt16BE(value, offset);
  const u32 = (value: number, offset: number) =>
    little ? tiff.writeUInt32LE(value, offset) : tiff.writeUInt32BE(value, offset);
  tiff.write(little ? 'II' : 'MM');
  u16(42, 2);
  u32(8, 4);
  u16(1, 8);
  u16(0x8825, 10);
  u16(4, 12);
  u32(1, 14);
  u32(26, 18);
  u16(6, 26);
  for (const [index, [tag, type, count, value]] of [
    [1, 2, 2, ns.charCodeAt(0)],
    [2, 5, 3, 104],
    [3, 2, 2, ew.charCodeAt(0)],
    [4, 5, 3, 128],
    [5, 1, 1, 1],
    [6, 5, 1, 152],
  ].entries()) {
    const offset = 28 + index * 12;
    u16(tag, offset);
    u16(type, offset + 2);
    u32(count, offset + 4);
    if (type === 2 || type === 1) tiff[offset + 8] = value;
    else u32(value, offset + 8);
  }
  for (const [index, value] of [6, 30, 0, 106, 45, 0, 25].entries()) {
    u32(value, 104 + index * 8);
    u32(index === 6 ? 2 : 1, 108 + index * 8);
  }
  return Buffer.concat([Buffer.from('Exif\0\0'), tiff]);
}

test('IRFD parser preserves attachment identity/defaults/order and safely rejects truncated/invalid protobuf', () => {
  const items = [
    { data: Buffer.from([0, 1, 255]), name: '画像/<&>', format: 'png', pageNumber: 2 },
    { data: '<text>\nline', name: 'note', format: 'text', pageNumber: -1 },
  ];
  const encoded = irfdFixture(items);
  const decoded = irfdAttachments(encoded);
  assert.deepEqual(
    decoded,
    items.map((item) => ({ ...item, data: Buffer.from(item.data) })),
  );
  const unknown = Buffer.concat([
    varint(80),
    varint(300),
    varint(89),
    Buffer.alloc(8),
    protoBytes(12, 'ignored'),
    varint(107),
    varint(8),
    varint(1),
    varint(108),
    varint(117),
    Buffer.alloc(4),
  ]);
  assert.deepEqual(irfdAttachments(Buffer.concat([encoded, unknown])), decoded);
  assert.deepEqual(irfdAttachments(protoBytes(2, Buffer.alloc(0))), [
    { data: Buffer.alloc(0), name: '', format: '', pageNumber: 0 },
  ]);
  for (const data of [
    Buffer.from([0]),
    Buffer.from([18, 255]),
    Buffer.from([18, 10, 1]),
    Buffer.from([8, ...Array(11).fill(255)]),
    Buffer.from([83, 92]),
    Buffer.from([84]),
    protoBytes(2, protoBytes(2, Buffer.from([255]))),
    Buffer.concat([encoded, Buffer.from([128])]),
  ])
    assert.deepEqual(irfdAttachments(data), []);
  const duplicate = protoBytes(
    2,
    Buffer.concat([protoBytes(2, 'first'), protoBytes(2, 'last'), protoBytes(1, 'image')]),
  );
  assert.equal(irfdAttachments(duplicate)[0].name, 'last');
  assert.equal(irfdAttachments(protoBytes(2, protoBytes(2, '\uFEFFname')))[0].name, '\uFEFFname');
});

test('IRFD GPS handles both TIFF byte orders/directions/defaults and previews use the source 200x150 transparent canvas', async () => {
  for (const little of [true, false]) {
    assert.deepEqual(irfdLocation(gpsFixture(little)), { latitude: -6.5, longitude: -106.75, altitude: 12.5 });
    assert.deepEqual(irfdLocation(gpsFixture(little, 'N', 'E')), { latitude: 6.5, longitude: 106.75, altitude: 12.5 });
  }
  const noAltitude = gpsFixture();
  noAltitude.writeUInt16LE(99, 6 + 28 + 5 * 12);
  assert.equal(irfdLocation(noAltitude)?.altitude, 0);
  const bad = gpsFixture();
  bad.writeUInt32LE(0, 6 + 108);
  assert.equal(irfdLocation(bad), undefined);
  assert.equal(irfdLocation(Buffer.from('invalid')), undefined);
  assert.equal(irfdLocation(gpsFixture().subarray(0, 80)), undefined);
  assert.equal(irfdLocation(), undefined);
  const jpeg = await sharp({ create: { width: 40, height: 10, channels: 3, background: 'red' } })
    .jpeg()
    .toBuffer();
  const exif = gpsFixture(),
    length = Buffer.alloc(2);
  length.writeUInt16BE(exif.length + 2);
  const tagged = Buffer.concat([jpeg.subarray(0, 2), Buffer.from([255, 225]), length, exif, jpeg.subarray(2)]);
  assert.deepEqual(await irfdImageLocation(tagged), { latitude: -6.5, longitude: -106.75, altitude: 12.5 });
  const preview = await irfdImagePreview(tagged),
    metadata = await sharp(preview).metadata();
  assert.equal(metadata.width, 200);
  assert.equal(metadata.height, 150);
  assert.equal(metadata.format, 'png');
  const pixel = await sharp(preview).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
  assert.equal(pixel[3], 0);
  const invalid = Buffer.from('broken image');
  assert.equal(await irfdImagePreview(invalid), invalid);
});

test(
  'IRFD revision content isolates documents and selects latest/exact revisions with audit names and history setting',
  enabled,
  async () =>
    fixture(async (db, client) => {
      const png = await sharp({ create: { width: 4, height: 2, channels: 3, background: 'blue' } })
        .png()
        .toBuffer();
      const content = irfdFixture([
        { data: png, name: 'camera', format: 'png', pageNumber: 3 },
        { data: '<note>', name: 'note', format: 'text', pageNumber: 3 },
        { data: 'ignored', name: 'unknown', format: 'pdf', pageNumber: 1 },
      ]);
      await client.query(
        `INSERT INTO common_document_irfd (document_id,rev_no,document_name,pdf_file_name,irfd_file_name,irfd_file,sys_regist_user,sys_update_user)
    VALUES (1,1,'Old','old.pdf','old.irfd',$1,'fixture','missing'),(1,2,'New','new.pdf','new.irfd',$1,'fixture','missing'),(2,3,'Other','other.pdf','other.irfd',$1,'fixture','missing')`,
        [content],
      );
      const latest = (await libraryIrfdContent(db, 1))!;
      assert.equal(latest.selectedRevision, 2);
      assert.equal(latest.documentName, 'New');
      assert.equal(latest.history.length, 2);
      assert.equal(latest.history[0].created_by, 'Fixture');
      assert.equal(latest.history[0].updated_by, 'missing');
      assert.deepEqual(latest.images, [{ name: 'camera', format: 'png', pageNumber: 3, location: undefined }]);
      assert.deepEqual(latest.texts, [{ pageNumber: 3, text: '<note>' }]);
      assert.equal(latest.useHistory, false);
      await client.query(
        "INSERT INTO mst_common(com_key,com_name,com_index,com_value) VALUES('LIBRARY','FD_USE_HISTORY',0,'1')",
      );
      assert.equal((await libraryIrfdContent(db, 1, 1))!.useHistory, true);
      assert.equal((await libraryIrfdContent(db, 1, 1))!.documentName, 'Old');
      assert.equal(await libraryIrfdContent(db, 1, 3), undefined);
      assert.equal(await libraryIrfdContent(db, 999), undefined);
    }),
);

test(
  'IRFD isolated routes enforce read/row roles and revision/attachment identity, serving exact originals and PNG previews',
  enabled,
  async () =>
    fixture(async (db, client) => {
      const png = await sharp({ create: { width: 8, height: 4, channels: 3, background: 'green' } })
        .png()
        .toBuffer();
      const newer = await sharp(png).negate().png().toBuffer(),
        jpeg = await sharp(png).jpeg().toBuffer();
      const name = '<camera>&名',
        items = [
          { data: png, name, format: 'png', pageNumber: 2 },
          { data: jpeg, name: 'photo', format: 'JPEG', pageNumber: 4 },
          { data: '<script>not executable</script>', name: 'note', format: 'text', pageNumber: 2 },
        ];
      const content = irfdFixture([...items, { data: newer, name, format: 'png', pageNumber: 2 }]),
        latest = irfdFixture([{ ...items[0], data: newer }, ...items.slice(1)]);
      await client.query(`INSERT INTO mst_common_document(document_id,document_name,document_save_kbn) VALUES(1,'FreeDraw',2),(2,'Hidden',2),(3,'Ordinary',0);
    INSERT INTO mst_report_document(document_id,document_name,document_save_kbn) VALUES(2,'Same-ID bypass attempt',0);
    INSERT INTO common_document_irfd_role(document_id,group_id,role_irfd_read,role_irfd_update) VALUES(1,10,1,0),(2,20,1,0)`);
      await client.query(
        `INSERT INTO common_document_irfd(document_id,rev_no,document_name,pdf_file_name,irfd_file_name,irfd_file,pdf_file)
    VALUES(1,1,'Old','old.pdf','old.irfd',$1,$2),(1,2,'Latest','latest.pdf','latest.irfd',$3,$2),(2,3,'Hidden','hidden.pdf','hidden.irfd',$1,$2)`,
        [content, Buffer.from('%PDF fixture'), latest],
      );
      await client.query("UPDATE mst_user SET password=$1 WHERE user_id='fixture'", [
        legacyPassword('fixture', 'fixture-password', process.env.CONMAS_LEGACY_KEY ?? 'fixture-key'),
      ]);
      const app = createApp(db, true),
        server = app.listen(0, '127.0.0.1');
      try {
        await new Promise<void>((resolve) => server.once('listening', resolve));
        const address = server.address();
        assert(address && typeof address !== 'string');
        const root = `http://127.0.0.1:${address.port}/ConMasManager`;
        const login = await fetch(root + '/Account/LogOn', {
          method: 'POST',
          body: new URLSearchParams({ UserName: 'fixture', Password: 'fixture-password' }),
          redirect: 'manual',
        });
        const cookie = login.headers.get('set-cookie')?.split(';')[0];
        assert.equal(login.status, 302);
        assert(cookie);
        const get = (path: string) =>
          fetch(root + '/Library/' + path, { headers: { Cookie: cookie }, redirect: 'manual' });
        const adminLogin = await fetch(root + '/Account/LogOn', {
          method: 'POST',
          body: new URLSearchParams({ UserName: 'conmasadmin', Password: 'fixture-password' }),
          redirect: 'manual',
        });
        const adminCookie = adminLogin.headers.get('set-cookie')?.split(';')[0];
        assert.equal(adminLogin.status, 302);
        assert(adminCookie);
        const adminGet = (path: string) =>
          fetch(root + '/Library/' + path, { headers: { Cookie: adminCookie }, redirect: 'manual' });
        const imageQuery = new URLSearchParams({ documentId: '1', revNo: '1', pageNumber: '2', format: 'png', name });
        let response = await get('GetIrfdImage?' + imageQuery);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'image/png');
        assert.match(response.headers.get('content-disposition') ?? '', /attachment/);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
        response = await get('GetIrfdImage?' + imageQuery.toString().replace('revNo=1', 'revNo=2'));
        assert.equal(response.status, 200);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), newer);
        const jpegQuery = new URLSearchParams({
          documentId: '1',
          revNo: '1',
          pageNumber: '4',
          format: 'jpeg',
          name: 'photo',
        });
        response = await get('GetIrfdImage?' + jpegQuery);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'image/jpeg');
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), jpeg);
        response = await get('GetIrfdImage?' + jpegQuery + '&isResize=True');
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'image/png');
        assert.match(response.headers.get('content-disposition') ?? '', /photo.jpeg/);
        response = await get('GetIrfdImage?' + imageQuery + '&isResize=true');
        assert.equal(response.status, 200);
        const metadata = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
        assert.equal(metadata.width, 200);
        assert.equal(metadata.height, 150);
        for (const [key, value, status] of [
          ['revNo', '3', 404],
          ['documentId', '2', 404],
          ['name', 'wrong', 404],
          ['pageNumber', '1', 404],
          ['pageNumber', 'x', 400],
          ['format', 'text', 400],
        ] as const) {
          const query = new URLSearchParams(imageQuery);
          query.set(key, value);
          assert.equal((await get('GetIrfdImage?' + query)).status, status, key);
        }
        for (const action of ['IrfdHistory', 'Image']) {
          response = await get(action + '?documentId=1');
          const html = await response.text();
          assert.equal(response.status, 200, html);
          scripts(html);
          assert.match(html, /revNo=2/);
          assert.match(html, /name=%3Ccamera%3E%26%E5%90%8D/);
          if (action === 'IrfdHistory') assert.match(html, /&lt;script&gt;not executable&lt;\/script&gt;/);
          response = await get(action + '?documentId=1&selectedRevNo=1');
          assert.equal(response.status, 200);
          assert.match(await response.text(), /revNo=1/);
          assert.equal((await get(action + '?documentId=1&selectedRevNo=3')).status, 404);
          assert.equal((await get(action + '?documentId=2')).status, 404);
          assert.equal((await get(action + '?documentId=3')).status, 302);
        }
        response = await get('GetPdf?documentId=1&revNo=1');
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-disposition'), null);
        assert.equal(await response.text(), '%PDF fixture');
        response = await get('GetIrfdDocument?documentId=1&revNo=1&fileType=1');
        assert.equal(response.status, 200);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), content);
        assert.equal((await adminGet('IrfdHistory?documentId=2')).status, 200);
        await client.query('UPDATE mst_group SET role_library_read=0 WHERE group_id=10');
        for (const path of ['IrfdHistory?documentId=1', 'Image?documentId=1', 'GetIrfdImage?' + imageQuery]) {
          assert.equal((await get(path)).status, 403);
          assert.equal((await adminGet(path)).status, 403);
        }
        await client.query(
          'UPDATE mst_group SET role_library_read=1 WHERE group_id=10;UPDATE common_document_irfd_role SET role_irfd_read=0 WHERE document_id=1',
        );
        assert.equal((await get('GetIrfdImage?' + imageQuery)).status, 404);
        await client.query('UPDATE common_document_irfd_role SET role_irfd_update=1 WHERE document_id=1');
        assert.equal((await get('GetIrfdImage?' + imageQuery)).status, 200);
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }
    }),
);

test('Library permissions aggregate exact role bits without an administrator bypass; TabOption restricts both requested tabs', async () => {
  for (let bits = 0; bits < 32; bits++) {
    const row = Object.fromEntries(
      ['read', 'create', 'edit', 'delete', 'output'].map((key, i) => [key, String((bits >> i) & 1)]),
    );
    const permissions = await managerLibraryPermissions(
      { query: async () => ({ rows: [row] }) } as unknown as pg.Pool,
      'conmasadmin',
    );
    for (const key of ['read', 'create', 'edit', 'delete', 'output'] as const)
      assert.equal(permissions[key], row[key] === '1');
    assert.equal(permissions.refer, Boolean(bits & 15));
  }
  assert.equal(managerTabAllowed('Library', new Map()), true);
  assert.equal(
    managerTabAllowed(
      'Library',
      new Map([
        ['Tab', '1'],
        ['TabOption', 'DataOutput'],
      ]),
    ),
    false,
  );
  assert.equal(
    managerTabAllowed(
      'DataOutput',
      new Map([
        ['Tab', '1'],
        ['TabOption', 'Library,DataOutput'],
      ]),
    ),
    true,
  );
  for (const mode of ['constructor', 'toString', 'Def', 'bad']) assert.throws(() => libraryMode(mode));
  assert.equal(libraryMode('8'), 'ImageLib');
  assert.throws(() => libraryInput({ ...input(), 'Document.use_end_time': '2026/02/30' }));
  assert.throws(() =>
    libraryInput({ ...input(), 'Document.document_life_time_day': '1', 'Document.document_life_time_hour': '-1' }),
  );
  assert.deepEqual(outputSelection([1, 2], '1:false,3:true,3:true'), [2, 3]);
  assert.throws(() => outputSelection([], '1:yes'));
});

test(
  'all Library families save, replace, authorize, label and delete files with isolated disk/database rollback',
  enabled,
  async () =>
    fixture(async (db, client, directory) => {
      const path = join(directory, 'upload');
      await writeFile(path, 'first');
      const file: LibraryFile = { token: 'test', path, name: 'a.txt', type: 'text/plain', size: 5 };
      for (const mode of ['ComLIb', 'RepLIb'] as const) {
        const [id] = await saveLibraryDocument(db, mode, input(), [file], 'fixture', options);
        const item = (await libraryDocument(db, mode, id, 'fixture'))!;
        assert(item);
        assert.equal((await libraryBinary(db, item)).data.toString(), 'first');
        assert.equal(await libraryDocument(db, mode, id, 'denied'), undefined);
        await saveLibraryDocument(db, mode, input('Renamed', id), [], 'fixture', { ...options, create: false });
        assert.equal((await libraryDocument(db, mode, id, 'fixture'))!.document_name, 'Renamed');
        await writeFile(path, 'second');
        const rejected = { ...options, create: false, labels: [999] };
        await assert.rejects(saveLibraryDocument(db, mode, input('Rejected', id), [file], 'fixture', rejected));
        assert.equal((await readFile(join(directory, String(id)))).toString(), 'first');
        await saveLibraryDocument(db, mode, input('Replaced', id), [file], 'fixture', { ...options, create: false });
        assert.equal((await readFile(join(directory, String(id)))).toString(), 'second');
        await assert.rejects(changeLibraryDocuments(db, mode, [id], 'denied', 'delete'));
        await changeLibraryDocuments(db, mode, [id], 'fixture', 'delete');
        await assert.rejects(readFile(join(directory, String(id))));
        await writeFile(path, 'first');
      }
      await client.query("UPDATE mst_common SET com_value='1' WHERE com_key='LIBRARY' AND com_name='FILE_LOCATION'");
      const [id] = await saveLibraryDocument(db, 'ComLIb', input(), [file], 'fixture', options);
      const row = (await libraryDocument(db, 'ComLIb', id, 'fixture'))!;
      assert.equal((await libraryBinary(db, row)).data.toString(), 'first');
      await assert.rejects(readFile(join(directory, String(id))));
      await assert.rejects(
        saveLibraryDocument(db, 'ComLIb', input('FD', 0, 2), [], 'fixture', options),
        LibraryPendingError,
      );
      await assert.rejects(saveLibraryDocument(db, 'ImageLib', input(), [file], 'fixture', options));
      const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'white' } })
        .png()
        .toBuffer();
      await writeFile(path, png);
      const [image] = await saveLibraryDocument(
        db,
        'ImageLib',
        input(),
        [{ ...file, name: 'image.png', type: 'image/png', size: png.length }],
        'fixture',
        options,
      );
      assert.deepEqual((await libraryBinary(db, (await libraryDocument(db, 'ImageLib', image, 'fixture'))!)).data, png);
    }),
);

test('Library late database failures restore overwritten files and roll back multi-file rows', enabled, async () =>
  fixture(async (db, client, directory) => {
    const path = join(directory, 'upload');
    await writeFile(path, 'old');
    const file = { token: 'test', path, name: 'a.txt', type: 'text/plain', size: 3 };
    const [id] = await saveLibraryDocument(db, 'ComLIb', input(), [file], 'fixture', options);
    await writeFile(path, 'new');
    const broken = {
      query: db.query,
      connect: async () => ({
        release() {},
        query: (sql: string, values?: unknown[]) => {
          if (sql === 'COMMIT') throw new Error('fixture commit rejection');
          return client.query(sql, values);
        },
      }),
    } as unknown as pg.Pool;
    await assert.rejects(
      saveLibraryDocument(broken, 'ComLIb', input('Rejected', id), [file], 'fixture', { ...options, create: false }),
    );
    assert.equal((await readFile(join(directory, String(id)))).toString(), 'old');
    assert.notEqual((await libraryDocument(db, 'ComLIb', id, 'fixture'))!.document_name, 'Rejected');
    await assert.rejects(saveLibraryDocument(broken, 'ComLIb', input(), [file, file], 'fixture', options));
    assert.equal((await client.query('SELECT 1 FROM mst_common_document')).rowCount, 1);
  }),
);

test('Library list and document access retain ordinary and FreeDraw row-role distinctions', enabled, async () =>
  fixture(async (db, client) => {
    await client.query(`INSERT INTO mst_common_document (document_id,document_name,document_save_kbn,document_mobile_save) VALUES (1,'Public',0,1),(2,'Restricted',0,1),(3,'FD',2,1);
    INSERT INTO mst_common_document_role (document_id,group_id) VALUES (2,20);
    INSERT INTO common_document_irfd_role (document_id,group_id,role_irfd_read,role_irfd_update) VALUES (3,10,1,0)`);
    assert.deepEqual(
      (await libraryList(db, 'ComLIb', 'fixture', { PageSize: '10' })).rows.map((row) => row.document_id),
      [1, 3],
    );
    await client.query(`INSERT INTO mst_label_common_document (mst_label_id,label_name,label_id_path,label_name_path,diplay_number) VALUES (1,'Fixture label','1','Fixture label',0);
    INSERT INTO common_document_label (document_id,mst_label_id) VALUES (1,1)`);
    assert.deepEqual(
      (await libraryList(db, 'ComLIb', 'fixture', { SearchDocumentName: 'Pub' })).rows[0].label_ids,
      [1],
    );
    assert.equal(await libraryDocument(db, 'ComLIb', 1, 'no-group'), undefined);
    assert(await libraryDocument(db, 'ComLIb', 2, 'conmasadmin'));
    assert(await libraryDocument(db, 'ComLIb', 3, 'fixture'));
    assert.equal(await libraryDocument(db, 'ComLIb', 3, 'fixture', true), undefined);
    await client.query(`INSERT INTO mst_report_document_role(document_id,group_id) VALUES(1,20)`);
    assert.equal(await libraryDocument(db, 'ComLIb', 1, 'fixture'), undefined);
    await client.query(`INSERT INTO mst_image_document_role(document_id,group_id) VALUES(1,10)`);
    assert(await libraryDocument(db, 'ComLIb', 1, 'fixture'));
    await client.query(
      'DELETE FROM mst_report_document_role WHERE document_id=1;DELETE FROM mst_image_document_role WHERE document_id=1',
    );
    await assert.rejects(changeLibraryDocuments(db, 'ComLIb', [3], 'fixture', 'delete'));
    assert.deepEqual(
      (await libraryList(db, 'ComLIb', 'fixture', { SearchDocumentName: 'Pub' })).rows.map((row) => row.document_id),
      [1],
    );
    await assert.rejects(libraryList(db, 'ComLIb', 'fixture', { SearchRegistTimeFrom: '2026/02/30' }));
  }),
);

async function reportFixture(client: pg.PoolClient) {
  await client.query(`INSERT INTO def_top (def_top_id,def_top_org,def_top_name,rev_no,deleted) VALUES (1,1,'Form',1,0);
    INSERT INTO def_current (def_top_id,def_top_org) VALUES (1,1);
    INSERT INTO rep_top (rep_top_id,rep_top_org,def_top_id,rep_top_name,rev_no,deleted) VALUES (2,2,1,'Report',1,0),(3,3,1,'Hidden',1,0);
    INSERT INTO rep_current (rep_top_id,rep_top_org) VALUES (2,2),(3,3);
    INSERT INTO def_role (def_top_id,group_id,role_def_read,role_def_update) VALUES (1,10,1,1);
    INSERT INTO rep_role (rep_top_id,group_id,role_rep_read,role_rep_update) VALUES (2,10,1,1),(3,20,1,1);
    INSERT INTO rep_sheet (rep_sheet_id,rep_top_id,rep_sheet_no,rep_sheet_name,sheet_no_org) VALUES (10,2,1,'Sheet',1);
    INSERT INTO rep_cluster (rep_sheet_id,cluster_id,cluster_name,cluster_type,input_value,display_value) VALUES (10,1,'Text','Text','a,"b"','Display'),(10,2,'Number','Number','12','12.00')`);
}
test(
  'Data Output selections, saved XML layouts and CSV archive honor roles using private report tables',
  enabled,
  async () =>
    fixture(async (db, client) => {
      await reportFixture(client);
      await client.query("UPDATE def_top SET sys_regist_user='fixture',sys_update_user='missing-fixture-user'");
      const definitions = await outputList(
        db,
        'def',
        'fixture',
        { SortColumn: 'SYS_REGIST_USER', SortDirection: 'ASC' },
        [],
        [],
      );
      assert.equal(definitions.total, 1);
      assert.equal(definitions.order, 'sys_regist_user');
      assert.equal(definitions.rows[0].created_by, 'Fixture');
      assert.equal(definitions.rows[0].updated_by, 'missing-fixture-user');
      assert.equal(definitions.rows[0].is_current, true);
      assert.deepEqual(
        (await outputList(db, 'rep', 'fixture', {}, [1], [])).rows.map((row) => row.id),
        [2],
      );
      await assert.rejects(outputAuthorize(db, 'rep', [2, 3], 'fixture'));
      const [layout] = await outputLayouts(db, [2], 'fixture');
      assert.equal(layout.sheets.length, 1);
      assert.equal(layout.sheets[0].clusters.length, 2);
      const edited = outputLayoutInput(layout, {
        TopFields: ['Top_rep_top_id', 'Top_rep_top_name'],
        SheetFields_1: 'Sheet_rep_sheet_name',
        Cluster_1_1: 'true',
        Cluster_1_2: 'true',
        Display_1_2: 'true',
      });
      await saveOutputLayout(db, edited, 'fixture', false, false, [2]);
      const [loaded] = await outputLayouts(db, [2], 'fixture');
      assert.deepEqual(loaded.fields, edited.fields);
      assert.equal(loaded.sheets[0].clusters[1].display, true);
      assert.equal(loaded.clusterDetails, false);
      const result = await outputCsvFiles(db, [2], [loaded], 'fixture', 'en-US');
      assert.equal(result.data.readUInt32LE(), 0x04034b50);
      assert.deepEqual(result.previews[0].rows[1], [2, 'Report', 'Sheet', 'a,"b"', '12.00']);
      const sanitized = await outputCsvFiles(
        db,
        [2],
        [
          {
            ...loaded,
            name:
              'Form\\/:*?"<>|' +
              Array.from({ length: 32 }, (_, index) => String.fromCharCode(index)).join('') +
              '\x7f\u0080文',
          },
        ],
        'fixture',
        'en-US',
      );
      assert.equal(sanitized.previews[0].name, `report_1_Form${'_'.repeat(41)}\x7f\u0080文.csv`);
      const detailed = outputLayoutInput(loaded, { TopFields: loaded.fields, IsClusterDetails: 'true' });
      await saveOutputLayout(db, detailed, 'fixture', false, false, [2]);
      const [reloaded] = await outputLayouts(db, [2], 'fixture');
      assert.equal(reloaded.clusterDetails, true);
      await assert.rejects(outputCsvFiles(db, [2], [reloaded], 'fixture', 'en-US'), LibraryPendingError);
      await saveOutputLayout(db, edited, 'fixture', false, true, [2]);
      assert.equal(
        (await client.query('SELECT manager_output_layout FROM data_output_layout')).rows[0].manager_output_layout,
        null,
      );
      await client.query("UPDATE rep_cluster SET cluster_type='Date' WHERE cluster_id=1");
      await assert.rejects(outputCsvFiles(db, [2], [edited], 'fixture', 'en-US'), LibraryPendingError);
      await assert.rejects(outputCsvFiles(db, [2], [{ ...edited, org: 999 }], 'fixture', 'en-US'));
    }),
);

test(
  'Library and Data Output isolated Manager requests render scripts, enforce CSRF and preserve blocked tabs',
  enabled,
  async () =>
    fixture(async (db, client) => {
      await reportFixture(client);
      const app = createApp(db, true),
        server = app.listen(0, '127.0.0.1');
      try {
        await new Promise<void>((resolve) => server.once('listening', resolve));
        const address = server.address();
        assert(address && typeof address !== 'string');
        const root = `http://127.0.0.1:${address.port}/ConMasManager`;
        let response = await fetch(root + '/Account/LogOn');
        const login = await fetch(root + '/Account/LogOn', {
          method: 'POST',
          body: new URLSearchParams({ UserName: 'conmasadmin', Password: 'fixture-password' }),
          redirect: 'manual',
        });
        const cookie = login.headers.get('set-cookie')?.split(';')[0];
        assert(cookie);
        assert.equal(login.status, 302);
        const headers = { Cookie: cookie };
        let csrf = '';
        for (const route of [
          '/Library?mode=ComLIb',
          '/Library/Index?mode=RepLIb',
          '/Library/Details?mode=ComLIb&detailsMode=Create&isFirst=true',
          '/DataOutput',
          '/DataOutput/Index',
        ]) {
          response = await fetch(root + route, { headers });
          const html = await response.text();
          assert.equal(response.status, 200, html);
          scripts(html);
          csrf = /name="__RequestVerificationToken" value="([^"]+)"/.exec(html)?.[1] ?? csrf;
        }
        assert(csrf);
        assert.equal((await fetch(root + '/DefReport', { headers })).status, 503);
        assert.equal(
          (
            await fetch(root + '/Library/IndexList', {
              method: 'POST',
              headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
              body: 'mode=ComLIb',
            })
          ).status,
          403,
        );
        const post = async (route: string, body: Record<string, string>) =>
          fetch(root + route, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ __RequestVerificationToken: csrf, ...body }),
            redirect: 'manual',
          });
        const invalid = await post('/Library/Details', {
          ...(input('Invalid', 0, 1) as Record<string, string>),
          mode: 'ComLIb',
          DetailsMode: 'Create',
          act: 'SAVE',
          'Document.use_end_time': '2026/02/30',
        });
        assert.equal(invalid.status, 400);
        assert.match(await invalid.text(), /Invalid date/);
        const saved = await post('/Library/Details', {
          ...(input('URL', 0, 1) as Record<string, string>),
          mode: 'ComLIb',
          DetailsMode: 'Create',
          act: 'SAVE',
          IsRoleNone: 'true',
        });
        assert.equal(saved.status, 302, await saved.text());
        response = await fetch(root + saved.headers.get('location')!.replace('/ConMasManager', ''), { headers });
        assert.equal(response.status, 200);
        scripts(await response.text());
        const next = await fetch(root + '/DataOutput/NextDetails?topIds=1:true', { headers, redirect: 'manual' });
        assert.equal(next.status, 302);
        const nextRep = await fetch(root + '/DataOutput/NextSelectDetails?topIds=2:true', {
          headers,
          redirect: 'manual',
        });
        assert.equal(nextRep.status, 302, await nextRep.text());
        response = await fetch(root + '/DataOutput/Details', { headers });
        const details = await response.text();
        assert.equal(response.status, 200, details);
        scripts(details);
        response = await fetch(root + '/DataOutput/Confirm', { headers });
        assert.equal(response.status, 200, await response.clone().text());
        scripts(await response.text());
        const multipart = new FormData();
        for (const [key, value] of Object.entries({
          ...input('Multipart', 0, 1),
          __RequestVerificationToken: csrf,
          mode: 'ComLIb',
          DetailsMode: 'Create',
          act: 'SAVE',
          'GroupRolePage[0].group_id': '20',
          'GroupRolePage[0].IsReferRole': 'true',
        }))
          multipart.append(key, String(value));
        response = await fetch(root + '/Library/Details', {
          method: 'POST',
          headers,
          body: multipart,
          redirect: 'manual',
        });
        assert.equal(response.status, 302, await response.text());
        const item = (await client.query("SELECT document_id FROM mst_common_document WHERE document_name='Multipart'"))
          .rows[0];
        assert.deepEqual(
          (await client.query('SELECT group_id FROM mst_common_document_role WHERE document_id=$1', [item.document_id]))
            .rows,
          [{ group_id: 20 }],
        );
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }
    }),
);
