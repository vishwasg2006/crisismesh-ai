import 'dotenv/config';

const num = (v: string | undefined, d: number): number =>
  v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d;

export const config = {
  port: num(process.env.PORT, 4000),
  frontendDir: process.env.FRONTEND_DIR || '../frontend',
  nodeId: process.env.NODE_ID || 'hq-node-1',
  store: (process.env.STORE || 'auto') as 'auto' | 'mysql' | 'json',
  mysql: {
    host: process.env.MYSQL_HOST || 'localhost',
    port: num(process.env.MYSQL_PORT, 3306),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'crisismesh',
  },
  jsonPath: process.env.JSON_PATH || './data/store.json',
  ollama: {
    enabled: process.env.OLLAMA_ENABLED !== 'false',
    url: process.env.OLLAMA_URL || 'http://localhost:11434',
    model: process.env.OLLAMA_MODEL || 'llama3.2',
    timeoutMs: num(process.env.OLLAMA_TIMEOUT_MS, 15000),
  },
  staleMin: num(process.env.STALE_MIN, 180),
};
