import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { cabinetRouteAllowed, createWebhook } from '../src/webhook.js';

async function run(cabinetToken: string | null = 'cab-tok') {
  const seen: string[] = [];
  const files: { path: string; allowCabinet: boolean | undefined }[] = [];
  const server = createWebhook(() => Promise.resolve(0), undefined, Date.now, undefined, undefined, {
    token: 'adm-tok',
    cabinetToken: cabinetToken ?? undefined,
    handle: (r) => { seen.push(`${r.method} ${r.path}`); return Promise.resolve({ status: 200, body: { ok: true } }); },
    file: (path, _range, access) => { files.push({ path, allowCabinet: access.allowCabinet }); return { status: 404, headers: {}, json: { ok: false } }; },
  }, {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (method: string, path: string, headers: Record<string, string>) => fetch(url + path, { method, headers: { 'content-type': 'application/json', ...headers }, ...(method !== 'GET' ? { body: '{}' } : {}) });
  return { seen, files, call, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const ADMIN = { 'x-admin-token': 'adm-tok' };
const CAB = { 'x-cabinet-token': 'cab-tok' };

const MATRIX: Array<[string, string, boolean]> = [
  // [method, path, the cabinet token may call it]
  ['GET', '/admin/clients/by-email?email=a@b.c', true],
  ['POST', '/admin/clients', false],
  ['POST', '/admin/clients/7', true],
  ['GET', '/admin/clients/7/threads', true],
  ['POST', '/admin/clients/7/threads/lead-3/messages', true],
  ['GET', '/admin/clients/7/documents', true],
  ['POST', '/admin/clients/7/documents/4/sign', true],
  ['POST', '/admin/clients/7/uploads', true],
  ['POST', '/admin/clients/7/tickets', true],
  ['GET', '/admin/clients/7/knowledge', true],
  ['PATCH', '/admin/clients/7/agents/2', true],
  ['POST', '/admin/clients/7/anonymize', false],
  ['GET', '/admin/files/cabinet/c7/contract-1-signed.pdf', false],
  ['GET', '/admin/files/7/1.png', false],
  ['GET', '/admin/settings', false],
  ['POST', '/admin/settings', false],
  ['GET', '/admin/prices', false],
  ['GET', '/admin/crm/clients', false],
  ['GET', '/admin/crm/leads', false],
  ['GET', '/admin/tasks', false],
  ['GET', '/admin/hub', false],
  ['GET', '/admin/knowledge', false],
  ['DELETE', '/admin/knowledge/owner-1', false],
  ['GET', '/admin/clients/7/../settings', false],
  ['GET', '/admin/clients', false],
  ['POST', '/admin/content/purge', false],
];

describe('access matrix: every route class x both tokens', () => {
  it('the admin token reaches everything, the cabinet token only the client routes, no token or a wrong one nothing', async () => {
    const h = await run();
    for (const [method, path, cab] of MATRIX) {
      const admin = await h.call(method, path, ADMIN);
      // `GET /admin/clients/7/../settings` is normalised by the URL parser to `/admin/settings`: never a client route
      expect(admin.status === 401, `admin ${method} ${path}`).toBe(false);
      const c = await h.call(method, path, CAB);
      if (cab) expect(c.status, `cabinet ${method} ${path}`).not.toBe(403);
      else expect(c.status, `cabinet ${method} ${path}`).toBe(403);
      expect((await h.call(method, path, {})).status, `none ${method} ${path}`).toBe(401);
      expect((await h.call(method, path, { 'x-cabinet-token': 'wrong' })).status, `bad cabinet ${method} ${path}`).toBe(401);
      expect((await h.call(method, path, { 'x-admin-token': 'cab-tok' })).status, `cabinet key in the admin header ${method} ${path}`).toBe(401);
    }
    await h.close();
  });
  it('files: the admin token may read cabinet/, the file handler is told it may; the cabinet token never reaches the handler', async () => {
    const h = await run();
    await h.call('GET', '/admin/files/cabinet/c7/a.pdf', ADMIN);
    await h.call('GET', '/admin/files/cabinet/c7/a.pdf', CAB);
    expect(h.files).toEqual([{ path: 'cabinet/c7/a.pdf', allowCabinet: true }]);
    await h.close();
  });
  it('without CABINET_TOKEN the cabinet path is off (even an empty header)', async () => {
    const h = await run(null);
    expect((await h.call('GET', '/admin/clients/7/threads', CAB)).status).toBe(401);
    expect((await h.call('GET', '/admin/clients/7/threads', { 'x-cabinet-token': '' })).status).toBe(401);
    expect((await h.call('GET', '/admin/clients/7/threads', ADMIN)).status).toBe(200);
    await h.close();
  });
  it('cabinetRouteAllowed is the single rule', () => {
    expect(cabinetRouteAllowed('GET', '/admin/clients/by-email')).toBe(true);
    expect(cabinetRouteAllowed('POST', '/admin/clients/by-email')).toBe(false);
    expect(cabinetRouteAllowed('POST', '/admin/clients/12/anonymize')).toBe(false);
    expect(cabinetRouteAllowed('DELETE', '/admin/clients/12/threads')).toBe(false);
    expect(cabinetRouteAllowed('GET', '/admin/clients/abc/threads')).toBe(false);
  });
});
