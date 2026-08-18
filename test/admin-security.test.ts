import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { startAdminServer, isAuthorized } from '../src/runtime/admin-server';
import { WebSocketGateway } from '../src/runtime/websocket-gateway';
import { timingSafeEqualStr } from '../src/runtime/auth';
import { makeRig, type Rig } from './helpers/rig';

const TOKEN = 'test-admin-token-123';

function request(port: number, opts: { path: string; method?: string; headers?: Record<string, string>; body?: string }):
  Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: opts.path, method: opts.method ?? 'GET', headers: opts.headers },
      res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

describe('admin HTTP surface authorization', () => {
  let rig: Rig;
  let server: http.Server;
  let port: number;
  let savedToken: string | undefined;

  beforeEach(async () => {
    savedToken = process.env.ADMIN_TOKEN;
    rig = makeRig({ crashPoint: 2 });
  });

  afterEach(async () => {
    if (savedToken === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = savedToken;
    try { rig.game.reset(); } catch {}
    if (server) await new Promise(res => server.close(res));
  });

  async function startWithToken(token: string | undefined) {
    if (token === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = token;
    server = startAdminServer(0, rig.game, rig.betting);
    await new Promise(res => server.once('listening', res));
    port = (server.address() as { port: number }).port;
  }

  it('with no ADMIN_TOKEN configured, the entire surface is disabled (fail closed)', async () => {
    await startWithToken(undefined);
    for (const path of ['/admin/state', '/admin/player-mix-params', '/anything']) {
      const res = await request(port, { path, method: path.includes('player-mix') ? 'POST' : 'GET' });
      expect(res.status).toBe(503);
    }
  });

  it('rejects requests with no credentials', async () => {
    await startWithToken(TOKEN);
    const res = await request(port, { path: '/admin/state' });
    expect(res.status).toBe(401);
    expect(res.body).not.toContain('shapingParams'); // no information leakage
  });

  it('rejects invalid credentials', async () => {
    await startWithToken(TOKEN);
    const res = await request(port, {
      path: '/admin/state',
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects malformed authorization headers', async () => {
    await startWithToken(TOKEN);
    for (const header of [TOKEN, `Basic ${TOKEN}`, 'Bearer', 'Bearer ', `bearer ${TOKEN}`]) {
      const res = await request(port, { path: '/admin/state', headers: { authorization: header } });
      expect(res.status).toBe(401);
    }
  });

  it('repeated failed requests keep failing (no lockout bypass, no state change)', async () => {
    await startWithToken(TOKEN);
    for (let i = 0; i < 10; i++) {
      const res = await request(port, { path: '/admin/state', headers: { authorization: 'Bearer nope' } });
      expect(res.status).toBe(401);
    }
    const ok = await request(port, { path: '/admin/state', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(ok.status).toBe(200);
  });

  it('an unauthorized caller cannot mutate player-mix params (economic state transition blocked)', async () => {
    await startWithToken(TOKEN);
    const before = (rig.game as any).fairness?.getPlayerMixParams?.() ?? null;
    const res = await request(port, {
      path: '/admin/player-mix-params',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ greedy: 999 }),
    });
    expect(res.status).toBe(401);
    const after = (rig.game as any).fairness?.getPlayerMixParams?.() ?? null;
    expect(after).toEqual(before); // nothing changed
  });

  it('a valid bearer token is accepted and the endpoint works', async () => {
    await startWithToken(TOKEN);
    const res = await request(port, { path: '/admin/state', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toHaveProperty('shapingParams');
  });

  it('unknown paths still require auth and return 404 only when authorized', async () => {
    await startWithToken(TOKEN);
    const unauth = await request(port, { path: '/some/other/route' });
    expect(unauth.status).toBe(401);
    const auth = await request(port, { path: '/some/other/route', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(auth.status).toBe(404);
  });
});

describe('websocket gateway authorization', () => {
  let rig: Rig;
  let gateway: WebSocketGateway;
  let port: number;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved.WS_CLIENT_TOKEN = process.env.WS_CLIENT_TOKEN;
    saved.WS_ADMIN_TOKEN = process.env.WS_ADMIN_TOKEN;
    delete process.env.WS_CLIENT_TOKEN;
    delete process.env.WS_ADMIN_TOKEN;
    rig = makeRig({ crashPoint: 2 });
    gateway = new WebSocketGateway(0, rig.game, rig.betting);
    port = (gateway.address() as { port: number }).port;
  });

  afterEach(() => {
    for (const k of ['WS_CLIENT_TOKEN', 'WS_ADMIN_TOKEN']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    gateway.close();
    try { rig.game.reset(); } catch {}
  });

  function connect(headers?: Record<string, string>): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
  }

  function sendAndWait(ws: WebSocket, msg: unknown, expectTypes: string[]): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for response')), 5000);
      const handler = (raw: Buffer) => {
        const parsed = JSON.parse(raw.toString());
        if (expectTypes.includes(parsed.type)) {
          clearTimeout(timer);
          ws.off('message', handler);
          resolve(parsed);
        }
      };
      ws.on('message', handler);
      ws.send(JSON.stringify(msg));
    });
  }

  it('with WS_CLIENT_TOKEN configured, connections without the token are closed', async () => {
    process.env.WS_CLIENT_TOKEN = 'client-secret';
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const code = await new Promise<number>(resolve => ws.on('close', c => resolve(c)));
    expect(code).toBe(4001);
  });

  it('with WS_CLIENT_TOKEN configured, wrong tokens are rejected and correct ones accepted', async () => {
    process.env.WS_CLIENT_TOKEN = 'client-secret';
    const bad = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { authorization: 'Bearer wrong' } });
    const code = await new Promise<number>(resolve => bad.on('close', c => resolve(c)));
    expect(code).toBe(4001);

    const good = await connect({ authorization: 'Bearer client-secret' });
    expect(good.readyState).toBe(WebSocket.OPEN);
    good.close();
  });

  it('ADMIN action is denied when no WS_ADMIN_TOKEN is configured (fail closed)', async () => {
    const ws = await connect();
    const res = await sendAndWait(ws, { action: 'ADMIN', payload: { token: '' } }, ['ADMIN_OK', 'ADMIN_DENIED']);
    expect(res.type).toBe('ADMIN_DENIED');
    // even an "undefined-matching" token cannot slip through
    const res2 = await sendAndWait(ws, { action: 'ADMIN', payload: { token: 'undefined' } }, ['ADMIN_OK', 'ADMIN_DENIED']);
    expect(res2.type).toBe('ADMIN_DENIED');
    ws.close();
  });

  it('ADMIN action with a wrong token is denied; with the right token granted', async () => {
    process.env.WS_ADMIN_TOKEN = 'admin-secret';
    const ws = await connect();
    const denied = await sendAndWait(ws, { action: 'ADMIN', payload: { token: 'nope' } }, ['ADMIN_OK', 'ADMIN_DENIED']);
    expect(denied.type).toBe('ADMIN_DENIED');
    const granted = await sendAndWait(ws, { action: 'ADMIN', payload: { token: 'admin-secret' } }, ['ADMIN_OK', 'ADMIN_DENIED']);
    expect(granted.type).toBe('ADMIN_OK');
    ws.close();
  });

  it('unauthorized WS callers cannot cause an economic state transition', async () => {
    rig.wallet.ensureAccount('alice', 100);
    const ws = await connect();
    // no round is open: bet must be rejected, wallet untouched
    const rejected = await sendAndWait(
      ws, { action: 'PLACE_BET', payload: { userId: 'alice', amount: 50 } }, ['BET_ACCEPTED', 'BET_REJECTED']);
    expect(rejected.type).toBe('BET_REJECTED');
    expect(rig.wallet.getBalance('alice')).toBe(100);
    // unknown/debug-like actions are rejected outright
    const unknown = await sendAndWait(ws, { action: 'DEBUG_RESET' }, ['ERROR']);
    expect(unknown.data.message).toMatch(/Unknown action/);
    ws.close();
  });
});

describe('auth primitives', () => {
  it('timingSafeEqualStr fails closed on empty/undefined values', () => {
    expect(timingSafeEqualStr(undefined, 'x')).toBe(false);
    expect(timingSafeEqualStr('x', undefined)).toBe(false);
    expect(timingSafeEqualStr('', '')).toBe(false);
    expect(timingSafeEqualStr('a', 'b')).toBe(false);
    expect(timingSafeEqualStr('same', 'same')).toBe(true);
  });

  it('isAuthorized only accepts a well-formed matching Bearer header', () => {
    expect(isAuthorized(undefined, 'tok')).toBe(false);
    expect(isAuthorized('tok', 'tok')).toBe(false); // missing scheme
    expect(isAuthorized('Bearer wrong', 'tok')).toBe(false);
    expect(isAuthorized('Bearer tok', 'tok')).toBe(true);
  });
});
