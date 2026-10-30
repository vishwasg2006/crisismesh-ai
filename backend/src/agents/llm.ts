import { config } from '../config';

let up = false;
let lastCheck = 0;

async function fetchT(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function llmAvailable(force = false): Promise<boolean> {
  if (!config.ollama.enabled) return false;
  if (!force && Date.now() - lastCheck < 15000) return up;
  lastCheck = Date.now();
  try {
    const r = await fetchT(`${config.ollama.url}/api/tags`, {}, 1500);
    up = r.ok;
  } catch {
    up = false;
  }
  return up;
}

async function generate(prompt: string, json: boolean): Promise<string | null> {
  if (!(await llmAvailable())) return null;
  try {
    const r = await fetchT(
      `${config.ollama.url}/api/generate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.ollama.model,
          prompt,
          stream: false,
          ...(json ? { format: 'json' } : {}),
          options: { temperature: 0.1 },
        }),
      },
      config.ollama.timeoutMs,
    );
    if (!r.ok) return null;
    const j = (await r.json()) as { response?: string };
    return j.response ?? null;
  } catch {
    up = false;
    return null;
  }
}

export interface LlmExtract {
  settlement?: string;
  people?: number;
  hazards?: string[];
  needs?: string[];
  vulnerable?: boolean;
  urgency?: number;
}

export async function extractWithLlm(text: string, settlementNames: string[]): Promise<LlmExtract | null> {
  const prompt =
    `You extract structured data from an emergency flood report. Reply ONLY with JSON:\n` +
    `{"settlement": one of ${JSON.stringify(settlementNames)} or null, "people": integer or null, ` +
    `"hazards": string[], "needs": string[], "vulnerable": boolean (elderly/children/pregnant/sick present), "urgency": number 0..1}\n` +
    `Report: """${text}"""`;
  const out = await generate(prompt, true);
  if (!out) return null;
  try {
    const j = JSON.parse(out) as LlmExtract;
    return {
      settlement: typeof j.settlement === 'string' ? j.settlement : undefined,
      people: typeof j.people === 'number' && j.people >= 0 && j.people < 5000 ? Math.round(j.people) : undefined,
      hazards: Array.isArray(j.hazards) ? j.hazards.filter((x) => typeof x === 'string').slice(0, 8) : undefined,
      needs: Array.isArray(j.needs) ? j.needs.filter((x) => typeof x === 'string').slice(0, 8) : undefined,
      vulnerable: typeof j.vulnerable === 'boolean' ? j.vulnerable : undefined,
      urgency: typeof j.urgency === 'number' ? Math.min(1, Math.max(0, j.urgency)) : undefined,
    };
  } catch {
    return null;
  }
}

export async function narrate(facts: string): Promise<string | null> {
  const out = await generate(
    `You are a rescue coordination assistant. In 3-4 plain sentences, explain this rescue plan to a human coordinator. ` +
      `Mention what is prioritised first and why, and anything they must double-check. Do not invent facts.\n\n${facts}`,
    false,
  );
  return out ? out.trim() : null;
}
