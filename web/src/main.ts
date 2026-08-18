// Frontend entry point.
//
// One engine, multiple experiences: a single GameStore + GameClient (the
// shared engine-facing layer) feed whichever presentation experience is
// mounted. Switching experiences swaps only the presentation layer; the
// store, client, and connection are untouched.
//
// Config (URL query params):
//   ?experience=rocket|racecar   presentation (default rocket, persisted)
//   ?user=<id>                   player id (default persisted random guest id)
//   ?ws=<url>                    gateway url (default ws://<host>:3001)
//   ?mock=1                      explicit opt-in to the offline demo simulator

import { GameStore } from './runtime/store.js';
import type { GameClient } from './runtime/game-client.js';
import { WebSocketGameClient } from './runtime/ws-game-client.js';
import { MockGameClient } from './runtime/mock-game-client.js';
import { installAutoCashout } from './actions/auto-cashout.js';
import { mountRocketExperience } from './experiences/rocket/index.js';
import { mountRacecarExperience } from './experiences/racecar/index.js';
import { el } from './ui/dom.js';

type ExperienceName = 'rocket' | 'racecar';

const EXPERIENCES: Record<ExperienceName, (root: HTMLElement, store: GameStore, client: GameClient) => () => void> = {
  rocket: mountRocketExperience,
  racecar: mountRacecarExperience,
};

const params = new URLSearchParams(window.location.search);

function resolveExperience(): ExperienceName {
  const fromUrl = params.get('experience');
  if (fromUrl === 'rocket' || fromUrl === 'racecar') return fromUrl;
  const saved = localStorage.getItem('velocity.experience');
  return saved === 'racecar' ? 'racecar' : 'rocket';
}

function resolveUserId(): string {
  const fromUrl = params.get('user');
  if (fromUrl) return fromUrl;
  let saved = localStorage.getItem('velocity.userId');
  if (!saved) {
    saved = `guest-${Math.random().toString(36).slice(2, 8)}`;
    localStorage.setItem('velocity.userId', saved);
  }
  return saved;
}

const useMock = params.get('mock') === '1';
const userId = resolveUserId();
const wsUrl = params.get('ws') ?? `ws://${window.location.hostname || 'localhost'}:3001`;

const store = new GameStore();
const client: GameClient = useMock ? new MockGameClient() : new WebSocketGameClient(wsUrl, userId);
client.onEvent((ev) => store.dispatch(ev));
installAutoCashout(store, client);

// -- shell: header with experience switcher; experience owns everything below --
const rootEl = document.getElementById('app');
if (!rootEl) throw new Error('missing #app mount node');

const connBadge = el('span', { class: 'conn-badge' }, '');
const expRoot = el('div', { class: 'experience-root' });

let active: ExperienceName = resolveExperience();
let unmount: (() => void) | null = null;

const switchButtons = new Map<ExperienceName, HTMLButtonElement>();

function mountExperience(name: ExperienceName): void {
  unmount?.();
  active = name;
  localStorage.setItem('velocity.experience', name);
  document.body.dataset.experience = name;
  for (const [n, b] of switchButtons) b.classList.toggle('active', n === name);
  unmount = EXPERIENCES[name](expRoot, store, client);
}

const switcher = el(
  'div',
  { class: 'exp-switch' },
  ...(['rocket', 'racecar'] as ExperienceName[]).map((name) => {
    const btn = el(
      'button',
      { class: 'exp-switch-btn', type: 'button', onclick: () => mountExperience(name) },
      name.toUpperCase(),
    );
    switchButtons.set(name, btn);
    return btn;
  }),
);

rootEl.replaceChildren(
  el(
    'header',
    { class: 'app-header' },
    el('h1', { class: 'app-title' }, 'VELOCITY'),
    switcher,
    connBadge,
  ),
  expRoot,
);

store.subscribe((state) => {
  connBadge.textContent = state.connection === 'MOCK' ? 'SIMULATED DATA' : state.connection;
  connBadge.className = `conn-badge conn-${state.connection.toLowerCase()}`;
});

mountExperience(active);
client.connect();
