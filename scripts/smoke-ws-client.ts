// Dev smoke test: connect to the gateway like the web frontend does and
// verify a plain (non-admin) client receives the full public round lifecycle,
// wallet sync, and bet/cashout responses. Run with the vertical slice up:
//   npx tsx src/vertical-slice.ts   (in another terminal)
//   npx tsx scripts/smoke-ws-client.ts

import WebSocket from 'ws';

const url = process.env.WS_URL ?? 'ws://localhost:3001';
const userId = 'smoke-web-user';
const seen = new Set<string>();
let betPlaced = false;
let cashedOut = false;

const ws = new WebSocket(url);
const send = (action: string, payload: Record<string, unknown>) =>
  ws.send(JSON.stringify({ action, payload: { ...payload, requestId: `${userId}:${action}:${Date.now()}`, clientTs: Date.now() } }));

ws.on('open', () => {
  console.log('[smoke] connected');
  send('WALLET_SYNC', { userId });
});

ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw));
  const envelope = msg.type === 'EVENT_APPEND' ? (msg.data?.envelope ?? msg.data) : null;
  const label = envelope?.event ?? msg.type;
  if (!seen.has(label)) {
    seen.add(label);
    console.log('[smoke] first', label, JSON.stringify(envelope?.data ?? msg.data).slice(0, 200));
  }
  if (label === 'ROUND_STARTED' && !betPlaced) {
    betPlaced = true;
    send('PLACE_BET', { userId, amount: 25 });
  }
  if (label === 'TICK_UPDATE' && betPlaced && !cashedOut && Number(msg.data?.multiplier ?? 0) >= 1.3) {
    cashedOut = true;
    send('CASHOUT', { userId });
  }
  if (label === 'ROUND_SETTLED') {
    console.log('[smoke] observed types:', [...seen].sort().join(', '));
    ws.close();
    process.exit(0);
  }
});

setTimeout(() => {
  console.error('[smoke] TIMEOUT; observed:', [...seen].sort().join(', '));
  process.exit(1);
}, 60_000);
