import crypto from 'node:crypto';

/** Mulberry32. Seeded so every run of the demo produces the same numbers. */
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick(rand, items) {
  return items[Math.floor(rand() * items.length)];
}

export function weightedPick(rand, items, weightKey = 'share') {
  const total = items.reduce((s, i) => s + i[weightKey], 0);
  let r = rand() * total;
  for (const item of items) {
    r -= item[weightKey];
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

export function gaussian(rand, mean = 0, sd = 1) {
  const u = Math.max(rand(), 1e-9);
  const v = Math.max(rand(), 1e-9);
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Stable 32-bit hash. Used for holdout assignment so it never drifts. */
export function stableHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

export function id(prefix) {
  return `${prefix}_${crypto.randomBytes(7).toString('hex')}`;
}

/**
 * Deterministic id, drawn from a seeded stream.
 *
 * Seeded entities must not use `id()` above. That one is backed by
 * crypto.randomBytes, so it produces a different value on every boot — which is
 * correct for a runtime action id and quietly catastrophic for a seeded payment
 * id, because the A/B holdout is assigned by hashing that id. Random ids meant
 * the control/treatment split was re-drawn on every single run: arm sizes moved
 * by 10-15%, the pooled lift moved by several points, and the demo was not
 * reproducible despite a comment promising it never drifts.
 *
 * Anything whose identity feeds a hash, a holdout, or a printed figure comes
 * from here instead.
 */
export function seededId(rand, prefix) {
  const hex = Math.floor(rand() * 0xffffffff).toString(16).padStart(8, '0') +
    Math.floor(rand() * 0xffffff).toString(16).padStart(6, '0');
  return `${prefix}_${hex}`;
}

/** Paise in, human rupees out. All money in this codebase is integer paise. */
export function rupees(paise) {
  const n = Math.round(paise / 100);
  return '\u20B9' + n.toLocaleString('en-IN');
}

export function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

export function hoursBetween(a, b) {
  return Math.abs(new Date(a) - new Date(b)) / 36e5;
}

export function istHour(iso) {
  // The synthetic stream is generated in IST already; read the hour directly.
  return new Date(iso).getUTCHours();
}

export function sum(arr, fn = (x) => x) {
  return arr.reduce((s, x) => s + fn(x), 0);
}

export function groupBy(arr, fn) {
  const out = new Map();
  for (const item of arr) {
    const k = fn(item);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(item);
  }
  return out;
}
