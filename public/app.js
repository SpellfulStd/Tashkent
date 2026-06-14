// Ташкент — учёт игр

const app = document.getElementById('app');
const userNameEl = document.getElementById('userName');
const toastEl = document.getElementById('toast');

const state = {
  me: null,
  active: null,
  ws: null,
  wsTimer: null,
  currentGameId: null,
  reloadLiveGame: null,
  routeToken: 0,
  actionPending: false,
};

const api = {
  async request(url, options = {}) {
    const init = {
      method: options.method || 'GET',
      credentials: 'same-origin',
      headers: {},
    };
    if (Object.prototype.hasOwnProperty.call(options, 'body')) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    const r = await fetch(url, init);
    if (r.status === 401) {
      location.href = '/login';
      throw new Error('Сессия истекла');
    }

    const text = await r.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); }
      catch { data = { error: text }; }
    }

    if (!r.ok) {
      const err = new Error((data && data.error) || `Ошибка ${r.status}`);
      err.status = r.status;
      err.data = data;
      throw err;
    }
    return data;
  },
  get(url) { return this.request(url); },
  post(url, body) { return this.request(url, { method: 'POST', body }); },
  put(url, body) { return this.request(url, { method: 'PUT', body }); },
  del(url) { return this.request(url, { method: 'DELETE' }); },
};

// balls — счётчик победы; points — очки текущему; prevDelta — что прилетает предыдущему игроку в фиксированном порядке
const EVENT_DEFS = {
  pocket_regular: { label: 'Обычный',       balls: 1, points: 1,  prevDelta: -1, keepTurn: true,  isPocket: true,  isDurak: false, isGolden: false },
  pocket_duplet:  { label: 'Дуплет',        balls: 1, points: 2,  prevDelta: -2, keepTurn: true,  isPocket: true,  isDurak: false, isGolden: false },
  pocket_pants:   { label: 'Штаны',         balls: 2, points: 3,  prevDelta: -3, keepTurn: true,  isPocket: true,  isDurak: false, isGolden: false },
  pocket_durak:   { label: 'Дурак',         balls: 1, points: 1,  prevDelta: -1, keepTurn: true,  isPocket: true,  isDurak: true,  isGolden: false },
  penalty:        { label: 'Штраф',         balls: 0, points: -1, prevDelta:  1, keepTurn: false, isPocket: false, isDurak: false, isGolden: false },
  miss:           { label: 'Промах',        balls: 0, points: 0,  prevDelta:  0, keepTurn: false, isPocket: false, isDurak: false, isGolden: false },
  set_turn:       { label: 'Передача хода', balls: 0, points: 0,  prevDelta:  0, keepTurn: true,  isPocket: false, isDurak: false, isGolden: false },
  golden_regular: { label: 'Золотой шар',    balls: 1, points: 0, prevDelta: 0, keepTurn: true, isPocket: true,  isDurak: false, isGolden: true, goldenTier: 0 },
  golden_duplet:  { label: 'Золотой дуплет', balls: 1, points: 0, prevDelta: 0, keepTurn: true, isPocket: true,  isDurak: false, isGolden: true, goldenTier: 1 },
  golden_pants:   { label: 'Золотые штаны',  balls: 2, points: 0, prevDelta: 0, keepTurn: true, isPocket: true,  isDurak: false, isGolden: true, goldenTier: 2 },
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function signed(n) { return n > 0 ? `+${n}` : `${n}`; }
function prevIndex(idx, n) { return (idx - 1 + n) % n; }

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function fmtDateOnly(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' });
}

function fmtDuration(startIso, endIso) {
  const ms = new Date(endIso) - new Date(startIso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}ч ${m % 60}м` : `${m}м`;
}

function showToast(message) {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

function handleActionError(err) {
  if (err.status === 403) {
    showToast('Вы не в составе этой игры');
    return;
  }
  if (err.status === 409) {
    showToast('Игра уже завершена');
    return;
  }
  showToast(err.message || 'Не удалось выполнить действие');
}

function computeState(game) {
  const scores = {};
  game.players.forEach((p) => { scores[p.id] = { balls: 0, points: 0, duraks: 0 }; });
  let turnIdx = 0;
  let firstWinner = null;
  const n = game.players.length;
  const targetBalls = Number(game.targetBalls) || 0;

  for (const ev of game.events || []) {
    const def = EVENT_DEFS[ev.type];
    if (!def) continue;
    const idx = game.players.findIndex((p) => p.id === ev.playerId);
    if (idx < 0) continue;
    const s = scores[ev.playerId];

    if (def.isGolden) {
      const pts = n + def.goldenTier;
      const prevPts = -(2 + def.goldenTier);
      s.balls += def.balls;
      s.points += pts;
      if (n > 1) {
        const prevId = game.players[prevIndex(idx, n)].id;
        scores[prevId].points += prevPts;
        game.players.forEach((p) => {
          if (p.id !== ev.playerId && p.id !== prevId) scores[p.id].points -= 1;
        });
      }
      turnIdx = idx;
    } else {
      s.balls = Math.max(0, s.balls + def.balls);
      s.points += def.points;
      if (def.isDurak) s.duraks += 1;
      if (def.prevDelta && n > 1) {
        const prevId = game.players[prevIndex(idx, n)].id;
        if (prevId !== ev.playerId) scores[prevId].points += def.prevDelta;
      }
      turnIdx = def.keepTurn ? idx : (idx + 1) % n;
    }

    if (!firstWinner && def.balls > 0 && s.balls >= targetBalls) {
      firstWinner = game.players[idx];
    }
  }

  const winner = firstWinner || game.players.find((p) => scores[p.id].balls >= targetBalls) || null;
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

  const totalBalls = game.players.reduce((sum, p) => sum + scores[p.id].balls, 0);
  const prevPlayer = n > 0 ? game.players[prevIndex(turnIdx, n)] : null;
  return {
    scores,
    turnIdx,
    winner,
    firstWinner,
    pointsLeader,
    prevPlayer,
    totalBalls,
    isGoldenPhase: totalBalls === 14,
    allBallsGone: totalBalls >= 15,
  };
}

function seriesTotals(series, games) {
  const seriesGames = games.filter((g) => g.seriesId === series.id);
  const finished = seriesGames.filter((g) => g.status === 'finished');
  const totals = new Map();
  for (const g of finished) {
    for (const p of g.players) {
      if (!totals.has(p.id)) {
        totals.set(p.id, { id: p.id, name: p.name, wins: 0, pointsLeads: 0, totalPoints: 0, totalBalls: 0, totalDuraks: 0, gamesPlayed: 0 });
      }
      const t = totals.get(p.id);
      t.gamesPlayed++;
      if (g.winnerId === p.id) t.wins++;
      if (g.pointsLeaderId === p.id) t.pointsLeads++;
      const s = (g.finalScores && g.finalScores[p.id]) || { balls: 0, points: 0, duraks: 0 };
      t.totalPoints += s.points;
      t.totalBalls += s.balls;
      t.totalDuraks += s.duraks || 0;
    }
  }
  const arr = [...totals.values()];
  let winsChampion = null;
  let pointsChampion = null;
  if (arr.length) {
    const maxWins = Math.max(...arr.map((x) => x.wins));
    const winsTop = arr.filter((x) => x.wins === maxWins);
    if (winsTop.length === 1 && maxWins > 0) winsChampion = winsTop[0];
    const maxPts = Math.max(...arr.map((x) => x.totalPoints));
    const ptsTop = arr.filter((x) => x.totalPoints === maxPts);
    if (ptsTop.length === 1) pointsChampion = ptsTop[0];
  }
  return { games: seriesGames, finished, totals: arr, winsChampion, pointsChampion };
}

function overallPlayerStats(players, games) {
  const totals = new Map();
  for (const p of players) {
    totals.set(p.id, { id: p.id, name: p.name, gamesPlayed: 0, wins: 0, pointsLeads: 0, totalPoints: 0, totalBalls: 0, totalDuraks: 0 });
  }
  for (const g of games.filter((x) => x.status === 'finished')) {
    for (const p of g.players) {
      if (!totals.has(p.id)) {
        totals.set(p.id, { id: p.id, name: p.name, gamesPlayed: 0, wins: 0, pointsLeads: 0, totalPoints: 0, totalBalls: 0, totalDuraks: 0 });
      }
      const t = totals.get(p.id);
      const s = (g.finalScores && g.finalScores[p.id]) || { balls: 0, points: 0, duraks: 0 };
      t.gamesPlayed++;
      if (g.winnerId === p.id) t.wins++;
      if (g.pointsLeaderId === p.id) t.pointsLeads++;
      t.totalPoints += s.points;
      t.totalBalls += s.balls;
      t.totalDuraks += s.duraks || 0;
    }
  }
  return [...totals.values()]
    .filter((x) => x.gamesPlayed > 0)
    .sort((a, b) => b.wins - a.wins || b.totalPoints - a.totalPoints || a.name.localeCompare(b.name, 'ru'));
}

function eventDelta(def, playerCount) {
  if (!def) return '';
  const parts = [];
  if (def.isGolden) {
    if (def.balls) parts.push(`+${def.balls} ш`);
    parts.push(`+${playerCount + def.goldenTier} о`);
  } else {
    if (def.balls) parts.push(`${def.balls > 0 ? '+' : ''}${def.balls} ш`);
    if (def.points) parts.push(`${def.points > 0 ? '+' : ''}${def.points} о`);
  }
  return parts.join(', ');
}

function gameRowHTML(g) {
  const winner = g.winnerId ? g.players.find((p) => p.id === g.winnerId) : null;
  const pointsLeader = g.pointsLeaderId ? g.players.find((p) => p.id === g.pointsLeaderId) : null;
  const status = g.status === 'active'
    ? '<span class="tag active">идёт</span>'
    : `${winner ? `<span class="winner-badge">🏆 ${esc(winner.name)}</span>` : '<span class="tag">завершено</span>'}${pointsLeader && (!winner || pointsLeader.id !== winner.id) ? ` <span class="winner-badge points">🥇 ${esc(pointsLeader.name)}</span>` : ''}`;
  const route = g.status === 'active' ? `#/game/${esc(g.id)}` : `#/games/${esc(g.id)}`;
  return `
    <a href="${route}" class="row-link">
      <div class="game-row">
        <div>
          <div class="title">${g.players.map((p) => esc(p.name)).join(' · ')}</div>
          <div class="meta">${fmtDate(g.createdAt)} · до ${esc(g.targetBalls)}</div>
        </div>
        <div class="row-status">${status}</div>
      </div>
    </a>
  `;
}

function seriesRowHTML(s, gamesCount) {
  const status = s.status === 'active' ? '<span class="tag active">идёт</span>' : '<span class="tag">завершена</span>';
  return `
    <a href="#/series/${esc(s.id)}" class="row-link">
      <div class="game-row">
        <div>
          <div class="title">${esc(s.name || 'Серия от ' + fmtDateOnly(s.createdAt))}</div>
          <div class="meta">${fmtDate(s.createdAt)}${s.finishedAt ? ' → ' + fmtDate(s.finishedAt) : ''} · игр: ${gamesCount}</div>
        </div>
        <div class="row-status">${status}</div>
      </div>
    </a>
  `;
}

function accountLabel(account) {
  return account.username || account.email || account.sub;
}

function accountOptionsHTML(accounts, players, selectedSub = '') {
  const linkedBySub = new Map(players.filter((p) => p.accountSub).map((p) => [p.accountSub, p]));
  return accounts.map((a) => {
    const linked = linkedBySub.get(a.sub);
    const suffix = linked ? ` · ${linked.name}` : '';
    return `<option value="${esc(a.sub)}" ${a.sub === selectedSub ? 'selected' : ''}>${esc(accountLabel(a) + suffix)}</option>`;
  }).join('');
}

function updateUserHeader() {
  if (!userNameEl) return;
  const user = state.me && state.me.user;
  userNameEl.textContent = user ? (user.name || user.username || user.email || 'Аккаунт') : '—';
}

async function refreshSession() {
  state.me = await api.get('/api/me');
  updateUserHeader();
  return state.me;
}

async function refreshActive() {
  state.active = await api.get('/api/active');
  return state.active;
}

function isDefaultHash() {
  return !location.hash || location.hash === '#' || location.hash === '#/';
}

function accessForGame(game) {
  const myPlayerId = (state.active && state.active.myPlayerId) || (state.me && state.me.player && state.me.player.id) || null;
  const inRoster = !!myPlayerId && game.players.some((p) => p.id === myPlayerId);
  const activeSaysAttached = state.active && state.active.game && state.active.game.id === game.id && state.active.attached;
  return {
    myPlayerId,
    inRoster,
    canControl: game.status === 'active' && (inRoster || activeSaysAttached),
  };
}

function connectWS() {
  clearTimeout(state.wsTimer);
  const ws = new WebSocket(`wss://${location.host}/ws`);
  state.ws = ws;

  ws.addEventListener('message', async (event) => {
    let msg = null;
    try { msg = JSON.parse(event.data); }
    catch { return; }

    if (msg.type === 'gameUpdated' && msg.gameId === state.currentGameId && typeof state.reloadLiveGame === 'function') {
      await state.reloadLiveGame();
    }

    if (msg.type === 'activeChanged') {
      await refreshActive();
      if (isDefaultHash()) route();
    }
  });

  ws.addEventListener('close', () => {
    if (state.ws === ws) state.ws = null;
    state.wsTimer = setTimeout(connectWS, 2000);
  });

  ws.addEventListener('error', () => {
    try { ws.close(); } catch {}
  });
}

async function boot() {
  app.innerHTML = '<p class="muted">Загрузка…</p>';
  try {
    await Promise.all([refreshSession(), refreshActive()]);
    connectWS();
    if (isDefaultHash() && state.active && state.active.game) {
      location.hash = `#/game/${state.active.game.id}`;
      return;
    }
    await route();
  } catch (err) {
    if (err.status !== 401) app.innerHTML = `<p class="muted">Ошибка: ${esc(err.message)}</p>`;
  }
}

const routes = [
  { match: /^#?\/?$/, render: renderHome },
  { match: /^#\/players$/, render: renderPlayers },
  { match: /^#\/new-series$/, render: renderNewSeries },
  { match: /^#\/series\/(.+)$/, render: renderSeries },
  { match: /^#\/new-game\/(.+)$/, render: renderNewGame },
  { match: /^#\/game\/(.+)$/, render: renderLiveGame },
  { match: /^#\/history$/, render: renderHistory },
  { match: /^#\/games\/(.+)$/, render: renderGameDetail },
];

async function route() {
  const token = ++state.routeToken;
  state.currentGameId = null;
  state.reloadLiveGame = null;
  const hash = location.hash || '#/';
  for (const r of routes) {
    const m = hash.match(r.match);
    if (m) {
      app.innerHTML = '<p class="muted">Загрузка…</p>';
      try {
        await r.render(m, token);
      } catch (e) {
        if (e.status !== 401 && token === state.routeToken) {
          app.innerHTML = `<p class="muted">Ошибка: ${esc(e.message)}</p>`;
        }
        console.error(e);
      }
      return;
    }
  }
  app.innerHTML = '<p>Не найдено</p>';
}

window.addEventListener('hashchange', route);
window.addEventListener('load', boot);

async function renderHome() {
  const [series, games] = await Promise.all([api.get('/api/series'), api.get('/api/games')]);
  const activeSeries = series.filter((s) => s.status === 'active');
  const finished = series.filter((s) => s.status === 'finished').slice(0, 5);
  const orphanGames = games.filter((g) => !g.seriesId).slice(0, 5);
  const activeGame = state.active && state.active.game;

  app.innerHTML = `
    <section class="hero-panel">
      <p class="eyebrow"><span class="eyebrow-dot"></span>учёт пирамиды в реальном времени</p>
      <h1>Ташкент</h1>
      <p>Серии, партии, очки и шары. Ходы синхронизируются между телефонами через сервер.</p>
      <div class="toolbar">
        <a href="#/new-series" class="btn">+ Новая серия</a>
        <a href="#/players" class="btn ghost">Игроки</a>
        <a href="#/history" class="btn ghost">История</a>
      </div>
    </section>

    ${activeGame ? `
      <h2>Активная игра</h2>
      <div class="notice info">
        <div>
          <strong>${activeGame.players.map((p) => esc(p.name)).join(' · ')}</strong>
          <p class="muted">до ${esc(activeGame.targetBalls)} · ${state.active.attached ? 'вы в составе' : 'только просмотр'}</p>
        </div>
        <a href="#/game/${esc(activeGame.id)}" class="btn small">Открыть</a>
      </div>
    ` : ''}

    ${activeSeries.length > 0 ? `
      <h2>Активные серии</h2>
      ${activeSeries.map((s) => seriesRowHTML(s, games.filter((g) => g.seriesId === s.id).length)).join('')}
    ` : ''}

    ${finished.length > 0 ? `
      <h2>Недавние серии</h2>
      ${finished.map((s) => seriesRowHTML(s, games.filter((g) => g.seriesId === s.id).length)).join('')}
    ` : ''}

    ${orphanGames.length > 0 ? `
      <h2>Игры без серии</h2>
      ${orphanGames.map(gameRowHTML).join('')}
    ` : ''}

    ${series.length === 0 && orphanGames.length === 0 ? '<p class="empty-state">Пока ничего нет. Создай первую серию.</p>' : ''}
  `;
}

async function renderPlayers() {
  const [players, accounts, games] = await Promise.all([api.get('/api/players'), api.get('/api/accounts'), api.get('/api/games')]);
  const stats = overallPlayerStats(players, games);

  app.innerHTML = `
    <a href="#/" class="back-link">← Главная</a>
    <h1>Игроки</h1>

    <div class="card">
      <h2>Добавить игрока</h2>
      <div class="form-grid">
        <div>
          <label for="accountSelect">Аккаунт</label>
          <select id="accountSelect" ${accounts.length === 0 ? 'disabled' : ''}>
            <option value="">Выбрать вошедший аккаунт</option>
            ${accountOptionsHTML(accounts, players)}
          </select>
        </div>
        <div>
          <label for="accountPlayerName">Имя игрока</label>
          <input type="text" id="accountPlayerName" placeholder="По умолчанию username" />
        </div>
      </div>
      <button id="addAccountPlayerBtn" ${accounts.length === 0 ? 'disabled' : ''}>Добавить с аккаунтом</button>
      ${accounts.length === 0 ? '<p class="muted">Аккаунты появятся после первого входа через Keycloak.</p>' : ''}

      <div class="divider"></div>

      <label for="guestPlayerName">Гость без аккаунта</label>
      <div class="row">
        <input type="text" id="guestPlayerName" placeholder="Имя гостя" />
        <button id="addGuestBtn" class="shrink">Добавить гостя</button>
      </div>
    </div>

    <h2>Все игроки (${players.length})</h2>
    <div class="stack">
      ${players.length === 0 ? '<p class="empty-state">Никого нет. Добавь первого.</p>' :
        players.map((p) => `
          <div class="card player-admin">
            <div class="player-admin-main">
              <div class="admin-name">${esc(p.name)}</div>
              <div class="muted">${p.accountUsername ? `аккаунт: ${esc(p.accountUsername)}` : 'гость без аккаунта'}${p.createdAt ? ` · с ${fmtDate(p.createdAt)}` : ''}</div>
            </div>
            <div class="admin-actions">
              <select data-account="${esc(p.id)}">
                <option value="">Без аккаунта</option>
                ${accountOptionsHTML(accounts, players, p.accountSub || '')}
              </select>
              <button class="ghost small" data-bind="${esc(p.id)}">Сохранить</button>
              ${p.accountSub ? `<button class="ghost small" data-unbind="${esc(p.id)}">Отвязать</button>` : ''}
              <button class="ghost danger small" data-del="${esc(p.id)}">Удалить</button>
            </div>
          </div>
        `).join('')}
    </div>

    ${stats.length > 0 ? `
      <h2>Статистика игроков</h2>
      <div class="card totals-card table-scroll">
        <table class="totals">
          <thead><tr><th>Игрок</th><th>Игр</th><th>Побед</th><th>Лидер по очкам</th><th>Очков</th><th>Шаров</th><th>Дураков</th></tr></thead>
          <tbody>
            ${stats.map((t) => `
              <tr>
                <td>${esc(t.name)}</td>
                <td>${t.gamesPlayed}</td>
                <td>${t.wins}</td>
                <td>${t.pointsLeads}</td>
                <td>${signed(t.totalPoints)}</td>
                <td>${t.totalBalls}</td>
                <td>${t.totalDuraks}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    ` : ''}
  `;

  const guestInput = document.getElementById('guestPlayerName');
  const accountInput = document.getElementById('accountPlayerName');
  const accountSelect = document.getElementById('accountSelect');

  document.getElementById('addGuestBtn').addEventListener('click', async () => {
    const name = guestInput.value.trim();
    if (!name) return;
    await api.post('/api/players', { name });
    await refreshSession();
    route();
  });
  guestInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('addGuestBtn').click(); });

  document.getElementById('addAccountPlayerBtn').addEventListener('click', async () => {
    const account = accounts.find((a) => a.sub === accountSelect.value);
    if (!account) {
      showToast('Выберите аккаунт');
      return;
    }
    const name = accountInput.value.trim() || account.username || account.email || 'Игрок';
    await api.post('/api/players', { name, accountSub: account.sub });
    await refreshSession();
    route();
  });

  document.querySelectorAll('[data-bind]').forEach((b) => {
    b.addEventListener('click', async () => {
      const select = [...document.querySelectorAll('[data-account]')].find((el) => el.dataset.account === b.dataset.bind);
      if (!select) return;
      await api.put(`/api/players/${b.dataset.bind}`, { accountSub: select.value || null });
      await Promise.all([refreshSession(), refreshActive()]);
      showToast(select.value ? 'Аккаунт привязан' : 'Аккаунт отвязан');
      route();
    });
  });

  document.querySelectorAll('[data-unbind]').forEach((b) => {
    b.addEventListener('click', async () => {
      await api.put(`/api/players/${b.dataset.unbind}`, { accountSub: null });
      await Promise.all([refreshSession(), refreshActive()]);
      showToast('Аккаунт отвязан');
      route();
    });
  });

  document.querySelectorAll('[data-del]').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!confirm('Удалить игрока? История игр сохранится.')) return;
      await api.del(`/api/players/${b.dataset.del}`);
      await Promise.all([refreshSession(), refreshActive()]);
      route();
    });
  });
}

async function renderNewSeries() {
  app.innerHTML = `
    <a href="#/" class="back-link">← Главная</a>
    <h1>Новая серия</h1>
    <div class="card">
      <label for="seriesName">Название (необязательно)</label>
      <input type="text" id="seriesName" placeholder="Серия от ${fmtDateOnly(new Date().toISOString())}" />
      <p class="muted">Если оставить пустым, останется дата создания.</p>
    </div>
    <div class="button-row">
      <button id="createBtn">Создать и начать первую игру</button>
      <a href="#/" class="btn ghost">Отмена</a>
    </div>
  `;
  document.getElementById('createBtn').addEventListener('click', async () => {
    const name = document.getElementById('seriesName').value.trim();
    const s = await api.post('/api/series', { name: name || null });
    await refreshActive();
    location.hash = `#/new-game/${s.id}`;
  });
}

async function renderSeries(match) {
  const id = match[1];
  const [series, games] = await Promise.all([api.get(`/api/series/${id}`), api.get('/api/games')]);
  if (!series || series.error) { app.innerHTML = '<p>Серия не найдена.</p>'; return; }
  const { games: seriesGames, totals, winsChampion, pointsChampion } = seriesTotals(series, games);
  const isActive = series.status === 'active';
  const sortedTotals = [...totals].sort((a, b) => b.wins - a.wins || b.totalPoints - a.totalPoints);

  app.innerHTML = `
    <a href="#/" class="back-link">← Главная</a>
    <h1>${esc(series.name || 'Серия от ' + fmtDateOnly(series.createdAt))}</h1>
    <p class="muted">${fmtDate(series.createdAt)}${series.finishedAt ? ' → завершена ' + fmtDate(series.finishedAt) : ''} · игр: ${seriesGames.length}</p>

    ${isActive ? `
      <div class="toolbar card">
        <a href="#/new-game/${esc(id)}" class="btn">+ Новая игра в серии</a>
        <button class="ghost" id="endSeriesBtn">Завершить серию</button>
      </div>
    ` : ''}

    ${sortedTotals.length > 0 ? `
      <h2>${isActive ? 'Текущий зачёт' : '🏆 Итоги серии'}</h2>
      <div class="card totals-card table-scroll">
        <table class="totals">
          <thead><tr><th>Игрок</th><th>Побед</th><th>Лидер по очкам</th><th>Очков всего</th><th>Шаров всего</th><th>Дураков</th></tr></thead>
          <tbody>
            ${sortedTotals.map((t) => `
              <tr>
                <td>
                  ${esc(t.name)}
                  ${winsChampion && winsChampion.id === t.id ? '<span class="champ-tag wins">🏆 чемпион по победам</span>' : ''}
                  ${pointsChampion && pointsChampion.id === t.id ? '<span class="champ-tag points">🥇 чемпион по очкам</span>' : ''}
                </td>
                <td>${t.wins}</td>
                <td>${t.pointsLeads}</td>
                <td>${signed(t.totalPoints)}</td>
                <td>${t.totalBalls}</td>
                <td>${t.totalDuraks}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        ${!isActive && (!winsChampion || !pointsChampion) ? '<p class="muted table-note">Где не выделен чемпион — ничья.</p>' : ''}
      </div>
    ` : ''}

    <h2>Игры в серии</h2>
    ${seriesGames.length === 0 ? '<p class="empty-state">Игр пока нет.</p>' :
      [...seriesGames].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).map(gameRowHTML).join('')}

    <div class="danger-zone">
      <button class="ghost danger" id="delSeriesBtn">Удалить серию</button>
    </div>
  `;

  if (isActive) {
    document.getElementById('endSeriesBtn').addEventListener('click', async () => {
      const unfinished = seriesGames.some((g) => g.status === 'active');
      if (unfinished && !confirm('В серии есть незавершённые игры. Всё равно закрыть серию?')) return;
      if (!confirm('Завершить серию и зафиксировать итоги?')) return;
      await api.put(`/api/series/${id}`, { status: 'finished', finishedAt: new Date().toISOString() });
      await refreshActive();
      route();
    });
  }
  document.getElementById('delSeriesBtn').addEventListener('click', async () => {
    if (!confirm('Удалить серию? Игры останутся в общем списке без серии.')) return;
    await api.del(`/api/series/${id}`);
    await refreshActive();
    location.hash = '#/';
  });
}

async function renderNewGame(match) {
  const seriesId = match[1];
  const [playersInitial, allGames, series] = await Promise.all([api.get('/api/players'), api.get('/api/games'), api.get(`/api/series/${seriesId}`)]);
  if (!series || series.error) { app.innerHTML = '<p>Серия не найдена.</p>'; return; }
  let players = playersInitial;

  const prevGames = allGames.filter((g) => g.seriesId === seriesId).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const prevGame = prevGames[0];
  const gameState = {
    selectedOrder: prevGame ? prevGame.players.map((p) => p.id).filter((pid) => players.find((x) => x.id === pid)) : [],
    target: prevGame ? prevGame.targetBalls : 6,
    targetTouched: !!prevGame,
  };

  function refresh() {
    const selectedSet = new Set(gameState.selectedOrder);
    const orderedSelected = gameState.selectedOrder.map((pid) => players.find((p) => p.id === pid)).filter(Boolean);
    const unselected = players.filter((p) => !selectedSet.has(p.id));
    const playerCount = orderedSelected.length;
    const defaultTarget = playerCount <= 2 ? 8 : playerCount === 3 ? 6 : playerCount === 4 ? 5 : 4;
    if (!gameState.targetTouched) {
      gameState.target = defaultTarget;
      document.getElementById('targetVal').value = gameState.target;
    }

    document.getElementById('selectedList').innerHTML = orderedSelected.length === 0
      ? '<p class="empty-state">Никто не выбран. Добавь игроков ниже.</p>'
      : orderedSelected.map((p, i) => `
          <div class="player-pick selected">
            <div class="order">${i + 1}</div>
            <div class="name">${esc(p.name)}${p.accountUsername ? `<span class="account-pill">${esc(p.accountUsername)}</span>` : '<span class="account-pill guest">гость</span>'}</div>
            <div class="move">
              <button class="ghost small" data-up="${esc(p.id)}" ${i === 0 ? 'disabled' : ''}>↑</button>
              <button class="ghost small" data-down="${esc(p.id)}" ${i === orderedSelected.length - 1 ? 'disabled' : ''}>↓</button>
              <button class="ghost small" data-remove="${esc(p.id)}">×</button>
            </div>
          </div>
        `).join('');

    document.getElementById('unselectedList').innerHTML = unselected.length === 0
      ? '<p class="empty-state">Все заведённые игроки добавлены.</p>'
      : unselected.map((p) => `
          <div class="player-pick" data-add="${esc(p.id)}">
            <div class="order empty">+</div>
            <div class="name">${esc(p.name)}${p.accountUsername ? `<span class="account-pill">${esc(p.accountUsername)}</span>` : '<span class="account-pill guest">гость</span>'}</div>
          </div>
        `).join('');

    document.getElementById('startBtn').disabled = playerCount < 2;
    document.getElementById('countHint').textContent = `Игроков: ${playerCount}`;

    document.querySelectorAll('[data-add]').forEach((el) => el.addEventListener('click', () => {
      gameState.selectedOrder.push(el.dataset.add);
      refresh();
    }));
    document.querySelectorAll('[data-remove]').forEach((el) => el.addEventListener('click', () => {
      gameState.selectedOrder = gameState.selectedOrder.filter((x) => x !== el.dataset.remove);
      refresh();
    }));
    document.querySelectorAll('[data-up]').forEach((el) => el.addEventListener('click', () => {
      const i = gameState.selectedOrder.indexOf(el.dataset.up);
      if (i > 0) {
        [gameState.selectedOrder[i - 1], gameState.selectedOrder[i]] = [gameState.selectedOrder[i], gameState.selectedOrder[i - 1]];
        refresh();
      }
    }));
    document.querySelectorAll('[data-down]').forEach((el) => el.addEventListener('click', () => {
      const i = gameState.selectedOrder.indexOf(el.dataset.down);
      if (i >= 0 && i < gameState.selectedOrder.length - 1) {
        [gameState.selectedOrder[i + 1], gameState.selectedOrder[i]] = [gameState.selectedOrder[i], gameState.selectedOrder[i + 1]];
        refresh();
      }
    }));
  }

  app.innerHTML = `
    <a href="#/series/${esc(seriesId)}" class="back-link">← В серию</a>
    <h1>Новая игра</h1>
    <p class="muted">${esc(series.name || 'Серия от ' + fmtDateOnly(series.createdAt))}</p>

    <div class="card">
      <h2>Порядок игроков <span class="muted" id="countHint"></span></h2>
      <div id="selectedList"></div>
      <h3>Доступные</h3>
      <div id="unselectedList"></div>

      <div class="divider"></div>
      <label for="quickGuestName">Новый гость</label>
      <div class="row">
        <input type="text" id="quickGuestName" placeholder="Имя гостя" />
        <button class="shrink ghost" id="quickGuestBtn">Создать и добавить</button>
      </div>
    </div>

    <div class="card">
      <label for="targetVal">Шаров до победы</label>
      <div class="target-row">
        <input type="number" id="targetVal" min="1" max="15" value="${esc(gameState.target)}" />
        <div class="preset-row">
          ${[4, 5, 6, 7, 8].map((n) => `<button class="ghost small" data-target="${n}">${n}</button>`).join('')}
        </div>
      </div>
      <p class="muted">Обычный +1ш/+1о; дуплет +1ш/+2о; штаны +2ш/+3о; штраф −1о текущему и +1о предыдущему.</p>
    </div>

    <div class="button-row">
      <button id="startBtn">Начать игру</button>
      <a href="#/series/${esc(seriesId)}" class="btn ghost">Отмена</a>
    </div>
  `;
  refresh();

  document.getElementById('targetVal').addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    if (!Number.isNaN(v) && v > 0) {
      gameState.target = v;
      gameState.targetTouched = true;
    }
  });
  document.querySelectorAll('[data-target]').forEach((b) => {
    b.addEventListener('click', () => {
      gameState.target = parseInt(b.dataset.target, 10);
      gameState.targetTouched = true;
      document.getElementById('targetVal').value = gameState.target;
    });
  });

  document.getElementById('quickGuestBtn').addEventListener('click', async () => {
    const input = document.getElementById('quickGuestName');
    const name = input.value.trim();
    if (!name) return;
    const created = await api.post('/api/players', { name });
    players = await api.get('/api/players');
    const createdPlayer = players.find((p) => p.id === created.id) || players.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (createdPlayer && !gameState.selectedOrder.includes(createdPlayer.id)) gameState.selectedOrder.push(createdPlayer.id);
    input.value = '';
    refresh();
  });
  document.getElementById('quickGuestName').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('quickGuestBtn').click(); });

  document.getElementById('startBtn').addEventListener('click', async () => {
    const playersInGame = gameState.selectedOrder.map((pid) => {
      const p = players.find((x) => x.id === pid);
      return { id: p.id, name: p.name };
    });
    if (playersInGame.length < 2) return;
    const game = await api.post('/api/games', {
      seriesId,
      targetBalls: gameState.target,
      players: playersInGame,
      events: [],
      status: 'active',
    });
    await refreshActive();
    location.hash = `#/game/${game.id}`;
  });
}

async function renderLiveGame(match, token) {
  const id = match[1];
  let game = null;
  state.currentGameId = id;

  async function loadAndRender() {
    const fresh = await api.get(`/api/games/${id}`);
    if (token !== state.routeToken) return;
    if (!fresh || fresh.error) {
      app.innerHTML = '<p>Игра не найдена.</p>';
      return;
    }
    game = fresh;
    render();
  }

  state.reloadLiveGame = loadAndRender;
  await refreshActive();
  await loadAndRender();

  async function postGameEvent(type, playerId) {
    if (state.actionPending || !game || game.status === 'finished') return;
    state.actionPending = true;
    try {
      await api.post(`/api/games/${id}/events`, { type, playerId });
      await loadAndRender();
      await refreshActive();
    } catch (err) {
      handleActionError(err);
    } finally {
      state.actionPending = false;
    }
  }

  async function pushEvent(type) {
    const st = computeState(game);
    const currentPlayer = game.players[st.turnIdx];
    if (!currentPlayer) return;
    await postGameEvent(type, currentPlayer.id);
  }

  async function setTurn(playerId) {
    const st = computeState(game);
    const currentPlayer = game.players[st.turnIdx];
    if (!currentPlayer || currentPlayer.id === playerId) return;
    await postGameEvent('set_turn', playerId);
  }

  async function undoLast() {
    if (!game.events || game.events.length === 0) return;
    const events = game.events.slice(0, -1);
    try {
      await api.put(`/api/games/${id}`, {
        status: 'active',
        finishedAt: null,
        winnerId: null,
        pointsLeaderId: null,
        events,
      });
      await loadAndRender();
    } catch (err) {
      handleActionError(err);
    }
  }

  async function finishGame() {
    const st = computeState(game);
    const winner = st.firstWinner || st.winner;
    try {
      await api.put(`/api/games/${id}`, {
        status: 'finished',
        finishedAt: new Date().toISOString(),
        winnerId: winner ? winner.id : null,
        pointsLeaderId: st.pointsLeader ? st.pointsLeader.id : null,
        finalScores: st.scores,
      });
      await refreshActive();
      location.hash = `#/games/${id}`;
    } catch (err) {
      handleActionError(err);
    }
  }

  async function endGame() {
    if (!confirm('Завершить игру досрочно? Победителем будет лидер по шарам.')) return;
    const st = computeState(game);
    const leader = [...game.players].sort((a, b) => st.scores[b.id].balls - st.scores[a.id].balls)[0];
    try {
      await api.put(`/api/games/${id}`, {
        status: 'finished',
        finishedAt: new Date().toISOString(),
        winnerId: leader ? leader.id : null,
        pointsLeaderId: st.pointsLeader ? st.pointsLeader.id : null,
        finalScores: st.scores,
      });
      await refreshActive();
      location.hash = `#/games/${id}`;
    } catch (err) {
      handleActionError(err);
    }
  }

  function renderEventLog(st) {
    const n = game.players.length;
    if (!game.events || game.events.length === 0) return '<p class="empty-state">Пусто.</p>';
    return [...game.events].reverse().map((ev) => {
      const p = game.players.find((x) => x.id === ev.playerId);
      const def = EVENT_DEFS[ev.type];
      return `
        <div class="item">
          <span class="who">${esc(p ? p.name : '?')}</span>
          <span class="what">${esc(def ? def.label : ev.type)}</span>
          <span class="delta">${esc(eventDelta(def, n))}</span>
        </div>
      `;
    }).join('');
  }

  function render() {
    const st = computeState(game);
    const n = game.players.length;
    const access = accessForGame(game);
    const canControl = access.canControl;
    const isFinished = game.status === 'finished';
    const prevName = st.prevPlayer ? st.prevPlayer.name : null;
    const firstWinner = st.firstWinner || (game.winnerId ? game.players.find((p) => p.id === game.winnerId) : null);

    app.innerHTML = `
      <a href="${game.seriesId ? '#/series/' + esc(game.seriesId) : '#/'}" class="back-link">← ${game.seriesId ? 'В серию' : 'Главная'}</a>
      <div class="live-top">
        <h1>${isFinished ? 'Игра завершена' : 'Игра идёт'}</h1>
        <span class="muted">до ${esc(game.targetBalls)} · ${fmtDate(game.createdAt)}</span>
      </div>

      ${!isFinished && !canControl ? `
        <div class="notice info">
          <strong>Только просмотр</strong>
          <p class="muted">${access.myPlayerId ? 'Вы не в составе этой игры.' : 'Ваш аккаунт не привязан к игроку в этой игре.'} Счёт обновляется автоматически.</p>
        </div>
      ` : ''}

      ${!isFinished && (firstWinner || st.allBallsGone) ? `
        <div class="notice success">
          <div>
            ${firstWinner ? `<strong>🏆 ${esc(firstWinner.name)} набрал ${esc(game.targetBalls)} шаров</strong>` : '<strong>Все шары забиты</strong>'}
            <p class="muted">${st.allBallsGone ? 'Все шары забиты.' : 'Игра продолжается — можно добить оставшиеся шары.'}</p>
          </div>
          ${canControl ? '<button id="finishBtn">Завершить партию</button>' : '<span class="tag">ожидаем игрока</span>'}
        </div>
      ` : ''}

      ${!isFinished && st.isGoldenPhase ? `
        <div class="notice gold">
          <strong>Золотой шар</strong>
          <p class="muted">На столе остался последний прицельный шар.</p>
        </div>
      ` : ''}

      ${!isFinished ? `<p class="muted">Минус/плюс полетит предыдущему игроку: <strong>${esc(prevName || '—')}</strong></p>` : ''}

      <div id="playersWrap">
        ${game.players.map((p, i) => {
          const s = st.scores[p.id];
          const isTurn = !isFinished && i === st.turnIdx;
          const isWin = isFinished && p.id === game.winnerId;
          const isFirstWin = !isFinished && firstWinner && p.id === firstWinner.id;
          const isPtsLeader = st.pointsLeader && st.pointsLeader.id === p.id;
          return `
            <div class="player-card ${isTurn ? 'active' : ''} ${isWin || isFirstWin ? 'win' : ''} ${canControl ? 'clickable' : ''}" ${canControl ? `data-pick="${esc(p.id)}"` : ''}>
              <div class="head">
                <div class="name">
                  ${esc(p.name)}
                  ${isWin || isFirstWin ? ' 🏆' : ''}
                  ${isPtsLeader ? '<span class="pts-leader">🥇 лидер по очкам</span>' : ''}
                </div>
                ${isTurn ? '<span class="turn-badge">ход</span>' : ''}
              </div>
              <div class="stats">
                <div class="balls">${s.balls}<span class="target">/${esc(game.targetBalls)}</span></div>
                <div class="points">${signed(s.points)} очк.</div>
                ${s.duraks > 0 ? `<div class="duraks">🤡 ${s.duraks}</div>` : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>

      ${!isFinished && canControl ? `
        <p class="muted small-note">Тапни по игроку, чтобы передать ему ход.</p>

        ${st.allBallsGone ? '' : st.isGoldenPhase ? `
          <div class="action-grid">
            <button data-ev="golden_regular" class="wide">Золотой шар<span class="hint">+1ш +${n}о / пред. −2о / ост. −1о</span></button>
            <button data-ev="golden_duplet">Золотой дуплет<span class="hint">+1ш +${n + 1}о / пред. −3о / ост. −1о</span></button>
            <button data-ev="golden_pants">Золотые штаны<span class="hint">+2ш +${n + 2}о / пред. −4о / ост. −1о</span></button>
            <button data-ev="penalty" class="danger">Штраф<span class="hint">−1о текущему, +1о предыдущему</span></button>
            <button data-ev="miss" class="ghost">Промах<span class="hint">ход переходит</span></button>
          </div>
        ` : `
          <div class="action-grid">
            <button data-ev="pocket_regular">Обычный<span class="hint">+1ш +1о / пред. −1о</span></button>
            <button data-ev="pocket_durak">Дурак<span class="hint">+1ш +1о / пред. −1о</span></button>
            <button data-ev="pocket_duplet">Дуплет<span class="hint">+1ш +2о / пред. −2о</span></button>
            <button data-ev="pocket_pants">Штаны<span class="hint">+2ш +3о / пред. −3о</span></button>
            <button data-ev="penalty" class="danger">Штраф<span class="hint">−1о текущему, +1о предыдущему</span></button>
            <button data-ev="miss" class="ghost">Промах<span class="hint">ход переходит</span></button>
          </div>
        `}

        <div class="game-actions">
          <button class="ghost" id="undoBtn" ${(game.events || []).length === 0 ? 'disabled' : ''}>↶ Отменить</button>
          ${!firstWinner && !st.isGoldenPhase && !st.allBallsGone ? '<button class="ghost" id="endBtn">Завершить досрочно</button>' : ''}
        </div>
      ` : ''}

      <h2>Лог ходов (${(game.events || []).length})</h2>
      <div class="card event-log">${renderEventLog(st)}</div>

      ${isFinished ? `
        <dialog class="win-screen" id="winDlg">
          <h2>🏆 Победа по шарам</h2>
          <div class="winner">${esc((game.players.find((p) => p.id === game.winnerId) || {}).name || '')}</div>
          ${game.pointsLeaderId && game.pointsLeaderId !== game.winnerId ? `
            <p>🥇 Лидер по очкам: <strong>${esc((game.players.find((p) => p.id === game.pointsLeaderId) || {}).name || '')}</strong></p>
          ` : ''}
          <p class="muted">Игра сохранена.</p>
          <div class="button-row">
            ${game.seriesId ? '<button id="dlgSeriesBtn">К серии</button>' : ''}
            <button class="ghost" id="dlgHomeBtn">На главную</button>
          </div>
        </dialog>
      ` : ''}
    `;

    document.querySelectorAll('[data-ev]').forEach((b) => b.addEventListener('click', () => pushEvent(b.dataset.ev)));
    document.querySelectorAll('[data-pick]').forEach((el) => el.addEventListener('click', () => setTurn(el.dataset.pick)));
    const undoBtn = document.getElementById('undoBtn'); if (undoBtn) undoBtn.addEventListener('click', undoLast);
    const endBtn = document.getElementById('endBtn'); if (endBtn) endBtn.addEventListener('click', endGame);
    const finishBtn = document.getElementById('finishBtn'); if (finishBtn) finishBtn.addEventListener('click', finishGame);
    const dlgSeriesBtn = document.getElementById('dlgSeriesBtn'); if (dlgSeriesBtn) dlgSeriesBtn.addEventListener('click', () => { location.hash = `#/series/${game.seriesId}`; });
    const dlgHomeBtn = document.getElementById('dlgHomeBtn'); if (dlgHomeBtn) dlgHomeBtn.addEventListener('click', () => { location.hash = '#/'; });
    const dlg = document.getElementById('winDlg'); if (dlg && typeof dlg.showModal === 'function') dlg.showModal();
  }
}

async function renderHistory() {
  const [series, games] = await Promise.all([api.get('/api/series'), api.get('/api/games')]);
  const orphan = games.filter((g) => !g.seriesId);
  app.innerHTML = `
    <a href="#/" class="back-link">← Главная</a>
    <h1>История</h1>
    <h2>Серии (${series.length})</h2>
    ${series.length === 0 ? '<p class="empty-state">Пусто.</p>' :
      series.map((s) => seriesRowHTML(s, games.filter((g) => g.seriesId === s.id).length)).join('')}
    ${orphan.length > 0 ? `<h2>Игры без серии (${orphan.length})</h2>${orphan.map(gameRowHTML).join('')}` : ''}
  `;
}

async function renderGameDetail(match) {
  const id = match[1];
  const game = await api.get(`/api/games/${id}`);
  if (!game || game.error) { app.innerHTML = '<p>Игра не найдена.</p>'; return; }
  const st = computeState(game);
  const winner = game.players.find((p) => p.id === game.winnerId);
  const pointsLeader = game.players.find((p) => p.id === game.pointsLeaderId);
  const duration = game.finishedAt ? fmtDuration(game.createdAt, game.finishedAt) : null;

  app.innerHTML = `
    <a href="${game.seriesId ? '#/series/' + esc(game.seriesId) : '#/history'}" class="back-link">← Назад</a>
    <h1>${winner ? '🏆 ' + esc(winner.name) : 'Игра'}</h1>
    ${pointsLeader && (!winner || pointsLeader.id !== winner.id) ? `<p>🥇 Лидер по очкам: <strong>${esc(pointsLeader.name)}</strong></p>` : ''}
    <p class="muted">${fmtDate(game.createdAt)} · до ${esc(game.targetBalls)} шаров ${duration ? '· ' + duration : ''}</p>

    <div id="playersWrap">
      ${game.players.map((p) => {
        const s = (game.finalScores && game.finalScores[p.id]) || st.scores[p.id];
        const isWin = p.id === game.winnerId;
        const isPL = p.id === game.pointsLeaderId;
        return `
          <div class="player-card ${isWin ? 'win' : ''}">
            <div class="head">
              <div class="name">${esc(p.name)}${isWin ? ' 🏆' : ''}${isPL && !isWin ? ' 🥇' : ''}</div>
            </div>
            <div class="stats">
              <div class="balls">${s.balls}<span class="target">/${esc(game.targetBalls)}</span></div>
              <div class="points">${signed(s.points)} очк.</div>
              ${s.duraks > 0 ? `<div class="duraks">🤡 ${s.duraks}</div>` : ''}
            </div>
          </div>
        `;
      }).join('')}
    </div>

    <h2>Лог ходов (${(game.events || []).length})</h2>
    <div class="card event-log">
      ${(!game.events || game.events.length === 0) ? '<p class="empty-state">Пусто.</p>' :
        [...game.events].reverse().map((ev) => {
          const p = game.players.find((x) => x.id === ev.playerId);
          const def = EVENT_DEFS[ev.type];
          return `
            <div class="item">
              <span class="who">${esc(p ? p.name : '?')}</span>
              <span class="what">${esc(def ? def.label : ev.type)}</span>
              <span class="delta">${esc(eventDelta(def, game.players.length))}</span>
            </div>
          `;
        }).join('')}
    </div>

    <div class="danger-zone">
      <button class="ghost danger" id="delBtn">Удалить игру</button>
    </div>
  `;
  document.getElementById('delBtn').addEventListener('click', async () => {
    if (!confirm('Удалить игру навсегда?')) return;
    await api.del(`/api/games/${id}`);
    await refreshActive();
    location.hash = game.seriesId ? `#/series/${game.seriesId}` : '#/history';
  });
}
