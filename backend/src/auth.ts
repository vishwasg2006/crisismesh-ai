import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { config } from './config';
import { getStore } from './db/store';
import { HttpError } from './util';
import { Resource } from './types';

export type Role = 'coordinator' | 'responder';

interface User {
  username: string;
  name: string;
  role: Role;
  teamId: string | null; // responders: the boat/team (resource id) they operate
  salt: string;
  hash: string;
  createdAt: number;
}
export interface AuthUser {
  username: string;
  name: string;
  role: Role;
  teamId: string | null;
}

// ---------- password + token helpers ----------
const hashPw = (pw: string, salt: string): string => crypto.scryptSync(pw, salt, 32).toString('hex');
const safeEq = (a: string, b: string): boolean => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (data: string): string => crypto.createHmac('sha256', config.auth.secret).update(data).digest('base64url');

function makeToken(u: AuthUser): string {
  const body = b64({ ...u, exp: Date.now() + config.auth.tokenHours * 3600_000 });
  return `${body}.${sign(body)}`;
}
function readToken(token: string): AuthUser | null {
  const [body, sig] = token.split('.');
  if (!body || !sig || !safeEq(sig, sign(body))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (typeof p.exp !== 'number' || p.exp < Date.now()) return null;
    if (p.role !== 'coordinator' && p.role !== 'responder') return null;
    return { username: p.username, name: p.name, role: p.role, teamId: p.teamId ?? null };
  } catch {
    return null;
  }
}

// ---------- user storage (own file, so a scenario reset never deletes accounts) ----------
const usersFile = (): string => path.resolve(process.cwd(), config.auth.usersPath);

function loadUsers(): User[] {
  try {
    return JSON.parse(fs.readFileSync(usersFile(), 'utf8')) as User[];
  } catch {
    return [];
  }
}
function saveUsers(users: User[]): void {
  fs.mkdirSync(path.dirname(usersFile()), { recursive: true });
  fs.writeFileSync(usersFile(), JSON.stringify(users, null, 2));
}
function makeUser(username: string, password: string, name: string, role: Role, teamId: string | null): User {
  const salt = crypto.randomBytes(16).toString('hex');
  return { username, name, role, teamId, salt, hash: hashPw(password, salt), createdAt: Date.now() };
}
const pub = (u: User): AuthUser => ({ username: u.username, name: u.name, role: u.role, teamId: u.teamId });

/** First run: create demo accounts so the app is usable immediately. */
export function seedUsers(): void {
  if (loadUsers().length) return;
  saveUsers([
    makeUser('coordinator', 'coord123', 'Chief Coordinator', 'coordinator', null),
    makeUser('responder1', 'resp123', 'Rescue Truck Team 1', 'responder', 'T1'),
    makeUser('responder2', 'resp123', 'Medical Team 2', 'responder', 'T2'),
    makeUser('boat1', 'resp123', 'Boat Alpha crew', 'responder', 'B1'),
  ]);
  console.log('[auth] seeded demo users: coordinator/coord123, responder1/resp123, responder2/resp123, boat1/resp123');
}

// ---------- middleware ----------
declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

const PUBLIC: Array<[string, RegExp]> = [
  ['GET', /^\/health$/],
  ['POST', /^\/auth\/(login|register)$/],
  ['GET', /^\/auth\/teams$/], // names only, needed by the register form
  // laptop-to-laptop merge (server to server, no human logged in)
  ['GET', /^\/peer\/snapshot$/],
  ['POST', /^\/peer\/merge$/],
];
// everything else that is not a GET needs the coordinator role, except these:
const RESPONDER_WRITE: Array<[string, RegExp]> = [['POST', /^\/reports$/], ['POST', /^\/missions\/status$/]];
const matches = (rules: Array<[string, RegExp]>, req: Request): boolean =>
  rules.some(([m, re]) => m === req.method && re.test(req.path));

export const authGuard: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  if (!config.auth.enabled || matches(PUBLIC, req)) return next();

  const header = req.headers.authorization || '';
  const user = header.startsWith('Bearer ') ? readToken(header.slice(7)) : null;
  if (!user) return next(new HttpError(401, 'login required'));
  req.user = user;

  if (user.role === 'coordinator') return next();
  if (req.method === 'GET' || matches(RESPONDER_WRITE, req)) return next();
  next(new HttpError(403, `the ${user.role} role is not allowed to do this`));
};

// ---------- routes ----------
export const authRouter = Router();
const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

authRouter.post('/auth/login', (req, res) => {
  const username = clean(req.body?.username, 40).toLowerCase();
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const u = loadUsers().find((x) => x.username === username);
  // always hash, so a wrong username takes as long as a wrong password
  const attempt = hashPw(password, u?.salt ?? 'x');
  if (!u || !safeEq(attempt, u.hash)) throw new HttpError(401, 'wrong username or password');
  res.json({ token: makeToken(pub(u)), user: pub(u) });
});

authRouter.post('/auth/register', (req, res, next) => {
  register(req, res).catch(next); // Express 4 does not catch async errors itself
});

async function register(req: Request, res: Response): Promise<void> {
  const username = clean(req.body?.username, 40).toLowerCase();
  const name = clean(req.body?.name, 60) || username;
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const role: Role = req.body?.role === 'coordinator' ? 'coordinator' : 'responder';
  let teamId: string | null = null;

  if (!/^[a-z0-9_.-]{3,40}$/.test(username)) throw new HttpError(400, 'username: 3-40 chars, letters/numbers/._-');
  if (password.length < 6) throw new HttpError(400, 'password must be at least 6 characters');

  if (role === 'coordinator') {
    if (clean(req.body?.code, 80) !== config.auth.coordinatorCode) throw new HttpError(403, 'invalid coordinator access code');
  } else {
    teamId = clean(req.body?.teamId, 40) || null;
    if (!teamId) throw new HttpError(400, 'choose your team / boat');
    if (!(await getStore().get<Resource>('resources', teamId))) throw new HttpError(400, 'unknown team / boat');
  }

  const users = loadUsers();
  if (users.some((x) => x.username === username)) throw new HttpError(409, 'username already taken');
  const u = makeUser(username, password, name, role, teamId);
  users.push(u);
  saveUsers(users);
  res.status(201).json({ token: makeToken(pub(u)), user: pub(u) });
}

authRouter.get('/auth/teams', async (_req, res) => {
  const rs = await getStore().list<Resource>('resources');
  res.json(rs.map((r) => ({ id: r.id, name: r.name })));
});

authRouter.get('/auth/me', (req, res) => {
  if (!config.auth.enabled) return res.json({ user: { username: 'open', name: 'Open access', role: 'coordinator', teamId: null }, authDisabled: true });
  if (!req.user) throw new HttpError(401, 'login required');
  res.json({ user: req.user });
});

authRouter.get('/auth/users', (req, res) => {
  if (req.user?.role !== 'coordinator') throw new HttpError(403, 'coordinator only');
  res.json(loadUsers().map(pub));
});
