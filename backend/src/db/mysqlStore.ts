import * as mysql from 'mysql2/promise';
import { config } from '../config';
import { COLLECTIONS, Col, EventRow, Store } from './store';

const parse = (v: unknown): any => (typeof v === 'string' ? JSON.parse(v) : v);
const t = (c: Col) => `\`cm_${c}\``;

export class MysqlStore implements Store {
  kind = 'mysql' as const;
  private pool!: mysql.Pool;

  async init(): Promise<void> {
    const { host, port, user, password, database } = config.mysql;
    const boot = await mysql.createConnection({ host, port, user, password, connectTimeout: 4000 });
    await boot.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4`);
    await boot.end();
    this.pool = mysql.createPool({ host, port, user, password, database, connectionLimit: 10 });
    for (const c of COLLECTIONS) {
      await this.pool.query(
        `CREATE TABLE IF NOT EXISTS ${t(c)} (
           id VARCHAR(64) PRIMARY KEY,
           data JSON NOT NULL,
           updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
         ) ENGINE=InnoDB`,
      );
    }
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS event_log (
         seq BIGINT AUTO_INCREMENT PRIMARY KEY,
         ts BIGINT NOT NULL,
         type VARCHAR(64) NOT NULL,
         node VARCHAR(64) NOT NULL,
         payload JSON NULL,
         INDEX idx_type (type)
       ) ENGINE=InnoDB`,
    );
  }

  async list<T>(col: Col): Promise<T[]> {
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(`SELECT data FROM ${t(col)}`);
    return rows.map((r) => parse(r.data) as T);
  }
  async get<T>(col: Col, id: string): Promise<T | undefined> {
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(`SELECT data FROM ${t(col)} WHERE id = ?`, [id]);
    return rows.length ? (parse(rows[0].data) as T) : undefined;
  }
  async put(col: Col, id: string, doc: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${t(col)} (id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)`,
      [id, JSON.stringify(doc)],
    );
  }
  async del(col: Col, id: string): Promise<void> {
    await this.pool.query(`DELETE FROM ${t(col)} WHERE id = ?`, [id]);
  }
  async clear(col: Col): Promise<void> {
    await this.pool.query(`DELETE FROM ${t(col)}`);
  }
  async appendEvent(type: string, payload: unknown): Promise<EventRow> {
    const ts = Date.now();
    const [res] = await this.pool.query<mysql.ResultSetHeader>(
      `INSERT INTO event_log (ts, type, node, payload) VALUES (?, ?, ?, ?)`,
      [ts, type, config.nodeId, JSON.stringify(payload ?? null)],
    );
    return { seq: res.insertId, ts, type, node: config.nodeId, payload };
  }
  async events(sinceSeq: number, limit: number): Promise<EventRow[]> {
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT seq, ts, type, node, payload FROM event_log WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
      [sinceSeq, limit],
    );
    return rows.map((r) => ({ seq: Number(r.seq), ts: Number(r.ts), type: r.type, node: r.node, payload: parse(r.payload) }));
  }
}
