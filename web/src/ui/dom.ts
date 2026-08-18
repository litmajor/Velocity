// Pure presentational primitives (SSA /ui layer). Zero business logic,
// zero domain/state imports.

type Attrs = Record<string, string | boolean | ((e: Event) => void)>;
type Child = Node | string;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === 'function') {
      node.addEventListener(key.replace(/^on/, '').toLowerCase(), value);
    } else if (typeof value === 'boolean') {
      if (value) node.setAttribute(key, '');
      else node.removeAttribute(key);
    } else {
      node.setAttribute(key, value);
    }
  }
  for (const child of children) {
    node.append(child);
  }
  return node;
}

export const button = (label: string, attrs: Attrs = {}): HTMLButtonElement =>
  el('button', { class: 'btn', type: 'button', ...attrs }, label);

export const badge = (label: string, variant = 'neutral'): HTMLSpanElement =>
  el('span', { class: `badge badge-${variant}` }, label);

export interface PanelParts {
  root: HTMLElement;
  body: HTMLElement;
}

export const panel = (title: string, cls = ''): PanelParts => {
  const body = el('div', { class: 'panel-body' });
  const root = el(
    'section',
    { class: `panel ${cls}`.trim() },
    el('header', { class: 'panel-title' }, title),
    body,
  );
  return { root, body };
};
