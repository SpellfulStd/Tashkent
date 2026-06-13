const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const PLAYERS_FILE = path.join(DATA_DIR, 'players.json');
const GAMES_FILE = path.join(DATA_DIR, 'games.json');
const SERIES_FILE = path.join(DATA_DIR, 'series.json');
const PORT = process.env.PORT || 7777;

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PLAYERS_FILE)) fs.writeFileSync(PLAYERS_FILE, '[]');
if (!fs.existsSync(GAMES_FILE)) fs.writeFileSync(GAMES_FILE, '[]');
if (!fs.existsSync(SERIES_FILE)) fs.writeFileSync(SERIES_FILE, '[]');

const readJSON = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJSON = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJSON(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (p === '/api/players' && req.method === 'GET') {
      return sendJSON(res, 200, readJSON(PLAYERS_FILE));
    }
    if (p === '/api/players' && req.method === 'POST') {
      const body = await readBody(req);
      const name = (body.name || '').trim();
      if (!name) return sendJSON(res, 400, { error: 'name required' });
      const players = readJSON(PLAYERS_FILE);
      const existing = players.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (existing) return sendJSON(res, 200, existing);
      const player = { id: crypto.randomUUID(), name, createdAt: new Date().toISOString() };
      players.push(player);
      writeJSON(PLAYERS_FILE, players);
      return sendJSON(res, 201, player);
    }
    if (p.startsWith('/api/players/') && req.method === 'DELETE') {
      const id = p.split('/').pop();
      const players = readJSON(PLAYERS_FILE).filter((x) => x.id !== id);
      writeJSON(PLAYERS_FILE, players);
      return sendJSON(res, 204, {});
    }

    if (p === '/api/games' && req.method === 'GET') {
      return sendJSON(res, 200, readJSON(GAMES_FILE));
    }
    if (p === '/api/games' && req.method === 'POST') {
      const body = await readBody(req);
      const games = readJSON(GAMES_FILE);
      const game = {
        id: crypto.randomUUID(),
        seriesId: body.seriesId || null,
        createdAt: body.createdAt || new Date().toISOString(),
        finishedAt: body.finishedAt || null,
        targetBalls: body.targetBalls,
        players: body.players || [],
        events: body.events || [],
        finalScores: body.finalScores || null,
        winnerId: body.winnerId || null,
        pointsLeaderId: body.pointsLeaderId || null,
        status: body.status || 'active',
      };
      games.unshift(game);
      writeJSON(GAMES_FILE, games);
      return sendJSON(res, 201, game);
    }
    if (p.startsWith('/api/games/') && req.method === 'GET') {
      const id = p.split('/').pop();
      const game = readJSON(GAMES_FILE).find((g) => g.id === id);
      if (!game) return sendJSON(res, 404, { error: 'not found' });
      return sendJSON(res, 200, game);
    }
    if (p.startsWith('/api/games/') && req.method === 'PUT') {
      const id = p.split('/').pop();
      const body = await readBody(req);
      const games = readJSON(GAMES_FILE);
      const i = games.findIndex((g) => g.id === id);
      if (i < 0) return sendJSON(res, 404, { error: 'not found' });
      games[i] = { ...games[i], ...body, id };
      writeJSON(GAMES_FILE, games);
      return sendJSON(res, 200, games[i]);
    }
    if (p.startsWith('/api/games/') && req.method === 'DELETE') {
      const id = p.split('/').pop();
      const games = readJSON(GAMES_FILE).filter((g) => g.id !== id);
      writeJSON(GAMES_FILE, games);
      return sendJSON(res, 204, {});
    }

    if (p === '/api/series' && req.method === 'GET') {
      return sendJSON(res, 200, readJSON(SERIES_FILE));
    }
    if (p === '/api/series' && req.method === 'POST') {
      const body = await readBody(req);
      const series = readJSON(SERIES_FILE);
      const item = {
        id: crypto.randomUUID(),
        name: (body.name || '').trim() || null,
        createdAt: body.createdAt || new Date().toISOString(),
        finishedAt: null,
        status: 'active',
      };
      series.unshift(item);
      writeJSON(SERIES_FILE, series);
      return sendJSON(res, 201, item);
    }
    if (p.startsWith('/api/series/') && req.method === 'GET') {
      const id = p.split('/').pop();
      const item = readJSON(SERIES_FILE).find((x) => x.id === id);
      if (!item) return sendJSON(res, 404, { error: 'not found' });
      return sendJSON(res, 200, item);
    }
    if (p.startsWith('/api/series/') && req.method === 'PUT') {
      const id = p.split('/').pop();
      const body = await readBody(req);
      const series = readJSON(SERIES_FILE);
      const i = series.findIndex((x) => x.id === id);
      if (i < 0) return sendJSON(res, 404, { error: 'not found' });
      series[i] = { ...series[i], ...body, id };
      writeJSON(SERIES_FILE, series);
      return sendJSON(res, 200, series[i]);
    }
    if (p.startsWith('/api/series/') && req.method === 'DELETE') {
      const id = p.split('/').pop();
      const series = readJSON(SERIES_FILE).filter((x) => x.id !== id);
      writeJSON(SERIES_FILE, series);
      const games = readJSON(GAMES_FILE).map((g) => g.seriesId === id ? { ...g, seriesId: null } : g);
      writeJSON(GAMES_FILE, games);
      return sendJSON(res, 204, {});
    }

    let file = p === '/' ? '/index.html' : p;
    const full = path.normalize(path.join(PUBLIC_DIR, file));
    if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      const ext = path.extname(full).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    });
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`Ташкент: http://localhost:${PORT}`);
});
