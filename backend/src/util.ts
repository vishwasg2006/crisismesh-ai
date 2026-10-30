export const clamp = (v: number, a = 0, b = 1): number => Math.min(b, Math.max(a, v));
export const round = (v: number, d = 1): number => Math.round(v * 10 ** d) / 10 ** d;

export function haversine(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Serialises async work so writes/pipeline runs never interleave. */
export class Mutex {
  private p: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.p.then(fn);
    this.p = r.catch(() => undefined);
    return r;
  }
}

export const uniq = <T>(a: T[]): T[] => Array.from(new Set(a));

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const STOP = new Set(['the','a','an','is','are','at','in','on','of','to','and','we','please','pls','near','by','with','for','from','my','our','i','it','there','here','need','needs','help','send','urgent','urgently','now']);
export function tokens(t: string): string[] {
  return t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));
}
/** Jaccard similarity of the content words (0..1). Near-copies score > 0.6. */
export function textSimilarity(a: string, b: string): number {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}
