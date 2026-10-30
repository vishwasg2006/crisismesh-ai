import { config } from '../config';

export const COLLECTIONS = [
  'settlements',
  'routes',
  'resources',
  'reports',
  'incidents',
  'plans',
  'sync_queue',
  'kv',
] as const;
export type Col = (typeof COLLECTIONS)[number];

export interface EventRow {
  seq: number;
  ts: number;
  type: string;
  node: string;
  payload: unknown;
}

export interface Store {
  kind: 'mysql' | 'json';
  init(): Promise<void>;
  list<T>(col: Col): Promise<T[]>;
  get<T>(col: Col, id: string): Promise<T | undefined>;
  put(col: Col, id: string, doc: unknown): Promise<void>;
  del(col: Col, id: string): Promise<void>;
  clear(col: Col): Promise<void>;
  appendEvent(type: string, payload: unknown): Promise<EventRow>;
  events(sinceSeq: number, limit: number): Promise<EventRow[]>;
}

let current: Store | null = null;

export function getStore(): Store {
  if (!current) throw new Error('Store not initialised');
  return current;
}

export async function initStore(): Promise<Store> {
  const { JsonStore } = await import('./jsonStore');
  if (config.store !== 'json') {
    try {
      const { MysqlStore } = await import('./mysqlStore');
      const s = new MysqlStore();
      await s.init();
      current = s;
      console.log(`[store] MySQL connected (${config.mysql.host}:${config.mysql.port}/${config.mysql.database})`);
      return s;
    } catch (e) {
      if (config.store === 'mysql') throw e;
      console.warn(`[store] MySQL not reachable (${(e as Error).message}) -> falling back to JSON file store`);
    }
  }
  const s = new JsonStore();
  await s.init();
  current = s;
  console.log(`[store] JSON file store at ${config.jsonPath}`);
  return s;
}

// ---- small key/value helpers (collection "kv") ----
export async function getKv<T>(key: string, fallback: T): Promise<T> {
  const d = await getStore().get<{ value: T }>('kv', key);
  return d ? d.value : fallback;
}
export async function setKv<T>(key: string, value: T): Promise<void> {
  await getStore().put('kv', key, { value });
}
