import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { getStore } from '@netlify/blobs';

const scrypt = promisify(crypto.scrypt);

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const same = (a, b) => { const A = Buffer.from(String(a)), B = Buffer.from(String(b)); return A.length === B.length && crypto.timingSafeEqual(A, B); };
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const SESSION_MS = 30 * 24 * 3600 * 1000;
const TIMERS = [0, 20, 30, 45, 60];
const hashPw = async (pw, salt) => (await scrypt(pw, salt, 64)).toString('hex');
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

function newGame(lives = 3, timerSec = 0, forgiving = true, gameId = 0) {
  return { gameId, round: 0, phase: 'lobby', prompt: '', lives, timerSec, forgiving, endsAt: 0, scores: {}, results: [], finished: false, winners: [] };
}
function normKey(w, forgiving) {
  let k = String(w).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
  if (forgiving && k.length > 3 && k.slice(-1) === 's' && k.slice(-2) !== 'ss') k = k.slice(0, -1);
  return k;
}
const live = (g, id) => { const s = g.scores[id]; return !s || s.lives > 0; };
const subOk = (g, s) => (s && s.gameId === g.gameId && s.round === g.round && s.word ? s : null);

export function createHandler(store) {
  const getJ = k => store.get(k, { type: 'json' });
  const getGame = async () => (await getJ('game')) || newGame();
  const getRoster = async () => ((await getJ('roster')) || { users: [] }).users;

  // Read, change, and write back only if nobody else changed it in between.
  async function cas(key, fn) {
    for (let i = 0; i < 10; i++) {
      const cur = await store.getWithMetadata(key, { type: 'json' });
      const next = await fn(cur ? cur.data : null);
      if (next === false) return false;
      const r = cur ? await store.setJSON(key, next, { onlyIfMatch: cur.etag }) : await store.setJSON(key, next, { onlyIfNew: true });
      if (r.modified) return next;
      await sleep(20 + Math.random() * 60);
    }
    throw new HttpError(503, 'The game is busy. Try again.');
  }
  const updateGame = fn => cas('game', async cur => fn(cur || newGame()));
  const updateRoster = fn => cas('roster', async cur => fn(cur || { users: [] }));

  /* ---------- sessions (signed cookie, nothing stored) ---------- */
  const configured = () => !!process.env.ADMIN_PASSWORD;
  const secret = () => process.env.SESSION_SECRET || sha('sess|' + process.env.ADMIN_PASSWORD);
  const mac = b => crypto.createHmac('sha256', secret()).update(b).digest('base64url');
  const sign = p => { const b = Buffer.from(JSON.stringify(p)).toString('base64url'); return b + '.' + mac(b); };
  function verify(t) {
    const [b, m] = String(t || '').split('.');
    if (!b || !m || !same(m, mac(b))) return null;
    try { const p = JSON.parse(Buffer.from(b, 'base64url').toString()); return p.e > Date.now() ? p : null; } catch (e) { return null; }
  }
  const cookieOf = req => { const m = /(?:^|; )sid=([^;]+)/.exec(req.headers.get('cookie') || ''); return m ? m[1] : null; };
  const cookie = (req, token, maxAge) => 'sid=' + token + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + maxAge + (new URL(req.url).protocol === 'https:' ? '; Secure' : '');
  async function auth(req) {
    if (!configured()) return null;
    const p = verify(cookieOf(req));
    if (!p) return null;
    if (p.r === 'admin') return { role: 'admin' };
    const u = await getJ('user/' + p.u);
    return u ? { role: 'player', userId: u.id, user: u } : null;
  }
  const needConfig = () => { if (!configured()) throw new HttpError(503, 'The host password is not set on the server yet.'); };
  const needRole = async (req, role) => { const s = await auth(req); if (!s || s.role !== role) throw new HttpError(401, role === 'admin' ? 'Log in as the host.' : 'Log in as a player.'); return s; };

  /* ---------- game logic ---------- */
  function doReveal() {
    return updateGame(async g => {
      if (g.phase !== 'open') return false;
      const roster = await getRoster();
      const eligible = roster.filter(u => live(g, u.id));
      const subs = await Promise.all(eligible.map(u => getJ('sub/' + u.id)));
      const entries = eligible.map((u, i) => { const s = subOk(g, subs[i]); return { u, s, k: s ? normKey(s.word, g.forgiving) : '' }; });
      const counts = {};
      entries.forEach(e => { if (e.k) counts[e.k] = (counts[e.k] || 0) + 1; });
      const scores = { ...g.scores };
      const results = entries.map(e => {
        const c = scores[e.u.id] || { name: e.u.name, points: 0, lives: g.lives };
        const status = !e.k ? 'missed' : (counts[e.k] > 1 ? 'collision' : 'safe');
        scores[e.u.id] = { name: e.u.name, points: c.points + (status === 'safe' ? 1 : 0), lives: c.lives - (status === 'safe' ? 0 : 1) };
        return { uid: e.u.id, name: e.u.name, word: e.s ? e.s.word : '', key: e.k, status };
      });
      const ids = new Set(roster.map(u => u.id));
      const alive = Object.keys(scores).filter(id => ids.has(id) && scores[id].lives > 0);
      let finished = false, winners = [];
      if (ids.size >= 2 && alive.length <= 1) {
        finished = true;
        if (alive.length === 1) winners = [scores[alive[0]].name];
        else {
          const max = Math.max(...results.map(r => scores[r.uid].points));
          winners = results.filter(r => scores[r.uid].points === max).map(r => r.name);
        }
      }
      return { ...g, phase: 'revealed', endsAt: 0, scores, results, finished, winners };
    });
  }

  async function state(s) {
    let g = await getGame();
    // No background process on Netlify, so the timer is enforced whenever anyone checks in.
    if (g.phase === 'open' && g.endsAt && Date.now() > g.endsAt + 1500) { await doReveal(); g = await getGame(); }
    const roster = await getRoster();
    const out = {
      serverNow: Date.now(), role: s.role,
      board: roster.map(u => { const sc = g.scores[u.id]; return { id: u.id, name: u.name, lives: sc ? sc.lives : g.lives, points: sc ? sc.points : 0 }; }),
      game: { gameId: g.gameId, round: g.round, phase: g.phase, prompt: g.prompt, lives: g.lives, timerSec: g.timerSec, forgiving: g.forgiving, endsAt: g.endsAt, results: g.results, finished: g.finished, winners: g.winners }
    };
    if (s.role === 'player') {
      const sub = subOk(g, await getJ('sub/' + s.userId));
      out.me = { id: s.userId, name: s.user.username, word: sub ? sub.word : '' };
    }
    if (s.role === 'admin') {
      const eligible = roster.filter(u => live(g, u.id));
      const subs = await Promise.all(eligible.map(u => getJ('sub/' + u.id)));
      out.progress = eligible.map((u, i) => ({ id: u.id, name: u.name, done: !!subOk(g, subs[i]) }));
    }
    return out;
  }

  /* ---------- routes ---------- */
  return async function handle(req) {
    try {
      const path = new URL(req.url).pathname.replace(/\/+$/, '');
      if (req.method === 'GET' && path === '/api/me') { const s = await auth(req); return json({ role: s ? s.role : null }); }
      if (req.method === 'GET' && path === '/api/state') {
        const s = await auth(req);
        if (!s) throw new HttpError(401, 'Log in first.');
        return json(await state(s));
      }
      if (req.method !== 'POST') throw new HttpError(404, 'Not found.');
      if (!(req.headers.get('content-type') || '').includes('application/json')) throw new HttpError(415, 'Send JSON.');
      let body = {};
      try { const t = await req.text(); body = t ? JSON.parse(t) : {}; } catch (e) { throw new HttpError(400, 'Bad request.'); }

      switch (path) {
        case '/api/register': {
          needConfig();
          const username = clean(body.username, 20), password = String(body.password || '');
          if (!/^[\p{L}\p{N}_ -]{2,20}$/u.test(username)) throw new HttpError(400, 'Pick a username with 2 to 20 letters, numbers, spaces, dashes or underscores.');
          if (password.length < 6 || password.length > 100) throw new HttpError(400, 'Use a password with at least 6 characters.');
          const adminName = (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
          if (username.toLowerCase() === adminName) throw new HttpError(409, 'That username is taken.');
          const id = crypto.randomBytes(6).toString('hex'), salt = crypto.randomBytes(16).toString('hex');
          await store.setJSON('user/' + id, { id, username, salt, hash: await hashPw(password, salt) });
          try {
            await updateRoster(r => {
              if (r.users.some(u => u.name.toLowerCase() === username.toLowerCase())) throw new HttpError(409, 'That username is taken.');
              return { users: [...r.users, { id, name: username }] };
            });
          } catch (e) { await store.delete('user/' + id); throw e; }
          return json({ ok: true }, 200, { 'Set-Cookie': cookie(req, sign({ r: 'player', u: id, e: Date.now() + SESSION_MS }), SESSION_MS / 1000) });
        }
        case '/api/login': {
          needConfig();
          const username = clean(body.username, 20).toLowerCase(), password = String(body.password || '');
          const entry = (await getRoster()).find(u => u.name.toLowerCase() === username);
          const user = entry ? await getJ('user/' + entry.id) : null;
          const ok = same(await hashPw(password, user ? user.salt : 'x'.repeat(32)), user ? user.hash : 'nope') && !!user;
          if (!ok) { await sleep(400); throw new HttpError(401, 'Wrong username or password.'); }
          return json({ ok: true }, 200, { 'Set-Cookie': cookie(req, sign({ r: 'player', u: user.id, e: Date.now() + SESSION_MS }), SESSION_MS / 1000) });
        }
        case '/api/admin/login': {
          needConfig();
          const username = clean(body.username, 40).toLowerCase(), password = String(body.password || '');
          const okUser = same(username, (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase());
          const okPass = same(sha(password), sha(process.env.ADMIN_PASSWORD));
          if (!(okUser && okPass)) { await sleep(400); throw new HttpError(401, 'Wrong host username or password.'); }
          return json({ ok: true }, 200, { 'Set-Cookie': cookie(req, sign({ r: 'admin', e: Date.now() + SESSION_MS }), SESSION_MS / 1000) });
        }
        case '/api/logout':
          return json({ ok: true }, 200, { 'Set-Cookie': cookie(req, '', 0) });

        case '/api/word': {
          const s = await needRole(req, 'player');
          const g = await getGame();
          if (g.phase !== 'open') throw new HttpError(409, 'No round is open.');
          if (g.endsAt && Date.now() > g.endsAt + 1000) throw new HttpError(409, 'Time is up for this round.');
          if (!live(g, s.userId)) throw new HttpError(403, 'You are out of lives.');
          const word = clean(body.word, 30);
          if (!word) throw new HttpError(400, 'Type a word first.');
          await store.setJSON('sub/' + s.userId, { gameId: g.gameId, round: g.round, word, ts: Date.now() });
          return json({ ok: true });
        }
        case '/api/admin/start': {
          await needRole(req, 'admin');
          const prompt = clean(body.prompt, 80);
          if (!prompt) throw new HttpError(400, 'Write a prompt first.');
          const timerSec = TIMERS.includes(+body.timerSec) ? +body.timerSec : 0;
          const roster = await getRoster();
          await updateGame(g => {
            if (g.phase === 'open' || g.finished) throw new HttpError(409, 'Reveal the open round or start a new game first.');
            if (roster.length < 2) throw new HttpError(409, 'You need at least 2 players.');
            const lives = g.round === 0 ? Math.max(1, Math.min(9, parseInt(body.lives, 10) || 3)) : g.lives;
            const scores = { ...g.scores };
            roster.forEach(u => { const p = g.scores[u.id]; scores[u.id] = p ? { name: u.name, points: p.points, lives: p.lives } : { name: u.name, points: 0, lives }; });
            return { ...g, gameId: g.gameId || Date.now(), round: g.round + 1, phase: 'open', prompt, lives, timerSec, forgiving: !!body.forgiving, endsAt: timerSec ? Date.now() + timerSec * 1000 : 0, scores, results: [], winners: [], finished: false };
          });
          return json({ ok: true });
        }
        case '/api/admin/reveal': {
          await needRole(req, 'admin');
          if (!(await doReveal())) throw new HttpError(409, 'No round is open.');
          return json({ ok: true });
        }
        case '/api/admin/new-game': {
          await needRole(req, 'admin');
          const lives = Math.max(1, Math.min(9, parseInt(body.lives, 10) || 3));
          const timerSec = TIMERS.includes(+body.timerSec) ? +body.timerSec : 0;
          await store.setJSON('game', newGame(lives, timerSec, !!body.forgiving, Date.now()));
          const l = await store.list({ prefix: 'sub/' });
          await Promise.all(l.blobs.map(b => store.delete(b.key)));
          return json({ ok: true });
        }
        case '/api/admin/remove': {
          await needRole(req, 'admin');
          const id = String(body.id || '');
          const removed = await updateRoster(r => (r.users.some(u => u.id === id) ? { users: r.users.filter(u => u.id !== id) } : false));
          if (!removed) throw new HttpError(404, 'Player not found.');
          await store.delete('user/' + id); await store.delete('sub/' + id);
          return json({ ok: true });
        }
        default: throw new HttpError(404, 'Not found.');
      }
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'Something went wrong on the server.' }, 500);
    }
  };
}

export default async (req) => createHandler(getStore({ name: 'dont-say-same-word', consistency: 'strong' }))(req);
export const config = { path: '/api/*' };
