import { Hazard, Parsed, Report, Settlement, TraceEntry } from '../types';
import { clamp, uniq } from '../util';
import { PROFILES } from '../profiles';
import { extractWithLlm, llmAvailable } from './llm';

const WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30,
};
const UNIT = 'families|family|people|persons|person|members|residents|kids|children|elderly|villagers|ppl|pax|souls';
const PEOPLE_RE = new RegExp(`(\\d+|${Object.keys(WORDS).join('|')})\\s*(?:\\+\\s*)?(${UNIT})\\b`, 'g');

const HAZARD_KW: Record<string, string[]> = {
  trapped: ['trapped', 'stuck', 'stranded', "can't get out", 'cannot get out'],
  roof: ['roof', 'terrace', 'rooftop'],
  rising: ['rising', 'increasing', 'going up', 'fast'],
  current: ['current', 'strong flow', 'swept'],
  collapse: ['collapsed', 'collapse', 'wall fell'],
  electric: ['electric', 'live wire', 'power line'],
  drowning: ['drowning', 'swept away'],
};
const NEED_KW: Record<string, string[]> = {
  medical: ['medical', 'medicine', 'insulin', 'injur', 'sick', 'pregnan', 'doctor', 'ambulance', 'oxygen', 'dialysis', 'bleeding'],
  boat: ['boat', 'evacuat', 'rescue'],
  food: ['food', 'hungry', 'ration'],
  water: ['drinking water'],
};
const VULN_KW = ['elderly', 'old man', 'old woman', 'child', 'kid', 'infant', 'baby', 'pregnan', 'disabled', 'wheelchair', 'sick', 'patient', 'oxygen', 'diabet'];
const WATER_HINTS: [string, number][] = [['ankle', 0], ['knee', 0.05], ['waist', 0.12], ['chest', 0.2], ['neck', 0.28], ['roof', 0.3]];
const RESOLVED_KW = ['rescued already', 'all safe', 'safe now', 'evacuated already', 'got everyone out', 'no longer need', 'false alarm'];
const RECEDING_KW = ['receding', 'going down', 'water falling', 'dropping fast'];
const LANDMARKS = ['panchayat office', 'temple lane', 'school', 'bus stand', 'cattle shed', 'market', 'bridge', 'hospital'];

function extractPeople(t: string): number | null {
  let best: number | null = null;
  PEOPLE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PEOPLE_RE.exec(t))) {
    const n = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : WORDS[m[1]];
    const v = /^famil/.test(m[2]) ? n * 4 : n;
    if (best === null || v > best) best = v;
  }
  const f = /family of (\d+)/.exec(t);
  if (f) {
    const v = parseInt(f[1], 10);
    if (best === null || v > best) best = v;
  }
  return best;
}

const matchKeys = (t: string, map: Record<string, string[]>): string[] =>
  Object.entries(map).filter(([, kws]) => kws.some((k) => t.includes(k))).map(([k]) => k);

export function parseByRules(
  r: Pick<Report, 'text' | 'settlementId' | 'peopleCount'>,
  settlements: Settlement[],
  hazard: Hazard,
): Parsed {
  const t = r.text.toLowerCase();
  let sid: string | null = r.settlementId ?? null;
  if (!sid) {
    let best = 0;
    for (const s of settlements) {
      if (s.type === 'base') continue;
      for (const n of [s.name, ...s.aliases]) {
        const k = n.toLowerCase();
        if (t.includes(k) && k.length > best) {
          best = k.length;
          sid = s.id;
        }
      }
    }
  }
  const people = r.peopleCount ?? extractPeople(t);
  const hazards = uniq([...matchKeys(t, HAZARD_KW), ...matchKeys(t, PROFILES[hazard].keywords)]);
  const needs = matchKeys(t, NEED_KW);
  const vulnerable = VULN_KW.some((k) => t.includes(k));
  const hint = WATER_HINTS.find(([k]) => t.includes(k));
  let urgency = 0.25 + 0.1 * hazards.length + (hint ? hint[1] : 0) + (vulnerable ? 0.1 : 0) + (/(urgent|sos|emergency|help)/.test(t) ? 0.05 : 0);
  urgency = clamp(urgency);
  const landmark = LANDMARKS.find((l) => t.includes(l)) ?? null;
  const confidence = (sid ? 0.5 : 0) + (people !== null ? 0.3 : 0) + (landmark || hazards.length ? 0.2 : 0.1);
  return {
    settlementId: sid,
    landmark,
    people,
    hazards,
    needs,
    vulnerable,
    waterHint: hint ? hint[0] : null,
    urgency,
    resolved: RESOLVED_KW.some((k) => t.includes(k)),
    receding: RECEDING_KW.some((k) => t.includes(k)),
    confidence: clamp(confidence),
    method: 'rules',
  };
}

/** Incident Analysis agent: raw text -> structured fields. Local LLM (Ollama) refines rules when available. */
export async function analyse(
  reports: Report[],
  settlements: Settlement[],
  hazard: Hazard,
  useLlm: boolean,
): Promise<{ reports: Report[]; changed: Report[]; trace: TraceEntry }> {
  const t0 = Date.now();
  const todo = reports.filter((r) => !r.parsed);
  const llm = useLlm && todo.length > 0 && (await llmAvailable());
  const names = settlements.filter((s) => s.type !== 'base').map((s) => s.name);
  const details: string[] = [];
  let llmUsed = 0;
  for (const r of todo) {
    const rules = parseByRules(r, settlements, hazard);
    if (r.source === 'sensor') {
      r.parsed = { ...rules, people: null, urgency: 0 };
    } else if (llm) {
      const x = await extractWithLlm(r.text, names);
      if (x) {
        llmUsed++;
        const sid =
          rules.settlementId ??
          settlements.find((s) => x.settlement && s.name.toLowerCase() === x.settlement.toLowerCase())?.id ??
          null;
        r.parsed = {
          ...rules,
          settlementId: sid,
          people: rules.people ?? x.people ?? null,
          hazards: uniq([...rules.hazards, ...(x.hazards ?? [])]),
          needs: uniq([...rules.needs, ...(x.needs ?? [])]),
          vulnerable: rules.vulnerable || !!x.vulnerable,
          urgency: x.urgency !== undefined ? clamp((rules.urgency + x.urgency) / 2) : rules.urgency,
          method: 'llm+rules',
          confidence: clamp(rules.confidence + 0.05),
        };
      } else r.parsed = rules;
    } else r.parsed = rules;
    const p = r.parsed!;
    details.push(
      `${r.id} [${r.source}] -> ${p.settlementId ?? 'UNPLACED'}, people=${p.people ?? '?'}, hazards=[${p.hazards.join(',')}], urgency=${p.urgency.toFixed(2)}${p.resolved ? ', RESOLVED' : ''} (${p.method})`,
    );
  }
  return {
    reports,
    changed: todo,
    trace: {
      agent: 'Incident Analysis',
      ms: Date.now() - t0,
      summary: todo.length
        ? `Parsed ${todo.length} new report(s) (${llmUsed} with local LLM, ${todo.length - llmUsed} rules-only)`
        : 'No new reports to parse',
      details,
    },
  };
}
