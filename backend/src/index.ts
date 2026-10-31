import fs from 'fs';
import http from 'http';
import path from 'path';
import cors from 'cors';
import express, { NextFunction, Request, Response } from 'express';
import { WebSocketServer } from 'ws';
import { config } from './config';
import { attachWs } from './bus';
import { initStore, getStore } from './db/store';
import { api } from './routes';
import { getState, resetScenario } from './services/ops';
import { HttpError } from './util';
import { seedUsers } from './auth';

async function main() {
  await initStore();
  seedUsers();

  const app = express();
  app.use(cors()); // friend's frontend can call from any origin / laptop
  app.use(express.json({ limit: '1mb' }));
  // Serve the dashboards from the same origin (no CORS / URL setup needed): http://localhost:4000/app/
  const frontendDir = path.resolve(process.cwd(), config.frontendDir);
  const hasFrontend = fs.existsSync(path.join(frontendDir, 'index.html'));
  if (hasFrontend) app.use('/app', express.static(frontendDir));
  app.get('/', (_req, res) => {
    if (hasFrontend) return res.redirect('/app/');
    res.json({ name: 'CrisisMesh AI backend', docs: 'See API.md', health: '/api/health', ws: '/ws' });
  });
  app.use('/api', api);
  app.use((_req, _res, next) => next(new HttpError(404, 'route not found')));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if ((err as { type?: string })?.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON body' });
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: (err as Error)?.message });
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  attachWs(wss, async () => {
    const s = await getState();
    return { node: config.nodeId, online: s.network.online, planId: s.plan?.id ?? null, summary: s.plan?.summary ?? null };
  });

  // first run: load the synthetic flood scenario
  if ((await getStore().list('settlements')).length === 0) {
    console.log('[boot] empty database -> seeding synthetic flood scenario');
    await resetScenario();
  }

  server.listen(config.port, '0.0.0.0', () => {
    console.log(`CrisisMesh backend [${config.nodeId}] on http://0.0.0.0:${config.port}  (REST /api, WebSocket /ws, store=${getStore().kind})`);
    if (hasFrontend) console.log(`Dashboards: http://localhost:${config.port}/app/`);
    else console.log(`Frontend folder not found at ${frontendDir} (set FRONTEND_DIR) - API only`);
  });
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
