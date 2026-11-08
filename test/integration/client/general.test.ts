import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type pg from 'pg';
import type { Request, Response } from 'express';
import { clientIoTLicenseStatus } from '../../../src/shared/license-counts.js';
import { clientGeneralAction } from '../../../src/controllers/client-general.js';

test('IoT status merges both source entitlements, preserving expiry-day validity and malformed/absent expiry', () => {
  const today = new Date(2026, 10, 7);
  const status = (entries: Record<string, string>) => clientIoTLicenseStatus(new Map(Object.entries(entries)), today);
  const disabled: Record<string, string>[] = [
    {},
    { ConMasIoTGateway: '0' },
    { MappingTool: '2' },
    { MappingTool: '1.0' },
    { MappingTool: '2147483649' },
  ];
  for (const entries of disabled) assert.equal(status(entries), 0);
  for (const name of ['ConMasIoTGateway', 'MappingTool']) {
    for (const expiry of [
      '',
      '20261107',
      '20261108',
      '20260230',
      '20260001',
      '20261301',
      '00000101',
      '2026-11-06',
      'invalid',
    ])
      assert.equal(status({ [name]: ' +1 ', [`${name}Expire`]: expiry }), 1, `${name}/${expiry}`);
    for (const expiry of ['20261106', '20260228', '00010101', '00990101'])
      assert.equal(status({ [name]: '1', [`${name}Expire`]: expiry }), 2);
  }
  assert.equal(status({ ConMasIoTGateway: '1', ConMasIoTGatewayExpire: '20260101', MappingTool: '1' }), 1);
  assert.equal(
    status({
      ConMasIoTGateway: '1',
      ConMasIoTGatewayExpire: '20260101',
      MappingTool: '1',
      MappingToolExpire: '20261106',
    }),
    2,
  );
  assert.equal(status({ ConMasIoTGateway: '0', ConMasIoTGatewayExpire: '20260101', MappingTool: '0' }), 0);
});

test('GeneralProcess case-sensitive resolution and auth/method/parameter/permission validation keep source error precedence', async () => {
  const request = async (
    query: Record<string, string>,
    method = 'GET',
    userId?: string,
    rows: Record<string, unknown>[] = [],
  ) => {
    let output = '',
      status = 200,
      queries = 0;
    const db = {
      query: async () => {
        queries++;
        return { rows };
      },
    } as unknown as pg.Pool;
    const req = { query, method, session: { clientAccount: userId ? { userId } : undefined } } as unknown as Request;
    const res = {
      send(text: string) {
        output = text;
      },
      status(value: number) {
        status = value;
        return this;
      },
    } as unknown as Response;
    await clientGeneralAction(db, req, res);
    return { output, status, queries };
  };
  const unknown: Record<string, string>[] = [
    {},
    { target: 'system', process: 'LicenseStatusInquiry' },
    { target: 'System', process: 'licensestatusinquiry' },
    { target: 'Unknown', process: 'Unknown' },
  ];
  for (const query of unknown) assert.match((await request(query)).output, /<code>1<\/code>/);
  const query = { target: 'System', process: 'LicenseStatusInquiry', item: 'ConMasIoTGateway' };
  assert.match((await request(query, 'DELETE')).output, /<code>5<\/code>/);
  const method = await request(query, 'DELETE', 'fixture');
  assert.match(method.output, /<code>4<\/code>/);
  assert.equal(method.queries, 0);
  for (const item of ['', 'conmasiotgateway', ' ConMasIoTGateway ', '<&']) {
    const result = await request({ ...query, item }, 'GET', 'fixture');
    assert.match(result.output, /<code>2<\/code>/);
    assert.equal(result.queries, 0);
  }
  for (const rows of [
    [],
    [{ role_mst_read: null, role_mst_system_read: null }],
    [{ role_mst_read: '0', role_mst_system_read: '2' }],
  ])
    assert.match((await request(query, 'GET', 'fixture', rows)).output, /<code>3<\/code>/);
  assert.match((await request({ target: 'Library', process: 'DocumentList' })).output, /<code>5<\/code>/);
  const registration = { target: 'Library', process: 'DocumentRegistration' };
  assert.match((await request(registration)).output, /<code>5<\/code>/);
  const registrationGet = await request(registration, 'GET', 'fixture');
  assert.match(registrationGet.output, /<code>4<\/code>/);
  assert.equal(registrationGet.queries, 0);
  assert.equal(registrationGet.status, 200);
  const registrationPost = await request(registration, 'POST', 'fixture');
  assert.match(registrationPost.output, /<code>2<\/code>/);
  assert.equal(registrationPost.queries, 0);
  assert.equal(registrationPost.status, 200);
  for (const user of [undefined, 'fixture']) {
    const schedule = await request({ target: 'Schedule', process: 'ReportListForDownload' }, 'DELETE', user);
    assert.match(schedule.output, user ? /<code>4<\/code>/ : /<code>5<\/code>/);
    assert.equal(schedule.status, 200);
    assert.equal(schedule.queries, 0);
  }
  const admin = await request(query, 'POST', 'conmasadmin');
  assert.match(admin.output, /<license>/);
  assert.equal(admin.queries, 0);
  for (const rows of [[{ role_mst_read: '1' }], [{ role_mst_system_read: '1' }]])
    assert.match((await request(query, 'GET', 'fixture', rows)).output, /<license>/);
});
