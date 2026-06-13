# AGENTS.md — Tashkent Billiards Tracker

This file is the entry point for any AI agent working in this repository.
Read it fully before making changes.

---

## What this project is

A single-page web app for tracking **Tashkent billiards** (Russian pyramid variant) games.

- Node.js HTTP server with zero npm dependencies (`server.js`)
- Vanilla JS frontend (`public/app.js`, `public/styles.css`, `public/index.html`)
- Data stored as local JSON files in `data/`
- Runs on port 7777 by default (`PORT` env var overrides)

Start: `node server.js`

---

## Game rules (Tashkent variant)

Russian billiards table, 15 white target balls + 1 cue ball.

**Victory:** First player to pocket N balls wins (N set at game start, default 6).

**Turn rules:**
- Pocketing any ball → turn continues (same player)
- Miss or penalty → turn passes to next player

**Scoring:**

| Event | Balls (winner count) | Points to current | Points to previous player |
|---|---|---|---|
| Regular (обычный) | +1 | +1 | −1 |
| Duplet (дуплет) | +1 | +2 | −2 |
| Pants (штаны) | +2 | +3 | −3 |
| Fool (дурак) | +1 | +1 | −1 |
| Penalty (штраф) | 0 | −1 | +1 |
| Miss (промах) | 0 | 0 | 0 |

**"Previous player"** = the player immediately before the current one in fixed turn order (circular).
- If player 2 shoots → player 1 gets the delta
- If player 1 shoots → the last player in the list gets the delta
- This is determined by position in order, NOT by who last pocketed a ball

**Duplet:** Two balls pocketed in one shot, both from cushion.
**Pants (штаны):** Two balls pocketed in one shot, one direct.
**Fool (дурак):** Cueball pockets after pocketing target ball (still counts as +1 ball).

**Win condition:** Balls only. When a player reaches targetBalls, a banner appears. The game does NOT auto-finish — other players can continue pocketing balls. Press **«Завершить партию»** to finalize. Final scores are recorded at that moment.

### Golden Ball phase

Triggered when the sum of all players' `balls` equals **14** (one target ball remains on table, plus the cue ball).

**Свояк** (cue ball pocketed) counts as a regular ball. In the golden phase, «Золотые штаны» = pocket the last target ball + свояк in one shot.

In the UI, regular action buttons are replaced by golden buttons. After any golden pocket (total ≥ 15), all action buttons hide and «Завершить партию» is shown.

**Scoring** (N = number of players in the game):

| Event | Balls | Points to current | Points to prev | Points to each remaining |
|---|---|---|---|---|
| Золотой шар (golden_regular) | +1 | +N | −2 | −1 |
| Золотой дуплет (golden_duplet) | +1 | +N+1 | −3 | −1 |
| Золотые штаны (golden_pants) | +2 | +N+2 | −4 | −1 |

Zero-sum proof at N players: N − 2 − (N−2)×1 = 0 ✓

«Штраф» and «Промах» remain available in golden phase.

---

## Data model

### `data/players.json`
```json
[{ "id": "uuid", "name": "string", "createdAt": "ISO" }]
```

### `data/games.json`
```json
[{
  "id": "uuid",
  "seriesId": "uuid | null",
  "createdAt": "ISO",
  "finishedAt": "ISO | null",
  "targetBalls": 6,
  "players": [{ "id": "uuid", "name": "string" }],
  "events": [{ "type": "event_type", "playerId": "uuid", "ts": "ISO" }],
  "firstWinnerId": "uuid | null",
  "finalScores": { "playerId": { "balls": 0, "points": 0, "duraks": 0 } } | null,
  "winnerId": "uuid | null",
  "pointsLeaderId": "uuid | null",
  "status": "active | finished"
}]
```

`firstWinnerId` — set when a player first reaches `targetBalls` during active play.
`winnerId` — set on finalization (equals `firstWinnerId` when game ends normally).
`pointsLeaderId` — player with most points at the moment of finalization.

### `data/series.json`
```json
[{
  "id": "uuid",
  "name": "string | null",
  "createdAt": "ISO",
  "finishedAt": "ISO | null",
  "status": "active | finished"
}]
```

---

## Core algorithm — `computeState(game)`

Located in `public/app.js`. Replays all events from scratch each time (no incremental state).

```
scores = { playerId: { balls: 0, points: 0, duraks: 0 } }
turnIdx = 0
n = game.players.length

for each event:
  def = EVENT_DEFS[event.type]

  if def.isGolden:
    tier = def.goldenTier  # 0, 1, or 2
    scores[current].balls += def.balls
    scores[current].points += n + tier
    scores[prev].points -= 2 + tier
    for each other player (not current, not prev):
      scores[other].points -= 1
    turnIdx = currentIdx  # keepTurn
  else:
    apply def.balls and def.points to current player
    if def.prevDelta != 0 and n > 1:
      prevIdx = (currentIdx - 1 + n) % n
      scores[prevPlayer].points += def.prevDelta
    turnIdx = def.keepTurn ? currentIdx : (currentIdx + 1) % n

winner = first player where balls >= targetBalls
pointsLeader = player with max points (null if tie)
totalBalls = sum of all scores[p].balls
isGoldenPhase = (totalBalls === 14)
allBallsGone = (totalBalls >= 15)
```

`set_turn` events override turnIdx manually (keepTurn=true, no scoring).

**Golden phase UI logic:**
- `isGoldenPhase`: replace action grid with golden buttons
- `allBallsGone`: hide all action buttons, show «Завершить партию» only

---

## API routes

| Method | Path | Description |
|---|---|---|
| GET | `/api/players` | List all players |
| POST | `/api/players` | Create player (returns existing if name matches) |
| DELETE | `/api/players/:id` | Delete player |
| GET | `/api/games` | List all games |
| POST | `/api/games` | Create game |
| GET | `/api/games/:id` | Get single game |
| PUT | `/api/games/:id` | Update game (full merge) |
| DELETE | `/api/games/:id` | Delete game |
| GET | `/api/series` | List all series |
| POST | `/api/series` | Create series |
| GET | `/api/series/:id` | Get single series |
| PUT | `/api/series/:id` | Update series |
| DELETE | `/api/series/:id` | Delete series (games lose seriesId, not deleted) |

---

## Frontend routes (hash-based)

| Hash | View |
|---|---|
| `#/` | Home (active series, recent series, orphan games) |
| `#/players` | Player management |
| `#/new-series` | Create new series |
| `#/series/:id` | Series detail + standings table |
| `#/new-game/:seriesId` | Start new game in series |
| `#/game/:id` | Live game (events, scores, undo) |
| `#/history` | All series and orphan games |
| `#/games/:id` | Finished game detail |

---

## Series standings (`seriesTotals`)

Aggregates all **finished** games in a series per player:
- `wins` — games where `winnerId === player.id`
- `pointsLeads` — games where `pointsLeaderId === player.id`
- `totalPoints`, `totalBalls`, `totalDuraks` — sums from `finalScores`
- `winsChampion` — player with most wins (null if tie)
- `pointsChampion` — player with most total points (null if tie)

---

## Known conventions

- All IDs are `crypto.randomUUID()`
- Server reads/writes JSON files synchronously (no DB, no ORM)
- Frontend re-fetches from API on every route change (no client-side state between views)
- Undo pops the last event from `game.events` and resets `status`/`firstWinnerId` if needed
- `set_turn` events allow manually reassigning whose turn it is without scoring
