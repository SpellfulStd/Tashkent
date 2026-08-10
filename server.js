const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const { Issuer, generators } = require('openid-client');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 7777;
const PUBLIC = path.join(__dirname, 'public');
const APP_URL = process.env.APP_URL || 'https://tashkent.spellful.site';
const ADMIN_UPLOAD_DIR = path.join(__dirname, 'data', 'admin_uploads');
const ADMIN_CHAT_MAX_IMAGES = 5;
const ADMIN_CHAT_MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const ADMIN_CHAT_IMAGE_TYPES = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
]);
const SERIES_MAX_DURATION_HOURS = 24;
const SERIES_AUTO_FINISH_INTERVAL_MS = 5 * 60 * 1000;
const SPELLFUL_LAST_BALL_GAME_ID = '79d9f99a-4820-4d29-b9f4-d630cf3ef607';
const SERVER_EVENT_DEFS = {
  pocket_regular: { balls: 1, points: 1,  prevDelta: -1, isDurak: false, isGolden: false, isPocket: true },
  pocket_duplet:  { balls: 1, points: 2,  prevDelta: -2, isDurak: false, isGolden: false, isPocket: true },
  pocket_pants:   { balls: 2, points: 3,  prevDelta: -3, isDurak: false, isGolden: false, isPocket: true },
  pocket_durak:   { balls: 1, points: 1,  prevDelta: -1, isDurak: true,  isGolden: false, isPocket: true },
  penalty:        { balls: 0, points: -1, prevDelta:  1, isDurak: false, isGolden: false, isPocket: false },
  miss:           { balls: 0, points: 0,  prevDelta:  0, isDurak: false, isGolden: false, isPocket: false },
  set_turn:       { balls: 0, points: 0,  prevDelta:  0, isDurak: false, isGolden: false, isPocket: false },
  golden_regular: { balls: 1, points: 0, prevDelta: 0, isDurak: false, isGolden: true, isPocket: true, goldenTier: 0 },
  golden_duplet:  { balls: 1, points: 0, prevDelta: 0, isDurak: false, isGolden: true, isPocket: true, goldenTier: 1 },
  golden_pants:   { balls: 2, points: 0, prevDelta: 0, isDurak: false, isGolden: true, isPocket: true, goldenTier: 2 },
};
const SERVER_GOLDEN_AS_REGULAR_EVENT = {
  golden_regular: 'pocket_regular',
  golden_duplet: 'pocket_duplet',
  golden_pants: 'pocket_pants',
};

function serverEffectiveEventType(type, firstWinner) {
  return firstWinner && SERVER_GOLDEN_AS_REGULAR_EVENT[type] ? SERVER_GOLDEN_AS_REGULAR_EVENT[type] : type;
}

function serverEffectiveEventDef(type, firstWinner) {
  return SERVER_EVENT_DEFS[serverEffectiveEventType(type, firstWinner)];
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ---- OIDC (Keycloak) ----
let oidc;
async function initOidc() {
  for (let i = 0; ; i++) {
    try {
      const issuer = await Issuer.discover(process.env.OIDC_ISSUER);
      oidc = new issuer.Client({
        client_id: process.env.OIDC_CLIENT_ID,
        client_secret: process.env.OIDC_CLIENT_SECRET,
        redirect_uris: [process.env.OIDC_REDIRECT_URI],
        response_types: ['code'],
      });
      console.log('OIDC ready:', process.env.OIDC_ISSUER);
      return;
    } catch (e) {
      if (i > 30) throw e;
      console.log('OIDC discover retry', i, e.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '24mb' }));
const sessionMiddleware = session({
  store: new PgSession({ pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: true, httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 },
});
app.use(sessionMiddleware);

const requireAuth = (req, res, next) =>
  req.session.user ? next() : res.status(401).json({ error: 'unauthorized' });

// ---- WebSocket (real-time): уведомляем клиентов, они перезапрашивают ----
const clients = new Set();
function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(s);
}

// ---- Auth routes ----
function startOidc(req, res, registration = false) {
  const state = generators.state();
  const nonce = generators.nonce();
  req.session.oidc = { state, nonce };
  const url = oidc.authorizationUrl({ scope: 'openid email profile', state, nonce });
  res.redirect(registration
    ? url.replace('/protocol/openid-connect/auth', '/protocol/openid-connect/registrations')
    : url);
}

// сразу на форму входа Keycloak, без промежуточной страницы
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  startOidc(req, res);
});

// сразу на форму регистрации Keycloak (endpoint /registrations)
app.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/');
  startOidc(req, res, true);
});

app.get('/auth/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  startOidc(req, res);
});

// сразу на форму регистрации Keycloak (endpoint /registrations)
app.get('/auth/register', (req, res) => {
  if (req.session.user) return res.redirect('/');
  startOidc(req, res, true);
});

app.get('/landing.html', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.sendFile(path.join(PUBLIC, 'landing.html'));
});

app.get('/callback', async (req, res) => {
  try {
    const params = oidc.callbackParams(req);
    const { state, nonce } = req.session.oidc || {};
    const tokenSet = await oidc.callback(process.env.OIDC_REDIRECT_URI, params, { state, nonce });
    const c = tokenSet.claims();
    req.session.user = { sub: c.sub, username: c.preferred_username, email: c.email, name: c.name };
    req.session.idToken = tokenSet.id_token;
    delete req.session.oidc;
    await pool.query(
      `INSERT INTO accounts (sub, username, email, last_login) VALUES ($1,$2,$3, now())
       ON CONFLICT (sub) DO UPDATE SET username=$2, email=$3, last_login=now()`,
      [c.sub, c.preferred_username, c.email]
    );
    await pool.query('UPDATE players SET account_username=$2 WHERE account_sub=$1', [c.sub, c.preferred_username]);
    // новый пользователь сразу становится игроком (если ещё не привязан ни к одному)
    const hasPlayer = (await pool.query('SELECT 1 FROM players WHERE account_sub=$1', [c.sub])).rows[0];
    if (!hasPlayer) {
      await pool.query('INSERT INTO players (name, account_sub, account_username) VALUES ($1,$2,$3)',
        [c.name || c.preferred_username, c.sub, c.preferred_username]);
    }
    res.redirect('/');
  } catch (e) {
    res.status(500).send('Ошибка авторизации: ' + e.message);
  }
});

app.get('/logout', (req, res) => {
  const idToken = req.session.idToken;
  req.session.destroy(() => {
    res.redirect(oidc.endSessionUrl({ id_token_hint: idToken, post_logout_redirect_uri: APP_URL }));
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC, req.session.user ? 'index.html' : 'landing.html'));
});

// ---- helpers ----
async function loadGame(id) {
  return loadGameFromDb(pool, id);
}

async function loadGameForUser(id, user) {
  return loadGameFromDb(pool, id, user);
}

function canEditScoreForGameRow(user, g) {
  if (!user || !g) return false;
  return isAdmin(user) || g.created_by_sub === user.sub || g.series_created_by_sub === user.sub;
}

async function loadGameFromDb(db, id, user = null) {
  const g = (await db.query(
    `SELECT g.*, s.created_by_sub AS series_created_by_sub
     FROM games g
     LEFT JOIN series s ON s.id=g.series_id
     WHERE g.id=$1`,
    [id]
  )).rows[0];
  if (!g) return null;
  const players = (await db.query(
    'SELECT player_id AS id, name FROM game_players WHERE game_id=$1 ORDER BY position', [id]
  )).rows;
  const events = (await db.query(
    'SELECT seq, player_id AS "playerId", type, created_at AS ts FROM game_events WHERE game_id=$1 ORDER BY seq', [id]
  )).rows;
  return {
    id: g.id, seriesId: g.series_id, createdAt: g.created_at, finishedAt: g.finished_at,
    targetBalls: g.target_balls, players, events, finalScores: g.final_scores,
    winnerId: g.winner_player_id, pointsLeaderId: g.points_leader_player_id, status: g.status,
    canEditScore: canEditScoreForGameRow(user, g),
  };
}
const pid = (v, set) => (v && set.has(v) ? v : null);
const myPlayer = async (sub) =>
  (await pool.query('SELECT id FROM players WHERE account_sub=$1', [sub])).rows[0] || null;
const isAdmin = (user) => !!user && user.username === 'spellful';
const repairPrevIndex = (idx, n) => (idx - 1 + n) % n;
const hasBodyField = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

async function myPlayerFromDb(db, sub) {
  return (await db.query('SELECT id FROM players WHERE account_sub=$1', [sub])).rows[0] || null;
}

async function userInGameRoster(db, user, gameId) {
  const me = user && user.sub ? await myPlayerFromDb(db, user.sub) : null;
  if (!me) return false;
  return !!(await db.query('SELECT 1 FROM game_players WHERE game_id=$1 AND player_id=$2', [gameId, me.id])).rows[0];
}

async function canEditGameScore(db, user, gameId) {
  if (isAdmin(user)) return true;
  const g = (await db.query(
    `SELECT g.created_by_sub, s.created_by_sub AS series_created_by_sub
     FROM games g
     LEFT JOIN series s ON s.id=g.series_id
     WHERE g.id=$1`,
    [gameId]
  )).rows[0];
  return canEditScoreForGameRow(user, g);
}

async function canFinishGame(db, user, gameId) {
  if (isAdmin(user)) return true;
  return await canEditGameScore(db, user, gameId) || await userInGameRoster(db, user, gameId);
}

async function autoFinishExpiredSeries(db = pool, notify = false) {
  const r = await db.query(
    `UPDATE series
        SET status='finished',
            finished_at=COALESCE(finished_at, created_at + ($1::int * interval '1 hour'))
      WHERE status='active'
        AND created_at <= now() - ($1::int * interval '1 hour')
      RETURNING id`,
    [SERIES_MAX_DURATION_HOURS]
  );
  if (r.rowCount) {
    console.log(`Auto-finished expired series: ${r.rowCount}`);
    if (notify) broadcast({ type: 'activeChanged' });
  }
  return r.rowCount;
}

async function gameEventsFromDb(db, gameId) {
  return (await db.query(
    'SELECT seq, player_id AS "playerId", type, created_at AS ts FROM game_events WHERE game_id=$1 ORDER BY seq',
    [gameId]
  )).rows;
}

async function gamePlayerIdSet(db, gameId) {
  return new Set((await db.query('SELECT player_id AS id FROM game_players WHERE game_id=$1', [gameId])).rows.map(r => r.id));
}

function sameGameEvent(a, b) {
  if (!a || !b || a.type !== b.type || a.playerId !== b.playerId) return false;
  const ats = new Date(a.ts).getTime();
  const bts = new Date(b.ts).getTime();
  return Number.isFinite(ats) && Number.isFinite(bts) && ats === bts;
}

function isLastEventRemoval(currentEvents, nextEvents) {
  if (!Array.isArray(nextEvents) || nextEvents.length !== currentEvents.length - 1) return false;
  return nextEvents.every((ev, i) => sameGameEvent(currentEvents[i], ev));
}

function cleanGameEvents(events, pset) {
  if (!Array.isArray(events)) throw httpError(400, 'events must be an array');
  return events.map((event) => {
    const type = String(event && event.type || '');
    if (!SERVER_EVENT_DEFS[type]) throw httpError(400, 'unknown event type');
    const playerId = pid(event && event.playerId, pset);
    if (!playerId) throw httpError(400, 'unknown player');
    const ts = event && event.ts ? new Date(event.ts) : new Date();
    if (Number.isNaN(ts.getTime())) throw httpError(400, 'bad event timestamp');
    return { type, playerId, ts: ts.toISOString() };
  });
}

function serverBallsLeader(game, scores) {
  if (!game.players.length) return null;
  return [...game.players].sort((a, b) => scores[b.id].balls - scores[a.id].balls)[0] || null;
}

async function initOwnershipSchema() {
  await pool.query(`
    ALTER TABLE IF EXISTS series ADD COLUMN IF NOT EXISTS created_by_sub text;
    ALTER TABLE IF EXISTS games ADD COLUMN IF NOT EXISTS created_by_sub text;
  `);
  await pool.query(`
    UPDATE games g
       SET created_by_sub = e.created_by_sub
      FROM (
        SELECT DISTINCT ON (game_id) game_id, created_by_sub
        FROM game_events
        WHERE created_by_sub IS NOT NULL
        ORDER BY game_id, seq
      ) e
     WHERE g.id=e.game_id AND g.created_by_sub IS NULL
  `);
  await pool.query(`
    UPDATE series s
       SET created_by_sub = g.created_by_sub
      FROM (
        SELECT DISTINCT ON (series_id) series_id, created_by_sub
        FROM games
        WHERE series_id IS NOT NULL AND created_by_sub IS NOT NULL
        ORDER BY series_id, created_at
      ) g
     WHERE s.id=g.series_id AND s.created_by_sub IS NULL
  `);
  console.log('Ownership schema ready');
}

function computeServerGameState(game) {
  const scores = {};
  game.players.forEach((p) => { scores[p.id] = { balls: 0, points: 0, duraks: 0 }; });
  const n = game.players.length;
  let firstWinner = null;
  const targetBalls = Number(game.targetBalls) || 0;

  for (const ev of game.events || []) {
    const def = serverEffectiveEventDef(ev.type, firstWinner);
    if (!def) continue;
    const idx = game.players.findIndex((p) => p.id === ev.playerId);
    if (idx < 0) continue;
    const s = scores[ev.playerId];

    if (def.isGolden) {
      const tier = def.goldenTier || 0;
      s.balls += def.balls;
      s.points += n + tier;
      if (n > 1) {
        const prevId = game.players[repairPrevIndex(idx, n)].id;
        scores[prevId].points -= 2 + tier;
        game.players.forEach((p) => {
          if (p.id !== ev.playerId && p.id !== prevId) scores[p.id].points -= 1;
        });
      }
    } else {
      s.balls = Math.max(0, s.balls + def.balls);
      s.points += def.points;
      if (def.isDurak) s.duraks += 1;
      if (def.prevDelta && n > 1) {
        const prevId = game.players[repairPrevIndex(idx, n)].id;
        if (prevId !== ev.playerId) scores[prevId].points += def.prevDelta;
      }
    }

    if (!firstWinner && def.balls > 0 && s.balls >= targetBalls) {
      firstWinner = game.players[idx];
    }
  }

  let pointsLeader = null;
  let maxPts = -Infinity;
  for (const p of game.players) {
    if (scores[p.id].points > maxPts) {
      maxPts = scores[p.id].points;
      pointsLeader = p;
    }
  }
  const tiedTop = game.players.filter((p) => scores[p.id].points === maxPts);
  if (tiedTop.length !== 1) pointsLeader = null;
  return { scores, pointsLeader, firstWinner };
}

function lastPocketEvent(game) {
  const events = game.events || [];
  for (let i = events.length - 1; i >= 0; i--) {
    const def = SERVER_EVENT_DEFS[events[i].type];
    if (def && def.isPocket) return events[i];
  }
  return null;
}

async function repairSpellfulLastBallWinner() {
  const game = await loadGame(SPELLFUL_LAST_BALL_GAME_ID);
  if (!game || game.status !== 'finished') return;

  const spellful = game.players.find((p) => String(p.name || '').trim().toLowerCase() === 'spellful');
  if (!spellful) {
    console.warn('Data repair skipped: Spellful is not in game', SPELLFUL_LAST_BALL_GAME_ID);
    return;
  }

  const lastPocket = lastPocketEvent(game);
  if (!lastPocket || lastPocket.playerId !== spellful.id) {
    console.warn('Data repair skipped: last pocket is not Spellful in game', SPELLFUL_LAST_BALL_GAME_ID);
    return;
  }

  const st = computeServerGameState(game);
  const pointsLeaderId = st.pointsLeader ? st.pointsLeader.id : null;
  const r = await pool.query(
    `UPDATE games
       SET winner_player_id=$2, points_leader_player_id=$3, final_scores=$4::jsonb
     WHERE id=$1
       AND (
         winner_player_id IS DISTINCT FROM $2
         OR points_leader_player_id IS DISTINCT FROM $3
         OR final_scores IS DISTINCT FROM $4::jsonb
       )`,
    [SPELLFUL_LAST_BALL_GAME_ID, spellful.id, pointsLeaderId, JSON.stringify(st.scores)]
  );
  if (r.rowCount) {
    console.log('Data repair applied: Spellful winner for game', SPELLFUL_LAST_BALL_GAME_ID);
  }
}

async function runStartupDataRepairs() {
  try {
    await repairSpellfulLastBallWinner();
  } catch (e) {
    console.error('Startup data repair failed:', e.message);
  }
}

function safeAdminUploadName(name, mime) {
  const ext = ADMIN_CHAT_IMAGE_TYPES.get(mime) || '.jpg';
  const stem = path.basename(String(name || 'photo'), path.extname(String(name || '')))
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'photo';
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `${ts}-${crypto.randomUUID()}-${stem}${ext}`;
}

async function saveAdminChatImages(images) {
  if (!images) return [];
  if (!Array.isArray(images)) {
    const err = new Error('images must be an array');
    err.statusCode = 400;
    throw err;
  }
  if (images.length > ADMIN_CHAT_MAX_IMAGES) {
    const err = new Error(`Можно прикрепить не больше ${ADMIN_CHAT_MAX_IMAGES} фото`);
    err.statusCode = 400;
    throw err;
  }

  const prepared = [];
  for (const image of images) {
    const rawData = String(image && image.data || '');
    const dataUrl = rawData.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
    const mime = String((dataUrl ? dataUrl[1] : image && image.type) || '').toLowerCase();
    if (!ADMIN_CHAT_IMAGE_TYPES.has(mime)) {
      const err = new Error('Поддерживаются только JPG, PNG, WebP и GIF');
      err.statusCode = 400;
      throw err;
    }

    const base64 = (dataUrl ? dataUrl[2] : rawData).replace(/\s/g, '');
    if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
      const err = new Error('Некорректные данные изображения');
      err.statusCode = 400;
      throw err;
    }

    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length || buffer.length > ADMIN_CHAT_MAX_IMAGE_BYTES) {
      const err = new Error('Фото должно быть не больше 3 МБ после сжатия');
      err.statusCode = 400;
      throw err;
    }

    const fileName = safeAdminUploadName(image && image.name, mime);
    const filePath = path.join(ADMIN_UPLOAD_DIR, fileName);
    prepared.push({
      originalName: String(image && image.name || 'photo'),
      mime,
      bytes: buffer.length,
      buffer,
      fileName,
      filePath,
      url: `/api/admin/uploads/${fileName}`,
    });
  }

  await fs.promises.mkdir(ADMIN_UPLOAD_DIR, { recursive: true });
  const saved = [];
  for (const image of prepared) {
    await fs.promises.writeFile(image.filePath, image.buffer, { flag: 'wx' });
    const { buffer, ...meta } = image;
    saved.push(meta);
  }
  return saved;
}

function buildAdminChatPrompt(prompt, images) {
  const text = prompt || 'Проанализируй прикрепленные фотографии.';
  if (!images.length) return text;

  const lines = [text, '', '---', 'Фотографии, загруженные в чат:'];
  images.forEach((image, idx) => {
    lines.push(`${idx + 1}. ${image.originalName} (${image.mime}, ${Math.round(image.bytes / 1024)} КБ)`);
    lines.push(`   Локальный путь: ${image.filePath}`);
    lines.push(`   URL: ${image.url}`);
  });
  lines.push('', 'Перед ответом открой локальные файлы изображений и проанализируй их содержимое.');
  return lines.join('\n');
}

async function listVisibleSeries(user) {
  if (isAdmin(user)) {
    return (await pool.query(
      'SELECT id, name, status, created_at AS "createdAt", finished_at AS "finishedAt", true AS "canEditScore" FROM series ORDER BY created_at DESC'
    )).rows;
  }
  const me = await myPlayer(user.sub);
  const myPlayerId = me ? me.id : null;
  return (await pool.query(
    `SELECT DISTINCT s.id, s.name, s.status, s.created_at AS "createdAt", s.finished_at AS "finishedAt",
            (s.created_by_sub=$2) AS "canEditScore"
     FROM series s
     LEFT JOIN games g ON g.series_id=s.id
     LEFT JOIN game_players gp ON gp.game_id=g.id
     WHERE s.created_by_sub=$2 OR gp.player_id=$1
     ORDER BY s.created_at DESC`,
    [myPlayerId, user.sub]
  )).rows;
}

// ---- Me / accounts / active ----
app.get('/api/me', requireAuth, async (req, res) => {
  res.json({ user: req.session.user, player: await myPlayer(req.session.user.sub) });
});

app.get('/api/changelog', requireAuth, async (_req, res) => {
  try {
    const markdown = await fs.promises.readFile(path.join(__dirname, 'CHANGELOG.md'), 'utf8');
    res.json({ markdown });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// аккаунты, которые уже входили в приложение — для выбора при создании игрока
app.get('/api/accounts', requireAuth, async (req, res) => {
  const r = await pool.query('SELECT sub, username, email FROM accounts ORDER BY lower(username)');
  res.json(r.rows);
});

// активная игра/серия + привязан ли текущий пользователь (его игрок в составе)
app.get('/api/active', requireAuth, async (req, res) => {
  await autoFinishExpiredSeries(pool, true);
  const gr = (await pool.query("SELECT id FROM games WHERE status='active' ORDER BY created_at DESC LIMIT 1")).rows[0];
  const game = gr ? await loadGameForUser(gr.id, req.session.user) : null;
  const series = (await pool.query(
    'SELECT id, name, status, created_at AS "createdAt", (created_by_sub=$1 OR $2) AS "canEditScore" FROM series WHERE status=\'active\' ORDER BY created_at DESC LIMIT 1',
    [req.session.user.sub, isAdmin(req.session.user)]
  )).rows[0] || null;
  const me = await myPlayer(req.session.user.sub);
  const attached = !!(me && game && game.players.some(p => p.id === me.id));
  // активную игру показываем участнику, владельцу игры/серии или админу
  const visibleGame = (attached || (game && game.canEditScore) || isAdmin(req.session.user)) ? game : null;
  res.json({ game: visibleGame, series, myPlayerId: me ? me.id : null, attached });
});

// ---- Players ----
app.get('/api/players', requireAuth, async (req, res) => {
  const r = await pool.query(
    'SELECT id, name, created_at AS "createdAt", account_sub AS "accountSub", account_username AS "accountUsername" FROM players ORDER BY created_at'
  );
  res.json(r.rows);
});
app.post('/api/players', requireAuth, async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const ex = (await pool.query('SELECT * FROM players WHERE lower(name)=lower($1)', [name])).rows[0];
  if (ex) return res.json(ex);
  let username = null;
  if (req.body.accountSub) {
    username = (await pool.query('SELECT username FROM accounts WHERE sub=$1', [req.body.accountSub])).rows[0]?.username || null;
    await pool.query('UPDATE players SET account_sub=NULL WHERE account_sub=$1', [req.body.accountSub]);
  }
  const r = await pool.query(
    'INSERT INTO players (name, account_sub, account_username) VALUES ($1,$2,$3) RETURNING id, name, created_at AS "createdAt", account_sub AS "accountSub", account_username AS "accountUsername"',
    [name, req.body.accountSub || null, username]
  );
  res.status(201).json(r.rows[0]);
});
// привязать/отвязать аккаунт или переименовать
app.put('/api/players/:id', requireAuth, async (req, res) => {
  const b = req.body, id = req.params.id;
  let username = null;
  if (b.accountSub) {
    username = (await pool.query('SELECT username FROM accounts WHERE sub=$1', [b.accountSub])).rows[0]?.username || null;
    await pool.query('UPDATE players SET account_sub=NULL WHERE account_sub=$1 AND id<>$2', [b.accountSub, id]);
  }
  const r = await pool.query(
    `UPDATE players SET name=COALESCE($2,name),
       account_sub = CASE WHEN $5 THEN $3 ELSE account_sub END,
       account_username = CASE WHEN $5 THEN $4 ELSE account_username END
     WHERE id=$1 RETURNING id, name, account_sub AS "accountSub", account_username AS "accountUsername"`,
    [id, b.name ?? null, b.accountSub || null, username, Object.prototype.hasOwnProperty.call(b, 'accountSub')]
  );
  r.rows[0] ? res.json(r.rows[0]) : res.status(404).json({ error: 'not found' });
});
app.delete('/api/players/:id', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM players WHERE id=$1', [req.params.id]);
  res.status(204).end();
});

// ---- Series ----
app.get('/api/series', requireAuth, async (req, res) => {
  await autoFinishExpiredSeries(pool, true);
  res.json(await listVisibleSeries(req.session.user));
});
app.post('/api/series', requireAuth, async (req, res) => {
  const r = await pool.query(
    'INSERT INTO series (name, status, created_by_sub) VALUES ($1, $2, $3) RETURNING id, name, status, created_at AS "createdAt", finished_at AS "finishedAt", true AS "canEditScore"',
    [(req.body.name || '').trim() || null, 'active', req.session.user.sub]
  );
  broadcast({ type: 'activeChanged' });
  res.status(201).json(r.rows[0]);
});
app.get('/api/series/:id', requireAuth, async (req, res) => {
  await autoFinishExpiredSeries(pool, true);
  const r = await pool.query(
    `SELECT id, name, status, created_at AS "createdAt", finished_at AS "finishedAt",
            (($2::text IS NOT NULL AND created_by_sub=$2) OR $3) AS "canEditScore"
     FROM series WHERE id=$1`,
    [req.params.id, req.session.user.sub, isAdmin(req.session.user)]
  );
  r.rows[0] ? res.json(r.rows[0]) : res.status(404).json({ error: 'not found' });
});
app.put('/api/series/:id', requireAuth, async (req, res) => {
  const b = req.body;
  const hasName = hasBodyField(b, 'name');
  const hasStatus = hasBodyField(b, 'status');
  const hasFinishedAt = hasBodyField(b, 'finishedAt');
  const r = await pool.query(
    `UPDATE series SET
        name=CASE WHEN $7 THEN $2::text ELSE name END,
        status=CASE WHEN $8 THEN $3::text ELSE status END,
        finished_at=CASE WHEN $9 THEN $4::timestamptz ELSE finished_at END
      WHERE id=$1
      RETURNING id, name, status, created_at AS "createdAt", finished_at AS "finishedAt",
                (($5::text IS NOT NULL AND created_by_sub=$5) OR $6) AS "canEditScore"`,
    [req.params.id, b.name ?? null, b.status ?? null, b.finishedAt ?? null, req.session.user.sub, isAdmin(req.session.user),
     hasName, hasStatus, hasFinishedAt]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
  broadcast({ type: 'activeChanged' });
  res.json(r.rows[0]);
});
app.delete('/api/series/:id', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM series WHERE id=$1', [req.params.id]);
  broadcast({ type: 'activeChanged' });
  res.status(204).end();
});

// ---- Games ----
app.get('/api/games', requireAuth, async (req, res) => {
  let rows;
  if (isAdmin(req.session.user)) {
    rows = (await pool.query('SELECT id FROM games ORDER BY created_at DESC')).rows;
  } else {
    const me = await myPlayer(req.session.user.sub);
    const myPlayerId = me ? me.id : null;
    rows = (await pool.query(
      `SELECT DISTINCT g.id, g.created_at
       FROM games g
       LEFT JOIN game_players gp ON gp.game_id=g.id
       LEFT JOIN series s ON s.id=g.series_id
       WHERE gp.player_id=$1 OR g.created_by_sub=$2 OR s.created_by_sub=$2
       ORDER BY g.created_at DESC`,
      [myPlayerId, req.session.user.sub]
    )).rows;
  }
  res.json(await Promise.all(rows.map(r => loadGameForUser(r.id, req.session.user))));
});
app.get('/api/games/:id', requireAuth, async (req, res) => {
  const g = await loadGameForUser(req.params.id, req.session.user);
  if (!g) return res.status(404).json({ error: 'not found' });
  if (!isAdmin(req.session.user)) {
    const me = await myPlayer(req.session.user.sub);
    if ((!me || !g.players.some(p => p.id === me.id)) && !g.canEditScore) return res.status(403).json({ error: 'forbidden' });
  }
  res.json(g);
});
app.post('/api/games', requireAuth, async (req, res) => {
  const b = req.body;
  await autoFinishExpiredSeries(pool, true);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (b.seriesId) {
      const s = (await client.query('SELECT status FROM series WHERE id=$1', [b.seriesId])).rows[0];
      if (!s) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'series not found' }); }
      if (s.status !== 'active') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'series finished' }); }
    }
    const pset = new Set((await client.query('SELECT id FROM players')).rows.map(r => r.id));
    const g = (await client.query(
      `INSERT INTO games (series_id, status, target_balls, final_scores, winner_player_id, points_leader_player_id, created_by_sub)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [b.seriesId || null, b.status || 'active', b.targetBalls ?? null,
       b.finalScores ? JSON.stringify(b.finalScores) : null, pid(b.winnerId, pset), pid(b.pointsLeaderId, pset), req.session.user.sub]
    )).rows[0];
    await writeRoster(client, g.id, b.players || [], pset);
    await writeEvents(client, g.id, cleanGameEvents(b.events || [], pset), pset, req.session.user.sub);
    await client.query('COMMIT');
    broadcast({ type: 'activeChanged' });
    res.status(201).json(await loadGameForUser(g.id, req.session.user));
  } catch (e) { await client.query('ROLLBACK'); res.status(e.statusCode || 500).json({ error: e.message }); }
  finally { client.release(); }
});
app.put('/api/games/:id', requireAuth, async (req, res) => {
  const b = req.body, id = req.params.id;
  const mutationId = typeof b.mutationId === 'string' ? b.mutationId : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const exists = (await client.query('SELECT 1 FROM games WHERE id=$1', [id])).rows[0];
    if (!exists) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not found' }); }
    const inRoster = await userInGameRoster(client, req.session.user, id);
    const canEditScore = await canEditGameScore(client, req.session.user, id);
    if (!isAdmin(req.session.user) && !inRoster && !canEditScore) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'forbidden' });
    }
    let cleanEvents = null;
    const pset = new Set((await client.query('SELECT id FROM players')).rows.map(r => r.id));
    if (Array.isArray(b.events)) {
      cleanEvents = cleanGameEvents(b.events, pset);
      if (!canEditScore) {
        const currentEvents = await gameEventsFromDb(client, id);
        if (!isLastEventRemoval(currentEvents, cleanEvents)) {
          await client.query('ROLLBACK');
          return res.status(403).json({ error: 'score edit forbidden' });
        }
      }
    }
    const hasSeriesId = hasBodyField(b, 'seriesId');
    const hasStatus = hasBodyField(b, 'status');
    const hasTargetBalls = hasBodyField(b, 'targetBalls');
    const hasFinishedAt = hasBodyField(b, 'finishedAt');
    const hasFinalScores = hasBodyField(b, 'finalScores');
    const hasWinnerId = hasBodyField(b, 'winnerId');
    const hasPointsLeaderId = hasBodyField(b, 'pointsLeaderId');
    const upd = await client.query(
      `UPDATE games SET
         series_id=CASE WHEN $9 THEN $2::uuid ELSE series_id END,
         status=CASE WHEN $10 THEN $3::text ELSE status END,
         target_balls=CASE WHEN $11 THEN $4::int ELSE target_balls END,
         finished_at=CASE WHEN $12 THEN $5::timestamptz ELSE finished_at END,
         final_scores=CASE WHEN $13 THEN $6::jsonb ELSE final_scores END,
         winner_player_id=CASE WHEN $14 THEN $7::uuid ELSE winner_player_id END,
         points_leader_player_id=CASE WHEN $15 THEN $8::uuid ELSE points_leader_player_id END
       WHERE id=$1 RETURNING id`,
      [id, b.seriesId || null, b.status ?? null, b.targetBalls ?? null, b.finishedAt ?? null,
       b.finalScores == null ? null : JSON.stringify(b.finalScores),
       pid(b.winnerId, pset), pid(b.pointsLeaderId, pset),
       hasSeriesId, hasStatus, hasTargetBalls, hasFinishedAt, hasFinalScores, hasWinnerId, hasPointsLeaderId]
    );
    if (!upd.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not found' }); }
    if (Array.isArray(b.players)) { await client.query('DELETE FROM game_players WHERE game_id=$1', [id]); await writeRoster(client, id, b.players, pset); }
    if (cleanEvents)  { await client.query('DELETE FROM game_events WHERE game_id=$1', [id]); await writeEvents(client, id, cleanEvents, pset, req.session.user.sub); }
    await client.query('COMMIT');
    broadcast({ type: 'gameUpdated', gameId: id, ...(mutationId ? { mutationId } : {}) });
    broadcast({ type: 'activeChanged' });
    res.json(await loadGameForUser(id, req.session.user));
  } catch (e) { await client.query('ROLLBACK'); res.status(e.statusCode || 500).json({ error: e.message }); }
  finally { client.release(); }
});
app.put('/api/games/:id/score', requireAuth, async (req, res) => {
  const id = req.params.id;
  const mutationId = typeof req.body.mutationId === 'string' ? req.body.mutationId : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query('SELECT id, status FROM games WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!row) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not found' }); }
    if (!await canEditGameScore(client, req.session.user, id)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'forbidden' });
    }

    const pset = await gamePlayerIdSet(client, id);
    const events = cleanGameEvents(req.body.events, pset);
    await client.query('DELETE FROM game_events WHERE game_id=$1', [id]);
    await writeEvents(client, id, events, pset, req.session.user.sub);

    const game = await loadGameFromDb(client, id);
    if (game.status === 'finished') {
      const st = computeServerGameState(game);
      const winner = st.firstWinner || serverBallsLeader(game, st.scores);
      await client.query(
        `UPDATE games
            SET final_scores=$2::jsonb, winner_player_id=$3, points_leader_player_id=$4
          WHERE id=$1`,
        [id, JSON.stringify(st.scores), winner ? winner.id : null, st.pointsLeader ? st.pointsLeader.id : null]
      );
    } else {
      await client.query(
        'UPDATE games SET final_scores=NULL, winner_player_id=NULL, points_leader_player_id=NULL, finished_at=NULL WHERE id=$1',
        [id]
      );
    }

    await client.query('COMMIT');
    broadcast({ type: 'gameUpdated', gameId: id, ...(mutationId ? { mutationId } : {}) });
    broadcast({ type: 'activeChanged' });
    res.json(await loadGameForUser(id, req.session.user));
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(e.statusCode || 500).json({ error: e.message });
  } finally {
    client.release();
  }
});
app.post('/api/games/:id/finish', requireAuth, async (req, res) => {
  const id = req.params.id;
  const force = !!req.body.force;
  const mutationId = typeof req.body.mutationId === 'string' ? req.body.mutationId : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query('SELECT id, status FROM games WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!row) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not found' }); }
    if (!await canFinishGame(client, req.session.user, id)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'forbidden' });
    }
    if (row.status === 'finished') {
      await client.query('COMMIT');
      return res.json(await loadGameForUser(id, req.session.user));
    }

    const game = await loadGameFromDb(client, id);
    const st = computeServerGameState(game);
    const winner = st.firstWinner || (force ? serverBallsLeader(game, st.scores) : null);
    await client.query(
      `UPDATE games
          SET status='finished',
              finished_at=COALESCE(finished_at, now()),
              final_scores=$2::jsonb,
              winner_player_id=$3,
              points_leader_player_id=$4
        WHERE id=$1`,
      [id, JSON.stringify(st.scores), winner ? winner.id : null, st.pointsLeader ? st.pointsLeader.id : null]
    );

    await client.query('COMMIT');
    broadcast({ type: 'gameUpdated', gameId: id, ...(mutationId ? { mutationId } : {}) });
    broadcast({ type: 'activeChanged' });
    res.json(await loadGameForUser(id, req.session.user));
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(e.statusCode || 500).json({ error: e.message });
  } finally {
    client.release();
  }
});
app.delete('/api/games/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query('SELECT id FROM games WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!row) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not found' }); }
    if (!await canEditGameScore(client, req.session.user, id)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'forbidden' });
    }
    await client.query('DELETE FROM game_events WHERE game_id=$1', [id]);
    await client.query('DELETE FROM game_players WHERE game_id=$1', [id]);
    await client.query('DELETE FROM games WHERE id=$1', [id]);
    await client.query('COMMIT');
    broadcast({ type: 'gameUpdated', gameId: id });
    broadcast({ type: 'activeChanged' });
    res.status(204).end();
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(e.statusCode || 500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// append одного события (real-time нажатие). Право: игрок запросившего в составе игры.
app.post('/api/games/:id/events', requireAuth, async (req, res) => {
  const gameId = req.params.id;
  const { type, playerId } = req.body;
  const mutationId = typeof req.body.mutationId === 'string' ? req.body.mutationId : null;
  if (!type) return res.status(400).json({ error: 'type required' });
  if (!SERVER_EVENT_DEFS[type]) return res.status(400).json({ error: 'unknown event type' });
  if (!isAdmin(req.session.user)) {
    const me = await myPlayer(req.session.user.sub);
    if (!me) return res.status(403).json({ error: 'not a linked player' });
    const inRoster = (await pool.query('SELECT 1 FROM game_players WHERE game_id=$1 AND player_id=$2', [gameId, me.id])).rows[0];
    if (!inRoster) return res.status(403).json({ error: 'not in roster' });
  }
  const g = (await pool.query('SELECT status FROM games WHERE id=$1', [gameId])).rows[0];
  if (!g) return res.status(404).json({ error: 'not found' });
  if (g.status !== 'active') return res.status(409).json({ error: 'game not active' });
  let eventType = type;
  if (SERVER_GOLDEN_AS_REGULAR_EVENT[type]) {
    const game = await loadGame(gameId);
    const st = game ? computeServerGameState(game) : null;
    eventType = serverEffectiveEventType(type, st && st.firstWinner);
  }
  const pset = await gamePlayerIdSet(pool, gameId);
  const eventPlayerId = pid(playerId, pset);
  if (!eventPlayerId) return res.status(400).json({ error: 'unknown player' });
  const seq = (await pool.query('SELECT COALESCE(MAX(seq),-1)+1 AS n FROM game_events WHERE game_id=$1', [gameId])).rows[0].n;
  const inserted = await pool.query(
    `INSERT INTO game_events (game_id, seq, player_id, type, created_by_sub)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING seq, player_id AS "playerId", type, created_at AS ts`,
    [gameId, seq, eventPlayerId, eventType, req.session.user.sub]
  );
  broadcast({ type: 'gameUpdated', gameId, ...(mutationId ? { mutationId } : {}) });
  res.status(201).json({ ok: true, seq, event: inserted.rows[0] });
});

async function writeRoster(client, gameId, players, pset) {
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    await client.query('INSERT INTO game_players (game_id, position, player_id, name) VALUES ($1,$2,$3,$4)',
      [gameId, i, pid(p.id, pset), p.name || '']);
  }
}
async function writeEvents(client, gameId, events, pset, createdBySub = null) {
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    await client.query('INSERT INTO game_events (game_id, seq, player_id, type, created_at, created_by_sub) VALUES ($1,$2,$3,$4,$5,$6)',
      [gameId, i, pid(e.playerId, pset), e.type, e.ts || new Date().toISOString(), e.createdBySub || e.created_by_sub || createdBySub]);
  }
}

// объединить историю непривязанного игрока (source) в свой профиль (target)
app.post('/api/players/:id/merge', requireAuth, async (req, res) => {
  const target = req.params.id;
  const source = req.body.sourceId;
  if (!source) return res.status(400).json({ error: 'sourceId required' });
  const tp = (await pool.query('SELECT id, name, account_sub FROM players WHERE id=$1', [target])).rows[0];
  const sp = (await pool.query('SELECT id, account_sub FROM players WHERE id=$1', [source])).rows[0];
  if (!tp || !sp) return res.status(404).json({ error: 'not found' });
  if (!isAdmin(req.session.user) && tp.account_sub !== req.session.user.sub)
    return res.status(403).json({ error: 'not your profile' });
  if (sp.account_sub) return res.status(400).json({ error: 'source is linked' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE game_players SET player_id=$1, name=$2 WHERE player_id=$3', [target, tp.name, source]);
    await client.query('UPDATE game_events SET player_id=$1 WHERE player_id=$2', [target, source]);
    await client.query('UPDATE games SET winner_player_id=$1 WHERE winner_player_id=$2', [target, source]);
    await client.query('UPDATE games SET points_leader_player_id=$1 WHERE points_leader_player_id=$2', [target, source]);
    const fs = (await client.query('SELECT id, final_scores FROM games WHERE jsonb_exists(final_scores, $1)', [source])).rows;
    for (const g of fs) {
      const sc = g.final_scores; sc[target] = sc[source]; delete sc[source];
      await client.query('UPDATE games SET final_scores=$2 WHERE id=$1', [g.id, JSON.stringify(sc)]);
    }
    await client.query('DELETE FROM players WHERE id=$1', [source]);
    await client.query('COMMIT');
    broadcast({ type: 'activeChanged' });
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// ---- Админ-чат (codex-агент, только spellful). Задачи в очередь admin_tasks, их выполняет хост-воркер. ----
const requireAdmin = (req, res, next) =>
  (req.session.user && isAdmin(req.session.user)) ? next() : res.status(403).json({ error: 'forbidden' });

app.get('/api/admin/uploads/:file', requireAdmin, (req, res) => {
  const file = req.params.file;
  if (!/^[A-Za-z0-9_.-]+$/.test(file)) return res.status(404).json({ error: 'not found' });
  res.sendFile(path.join(ADMIN_UPLOAD_DIR, file), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'not found' });
  });
});

app.post('/api/admin/chat', requireAdmin, async (req, res) => {
  try {
    const promptText = (req.body.prompt || '').trim();
    const hasImages = Array.isArray(req.body.images) && req.body.images.length > 0;
    if (!promptText && !hasImages) return res.status(400).json({ error: 'prompt required' });

    const images = await saveAdminChatImages(req.body.images);
    const prompt = buildAdminChatPrompt(promptText, images);
    const r = await pool.query(
      "INSERT INTO admin_tasks (prompt, status) VALUES ($1,'pending') RETURNING id, prompt, status, created_at AS \"createdAt\"",
      [prompt]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});
app.get('/api/admin/tasks', requireAdmin, async (req, res) => {
  const r = await pool.query(
    'SELECT id, prompt, status, output, created_at AS "createdAt", updated_at AS "updatedAt" FROM admin_tasks ORDER BY created_at DESC LIMIT 50'
  );
  res.json(r.rows);
});

// ==================== Planning Poker (публичный модуль, без OIDC) ====================
// Пользователи заходят по ссылке, задают имя и голосуют. Реальное время — через /ws/poker.
const pokerClients = new Map(); // roomId -> Set<ws>
function pokerBroadcast(roomId) {
  const set = pokerClients.get(roomId);
  if (!set) return;
  const msg = JSON.stringify({ type: 'sync' });
  for (const ws of set) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
}

async function initPokerSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS poker_rooms (
      id uuid PRIMARY KEY,
      name text,
      deck text NOT NULL DEFAULT 'fibonacci',
      current_issue_id uuid,
      revealed boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS poker_participants (
      id uuid PRIMARY KEY,
      room_id uuid NOT NULL REFERENCES poker_rooms(id) ON DELETE CASCADE,
      name text NOT NULL,
      is_spectator boolean NOT NULL DEFAULT false,
      joined_at timestamptz NOT NULL DEFAULT now(),
      last_seen timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS poker_issues (
      id uuid PRIMARY KEY,
      room_id uuid NOT NULL REFERENCES poker_rooms(id) ON DELETE CASCADE,
      title text NOT NULL,
      url text,
      position int NOT NULL DEFAULT 0,
      final_estimate text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS poker_votes (
      issue_id uuid NOT NULL REFERENCES poker_issues(id) ON DELETE CASCADE,
      participant_id uuid NOT NULL REFERENCES poker_participants(id) ON DELETE CASCADE,
      value text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (issue_id, participant_id)
    );
  `);
  console.log('Planning Poker schema ready');
}

// Разбор списка задач: по строкам ИЛИ через запятую — не важно.
function parsePokerIssues(input) {
  if (Array.isArray(input)) input = input.join('\n');
  return String(input || '')
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 200);
}

async function insertPokerIssues(roomId, list) {
  if (!list.length) return;
  const startPos = (await pool.query(
    'SELECT COALESCE(MAX(position),-1)+1 AS n FROM poker_issues WHERE room_id=$1', [roomId]
  )).rows[0].n;
  for (let i = 0; i < list.length; i++) {
    const raw = list[i];
    const isUrl = /^https?:\/\//i.test(raw);
    await pool.query(
      'INSERT INTO poker_issues (id, room_id, title, url, position) VALUES ($1,$2,$3,$4,$5)',
      [crypto.randomUUID(), roomId, raw, isUrl ? raw : null, startPos + i]
    );
  }
}

async function loadPokerRoom(id, meId) {
  const room = (await pool.query(
    'SELECT id, name, deck, current_issue_id, revealed FROM poker_rooms WHERE id=$1', [id]
  )).rows[0];
  if (!room) return null;
  const participants = (await pool.query(
    'SELECT id, name, is_spectator AS "spectator" FROM poker_participants WHERE room_id=$1 ORDER BY joined_at', [id]
  )).rows;
  const issues = (await pool.query(
    'SELECT id, title, url, position, final_estimate AS "finalEstimate" FROM poker_issues WHERE room_id=$1 ORDER BY position, created_at', [id]
  )).rows;
  const currentId = room.current_issue_id;
  let rawVotes = [];
  if (currentId) {
    rawVotes = (await pool.query(
      'SELECT participant_id AS "participantId", value FROM poker_votes WHERE issue_id=$1', [currentId]
    )).rows;
  }
  let myValue = null;
  const votes = rawVotes.map((v) => {
    if (meId && v.participantId === meId) myValue = v.value;
    return { participantId: v.participantId, value: room.revealed ? v.value : null, voted: true };
  });
  return {
    id: room.id, name: room.name, deck: room.deck,
    currentIssueId: currentId, revealed: room.revealed,
    participants, issues, votes, myValue,
  };
}

// Отдаём SPA-страницу покера и на /poker, и на /poker/:id
app.get(['/poker', '/poker/:id'], (req, res) => res.sendFile(path.join(PUBLIC, 'poker.html')));

app.post('/api/poker/rooms', async (req, res) => {
  try {
    const id = crypto.randomUUID();
    const name = (req.body.name || '').trim() || null;
    const deck = (req.body.deck || 'fibonacci').toString().trim() || 'fibonacci';
    await pool.query('INSERT INTO poker_rooms (id, name, deck) VALUES ($1,$2,$3)', [id, name, deck]);
    await insertPokerIssues(id, parsePokerIssues(req.body.issues));
    res.status(201).json({ id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/poker/rooms/:id', async (req, res) => {
  try {
    const room = await loadPokerRoom(req.params.id, req.query.me);
    room ? res.json(room) : res.status(404).json({ error: 'not found' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/poker/rooms/:id/join', async (req, res) => {
  try {
    const roomId = req.params.id;
    const exists = (await pool.query('SELECT 1 FROM poker_rooms WHERE id=$1', [roomId])).rows[0];
    if (!exists) return res.status(404).json({ error: 'not found' });
    const name = (req.body.name || '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: 'name required' });
    const spectator = !!req.body.spectator;
    // Переподключение известного участника — обновляем имя/роль, id сохраняем.
    if (req.body.participantId) {
      const upd = await pool.query(
        'UPDATE poker_participants SET name=$2, is_spectator=$3, last_seen=now() WHERE id=$1 AND room_id=$4 RETURNING id',
        [req.body.participantId, name, spectator, roomId]
      );
      if (upd.rows[0]) { pokerBroadcast(roomId); return res.json({ participantId: req.body.participantId }); }
    }
    const id = crypto.randomUUID();
    await pool.query(
      'INSERT INTO poker_participants (id, room_id, name, is_spectator) VALUES ($1,$2,$3,$4)',
      [id, roomId, name, spectator]
    );
    pokerBroadcast(roomId);
    res.status(201).json({ participantId: id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/poker/rooms/:id/leave', async (req, res) => {
  const { participantId } = req.body;
  if (participantId) {
    await pool.query('DELETE FROM poker_participants WHERE id=$1 AND room_id=$2', [participantId, req.params.id]);
    pokerBroadcast(req.params.id);
  }
  res.json({ ok: true });
});

app.post('/api/poker/rooms/:id/issues', async (req, res) => {
  try {
    const roomId = req.params.id;
    const list = parsePokerIssues(req.body.issues);
    if (!list.length) return res.status(400).json({ error: 'no issues' });
    await insertPokerIssues(roomId, list);
    pokerBroadcast(roomId);
    res.status(201).json(await loadPokerRoom(roomId));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/poker/issues/:id', async (req, res) => {
  const row = (await pool.query('SELECT room_id FROM poker_issues WHERE id=$1', [req.params.id])).rows[0];
  await pool.query('UPDATE poker_rooms SET current_issue_id=NULL, revealed=false WHERE current_issue_id=$1', [req.params.id]);
  await pool.query('DELETE FROM poker_issues WHERE id=$1', [req.params.id]);
  if (row) pokerBroadcast(row.room_id);
  res.status(204).end();
});

app.post('/api/poker/rooms/:id/current', async (req, res) => {
  const roomId = req.params.id;
  await pool.query('UPDATE poker_rooms SET current_issue_id=$2, revealed=false WHERE id=$1',
    [roomId, req.body.issueId || null]);
  pokerBroadcast(roomId);
  res.json({ ok: true });
});

app.post('/api/poker/issues/:id/vote', async (req, res) => {
  try {
    const issueId = req.params.id;
    const { participantId, value } = req.body;
    if (!participantId) return res.status(400).json({ error: 'participantId required' });
    const issue = (await pool.query('SELECT room_id FROM poker_issues WHERE id=$1', [issueId])).rows[0];
    if (!issue) return res.status(404).json({ error: 'not found' });
    const room = (await pool.query('SELECT revealed FROM poker_rooms WHERE id=$1', [issue.room_id])).rows[0];
    if (room && room.revealed) return res.status(409).json({ error: 'revealed' });
    if (value === '' || value == null) {
      await pool.query('DELETE FROM poker_votes WHERE issue_id=$1 AND participant_id=$2', [issueId, participantId]);
    } else {
      await pool.query(
        `INSERT INTO poker_votes (issue_id, participant_id, value) VALUES ($1,$2,$3)
         ON CONFLICT (issue_id, participant_id) DO UPDATE SET value=$3, updated_at=now()`,
        [issueId, participantId, String(value)]
      );
    }
    pokerBroadcast(issue.room_id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/poker/rooms/:id/reveal', async (req, res) => {
  await pool.query('UPDATE poker_rooms SET revealed=true WHERE id=$1', [req.params.id]);
  pokerBroadcast(req.params.id);
  res.json({ ok: true });
});

app.post('/api/poker/rooms/:id/reset', async (req, res) => {
  const roomId = req.params.id;
  const room = (await pool.query('SELECT current_issue_id FROM poker_rooms WHERE id=$1', [roomId])).rows[0];
  if (room && room.current_issue_id) {
    await pool.query('DELETE FROM poker_votes WHERE issue_id=$1', [room.current_issue_id]);
  }
  await pool.query('UPDATE poker_rooms SET revealed=false WHERE id=$1', [roomId]);
  pokerBroadcast(roomId);
  res.json({ ok: true });
});

app.post('/api/poker/issues/:id/estimate', async (req, res) => {
  const issue = (await pool.query('SELECT room_id FROM poker_issues WHERE id=$1', [req.params.id])).rows[0];
  if (!issue) return res.status(404).json({ error: 'not found' });
  await pool.query('UPDATE poker_issues SET final_estimate=$2 WHERE id=$1',
    [req.params.id, (req.body.value ?? '').toString() || null]);
  pokerBroadcast(issue.room_id);
  res.json({ ok: true });
});

app.get('/api/poker/rooms/:id/results', async (req, res) => {
  const roomId = req.params.id;
  const room = (await pool.query('SELECT id, name FROM poker_rooms WHERE id=$1', [roomId])).rows[0];
  if (!room) return res.status(404).json({ error: 'not found' });
  const participants = (await pool.query(
    'SELECT id, name FROM poker_participants WHERE room_id=$1 ORDER BY joined_at', [roomId])).rows;
  const issues = (await pool.query(
    'SELECT id, title, url, final_estimate AS "finalEstimate" FROM poker_issues WHERE room_id=$1 ORDER BY position, created_at', [roomId])).rows;
  const votes = (await pool.query(
    `SELECT v.issue_id AS "issueId", v.participant_id AS "participantId", v.value
     FROM poker_votes v JOIN poker_issues i ON i.id=v.issue_id WHERE i.room_id=$1`, [roomId])).rows;
  res.json({ room, participants, issues, votes });
});

app.use(express.static(PUBLIC, { index: false }));

// ---- HTTP + WS сервер ----
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws')) { socket.destroy(); return; }
  // Публичный канал planning poker: /ws/poker?room=<uuid> — без авторизации
  if (req.url.startsWith('/ws/poker')) {
    const roomId = new URL(req.url, 'http://x').searchParams.get('room');
    if (!roomId || !/^[0-9a-f-]{36}$/i.test(roomId)) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      let set = pokerClients.get(roomId);
      if (!set) { set = new Set(); pokerClients.set(roomId, set); }
      set.add(ws);
      const drop = () => { set.delete(ws); if (!set.size) pokerClients.delete(roomId); };
      ws.on('close', drop);
      ws.on('error', drop);
    });
    return;
  }
  sessionMiddleware(req, {}, () => {
    if (!req.session || !req.session.user) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.on('close', () => clients.delete(ws));
      ws.on('error', () => clients.delete(ws));
    });
  });
});

initOidc().then(async () => {
  await initOwnershipSchema();
  await initPokerSchema();
  await runStartupDataRepairs();
  await autoFinishExpiredSeries();
  const seriesDurationTimer = setInterval(() => {
    autoFinishExpiredSeries(pool, true).catch((e) => console.error('Series auto-finish failed:', e.message));
  }, SERIES_AUTO_FINISH_INTERVAL_MS);
  if (seriesDurationTimer.unref) seriesDurationTimer.unref();
  server.listen(PORT, () => console.log(`Ташкент v2 на :${PORT}`));
}).catch(e => { console.error('OIDC init failed:', e); process.exit(1); });
