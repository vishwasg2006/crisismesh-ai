import { Report, Resource, Route, Settlement, Source } from '../types';
import { getStore, setKv } from './store';

/** Synthetic flood scenario: fictional "Riverbend" district. */
const T0 = Date.now();

const S = (
  id: string, name: string, aliases: string[], type: Settlement['type'],
  lat: number, lng: number, population: number, water: number, rate: number, crit: number,
): Settlement => ({
  id, name, aliases, type, lat, lng, population,
  waterLevelM: water, riseRateMPerHr: rate, criticalLevelM: crit, updatedAt: T0,
});

export const SETTLEMENTS: Settlement[] = [
  S('BASE', 'District Rescue Base', ['rescue base', 'relief camp'], 'base', 12.3, 76.65, 0, 0.1, 0, 3),
  S('S1', 'Kaveri Nagar', ['kaveri nagar', 'kaveri'], 'village', 12.312, 76.662, 2400, 1.4, 0.35, 2.5),
  S('S2', 'Hosahalli', ['hosahalli'], 'village', 12.326, 76.641, 900, 0.9, 0.2, 2.0),
  S('S3', 'Maddur Pet', ['maddur pet', 'maddur'], 'town', 12.288, 76.671, 5200, 1.1, 0.25, 2.2),
  S('S4', 'Sangam Colony', ['sangam colony', 'sangam'], 'ward', 12.304, 76.68, 1500, 1.8, 0.4, 2.2),
  S('S5', 'Temple Street Ward', ['temple street ward', 'temple street'], 'ward', 12.295, 76.635, 1800, 0.6, 0.1, 2.0),
  S('S6', 'Anchepalya', ['anchepalya'], 'village', 12.338, 76.659, 600, 1.2, 0.3, 2.0),
  S('S7', 'Lakshmipura', ['lakshmipura'], 'village', 12.278, 76.648, 1100, 0.8, 0.15, 2.0),
];

const R = (id: string, a: string, b: string, mode: Route['mode'], minutes: number, status: Route['status'], note?: string): Route =>
  ({ id, a, b, mode, minutes, status, note });

export const ROUTES: Route[] = [
  // roads
  R('RD1', 'BASE', 'S5', 'road', 8, 'open'),
  R('RD2', 'BASE', 'S7', 'road', 12, 'open'),
  R('RD3', 'BASE', 'S2', 'road', 14, 'open'),
  R('RD4', 'S2', 'S6', 'road', 10, 'blocked', 'Bridge washed away'),
  R('RD5', 'BASE', 'S1', 'road', 10, 'flooded', 'Underpass under 1.2 m of water'),
  R('RD6', 'S1', 'S4', 'road', 9, 'flooded'),
  R('RD7', 'BASE', 'S3', 'road', 11, 'open'),
  R('RD8', 'S3', 'S4', 'road', 8, 'open'),
  R('RD9', 'S3', 'S7', 'road', 9, 'open'),
  // water routes (boats)
  R('WR1', 'BASE', 'S1', 'water', 7, 'open'),
  R('WR2', 'S1', 'S4', 'water', 6, 'open'),
  R('WR3', 'BASE', 'S4', 'water', 13, 'open'),
  R('WR4', 'S1', 'S6', 'water', 9, 'open'),
  R('WR5', 'S2', 'S6', 'water', 8, 'open'),
  R('WR6', 'BASE', 'S3', 'water', 10, 'open'),
  R('WR7', 'S3', 'S4', 'water', 7, 'open'),
  R('WR8', 'BASE', 'S7', 'water', 12, 'open'),
  R('WR9', 'BASE', 'S2', 'water', 12, 'open'),
];

export const RESOURCES: Resource[] = [
  { id: 'B1', name: 'Boat Alpha', kind: 'boat', mode: 'water', capacity: 8, speedFactor: 1.0, skills: [], status: 'available' },
  { id: 'B2', name: 'Boat Bravo', kind: 'boat', mode: 'water', capacity: 6, speedFactor: 1.2, skills: [], status: 'available' },
  { id: 'B3', name: 'Boat Charlie (large)', kind: 'boat', mode: 'water', capacity: 12, speedFactor: 0.8, skills: [], status: 'available' },
  { id: 'T1', name: 'Rescue Truck Team 1', kind: 'team', mode: 'road', capacity: 12, speedFactor: 1.0, skills: [], status: 'available' },
  { id: 'T2', name: 'Medical Team 2', kind: 'team', mode: 'road', capacity: 6, speedFactor: 1.1, skills: ['medical'], status: 'available' },
];

type Seed = {
  s: Source; text: string; name: string; ago: number;
  at?: [string, number, number]; sid?: string; people?: number;
  reading?: Report['reading'];
};

export const SEED_REPORTS: Seed[] = [
  { s: 'field', name: 'Ravi (field team)', ago: 25, at: ['S4', 0.0006, 0.0004],
    text: 'Sangam Colony temple lane: 12 people trapped on a roof, water chest high, 3 kids among them. Need boat urgently' },
  { s: 'volunteer', name: 'Anitha', ago: 18, at: ['S4', 0.0008, 0.0005],
    text: 'sangam colony temple lane roof around 15 ppl stuck incl children. water rising fast' },
  { s: 'citizen', name: 'Anonymous', ago: 10, sid: 'S4', text: 'Sangam colony help! water rising' },
  { s: 'field', name: 'Imran (field team)', ago: 32, at: ['S1', 0.0003, -0.0002],
    text: 'Kaveri Nagar near panchayat office: 8 families stranded on first floor, water waist high' },
  { s: 'citizen', name: 'Mohan', ago: 20, at: ['S1', 0.0004, -0.0001],
    text: 'kaveri nagar panchayat office 6 people trapped, need boat' },
  { s: 'field', name: 'Divya (field team)', ago: 45, at: ['S6', 0.0002, 0.0003],
    text: 'Anchepalya school terrace: 20 people on terrace, one pregnant woman, boat needed, road bridge washed away' },
  { s: 'volunteer', name: 'Suresh', ago: 90, at: ['S3', 0.001, 0.0005],
    text: 'Maddur Pet market: ground floor flooded, 5 people upstairs, safe for now' },
  { s: 'volunteer', name: 'Latha', ago: 15, at: ['S3', -0.002, 0.003],
    text: 'Maddur Pet bridge side: family of 4 trapped, one child is sick, water knee high' },
  { s: 'citizen', name: 'Kamala', ago: 400, at: ['S5', 0.0005, 0.0], people: 2,
    text: 'Temple Street Ward: elderly couple, need medicine (insulin), water knee high' },
  { s: 'volunteer', name: 'Girish', ago: 150, at: ['S2', 0.0005, 0.0005],
    text: 'Hosahalli cattle shed: 3 people stuck, water knee deep' },
  { s: 'field', name: 'Divya (field team)', ago: 30, at: ['S2', 0.0005, 0.0005],
    text: 'Hosahalli cattle shed update: rescued already by locals, all safe now' },
  { s: 'field', name: 'Imran (field team)', ago: 40, at: ['S7', 0.0004, 0.0003],
    text: 'Lakshmipura bus stand: 9 people incl 2 elderly, waist high water, need evacuation' },
  { s: 'sensor', name: 'Gauge G-S4', ago: 5, sid: 'S4', reading: { waterLevelM: 1.8, riseRateMPerHr: 0.4 },
    text: 'Gauge Sangam Colony: 1.8 m, rising 0.40 m/h' },
  { s: 'sensor', name: 'Gauge G-S1', ago: 5, sid: 'S1', reading: { waterLevelM: 1.4, riseRateMPerHr: 0.35 },
    text: 'Gauge Kaveri Nagar: 1.4 m, rising 0.35 m/h' },
];

/** Reports "held" at a remote node / cloud (citizens, volunteers) used to demo reconnect + conflict merge. */
export const DEMO_REMOTE_REPORTS: Seed[] = [
  { s: 'citizen', name: 'Priya (remote)', ago: 4, at: ['S1', 0.0003, -0.0001],
    text: 'Kaveri Nagar panchayat office: 30 people on first floor, water rising fast, please send boats' },
  { s: 'volunteer', name: 'Naveen (remote)', ago: 6, at: ['S4', 0.0007, 0.0004],
    text: 'Sangam Colony temple lane roof 14 people, kids and an elderly man' },
  { s: 'field', name: 'Divya (remote)', ago: 8, at: ['S2', -0.003, -0.002],
    text: 'Hosahalli school: 18 people trapped, water chest high, one needs oxygen' },
  { s: 'volunteer', name: 'Gopal (remote)', ago: 3, at: ['S7', 0.0004, 0.0003],
    text: 'Lakshmipura bus stand: 9 people incl 2 elderly' },
];

export function seedToPayload(seed: Seed) {
  const base = SETTLEMENTS.find((x) => x.id === (seed.at ? seed.at[0] : seed.sid));
  return {
    source: seed.s,
    text: seed.text,
    reporterName: seed.name,
    minutesAgo: seed.ago,
    settlementId: seed.sid,
    peopleCount: seed.people,
    lat: seed.at && base ? base.lat + seed.at[1] : undefined,
    lng: seed.at && base ? base.lng + seed.at[2] : undefined,
    reading: seed.reading,
  };
}

export async function seedScenario(): Promise<void> {
  const st = getStore();
  for (const c of ['settlements', 'routes', 'resources', 'reports', 'incidents', 'plans', 'sync_queue', 'kv'] as const) {
    await st.clear(c);
  }
  for (const s of SETTLEMENTS) await st.put('settlements', s.id, s);
  for (const r of ROUTES) await st.put('routes', r.id, r);
  for (const r of RESOURCES) await st.put('resources', r.id, r);

  let n = 0;
  for (const seed of SEED_REPORTS) {
    n++;
    const p = seedToPayload(seed);
    const id = `R-${String(n).padStart(4, '0')}`;
    const rep: Report = {
      id, source: p.source, text: p.text, reporterName: p.reporterName,
      lat: p.lat, lng: p.lng, settlementId: p.settlementId, peopleCount: p.peopleCount, reading: p.reading,
      timestamp: Date.now() - p.minutesAgo * 60000, createdAt: Date.now(), origin: 'local', synced: true,
    };
    await st.put('reports', id, rep);
  }
  await setKv('counter', n);
  await setKv('network', { online: true, changedAt: Date.now() });
  await setKv('hazard', 'flood');
  await setKv('locks', {});
}
