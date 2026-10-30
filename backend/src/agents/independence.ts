import { Report } from '../types';
import { textSimilarity } from '../util';

const ECHO_SIM = 0.6; // content-word overlap that counts as "the same message"
const ECHO_WINDOW_MIN = 45; // copies posted close together look like a burst / forward
const CROWD_SOURCES = new Set(['citizen', 'volunteer']);

export interface EchoGroup {
  reports: Report[];
  reason: string;
}

export const reporterKey = (r: Report): string | null => {
  const n = (r.reporterName ?? '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]/g, '');
  return n && n !== 'anonymous' && n !== 'unknown' ? `${r.source}:${n}` : null;
};

/** Near-identical message from crowd sources close in time (a copy-paste / forward / bot burst). */
export function copyReason(a: Report, b: Report): string | null {
  // field teams and gauges are independent instruments; only crowd sources can be copy-paste echoes
  if (!CROWD_SOURCES.has(a.source) || !CROWD_SOURCES.has(b.source)) return null;
  const gapMin = Math.abs(a.timestamp - b.timestamp) / 60000;
  const sim = textSimilarity(a.text, b.text);
  return sim >= ECHO_SIM && gapMin <= ECHO_WINDOW_MIN ? `near-identical wording (${Math.round(sim * 100)}% overlap) within ${Math.round(gapMin)} min` : null;
}

/** Are two reports likely the same voice (same person, or a copy/forward of the same message)? */
export function echoReason(a: Report, b: Report): string | null {
  const ka = reporterKey(a), kb = reporterKey(b);
  if (ka && ka === kb) return `same reporter (${a.reporterName})`;
  return copyReason(a, b);
}

/**
 * Splits reports into groups of non-independent voices. 6 copies of one message => 1 group => 1 source.
 * Transitive: if A~B and B~C they all collapse together.
 */
export function echoGroups(reports: Report[]): EchoGroup[] {
  const p = reports.map((_, i) => i);
  const find = (x: number): number => (p[x] === x ? x : (p[x] = find(p[x])));
  const why = new Map<number, string[]>();
  for (let i = 0; i < reports.length; i++)
    for (let j = i + 1; j < reports.length; j++) {
      const r = echoReason(reports[i], reports[j]);
      if (r) {
        p[find(i)] = find(j);
        why.set(i, [...(why.get(i) ?? []), r]);
      }
    }
  const groups = new Map<number, EchoGroup>();
  reports.forEach((r, i) => {
    const k = find(i);
    const g = groups.get(k) ?? { reports: [], reason: '' };
    g.reports.push(r);
    groups.set(k, g);
  });
  reports.forEach((_, i) => {
    const g = groups.get(find(i))!;
    const w = why.get(i)?.[0];
    if (w && !g.reason) g.reason = w;
  });
  return [...groups.values()];
}
