/* Planning Poker — публичная страница (/poker, /poker/:id). Без авторизации:
   участник задаёт имя, оно хранится в localStorage и в итогах игры. */
(() => {
  const app = document.getElementById('poker-app');
  const toastEl = document.getElementById('toast');

  const DECKS = {
    fibonacci: { label: 'Фибоначчи', cards: ['0', '½', '1', '2', '3', '5', '8', '13', '21', '34', '55', '89', '?', '☕'] },
    tshirt: { label: 'Футболки (XS–XXL)', cards: ['XS', 'S', 'M', 'L', 'XL', 'XXL', '?', '☕'] },
    powers: { label: 'Степени двойки', cards: ['0', '1', '2', '4', '8', '16', '32', '64', '?'] },
  };

  const roomId = (location.pathname.match(/^\/poker\/([0-9a-f-]{36})/i) || [])[1] || null;

  let room = null;       // состояние комнаты с сервера
  let me = null;         // { participantId, name, spectator }
  let ws = null;
  let pollTimer = null;
  let view = 'table';    // 'table' | 'results'

  // ---------- utils ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl.classList.remove('show'), 2600);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  const storeKey = () => `poker:${roomId}`;
  function loadMe() {
    try { return JSON.parse(localStorage.getItem(storeKey()) || 'null'); } catch { return null; }
  }
  function saveMe(v) { localStorage.setItem(storeKey(), JSON.stringify(v)); }

  function issueLink(issue) {
    if (!issue) return '';
    const title = esc(issue.title);
    return issue.url
      ? `<a href="${esc(issue.url)}" target="_blank" rel="noopener noreferrer">${title}</a>`
      : title;
  }

  function voteStats(values) {
    const nums = values
      .map((v) => (v === '½' ? 0.5 : parseFloat(v)))
      .filter((n) => Number.isFinite(n));
    if (!nums.length) return null;
    const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
    const consensus = new Set(values.filter((v) => v !== null && v !== undefined)).size === 1;
    return { avg: Math.round(avg * 10) / 10, consensus, count: nums.length };
  }

  // ---------- create room (/poker) ----------
  function renderCreate() {
    document.title = 'Planning Poker — Ташкент';
    const deckOptions = Object.entries(DECKS)
      .map(([k, d]) => `<option value="${k}">${d.label} · ${d.cards.join(' ')}</option>`)
      .join('');
    app.innerHTML = `
      <div class="poker-entry">
        <div class="card-panel">
          <p class="eyebrow"><span class="eyebrow-dot" aria-hidden="true"></span>Planning Poker</p>
          <h1>Новая игра</h1>
          <p class="sub">Создайте комнату, пригласите команду по ссылке и оценивайте задачи в реальном времени. Регистрация не нужна.</p>
          <label for="pk-room-name">Название игры</label>
          <input id="pk-room-name" type="text" maxlength="80" placeholder="Спринт 42" />
          <label for="pk-deck">Колода</label>
          <select id="pk-deck">${deckOptions}</select>
          <label for="pk-issues">Задачи — ссылки или названия, по строкам или через запятую (можно добавить позже)</label>
          <textarea id="pk-issues" class="poker-issues-input" placeholder="https://tracker/TASK-101
https://tracker/TASK-102, https://tracker/TASK-103
Рефакторинг оплаты"></textarea>
          <div class="actions">
            <button id="pk-create" class="btn">Создать игру</button>
          </div>
        </div>
      </div>`;
    document.getElementById('pk-create').onclick = async () => {
      const btn = document.getElementById('pk-create');
      btn.disabled = true;
      try {
        const r = await api('/api/poker/rooms', {
          method: 'POST',
          body: {
            name: document.getElementById('pk-room-name').value,
            deck: document.getElementById('pk-deck').value,
            issues: document.getElementById('pk-issues').value,
          },
        });
        location.href = `/poker/${r.id}`;
      } catch (e) { toast('Ошибка: ' + e.message); btn.disabled = false; }
    };
  }

  // ---------- join (/poker/:id, имя ещё не задано) ----------
  function renderJoin(prefillName = '') {
    app.innerHTML = `
      <div class="poker-entry">
        <div class="card-panel">
          <p class="eyebrow"><span class="eyebrow-dot" aria-hidden="true"></span>Planning Poker</p>
          <h1>${esc(room && room.name || 'Присоединиться к игре')}</h1>
          <p class="sub">Представьтесь — имя увидят остальные участники, и оно сохранится в итогах игры.</p>
          <label for="pk-name">Ваше имя</label>
          <input id="pk-name" type="text" maxlength="60" placeholder="Иван" value="${esc(prefillName)}" autofocus />
          <label class="check"><input id="pk-spectator" type="checkbox" /> Я наблюдатель (не голосую)</label>
          <div class="actions">
            <button id="pk-join" class="btn">Войти в игру</button>
          </div>
        </div>
      </div>`;
    const submit = async () => {
      const name = document.getElementById('pk-name').value.trim();
      if (!name) { toast('Укажите имя'); return; }
      const spectator = document.getElementById('pk-spectator').checked;
      try {
        const prev = loadMe();
        const r = await api(`/api/poker/rooms/${roomId}/join`, {
          method: 'POST',
          body: { name, spectator, participantId: prev && prev.participantId },
        });
        me = { participantId: r.participantId, name, spectator };
        saveMe(me);
        await refresh();
      } catch (e) { toast('Ошибка: ' + e.message); }
    };
    document.getElementById('pk-join').onclick = submit;
    document.getElementById('pk-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  }

  // ---------- room (стол) ----------
  function renderRoom() {
    document.title = `${room.name || 'Planning Poker'} — Ташкент`;
    const deck = DECKS[room.deck] || DECKS.fibonacci;
    const current = room.issues.find((i) => i.id === room.currentIssueId) || null;
    const votesByPid = new Map(room.votes.map((v) => [v.participantId, v]));
    const voters = room.participants.filter((p) => !p.spectator);
    const votedCount = voters.filter((p) => votesByPid.has(p.id)).length;

    const seats = room.participants.map((p) => {
      const v = votesByPid.get(p.id);
      const isMe = me && p.id === me.participantId;
      let cardCls = 'mini-card', cardTxt = '';
      if (p.spectator) { cardCls += ' spectator'; cardTxt = '👁'; }
      else if (room.revealed && v) { cardCls += ' open'; cardTxt = esc(v.value); }
      else if (v) { cardCls += ' voted'; cardTxt = '✓'; }
      return `<div class="seat${isMe ? ' me' : ''}">
        <div class="${cardCls}">${cardTxt}</div>
        <div class="nm" title="${esc(p.name)}">${esc(p.name)}</div>
      </div>`;
    }).join('');

    // центр стола: кнопка «Показать карты» / статистика / приглашение
    let felt;
    if (!current) {
      felt = `<div class="felt-cta">
        <div>Выберите задачу в списке справа</div>
        <div class="hint">или добавьте задачи — по строкам или через запятую</div>
      </div>`;
    } else if (room.revealed) {
      const values = room.votes.map((v) => v.value);
      const st = voteStats(values);
      felt = `<div class="felt-cta">
        ${st ? `<div class="poker-stats">
            <div class="stat"><div class="v">${st.avg}</div><div class="l">среднее</div></div>
            <div class="stat"><div class="v">${votedCount}/${voters.length}</div><div class="l">голосов</div></div>
            ${st.consensus ? '<div class="stat"><div class="v">🤝</div><div class="l">консенсус</div></div>' : ''}
          </div>` : `<div>Числовых голосов нет</div>`}
        <div class="button-row" style="justify-content:center; margin-top:10px">
          ${st ? `<button id="pk-save-est" class="btn small">Записать оценку ${st.avg}</button>` : ''}
          <button id="pk-reset" class="btn small ghost">Голосовать заново</button>
        </div>
      </div>`;
    } else if (votedCount === 0) {
      felt = `<div class="felt-cta">
        <div>Выбирайте карты!</div>
        <div class="hint">Когда все будут готовы, появится кнопка «Показать карты»</div>
      </div>`;
    } else {
      felt = `<div class="felt-cta">
        <button id="pk-reveal" class="btn">Показать карты</button>
        <div class="hint">Проголосовали ${votedCount} из ${voters.length}</div>
      </div>`;
    }

    const isSpectator = me && me.spectator;
    const deckHtml = (current && !isSpectator) ? `<div class="poker-deck">
        ${deck.cards.map((c) => `<button class="poker-card-btn${room.myValue === c ? ' selected' : ''}"
          data-card="${esc(c)}" ${room.revealed ? 'disabled' : ''}>${esc(c)}</button>`).join('')}
      </div>` : '';

    const issuesHtml = room.issues.map((i) => `
      <li class="issue-item${i.id === room.currentIssueId ? ' current' : ''}" data-issue="${i.id}">
        <span class="t">${issueLink(i)}</span>
        <span class="est${i.finalEstimate ? ' done' : ''}">${esc(i.finalEstimate || '—')}</span>
        <button class="del" data-del="${i.id}" title="Удалить" aria-label="Удалить задачу">✕</button>
      </li>`).join('');

    const peopleHtml = room.participants.map((p) => `
      <li><span class="dot${votesByPid.has(p.id) ? ' on' : ''}"></span>${esc(p.name)}
        ${p.spectator ? '<span class="tag">наблюдатель</span>' : ''}
        ${me && p.id === me.participantId ? '<span class="tag">вы</span>' : ''}</li>`).join('');

    app.innerHTML = `
      <div class="poker-topbar">
        <div>
          <h1>${esc(room.name || 'Planning Poker')}</h1>
          <span class="who">Вы — <b>${esc(me.name)}</b>${isSpectator ? ' (наблюдатель)' : ''} · <a href="#" id="pk-rename" style="color:var(--muted)">сменить имя</a></span>
        </div>
        <div class="button-row">
          <button id="pk-invite" class="btn small">🔗 Пригласить по ссылке</button>
          <button id="pk-view" class="btn small ghost">${view === 'table' ? '📋 Итоги игры' : '🃏 К столу'}</button>
        </div>
      </div>
      ${view === 'results' ? '<div id="pk-results" class="poker-panel"><p class="muted">Загрузка…</p></div>' : `
      <div class="poker-layout">
        <section class="poker-table-card">
          <div class="poker-issue-current">
            ${current ? `Оцениваем: <span class="title">${issueLink(current)}</span>` : 'Задача не выбрана'}
          </div>
          <div class="poker-seats">${seats}</div>
          <div class="poker-felt">${felt}</div>
          ${deckHtml}
        </section>
        <aside class="poker-side">
          <div class="poker-panel">
            <h2>Задачи <span class="muted small-note">(${room.issues.length})</span></h2>
            <ul class="issue-list">${issuesHtml || '<li class="muted" style="font-size:.88rem">Пока пусто</li>'}</ul>
            <textarea id="pk-new-issues" class="poker-issues-input" placeholder="Ссылки или названия — по строкам или через запятую"></textarea>
            <div class="button-row" style="margin-top:8px">
              <button id="pk-add-issues" class="btn small">Добавить</button>
            </div>
          </div>
          <div class="poker-panel">
            <h2>Участники <span class="muted small-note">(${room.participants.length})</span></h2>
            <ul class="poker-people">${peopleHtml}</ul>
          </div>
        </aside>
      </div>`}
    `;

    bindRoomHandlers(current);
    if (view === 'results') loadResults();
  }

  function bindRoomHandlers(current) {
    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };

    on('pk-invite', async () => {
      const url = `${location.origin}/poker/${roomId}`;
      try { await navigator.clipboard.writeText(url); toast('Ссылка-приглашение скопирована'); }
      catch { prompt('Скопируйте ссылку:', url); }
    });
    on('pk-view', () => { view = view === 'table' ? 'results' : 'table'; renderRoom(); });
    on('pk-rename', (e) => { e.preventDefault(); renderJoin(me.name); });
    on('pk-reveal', () => api(`/api/poker/rooms/${roomId}/reveal`, { method: 'POST' }).catch((e) => toast(e.message)));
    on('pk-reset', () => api(`/api/poker/rooms/${roomId}/reset`, { method: 'POST' }).catch((e) => toast(e.message)));
    on('pk-save-est', async (e) => {
      const value = e.target.textContent.replace('Записать оценку', '').trim();
      if (!current) return;
      try {
        await api(`/api/poker/issues/${current.id}/estimate`, { method: 'POST', body: { value } });
        // после записи оценки — автоматически перейти к следующей неоценённой задаче
        const next = room.issues.find((i) => !i.finalEstimate && i.id !== current.id);
        await api(`/api/poker/rooms/${roomId}/current`, { method: 'POST', body: { issueId: next ? next.id : null } });
      } catch (err) { toast(err.message); }
    });
    on('pk-add-issues', async () => {
      const ta = document.getElementById('pk-new-issues');
      if (!ta.value.trim()) return;
      try {
        await api(`/api/poker/rooms/${roomId}/issues`, { method: 'POST', body: { issues: ta.value } });
        ta.value = '';
      } catch (e) { toast(e.message); }
    });

    document.querySelectorAll('.poker-card-btn').forEach((btn) => {
      btn.onclick = async () => {
        if (!current || !me) return;
        const value = btn.dataset.card === room.myValue ? '' : btn.dataset.card; // повторный клик снимает голос
        try {
          await api(`/api/poker/issues/${current.id}/vote`, {
            method: 'POST',
            body: { participantId: me.participantId, value },
          });
        } catch (e) { toast(e.message); }
      };
    });

    document.querySelectorAll('.issue-item').forEach((li) => {
      li.addEventListener('click', (e) => {
        if (e.target.closest('a') || e.target.closest('.del')) return;
        api(`/api/poker/rooms/${roomId}/current`, { method: 'POST', body: { issueId: li.dataset.issue } })
          .catch((err) => toast(err.message));
      });
    });
    document.querySelectorAll('.issue-item .del').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        api(`/api/poker/issues/${btn.dataset.del}`, { method: 'DELETE' }).catch((err) => toast(err.message));
      };
    });
  }

  // ---------- итоги игры ----------
  async function loadResults() {
    const box = document.getElementById('pk-results');
    if (!box) return;
    try {
      const r = await api(`/api/poker/rooms/${roomId}/results`);
      const voteMap = new Map(r.votes.map((v) => [`${v.issueId}:${v.participantId}`, v.value]));
      const head = r.participants.map((p) => `<th>${esc(p.name)}</th>`).join('');
      const rows = r.issues.map((i) => {
        const cells = r.participants.map((p) => `<td>${esc(voteMap.get(`${i.id}:${p.id}`) ?? '')}</td>`).join('');
        return `<tr>
          <td class="issue-cell">${issueLink(i)}</td>
          ${cells}
          <td><span class="avg">${esc(i.finalEstimate || '—')}</span></td>
        </tr>`;
      }).join('');
      box.innerHTML = `
        <h2>Итоги игры${r.room.name ? ` — ${esc(r.room.name)}` : ''}</h2>
        ${r.issues.length ? `<div class="poker-results-wrap"><table class="poker-results">
          <thead><tr><th style="text-align:left">Задача</th>${head}<th>Оценка</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>` : '<p class="muted">Задач пока нет.</p>'}`;
    } catch (e) {
      box.innerHTML = `<p class="muted">Не удалось загрузить итоги: ${esc(e.message)}</p>`;
    }
  }

  // ---------- sync ----------
  async function refresh() {
    if (!roomId) return;
    try {
      const meParam = me ? `?me=${encodeURIComponent(me.participantId)}` : '';
      room = await api(`/api/poker/rooms/${roomId}${meParam}`);
    } catch (e) {
      app.innerHTML = `<div class="poker-entry"><div class="card-panel">
        <h1>Игра не найдена</h1>
        <p class="sub">Возможно, ссылка устарела.</p>
        <div class="actions"><a class="btn" href="/poker">Создать новую игру</a></div>
      </div></div>`;
      return;
    }
    // если наш participantId уже не в комнате (удалили) — просим представиться заново
    if (me && !room.participants.some((p) => p.id === me.participantId)) me = null;
    if (!me) { renderJoin((loadMe() || {}).name || ''); return; }
    if (view === 'results') { renderRoom(); return; }
    renderRoom();
  }

  function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws/poker?room=${roomId}`);
    ws.onmessage = () => refresh();
    ws.onclose = () => setTimeout(connectWs, 2500);
    // страховка на случай пропущенных сообщений
    if (!pollTimer) pollTimer = setInterval(refresh, 20000);
  }

  // ---------- init ----------
  if (!roomId) {
    renderCreate();
  } else {
    me = loadMe();
    refresh().then(() => connectWs());
  }
})();
