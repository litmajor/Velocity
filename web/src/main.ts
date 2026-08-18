// Bootstrap: compose runtime (store + client) and mount the GamePage surface.
// Uses the deterministic MockGameClient; switch to WebSocketGameClient once
// the gateway integration is verified (see web/README.md).

import { GameStore } from './runtime/store.js';
import { MockGameClient } from './runtime/mock-game-client.js';
import { mountGamePage } from './surfaces/game/index.js';

const store = new GameStore();
const client = new MockGameClient();
client.onEvent((ev) => store.dispatch(ev));

const rootEl = document.getElementById('app');
if (!rootEl) throw new Error('missing #app mount node');
mountGamePage(rootEl, store, client);
client.connect();
