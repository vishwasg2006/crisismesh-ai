import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { COLLECTIONS, Col, EventRow, Store } from './store';

interface Data {
  cols: Record<string, Record<string, unknown>>;
  events: EventRow[];
  seq: number;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export class JsonStore implements Store {
  kind = 'json' as const;
  private data: Data = { cols: {}, events: [], seq: 0 };
  private timer?: NodeJS.Timeout;
  private file = path.resolve(config.jsonPath);

  async init(): Promise<void> {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (fs.existsSync(this.file)) {
      try {
        this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      } catch {
        console.warn('[store] store.json unreadable, starting empty');
      }
    }
    for (const c of COLLECTIONS) this.data.cols[c] ??= {};
  }

  private persist() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try {
        fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data));
        fs.renameSync(this.file + '.tmp', this.file);
      } catch (e) {
        console.warn('[store] persist failed', (e as Error).message);
      }
    }, 300);
  }

  async list<T>(col: Col): Promise<T[]> {
    return Object.values(this.data.cols[col]).map((d) => clone(d)) as T[];
  }
  async get<T>(col: Col, id: string): Promise<T | undefined> {
    const d = this.data.cols[col][id];
    return d === undefined ? undefined : (clone(d) as T);
  }
  async put(col: Col, id: string, doc: unknown): Promise<void> {
    this.data.cols[col][id] = clone(doc);
    this.persist();
  }
  async del(col: Col, id: string): Promise<void> {
    delete this.data.cols[col][id];
    this.persist();
  }
  async clear(col: Col): Promise<void> {
    this.data.cols[col] = {};
    this.persist();
  }
  async appendEvent(type: string, payload: unknown): Promise<EventRow> {
    const row: EventRow = { seq: ++this.data.seq, ts: Date.now(), type, node: config.nodeId, payload: clone(payload) };
    this.data.events.push(row);
    if (this.data.events.length > 5000) this.data.events.splice(0, this.data.events.length - 5000);
    this.persist();
    return row;
  }
  async events(sinceSeq: number, limit: number): Promise<EventRow[]> {
    return this.data.events.filter((e) => e.seq > sinceSeq).slice(0, limit);
  }
}
