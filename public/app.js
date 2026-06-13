// Ташкент — учёт игр

const api = {
  async get(url) { const r = await fetch(url); return r.json(); },
  async post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return r.json();
  },
  async put(url, body) {
    const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return r.json();
  },
  async del(url) { await fetch(url, { method: 'DELETE' }); },
};

// balls — счётчик победы; points — очки текущему; prevDelta — что прилетает предыдущему игроку (последнему забившему)
const EVENT_DEFS = {
  pocket_regular: { label: 'Обычный',       balls: 1, points: 1,  prevDelta: -1, keepTurn: true,  isPocket: true,  isDurak: false, isGolden: false },
  pocket_duplet:  { label: 'Дуплет',        balls: 1, points: 2,  prevDelta: -2, keepTurn: true,  isPocket: true,  isDurak: false, isGolden: false },
  pocket_pants:   { label: 'Штаны',         balls: 2, points: 3,  prevDelta: -3, keepTurn: true,  isPocket: true,  isDurak: false, isGolden: false },
  pocket_durak:   { label: 'Дурак',         balls: 1, points: 1,  prevDelta: -1, keepTurn: true,  isPocket: true,  isDurak: true,  isGolden: false },
  penalty:        { label: 'Штраф',         balls: 0, points: -1, prevDelta:  1, keepTurn: false, isPocket: false, isDurak: false, isGolden: false },
  miss:           { label: 'Промах',        balls: 0, points: 0,  prevDelta:  0, keepTurn: false, isPocket: false, isDurak: false, isGolden: false },
  set_turn:       { label: 'Передача хода', balls: 0, points: 0,  prevDelta:  0, keepTurn: true,  isPocket: false, isDurak: false, isGolden: false },
  // Golden ball events — points computed dynamically based on player count (N+tier)
  golden_regular: { label: '🥇 Золотой шар',    balls: 1, points: 0, prevDelta: 0, keepTurn: true, isPocket: true,  isDurak: false, isGolden: true, goldenTier: 0 },
  golden_duplet:  { label: '🥇 Золотой дуплет', balls: 1, points: 0, prevDelta: 0, keepTurn: true, isPocket: true,  isDurak: false, isGolden: true, goldenTier: 1 },
  golden_pants:   { label: '🥇 Золотые штаны',  balls: 2, points: 0, prevDelta: 0, keepTurn: true, isPocket: true,  isDurak: false, isGolden: true, goldenTier: 2 },
};

function fmtDate(iso) {
  return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function fmtDateOnly(iso) {
  return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' });
}
function fmtDuration(startIso, endIso) {
  const ms = new Date(endIso) - new Date(startIso);
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}ч ${m % 60}м` : `${m}м`;
}

function prevIndex(idx, n) { return (idx - 1 + n) % n; }

function computeState(game) {
  const scores = {};
  game.players.forEach((p) => { scores[p.id] = { balls: 0, points: 0, duraks: 0 }; });
  let turnIdx = 0;
  const n = game.players.length;
  for (const ev of game.events) {
    const def = EVENT_DEFS[ev.type];
    if (!def) continue;
    const idx = game.players.findIndex((p) => p.id === ev.playerId);
    if (idx < 0) continue;
    const s = scores[ev.playerId];
    if (def.isGolden) {
      // Points: +N+tier to current; -(2+tier) to prev; -1 to each remaining
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
      s.points = s.points + def.points;
      if (def.isDurak) s.duraks += 1;
      if (def.prevDelta && n > 1) {
        const prevId = game.players[prevIndex(idx, n)].id;
        if (prevId !== ev.playerId) scores[prevId].points += def.prevDelta;
      }
      turnIdx = def.keepTurn ? idx : (idx + 1) % n;
    }
  }
  const winner = game.players.find((p) => scores[p.id].balls >= game.targetBalls) || null;
  let pointsLeader = null;
  let maxPts = -Infinity;
  for (const p of game.players) {
    if (scores[p.id].points > maxPts) { maxPts = scores[p.id].points; pointsLeader = p; }
  }
  const tiedTop = game.players.filter((p) => scores[p.id].points === maxPts);
  if (tiedTop.length > 1) pointsLeader = null;
  const prevPlayer = n > 0 ? game.players[prevIndex(turnIdx, n)] : null;
  return { scores, turnIdx, winner, pointsLeader, prevPlayer };
}

function seriesTotals(series, games) {
  const seriesGames = games.filter((g) => g.seriesId === series.id);
  const finished = seriesGames.filter((g) => g.status === 'finished');
  const totals = new Map(); // playerId -> {name, wins, pointsLeads, totalPoints, totalBalls, gamesPlayed}
  for (const g of finished) {
    for (const p of g.players) {
      if (!totals.has(p.id)) totals.set(p.id, { id: p.id, name: p.name, wins: 0, pointsLeads: 0, totalPoints: 0, totalBalls: 0, totalDuraks: 0, gamesPlayed: 0 });
      const t = totals.get(p.id);
      t.gamesPlayed++;
      if (g.winnerId === p.id) t.wins++;
      if (g.pointsLeaderId === p.id) t.pointsLeads++;
      const s = (g.finalScores && g.finalScores[p.id]) || { balls: 0, points: 0, duraks: 0 };
      t.totalPoints += s.points;
      t.totalBalls += s.balls;
      t.totalDuraks += (s.duraks || 0);
    }
  }
  const arr = [...totals.values()];
  let winsChampion = null, pointsChampion = null;
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

// ---------- Router ----------
const app = document.getElementById('app');

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
  const hash = location.hash || '#/';
  for (const r of routes) {
    const m = hash.match(r.match);
    if (m) {
      app.innerHTML = '<p class="muted">Загрузка…</p>';
      try { await r.render(m); } catch (e) { app.innerHTML = `<p class="muted">Ошибка: ${e.message}</p>`; console.error(e); }
      return;
    }
  }
  app.innerHTML = '<p>Не найдено</p>';
}
window.addEventListener('hashchange', route);
window.addEventListener('load', route);

// ---------- Helpers ----------
function badge(text, cls = '') { return `<span class="tag ${cls}">${text}</span>`; }

function gameRowHTML(g) {
  const winner = g.winnerId ? g.players.find((p) => p.id === g.winnerId) : null;
  const pointsLeader = g.pointsLeaderId ? g.players.find((p) => p.id === g.pointsLeaderId) : null;
  const status = g.status === 'active'
    ? '<span class="tag">идёт</span>'
    : `${winner ? `<span class="winner-badge">🏆 ${winner.name}</span>` : '<span class="tag">завершено</span>'}${pointsLeader && (!winner || pointsLeader.id !== winner.id) ? ` <span class="winner-badge points">🥇 ${pointsLeader.name}</span>` : ''}`;
  const route = g.status === 'active' ? `#/game/${g.id}` : `#/games/${g.id}`;
  return `
    <a href="${route}" style="text-decoration:none;color:inherit;">
      <div class="game-row">
        <div>
          <div class="title">${g.players.map((p) => p.name).join(' · ')}</div>
          <div class="meta">${fmtDate(g.createdAt)} · до ${g.targetBalls}</div>
        </div>
        <div>${status}</div>
      </div>
    </a>
  `;
}

function seriesRowHTML(s, gamesCount) {
  const status = s.status === 'active' ? '<span class="tag active">идёт</span>' : '<span class="tag">завершена</span>';
  return `
    <a href="#/series/${s.id}" style="text-decoration:none;color:inherit;">
      <div class="game-row">
        <div>
          <div class="title">${s.name || 'Серия от ' + fmtDateOnly(s.createdAt)}</div>
          <div class="meta">${fmtDate(s.createdAt)}${s.finishedAt ? ' → ' + fmtDate(s.finishedAt) : ''} · игр: ${gamesCount}</div>
        </div>
        <div>${status}</div>
      </div>
    </a>
  `;
}

// ---------- Views ----------

async function renderHome() {
  const [series, games] = await Promise.all([api.get('/api/series'), api.get('/api/games')]);
  const active = series.filter((s) => s.status === 'active');
  const finished = series.filter((s) => s.status === 'finished').slice(0, 5);
  const orphanGames = games.filter((g) => !g.seriesId).slice(0, 5);

  app.innerHTML = `
    <h1>🎱 Ташкент</h1>
    <p>Игры группируются в серии. После серии — общий зачёт.</p>

    <div class="card">
      <a href="#/new-series" class="btn">+ Новая серия</a>
      <a href="#/players" class="btn ghost" style="margin-left: 8px;">Игроки</a>
      <a href="#/history" class="btn ghost" style="margin-left: 8px;">История</a>
    </div>

    ${active.length > 0 ? `
      <h2>Активные серии</h2>
      ${active.map((s) => seriesRowHTML(s, games.filter((g) => g.seriesId === s.id).length)).join('')}
    ` : ''}

    ${finished.length > 0 ? `
      <h2>Недавние серии</h2>
      ${finished.map((s) => seriesRowHTML(s, games.filter((g) => g.seriesId === s.id).length)).join('')}
    ` : ''}

    ${orphanGames.length > 0 ? `
      <h2>Игры без серии</h2>
      ${orphanGames.map(gameRowHTML).join('')}
    ` : ''}

    ${series.length === 0 && orphanGames.length === 0 ? '<p class="muted">Пока ничего нет. Создай первую серию.</p>' : ''}
  `;
}

async function renderPlayers() {
  const players = await api.get('/api/players');
  app.innerHTML = `
    <h1>Игроки</h1>
    <div class="card">
      <label>Добавить игрока</label>
      <div class="row">
        <input type="text" id="newPlayerName" placeholder="Имя" />
        <button id="addPlayerBtn" style="flex:0 0 auto;">Добавить</button>
      </div>
    </div>
    <h2>Все игроки (${players.length})</h2>
    <div class="stack">
      ${players.length === 0 ? '<p class="muted">Никого нет. Добавь первого.</p>' :
        players.map((p) => `
          <div class="card" style="margin-bottom:0; display:flex; justify-content:space-between; align-items:center;">
            <div>
              <div style="font-weight:600;">${p.name}</div>
              <div class="muted">с ${fmtDate(p.createdAt)}</div>
            </div>
            <button class="ghost small" data-del="${p.id}">Удалить</button>
          </div>
        `).join('')}
    </div>
  `;
  const input = document.getElementById('newPlayerName');
  document.getElementById('addPlayerBtn').addEventListener('click', async () => {
    const name = input.value.trim();
    if (!name) return;
    await api.post('/api/players', { name });
    route();
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('addPlayerBtn').click(); });
  document.querySelectorAll('[data-del]').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!confirm('Удалить игрока? История игр сохранится.')) return;
      await api.del(`/api/players/${b.dataset.del}`);
      route();
    });
  });
}

async function renderNewSeries() {
  app.innerHTML = `
    <a href="#/" class="muted">← Главная</a>
    <h1>Новая серия</h1>
    <div class="card">
      <label>Название (необязательно)</label>
      <input type="text" id="seriesName" placeholder="Серия от ${fmtDateOnly(new Date().toISOString())}" />
      <p class="muted" style="margin-top:8px;">Если оставить пустым — поставлю дату.</p>
    </div>
    <button id="createBtn">Создать и начать первую игру</button>
    <a href="#/" class="btn ghost" style="margin-left:8px;">Отмена</a>
  `;
  document.getElementById('createBtn').addEventListener('click', async () => {
    const name = document.getElementById('seriesName').value.trim();
    const s = await api.post('/api/series', { name: name || null });
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
    <a href="#/" class="muted">← Главная</a>
    <h1>${series.name || 'Серия от ' + fmtDateOnly(series.createdAt)}</h1>
    <p class="muted">${fmtDate(series.createdAt)}${series.finishedAt ? ' → завершена ' + fmtDate(series.finishedAt) : ''} · игр: ${seriesGames.length}</p>

    ${isActive ? `
      <div class="card">
        <a href="#/new-game/${id}" class="btn">+ Новая игра в серии</a>
        <button class="ghost" id="endSeriesBtn" style="margin-left:8px;">Завершить серию</button>
      </div>
    ` : ''}

    ${sortedTotals.length > 0 ? `
      <h2>${isActive ? 'Текущий зачёт' : '🏆 Итоги серии'}</h2>
      <div class="card totals-card">
        <table class="totals">
          <thead><tr><th>Игрок</th><th>Побед</th><th>Лидер по очкам</th><th>Очков всего</th><th>Шаров всего</th><th>Дураков</th></tr></thead>
          <tbody>
            ${sortedTotals.map((t) => `
              <tr>
                <td>
                  ${t.name}
                  ${winsChampion && winsChampion.id === t.id ? '<span class="champ-tag wins">🏆 чемпион по победам</span>' : ''}
                  ${pointsChampion && pointsChampion.id === t.id ? '<span class="champ-tag points">🥇 чемпион по очкам</span>' : ''}
                </td>
                <td>${t.wins}</td>
                <td>${t.pointsLeads}</td>
                <td>${t.totalPoints >= 0 ? '+' : ''}${t.totalPoints}</td>
                <td>${t.totalBalls}</td>
                <td>${t.totalDuraks}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        ${!isActive && (!winsChampion || !pointsChampion) ? '<p class="muted" style="margin-top:10px;">Где не выделен чемпион — ничья.</p>' : ''}
      </div>
    ` : ''}

    <h2>Игры в серии</h2>
    ${seriesGames.length === 0 ? '<p class="muted">Игр пока нет.</p>' :
      seriesGames.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).map(gameRowHTML).join('')}

    <div class="spacer"></div>
    <button class="ghost danger" id="delSeriesBtn">Удалить серию</button>
  `;

  if (isActive) {
    document.getElementById('endSeriesBtn').addEventListener('click', async () => {
      const unfinished = seriesGames.some((g) => g.status === 'active');
      if (unfinished && !confirm('В серии есть незавершённые игры. Всё равно закрыть серию?')) return;
      if (!confirm('Завершить серию и зафиксировать итоги?')) return;
      await api.put(`/api/series/${id}`, { status: 'finished', finishedAt: new Date().toISOString() });
      route();
    });
  }
  document.getElementById('delSeriesBtn').addEventListener('click', async () => {
    if (!confirm('Удалить серию? Игры останутся в общем списке без серии.')) return;
    await api.del(`/api/series/${id}`);
    location.hash = '#/';
  });
}

async function renderNewGame(match) {
  const seriesId = match[1];
  const [players, allGames, series] = await Promise.all([api.get('/api/players'), api.get('/api/games'), api.get(`/api/series/${seriesId}`)]);
  if (!series || series.error) { app.innerHTML = '<p>Серия не найдена.</p>'; return; }

  // дефолты по последней игре серии
  const prevGames = allGames.filter((g) => g.seriesId === seriesId).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const prevGame = prevGames[0];
  const state = {
    selectedOrder: prevGame ? prevGame.players.map((p) => p.id).filter((id) => players.find((x) => x.id === id)) : [],
    target: prevGame ? prevGame.targetBalls : 6,
    targetTouched: !!prevGame,
  };

  function refresh() {
    const selectedSet = new Set(state.selectedOrder);
    const orderedSelected = state.selectedOrder.map((id) => players.find((p) => p.id === id)).filter(Boolean);
    const unselected = players.filter((p) => !selectedSet.has(p.id));
    const N = orderedSelected.length;
    const defaultTarget = N <= 2 ? 8 : N === 3 ? 6 : N === 4 ? 5 : 4;
    if (!state.targetTouched) { state.target = defaultTarget; document.getElementById('targetVal').value = state.target; }

    document.getElementById('selectedList').innerHTML = orderedSelected.length === 0
      ? '<p class="muted">Никто не выбран. Тыкни ниже.</p>'
      : orderedSelected.map((p, i) => `
          <div class="player-pick selected">
            <div class="order">${i + 1}</div>
            <div class="name">${p.name}</div>
            <div class="move">
              <button class="ghost small" data-up="${p.id}" ${i === 0 ? 'disabled' : ''}>↑</button>
              <button class="ghost small" data-down="${p.id}" ${i === orderedSelected.length - 1 ? 'disabled' : ''}>↓</button>
              <button class="ghost small" data-remove="${p.id}">✕</button>
            </div>
          </div>
        `).join('');

    document.getElementById('unselectedList').innerHTML = unselected.length === 0
      ? '<p class="muted">Все игроки добавлены. <a href="#/players">Завести нового</a>.</p>'
      : unselected.map((p) => `
          <div class="player-pick" data-add="${p.id}">
            <div class="order empty">+</div>
            <div class="name">${p.name}</div>
          </div>
        `).join('');

    document.getElementById('startBtn').disabled = N < 2;
    document.getElementById('countHint').textContent = `Игроков: ${N}`;

    document.querySelectorAll('[data-add]').forEach((el) => el.addEventListener('click', () => { state.selectedOrder.push(el.dataset.add); refresh(); }));
    document.querySelectorAll('[data-remove]').forEach((el) => el.addEventListener('click', () => { state.selectedOrder = state.selectedOrder.filter((x) => x !== el.dataset.remove); refresh(); }));
    document.querySelectorAll('[data-up]').forEach((el) => el.addEventListener('click', () => {
      const i = state.selectedOrder.indexOf(el.dataset.up);
      if (i > 0) { [state.selectedOrder[i-1], state.selectedOrder[i]] = [state.selectedOrder[i], state.selectedOrder[i-1]]; refresh(); }
    }));
    document.querySelectorAll('[data-down]').forEach((el) => el.addEventListener('click', () => {
      const i = state.selectedOrder.indexOf(el.dataset.down);
      if (i >= 0 && i < state.selectedOrder.length - 1) { [state.selectedOrder[i+1], state.selectedOrder[i]] = [state.selectedOrder[i], state.selectedOrder[i+1]]; refresh(); }
    }));
  }

  app.innerHTML = `
    <a href="#/series/${seriesId}" class="muted">← В серию</a>
    <h1>Новая игра</h1>
    <p class="muted">${series.name || 'Серия от ' + fmtDateOnly(series.createdAt)}</p>

    <div class="card">
      <h3>Порядок игроков <span class="muted" id="countHint"></span></h3>
      <div id="selectedList"></div>
      <h3 style="margin-top:16px;">Доступные</h3>
      <div id="unselectedList"></div>
      <div style="margin-top:12px;">
        <a href="#/players" class="muted">+ Завести нового игрока</a>
      </div>
    </div>

    <div class="card">
      <label>Шаров до победы</label>
      <div class="row" style="align-items:stretch;">
        <input type="number" id="targetVal" min="1" max="15" value="${state.target}" />
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          ${[4, 5, 6, 7, 8].map((n) => `<button class="ghost small" data-target="${n}">${n}</button>`).join('')}
        </div>
      </div>
      <p class="muted" style="margin-top:8px;">Обычный +1ш/+1о (предыдущему −1о); Дуплет +1ш/+2о (−2о); Штаны +2ш/+3о (−3о); Штраф −1о текущему / +1о предыдущему.</p>
    </div>

    <button id="startBtn">Начать игру</button>
    <a href="#/series/${seriesId}" class="btn ghost" style="margin-left:8px;">Отмена</a>
  `;
  refresh();

  document.getElementById('targetVal').addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    if (!isNaN(v) && v > 0) { state.target = v; state.targetTouched = true; }
  });
  document.querySelectorAll('[data-target]').forEach((b) => {
    b.addEventListener('click', () => {
      state.target = parseInt(b.dataset.target, 10);
      state.targetTouched = true;
      document.getElementById('targetVal').value = state.target;
    });
  });

  document.getElementById('startBtn').addEventListener('click', async () => {
    const playersInGame = state.selectedOrder.map((id) => {
      const p = players.find((x) => x.id === id);
      return { id: p.id, name: p.name };
    });
    if (playersInGame.length < 2) return;
    const game = await api.post('/api/games', {
      seriesId,
      targetBalls: state.target,
      players: playersInGame,
      events: [],
      status: 'active',
    });
    location.hash = `#/game/${game.id}`;
  });
}

async function renderLiveGame(match) {
  const id = match[1];
  let game = await api.get(`/api/games/${id}`);
  if (!game || game.error) { app.innerHTML = '<p>Игра не найдена.</p>'; return; }

  async function persist() { game = await api.put(`/api/games/${id}`, game); }

  async function pushEvent(type) {
    if (game.status === 'finished') return;
    const st = computeState(game);
    const currentPlayer = game.players[st.turnIdx];
    game.events.push({ type, playerId: currentPlayer.id, ts: new Date().toISOString() });
    // Record the first player to reach targetBalls, but don't auto-finish
    if (!game.firstWinnerId) {
      const newSt = computeState(game);
      if (newSt.winner) game.firstWinnerId = newSt.winner.id;
    }
    await persist();
    render();
  }

  async function setTurn(playerId) {
    if (game.status === 'finished') return;
    const st = computeState(game);
    if (game.players[st.turnIdx].id === playerId) return;
    game.events.push({ type: 'set_turn', playerId, ts: new Date().toISOString() });
    await persist();
    render();
  }

  async function undoLast() {
    if (game.events.length === 0) return;
    game.events.pop();
    if (game.status === 'finished') {
      game.status = 'active';
      game.finishedAt = null;
      game.winnerId = null;
      game.pointsLeaderId = null;
      game.finalScores = null;
    }
    if (game.firstWinnerId && !computeState(game).winner) game.firstWinnerId = null;
    await persist();
    render();
  }

  async function finishGame() {
    const st = computeState(game);
    game.status = 'finished';
    game.finishedAt = new Date().toISOString();
    game.winnerId = game.firstWinnerId || (st.winner ? st.winner.id : null);
    game.pointsLeaderId = st.pointsLeader ? st.pointsLeader.id : null;
    game.finalScores = st.scores;
    await persist();
    location.hash = `#/games/${id}`;
  }

  async function endGame() {
    if (!confirm('Завершить игру досрочно? Победителем будет лидер по шарам.')) return;
    const st = computeState(game);
    const leader = [...game.players].sort((a, b) => st.scores[b.id].balls - st.scores[a.id].balls)[0];
    game.status = 'finished';
    game.finishedAt = new Date().toISOString();
    game.winnerId = leader ? leader.id : null;
    game.pointsLeaderId = st.pointsLeader ? st.pointsLeader.id : null;
    game.finalScores = st.scores;
    await persist();
    location.hash = `#/games/${id}`;
  }

  function render() {
    const st = computeState(game);
    const n = game.players.length;
    const isFinished = game.status === 'finished';
    const prevName = st.prevPlayer ? st.prevPlayer.name : null;
    const firstWinner = game.firstWinnerId ? game.players.find((p) => p.id === game.firstWinnerId) : null;
    const totalBalls = game.players.reduce((sum, p) => sum + st.scores[p.id].balls, 0);
    const isGoldenPhase = totalBalls === 14;
    const allBallsGone = totalBalls >= 15;

    app.innerHTML = `
      <a href="${game.seriesId ? '#/series/' + game.seriesId : '#/'}" class="muted">← ${game.seriesId ? 'В серию' : 'Главная'}</a>
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
        <h1 style="margin-right:auto;">${isFinished ? 'Игра завершена' : 'Игра идёт'}</h1>
        <span class="muted">до ${game.targetBalls} · ${fmtDate(game.createdAt)}</span>
      </div>

      ${!isFinished && (firstWinner || allBallsGone) ? `
        <div class="card" style="border:2px solid #4a9a4a; margin-bottom:12px; padding:14px 16px;">
          ${firstWinner ? `<div style="font-size:17px; font-weight:700; margin-bottom:6px;">🏆 ${firstWinner.name} набрал ${game.targetBalls} шаров!</div>` : ''}
          <p class="muted" style="margin:0 0 12px; font-size:13px;">${allBallsGone ? 'Все шары забиты.' : 'Игра продолжается — можно добить оставшиеся шары.'}</p>
          <button id="finishBtn">Завершить партию</button>
        </div>
      ` : ''}

      ${!isFinished && isGoldenPhase ? `
        <div class="card" style="border:2px solid #c9a227; margin-bottom:12px; padding:10px 14px; background:rgba(201,162,39,0.07);">
          <div style="font-size:14px; font-weight:700; color:#c9a227; margin-bottom:4px;">🥇 ЗОЛОТОЙ ШАР — последний прицельный на столе!</div>
        </div>
      ` : ''}

      ${!isFinished ? `<p class="muted" style="margin-top:0;">Минус/плюс полетит предыдущему игроку: <strong>${prevName || '—'}</strong></p>` : ''}

      <div id="playersWrap">
        ${game.players.map((p, i) => {
          const s = st.scores[p.id];
          const isTurn = !isFinished && i === st.turnIdx;
          const isWin = isFinished && p.id === game.winnerId;
          const isFirstWin = !isFinished && p.id === game.firstWinnerId;
          const isPtsLeader = st.pointsLeader && st.pointsLeader.id === p.id;
          return `
            <div class="player-card ${isTurn ? 'active' : ''} ${isWin || isFirstWin ? 'win' : ''} ${!isFinished ? 'clickable' : ''}" ${!isFinished ? `data-pick="${p.id}"` : ''}>
              <div class="head">
                <div class="name">
                  ${p.name}
                  ${isWin || isFirstWin ? '🏆' : ''}
                  ${isPtsLeader ? '<span class="pts-leader">🥇 лидер по очкам</span>' : ''}
                </div>
                ${isTurn ? '<span class="turn-badge">ход</span>' : ''}
              </div>
              <div class="stats">
                <div class="balls">${s.balls}<span class="target">/${game.targetBalls}</span></div>
                <div class="points">${s.points >= 0 ? '+' : ''}${s.points} очк.</div>
                ${s.duraks > 0 ? `<div class="duraks">🤡 ${s.duraks}</div>` : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>

      ${isFinished ? '' : `
        <p class="muted" style="font-size:12px; margin:-4px 0 10px;">Тапни по игроку, чтобы передать ему ход.</p>

        ${isGoldenPhase ? `
          <div class="action-grid">
            <button data-ev="golden_regular" style="grid-column: 1 / -1;">🥇 Золотой шар<span class="hint">+1ш +${n}о / пред. −2о / ост. −1о</span></button>
            <button data-ev="golden_duplet">🥇 Золотой дуплет<span class="hint">+1ш +${n+1}о / пред. −3о / ост. −1о</span></button>
            <button data-ev="golden_pants">🥇 Золотые штаны<span class="hint">+2ш +${n+2}о / пред. −4о / ост. −1о</span></button>
            <button data-ev="penalty" class="danger">Штраф<span class="hint">−1о текущему, +1о предыдущему</span></button>
            <button data-ev="miss" class="ghost">Промах</button>
          </div>
        ` : allBallsGone ? '' : `
          <div class="action-grid">
            <button data-ev="pocket_regular">Обычный<span class="hint">+1ш +1о / пред. −1о</span></button>
            <button data-ev="pocket_durak">Дурак<span class="hint">+1ш +1о / пред. −1о</span></button>
            <button data-ev="pocket_duplet">Дуплет<span class="hint">+1ш +2о / пред. −2о</span></button>
            <button data-ev="pocket_pants">Штаны<span class="hint">+2ш +3о / пред. −3о</span></button>
            <button data-ev="penalty" class="danger" style="grid-column: 1 / -1;">Штраф<span class="hint">−1о текущему, +1о предыдущему, ход переходит</span></button>
          </div>
        `}

        <div style="display:flex; gap:8px; margin-top:14px;">
          <button class="ghost" id="undoBtn" ${game.events.length === 0 ? 'disabled' : ''}>↶ Отменить</button>
          ${!firstWinner && !isGoldenPhase && !allBallsGone ? `<button class="ghost" id="endBtn">Завершить досрочно</button>` : ''}
        </div>
      `}

      <h2>Лог ходов (${game.events.length})</h2>
      <div class="card event-log">
        ${game.events.length === 0 ? '<p class="muted">Пусто.</p>' :
          [...game.events].reverse().map((ev) => {
            const p = game.players.find((x) => x.id === ev.playerId);
            const def = EVENT_DEFS[ev.type];
            const dParts = [];
            if (def.isGolden) {
              if (def.balls) dParts.push(`+${def.balls} ш`);
              dParts.push(`+${n + def.goldenTier} о`);
            } else {
              if (def.balls) dParts.push(`${def.balls > 0 ? '+' : ''}${def.balls} ш`);
              if (def.points) dParts.push(`${def.points > 0 ? '+' : ''}${def.points} о`);
            }
            const delta = dParts.join(', ');
            return `<div class="item"><span class="who">${p ? p.name : '?'}</span><span class="what">${def.label}</span><span class="delta">${delta}</span></div>`;
          }).join('')}
      </div>

      ${isFinished ? `
        <dialog class="win-screen" id="winDlg">
          <h2>🏆 Победа по шарам</h2>
          <div class="winner">${(game.players.find((p) => p.id === game.winnerId) || {}).name || ''}</div>
          ${game.pointsLeaderId && game.pointsLeaderId !== game.winnerId ? `
            <p style="margin:8px 0;">🥇 Лидер по очкам: <strong>${(game.players.find((p) => p.id === game.pointsLeaderId) || {}).name}</strong></p>
          ` : ''}
          <p class="muted">Игра сохранена в серии.</p>
          <div style="display:flex; gap:8px; margin-top:14px;">
            ${game.seriesId ? `<button onclick="location.hash='#/series/${game.seriesId}'">К серии</button>` : ''}
            <button class="ghost" onclick="location.hash='#/'">На главную</button>
          </div>
        </dialog>
      ` : ''}
    `;

    document.querySelectorAll('[data-ev]').forEach((b) => b.addEventListener('click', () => pushEvent(b.dataset.ev)));
    document.querySelectorAll('[data-pick]').forEach((el) => el.addEventListener('click', () => setTurn(el.dataset.pick)));
    const undoBtn = document.getElementById('undoBtn'); if (undoBtn) undoBtn.addEventListener('click', undoLast);
    const endBtn = document.getElementById('endBtn'); if (endBtn) endBtn.addEventListener('click', endGame);
    const finishBtn = document.getElementById('finishBtn'); if (finishBtn) finishBtn.addEventListener('click', finishGame);
    const dlg = document.getElementById('winDlg'); if (dlg && typeof dlg.showModal === 'function') dlg.showModal();
  }

  render();
}

async function renderHistory() {
  const [series, games] = await Promise.all([api.get('/api/series'), api.get('/api/games')]);
  const orphan = games.filter((g) => !g.seriesId);
  app.innerHTML = `
    <a href="#/" class="muted">← Главная</a>
    <h1>История</h1>
    <h2>Серии (${series.length})</h2>
    ${series.length === 0 ? '<p class="muted">Пусто.</p>' :
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
    <a href="${game.seriesId ? '#/series/' + game.seriesId : '#/history'}" class="muted">← Назад</a>
    <h1>${winner ? '🏆 ' + winner.name : 'Игра'}</h1>
    ${pointsLeader && (!winner || pointsLeader.id !== winner.id) ? `<p>🥇 Лидер по очкам: <strong>${pointsLeader.name}</strong></p>` : ''}
    <p class="muted">${fmtDate(game.createdAt)} · до ${game.targetBalls} шаров ${duration ? '· ' + duration : ''}</p>

    <div id="playersWrap">
      ${game.players.map((p) => {
        const s = (game.finalScores && game.finalScores[p.id]) || st.scores[p.id];
        const isWin = p.id === game.winnerId;
        const isPL = p.id === game.pointsLeaderId;
        return `
          <div class="player-card ${isWin ? 'win' : ''}">
            <div class="head">
              <div class="name">${p.name} ${isWin ? '🏆' : ''} ${isPL && !isWin ? '🥇' : ''}</div>
            </div>
            <div class="stats">
              <div class="balls">${s.balls}<span class="target">/${game.targetBalls}</span></div>
              <div class="points">${s.points >= 0 ? '+' : ''}${s.points} очк.</div>
              ${s.duraks > 0 ? `<div class="duraks">🤡 ${s.duraks}</div>` : ''}
            </div>
          </div>
        `;
      }).join('')}
    </div>

    <h2>Лог ходов (${game.events.length})</h2>
    <div class="card event-log">
      ${game.events.length === 0 ? '<p class="muted">Пусто.</p>' :
        [...game.events].reverse().map((ev) => {
          const p = game.players.find((x) => x.id === ev.playerId);
          const def = EVENT_DEFS[ev.type];
          const dParts = [];
          if (def.isGolden) {
            if (def.balls) dParts.push(`+${def.balls} ш`);
            dParts.push(`+${game.players.length + def.goldenTier} о`);
          } else {
            if (def.balls) dParts.push(`${def.balls > 0 ? '+' : ''}${def.balls} ш`);
            if (def.points) dParts.push(`${def.points > 0 ? '+' : ''}${def.points} о`);
          }
          return `<div class="item"><span class="who">${p ? p.name : '?'}</span><span class="what">${def.label}</span><span class="delta">${dParts.join(', ')}</span></div>`;
        }).join('')}
    </div>

    <button class="ghost danger" id="delBtn">Удалить игру</button>
  `;
  document.getElementById('delBtn').addEventListener('click', async () => {
    if (!confirm('Удалить игру навсегда?')) return;
    await api.del(`/api/games/${id}`);
    location.hash = game.seriesId ? `#/series/${game.seriesId}` : '#/history';
  });
}
