import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Server } from 'node:http';
import express from 'express';
import session from 'express-session';
import pg from 'pg';
import sharp from 'sharp';
import { registerDocumentController } from '../../../../src/controllers/manager/documents/index.js';

test(
  'Documents media keeps original binary contracts, resize and report permissions using private fixtures',
  { skip: !process.env.DATABASE_URL },
  async () => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }),
      client = await pool.connect();
    let server: Server | undefined;
    try {
      for (const table of [
        'mst_common',
        'mst_group',
        'mst_group_affiation',
        'rep_role',
        'rep_top',
        'rep_sheet',
        'rep_cluster',
        'rep_layer_draw',
        'rep_cluster_draw',
        'history_rep_cluster',
        'rep_fd_sheet',
      ])
        await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
      await client.query(`SET search_path TO pg_temp;
        INSERT INTO mst_group (group_id,role_rep_read_manager) VALUES (10,1);
        INSERT INTO mst_group_affiation (group_id,user_id) VALUES (10,'fixture');
        INSERT INTO rep_top (rep_top_id,rep_top_name,deleted) VALUES (1,'Fixture title',0),(2,'Private title',0);
        INSERT INTO rep_role (rep_top_id,group_id,role_rep_read,role_rep_update) VALUES (1,10,1,0),(2,20,1,1);
        INSERT INTO rep_sheet (rep_sheet_id,rep_top_id) VALUES (11,1),(22,2)`);
      const png = await sharp({
        create: { width: 10, height: 20, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
      })
        .png()
        .toBuffer();
      const wav = Buffer.from('fixture recording'),
        pdf = Buffer.from('%PDF-fixture');
      await client.query('UPDATE rep_sheet SET input_image_file=$1', [png]);
      await client.query(
        `INSERT INTO rep_cluster (rep_sheet_id,cluster_id,image_file,approval_sign,recording_file,recording_file_extension)
        VALUES (11,1,$1,$2,$3,'wav'),(22,1,$1,$2,$3,'wav')`,
        [png, png.toString('base64'), wav],
      );
      await client.query(
        'INSERT INTO rep_layer_draw (rep_sheet_id,key_id,image_no,image_file) VALUES (11,1,0,$1),(22,1,0,$1)',
        [png],
      );
      await client.query('INSERT INTO rep_cluster_draw (rep_sheet_id,key_id,image_no,image_file) VALUES (11,1,0,$1)', [
        png,
      ]);
      await client.query(
        `INSERT INTO history_rep_cluster (history_id,rep_sheet_id,cluster_id,image_file,approval_sign,recording_file,recording_file_extension)
        VALUES ('history',11,1,$1,$2,$3,'wav'),('private',22,1,$1,$2,$3,'wav')`,
        [png, png.toString('base64'), wav],
      );
      const bytes = (field: number, data: Buffer) => {
        let length = data.length;
        const prefix = [(field << 3) | 2];
        while (length > 127) {
          prefix.push((length & 127) | 128);
          length >>= 7;
        }
        prefix.push(length);
        return Buffer.concat([Buffer.from(prefix), data]);
      };
      const imageName = 'quoted " image';
      const irfd = Buffer.concat([
        bytes(
          2,
          Buffer.concat([
            bytes(1, png),
            bytes(2, Buffer.from(imageName)),
            bytes(3, Buffer.from('png')),
            Buffer.from([32, 1]),
          ]),
        ),
        bytes(
          2,
          Buffer.concat([
            bytes(1, Buffer.from('<private fixture text>')),
            bytes(3, Buffer.from('text')),
            Buffer.from([32, 1]),
          ]),
        ),
      ]);
      await client.query(
        'INSERT INTO rep_fd_sheet (top_id,fd_sheet_no,pdf_file,irfd_file) VALUES (1,1,$1,$2),(2,1,$1,$2)',
        [pdf, irfd],
      );
      const app = express();
      app.set('views', 'views');
      app.set('view engine', 'ejs');
      app.use(express.urlencoded({ extended: false }));
      app.use(session({ secret: 'documents-media-fixture', resave: false, saveUninitialized: true }));
      app.use((req, _res, next) => {
        req.session.userId = 'fixture';
        next();
      });
      registerDocumentController(
        app,
        { query: client.query.bind(client) } as unknown as pg.Pool,
        true,
        () => {
          throw new Error('Unexpected page');
        },
        (_req, _res, next) => next(),
      );
      app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).send('Fixture handler failed.');
      });
      server = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server!.once('listening', resolve));
      const address = server.address();
      assert(address && typeof address !== 'string');
      const get = (action: string, input: Record<string, string> = {}) =>
        fetch(`http://127.0.0.1:${address.port}/ConMasManager/InputReport/${action}?${new URLSearchParams(input)}`, {
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });
      const sheet = await get('DetailsFdSheet', { repTopId: '1', fdSheetNo: '1' });
      assert.equal(sheet.status, 200);
      const html = await sheet.text();
      assert.match(html, /id="previewImage"/);
      assert.match(html, /GetFdPdf\?repTopId=1&amp;fdSheetNo=1/);
      assert.match(html, /GetIrfdImage\?/);
      assert.match(html, /quoted\+%22\+image/);
      assert.match(html, /&lt;private fixture text&gt;/);
      assert.equal((await get('DetailsFdSheet', { repTopId: '2', fdSheetNo: '1' })).status, 403);
      assert.equal(await (await get('GetRepTopName', { repTopId: '1' })).text(), 'Fixture title');
      const cases: [string, Record<string, string>, Buffer, string, boolean][] = [
        ['GetThumbnail', { repTopId: '1', repSheetId: '11' }, png, 'image/png', false],
        ['GetInputValueImage', { repSheetId: '11', clusterId: '1' }, png, 'image/png', true],
        ['GetInputValueImage', { repSheetId: '11', clusterId: '1', signFlg: 'true' }, png, 'image/png', false],
        ['GetRecordingValue', { repSheetId: '11', clusterId: '1' }, wav, 'audio/wav', true],
        ['GetLayerDraw', { repSheetId: '11', layerId: '1', imageNo: '0', type: 'layer' }, png, 'image/png', true],
        ['GetLayerDraw', { repSheetId: '11', layerId: '1', imageNo: '0', type: 'cluster' }, png, 'image/png', true],
        ['GetHistoryImage', { historyId: 'history', imageType: '0' }, png, 'image/png', true],
        ['GetHistoryImage', { historyId: 'history', imageType: '1' }, png, 'image/png', true],
        ['GetHistoryImage', { historyId: 'history', imageType: '2' }, wav, 'audio/wav', true],
        ['GetFdPdf', { repTopId: '1', fdSheetNo: '1' }, pdf, 'application/pdf', false],
        [
          'GetIrfdImage',
          { repTopId: '1', fdSheetNo: '1', pageNumber: '1', format: 'png', name: imageName },
          png,
          'image/png',
          true,
        ],
      ];
      for (const [action, params, expected, type, attachment] of cases) {
        const response = await get(action, params);
        assert.equal(response.status, 200, action);
        assert.match(response.headers.get('content-type') ?? '', new RegExp('^' + type));
        assert.equal(!!response.headers.get('content-disposition'), attachment);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
        if (type === 'image/png') {
          const preview = await get(action, { ...params, isResize: 'true' });
          const data = Buffer.from(await preview.arrayBuffer());
          if (action === 'GetThumbnail' || (action === 'GetInputValueImage' && params.signFlg))
            assert.deepEqual(data, png);
          else {
            const size = await sharp(data).metadata();
            assert.equal(size.width, 200);
            assert.equal(size.height, 150);
          }
        }
      }
      for (const [action, params] of cases) {
        const privateParams = {
          ...params,
          ...(params.repTopId
            ? { repTopId: '2' }
            : params.repSheetId
              ? { repSheetId: '22' }
              : { historyId: 'private' }),
        };
        assert.equal((await get(action, privateParams)).status, 404, action);
      }
      assert.equal((await get('GetThumbnail', { repTopId: '1', repSheetId: '22' })).status, 404);
      assert.equal(
        (await get('GetIrfdImage', { repTopId: '1', fdSheetNo: '1', pageNumber: '2', format: 'png', name: imageName }))
          .status,
        404,
      );
      assert.equal(
        (await get('GetLayerDraw', { repSheetId: '11', layerId: '1', imageNo: '0', type: 'layer;DELETE' })).status,
        400,
      );
      assert.equal((await get('GetHistoryImage', { historyId: 'history', imageType: '9' })).status, 400);
      assert.equal((await get('GetInputValueImage', { repSheetId: '11;DELETE', clusterId: '1' })).status, 400);
      await client.query('UPDATE rep_role SET role_rep_read=0,role_rep_update=1 WHERE rep_top_id=1');
      assert.equal((await get('GetRepTopName', { repTopId: '1' })).status, 200);
      await client.query('UPDATE rep_role SET role_rep_update=0 WHERE rep_top_id=1');
      assert.equal((await get('GetRepTopName', { repTopId: '1' })).status, 404);
      assert.equal((await client.query('SELECT COUNT(*) FROM rep_top')).rows[0].count, '2');
    } finally {
      if (server)
        await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
      client.release();
      await pool.end();
    }
  },
);
