const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const { Issuer, generators } = require('openid-client');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 7777;
const PUBLIC = path.join(__dirname, 'public');
const APP_URL = process.env.APP_URL || 'https://tashkent.spellful.site';

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
app.use(express.json({ limit: '1mb' }));
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
app.get('/login', (req, res) => {
  const state = generators.state();
  const nonce = generators.nonce();
  req.session.oidc = { state, nonce };
  res.redirect(oidc.authorizationUrl({ scope: 'openid email profile', state, nonce }));
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

// ---- Me / accounts / active ----
app.get('/api/me', requireAuth, async (req, res) => {
  res.json({ user: req.session.user, player: await myPlayer(req.session.user.sub) });
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
  res.json({ game, series, myPlayerId: me ? me.id : null, attached });
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
  const r = await pool.query(
    'SELECT id, name, status, created_at AS "createdAt", finished_at AS "finishedAt" FROM series ORDER BY created_at DESC'
  );
  res.json(r.rows);
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
  const ids = (await pool.query('SELECT id FROM games ORDER BY created_at DESC')).rows;
  res.json(await Promise.all(ids.map(r => loadGame(r.id))));
});
app.get('/api/games/:id', requireAuth, async (req, res) => {
  const g = await loadGame(req.params.id);
  g ? res.json(g) : res.status(404).json({ error: 'not found' });
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
