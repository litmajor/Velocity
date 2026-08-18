// Pure formatting helpers (SSA /core layer).

export const fmtMoney = (n: number): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtMult = (m: number): string => `${m.toFixed(2)}\u00d7`;

export const fmtTime = (ts: number): string => {
  const d = new Date(ts);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

export const shortHash = (h: string | null, keep = 10): string =>
  h ? (h.length <= keep * 2 ? h : `${h.slice(0, keep)}\u2026${h.slice(-keep)}`) : '\u2014';

export const fmtCountdown = (msLeft: number): string =>
  `${Math.max(0, msLeft / 1000).toFixed(1)}s`;
