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
function renderAuthPage({ title, text, actionHref, actionLabel, secondaryHref, secondaryLabel }) {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${title} — Ташкент</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <header class="site-header">
    <a href="/" class="logo" aria-label="Ташкент — главная"><span class="logo-mark">🎱</span><span>Ташкент</span></a>
    <div class="user-bar">
      <a href="/" class="logout-link">На главную</a>
    </div>
  </header>
  <main class="auth-main">
    <section class="hero-panel auth-panel" aria-labelledby="auth-title">
      <p class="eyebrow"><span class="eyebrow-dot" aria-hidden="true"></span>Аккаунт</p>
      <h1 id="auth-title">${title}</h1>
      <p>${text}</p>
      <div class="button-row auth-actions">
        <a class="btn" href="${actionHref}">${actionLabel}</a>
        <a class="btn ghost" href="${secondaryHref}">${secondaryLabel}</a>
      </div>
      <a class="back-link" href="/">← На главную сервиса</a>
    </section>
  </main>
</body>
</html>`;
}

function startOidc(req, res, registration = false) {
  const state = generators.state();
  const nonce = generators.nonce();
  req.session.oidc = { state, nonce };
  const url = oidc.authorizationUrl({ scope: 'openid email profile', state, nonce });
  res.redirect(registration
    ? url.replace('/protocol/openid-connect/auth', '/protocol/openid-connect/registrations')
    : url);
}

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.send(renderAuthPage({
    title: 'Вход',
    text: 'Войдите через аккаунт Ташкента, чтобы продолжить учёт партий, серий и статистики.',
    actionHref: '/auth/login',
    actionLabel: 'Войти',
    secondaryHref: '/register',
    secondaryLabel: 'Регистрация',
  }));
});

app.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.send(renderAuthPage({
    title: 'Регистрация',
    text: 'Создайте аккаунт Ташкента через форму регистрации и возвращайтесь к учёту игр.',
    actionHref: '/auth/register',
    actionLabel: 'Зарегистрироваться',
    secondaryHref: '/login',
    secondaryLabel: 'У меня уже есть аккаунт',
  }));
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
  const g = (await pool.query('SELECT * FROM games WHERE id=$1', [id])).rows[0];
  if (!g) return null;
  const players = (await pool.query(
    'SELECT player_id AS id, name FROM game_players WHERE game_id=$1 ORDER BY position', [id]
  )).rows;
  const events = (await pool.query(
    'SELECT player_id AS "playerId", type, created_at AS ts FROM game_events WHERE game_id=$1 ORDER BY seq', [id]
  )).rows;
  return {
    id: g.id, seriesId: g.series_id, createdAt: g.created_at, finishedAt: g.finished_at,
    targetBalls: g.target_balls, players, events, finalScores: g.final_scores,
    winnerId: g.winner_player_id, pointsLeaderId: g.points_leader_player_id, status: g.status,
  };
}
const pid = (v, set) => (v && set.has(v) ? v : null);
const myPlayer = async (sub) =>
  (await pool.query('SELECT id FROM players WHERE account_sub=$1', [sub])).rows[0] || null;
const isAdmin = (user) => !!user && user.username === 'spellful';

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
      'SELECT id, name, status, created_at AS "createdAt", finished_at AS "finishedAt" FROM series ORDER BY created_at DESC'
    )).rows;
  }
  const me = await myPlayer(user.sub);
  if (!me) return [];
  return (await pool.query(
    `SELECT DISTINCT s.id, s.name, s.status, s.created_at AS "createdAt", s.finished_at AS "finishedAt"
     FROM series s
     JOIN games g ON g.series_id=s.id
     JOIN game_players gp ON gp.game_id=g.id
     WHERE gp.player_id=$1
     ORDER BY s.created_at DESC`,
    [me.id]
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
  const gr = (await pool.query("SELECT id FROM games WHERE status='active' ORDER BY created_at DESC LIMIT 1")).rows[0];
  const game = gr ? await loadGame(gr.id) : null;
  const series = (await pool.query(
    "SELECT id, name, status, created_at AS \"createdAt\" FROM series WHERE status='active' ORDER BY created_at DESC LIMIT 1"
  )).rows[0] || null;
  const me = await myPlayer(req.session.user.sub);
  const attached = !!(me && game && game.players.some(p => p.id === me.id));
  // активную игру показываем только её участнику или админу
  const visibleGame = (attached || isAdmin(req.session.user)) ? game : null;
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
  res.json(await listVisibleSeries(req.session.user));
});
app.post('/api/series', requireAuth, async (req, res) => {
  const r = await pool.query(
    'INSERT INTO series (name, status) VALUES ($1, $2) RETURNING id, name, status, created_at AS "createdAt", finished_at AS "finishedAt"',
    [(req.body.name || '').trim() || null, 'active']
  );
  broadcast({ type: 'activeChanged' });
  res.status(201).json(r.rows[0]);
});
app.get('/api/series/:id', requireAuth, async (req, res) => {
  const r = await pool.query(
    'SELECT id, name, status, created_at AS "createdAt", finished_at AS "finishedAt" FROM series WHERE id=$1', [req.params.id]
  );
  r.rows[0] ? res.json(r.rows[0]) : res.status(404).json({ error: 'not found' });
});
app.put('/api/series/:id', requireAuth, async (req, res) => {
  const b = req.body;
  const r = await pool.query(
    'UPDATE series SET name=COALESCE($2,name), status=COALESCE($3,status), finished_at=$4 WHERE id=$1 RETURNING id, name, status, created_at AS "createdAt", finished_at AS "finishedAt"',
    [req.params.id, b.name ?? null, b.status ?? null, b.finishedAt ?? null]
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
    if (!me) return res.json([]);
    rows = (await pool.query(
      `SELECT g.id FROM games g JOIN game_players gp ON gp.game_id=g.id
       WHERE gp.player_id=$1 ORDER BY g.created_at DESC`, [me.id]
    )).rows;
  }
  res.json(await Promise.all(rows.map(r => loadGame(r.id))));
});
app.get('/api/games/:id', requireAuth, async (req, res) => {
  const g = await loadGame(req.params.id);
  if (!g) return res.status(404).json({ error: 'not found' });
  if (!isAdmin(req.session.user)) {
    const me = await myPlayer(req.session.user.sub);
    if (!me || !g.players.some(p => p.id === me.id)) return res.status(403).json({ error: 'forbidden' });
  }
  res.json(g);
});
app.post('/api/games', requireAuth, async (req, res) => {
  const b = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pset = new Set((await client.query('SELECT id FROM players')).rows.map(r => r.id));
    const g = (await client.query(
      `INSERT INTO games (series_id, status, target_balls, final_scores, winner_player_id, points_leader_player_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [b.seriesId || null, b.status || 'active', b.targetBalls ?? null,
       b.finalScores ? JSON.stringify(b.finalScores) : null, pid(b.winnerId, pset), pid(b.pointsLeaderId, pset)]
    )).rows[0];
    await writeRoster(client, g.id, b.players || [], pset);
    await writeEvents(client, g.id, b.events || [], pset);
    await client.query('COMMIT');
    broadcast({ type: 'activeChanged' });
    res.status(201).json(await loadGame(g.id));
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});
app.put('/api/games/:id', requireAuth, async (req, res) => {
  const b = req.body, id = req.params.id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pset = new Set((await client.query('SELECT id FROM players')).rows.map(r => r.id));
    const upd = await client.query(
      `UPDATE games SET series_id=COALESCE($2,series_id), status=COALESCE($3,status),
         target_balls=COALESCE($4,target_balls), finished_at=$5,
         final_scores=COALESCE($6,final_scores), winner_player_id=$7, points_leader_player_id=$8
       WHERE id=$1 RETURNING id`,
      [id, b.seriesId ?? null, b.status ?? null, b.targetBalls ?? null, b.finishedAt ?? null,
       b.finalScores ? JSON.stringify(b.finalScores) : null, pid(b.winnerId, pset), pid(b.pointsLeaderId, pset)]
    );
    if (!upd.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not found' }); }
    if (Array.isArray(b.players)) { await client.query('DELETE FROM game_players WHERE game_id=$1', [id]); await writeRoster(client, id, b.players, pset); }
    if (Array.isArray(b.events))  { await client.query('DELETE FROM game_events WHERE game_id=$1', [id]); await writeEvents(client, id, b.events, pset); }
    await client.query('COMMIT');
    broadcast({ type: 'gameUpdated', gameId: id });
    broadcast({ type: 'activeChanged' });
    res.json(await loadGame(id));
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});
app.delete('/api/games/:id', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM games WHERE id=$1', [req.params.id]);
  broadcast({ type: 'activeChanged' });
  res.status(204).end();
});

// append одного события (real-time нажатие). Право: игрок запросившего в составе игры.
app.post('/api/games/:id/events', requireAuth, async (req, res) => {
  const gameId = req.params.id;
  const { type, playerId } = req.body;
  if (!type) return res.status(400).json({ error: 'type required' });
  const me = await myPlayer(req.session.user.sub);
  if (!me) return res.status(403).json({ error: 'not a linked player' });
  const inRoster = (await pool.query('SELECT 1 FROM game_players WHERE game_id=$1 AND player_id=$2', [gameId, me.id])).rows[0];
  if (!inRoster) return res.status(403).json({ error: 'not in roster' });
  const g = (await pool.query('SELECT status FROM games WHERE id=$1', [gameId])).rows[0];
  if (!g) return res.status(404).json({ error: 'not found' });
  if (g.status !== 'active') return res.status(409).json({ error: 'game not active' });
  const pset = new Set((await pool.query('SELECT id FROM players')).rows.map(r => r.id));
  const seq = (await pool.query('SELECT COALESCE(MAX(seq),-1)+1 AS n FROM game_events WHERE game_id=$1', [gameId])).rows[0].n;
  await pool.query(
    'INSERT INTO game_events (game_id, seq, player_id, type, created_by_sub) VALUES ($1,$2,$3,$4,$5)',
    [gameId, seq, pid(playerId, pset), type, req.session.user.sub]
  );
  broadcast({ type: 'gameUpdated', gameId });
  res.status(201).json({ ok: true, seq });
});

async function writeRoster(client, gameId, players, pset) {
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    await client.query('INSERT INTO game_players (game_id, position, player_id, name) VALUES ($1,$2,$3,$4)',
      [gameId, i, pid(p.id, pset), p.name || '']);
  }
}
async function writeEvents(client, gameId, events, pset) {
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    await client.query('INSERT INTO game_events (game_id, seq, player_id, type, created_at) VALUES ($1,$2,$3,$4,$5)',
      [gameId, i, pid(e.playerId, pset), e.type, e.ts || new Date().toISOString()]);
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

app.use(express.static(PUBLIC, { index: false }));

// ---- HTTP + WS сервер ----
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws')) { socket.destroy(); return; }
  sessionMiddleware(req, {}, () => {
    if (!req.session || !req.session.user) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.on('close', () => clients.delete(ws));
      ws.on('error', () => clients.delete(ws));
    });
  });
});

initOidc().then(() => {
  server.listen(PORT, () => console.log(`Ташкент v2 на :${PORT}`));
}).catch(e => { console.error('OIDC init failed:', e); process.exit(1); });
