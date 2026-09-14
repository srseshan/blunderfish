import { Chess } from './vendor/chess.esm.js';

// ---------- Stockfish engine wrapper ----------
// Talks UCI over a Worker. The wasm path is passed via the URL hash, which
// is how nmrugg/stockfish.js locates it when it detects it's running inside
// a Worker (see vendor/stockfish.js, worker-mode branch at the bottom).
class Engine {
  constructor() {
    // The part after '#' is resolved by the worker relative to its OWN
    // script location (vendor/stockfish.js), not the page, so this must be
    // just the filename, not another './vendor/...' path.
    this.worker = new Worker('./vendor/stockfish.js#stockfish.wasm');
    this.ready = new Promise((resolve) => {
      const onFirstReady = (e) => {
        if (e.data === 'readyok') {
          this.worker.removeEventListener('message', onFirstReady);
          resolve();
        }
      };
      this.worker.addEventListener('message', onFirstReady);
    });
    this.worker.postMessage('uci');
    // Hash is a free quality/speed win (bigger transposition table), so it
    // stays. MultiPV 3 (chess.com's Game Review setting) was tried too, but
    // we don't actually read lines 2/3 anywhere yet — that's only needed for
    // Great/Brilliant move detection, which isn't built — so it was pure
    // search-time overhead (searching 3 lines costs real time per depth,
    // even on a single-threaded engine) with zero benefit. Reverted to
    // MultiPV 1 until that feature exists. UCI_AnalyseMode is set for
    // parity but this build doesn't expose that option, so it's a no-op.
    this.worker.postMessage('setoption name Hash value 64');
    this.worker.postMessage('setoption name UCI_AnalyseMode value true');
    this.worker.postMessage('isready');
  }

  // Runs `go depth 18 movetime N` on a FEN and resolves with
  // { bestMove, score, isMate, mateIn }. score is in pawns from the
  // side-to-move's perspective (UCI cp / 100).
  // Bounded by BOTH a depth ceiling and a time cap — the engine stops at
  // whichever it hits first. A flat movetime alone burns the full budget on
  // every move even trivial/forced ones (recaptures, forced replies, book
  // moves), which made analysis feel far slower than the old fixed-depth
  // version. Depth 18 resolves those easy positions almost instantly, same
  // as before; the time cap only actually gets used on positions complex
  // enough to still be searching when it runs out, which is exactly where
  // a fixed depth used to finish "early" and miss subtler errors.
  evaluate(fen, movetimeMs = 3000) {
    return new Promise((resolve) => {
      let lastScore = null;
      let lastIsMate = false;
      let lastMateIn = undefined;

      const onMessage = (e) => {
        const line = e.data;
        if (typeof line !== 'string') return;

        // With MultiPV 3 the engine reports three separate candidate lines
        // per depth (multipv 1/2/3). Only line 1 is the actual best move —
        // ignore updates from lines 2/3 or they'll clobber the real score.
        const multipvMatch = line.match(/multipv (\d+)/);
        if (multipvMatch && multipvMatch[1] !== '1') return;

        const mateMatch = line.match(/score mate (-?\d+)/);
        const cpMatch = line.match(/score cp (-?\d+)/);
        if (mateMatch) {
          lastIsMate = true;
          lastMateIn = parseInt(mateMatch[1], 10);
          lastScore = lastMateIn > 0 ? 100 : -100; // clamp for downstream math
        } else if (cpMatch) {
          lastIsMate = false;
          lastMateIn = undefined;
          lastScore = parseInt(cpMatch[1], 10) / 100;
        }

        if (line.startsWith('bestmove')) {
          this.worker.removeEventListener('message', onMessage);
          const bestMove = line.split(' ')[1];
          resolve({
            bestMove,
            score: lastScore ?? 0,
            isMate: lastIsMate,
            mateIn: lastMateIn,
          });
        }
      };

      this.worker.addEventListener('message', onMessage);
      this.worker.postMessage(`position fen ${fen}`);
      this.worker.postMessage(`go depth 18 movetime ${movetimeMs}`);
    });
  }

  terminate() {
    this.worker.postMessage('quit');
    this.worker.terminate();
  }
}

// ---------- Move classification ----------
// Compares the eval right after the played move to the eval Stockfish would
// have reached after its own best move from the same position, both from
// White's perspective, and buckets the loss into a classification. This
// bucketing is only used for the per-move display label/color, not for the
// game accuracy score below.
function classifyLoss(centipawnLoss) {
  if (centipawnLoss <= 5) return 'best';
  if (centipawnLoss <= 30) return 'good';
  if (centipawnLoss <= 80) return 'inaccuracy';
  if (centipawnLoss <= 200) return 'mistake';
  return 'blunder';
}

// ---------- Accuracy scoring ----------
// Ported from lichess's actual open-source implementation (chess.com's own
// formula is closed-source, but lichess publishes theirs and both platforms
// describe the same win-probability approach):
//   - WinPercent.fromCentiPawns / winningChances in lichess-org/scalachess
//     (core/src/main/scala/eval.scala)
//   - AccuracyPercent.fromWinPercents and .gameAccuracy in lichess-org/lila
//     (modules/analyse/src/main/AccuracyPercent.scala)
// Constants and the ceiling below are copied from there, not guessed.
function cpToWinPercent(centipawns) {
  const cp = Math.max(-1000, Math.min(1000, centipawns)); // engine's own eval ceiling
  const winningChances = Math.max(-1, Math.min(1, 2 / (1 + Math.exp(-0.00368208 * cp)) - 1));
  return 50 + 50 * winningChances;
}

// winPercentBefore/After are both from the moving side's own perspective.
function moveAccuracyFromWinPercent(winPercentBefore, winPercentAfter) {
  if (winPercentAfter >= winPercentBefore) return 100; // move held or improved the position
  const winDiff = winPercentBefore - winPercentAfter;
  const raw = 103.1668100711649 * Math.exp(-0.04354415386753951 * winDiff) - 3.166924740191411;
  return Math.max(0, Math.min(100, raw + 1)); // +1: uncertainty bonus, per lichess source
}

function standardDeviation(nums) {
  if (nums.length === 0) return 0;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const variance = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length;
  return Math.sqrt(variance);
}

// Real per-color game accuracy is NOT a plain average of per-move accuracy —
// that dilutes a single game-losing blunder into near-nothing over a long
// game. Lichess (and, going by chess.com's own description of CAPS2, chess.com
// too) instead weights each move's accuracy by how "volatile"/critical the
// position was around that point in the game (a sharp, swingy moment counts
// more than a routine one), then averages a volatility-weighted mean with a
// volatility-weighted harmonic mean — the harmonic mean is what makes a bad
// blunder actually tank the score instead of getting smoothed away.
function gameAccuracy(positions, perMove) {
  const allWinPercents = positions.map((p) => cpToWinPercent(p.whiteRelativeEval * 100));
  const n = perMove.length;
  if (n === 0) return { w: 0, b: 0 };

  const windowSize = Math.max(2, Math.min(8, Math.floor(n / 10)));
  const windows = [];
  const fixedWindow = allWinPercents.slice(0, Math.min(windowSize, allWinPercents.length));
  for (let i = 0; i < windowSize - 2; i++) windows.push(fixedWindow);
  for (let start = 0; start + windowSize <= allWinPercents.length; start++) {
    windows.push(allWinPercents.slice(start, start + windowSize));
  }

  const weights = windows.map((w) => Math.max(0.5, Math.min(12, standardDeviation(w))));

  const byColor = { w: [], b: [] };
  for (let i = 0; i < n; i++) {
    byColor[perMove[i].playerColor].push({ value: perMove[i].accuracy, weight: weights[i] });
  }

  const weightedMean = (pairs) => {
    const sumW = pairs.reduce((s, p) => s + p.weight, 0);
    if (sumW === 0) return 0;
    return pairs.reduce((s, p) => s + p.value * p.weight, 0) / sumW;
  };
  const harmonicMean = (pairs) => {
    const sumW = pairs.reduce((s, p) => s + p.weight, 0);
    const denom = pairs.reduce((s, p) => s + p.weight / Math.max(p.value, 1e-6), 0);
    if (denom === 0) return 0;
    return sumW / denom;
  };
  const colorAccuracy = (pairs) => (pairs.length === 0 ? 0 : Math.round((weightedMean(pairs) + harmonicMean(pairs)) / 2));

  return { w: colorAccuracy(byColor.w), b: colorAccuracy(byColor.b) };
}

// ---------- chess.com lookup ----------
// Public API, CORS-open (verified: access-control-allow-origin: *), so this
// can be called straight from the browser with no backend.
async function fetchRecentGames(username, monthsBack = 2) {
  const archivesResp = await fetch(`https://api.chess.com/pub/player/${encodeURIComponent(username)}/games/archives`);
  if (!archivesResp.ok) {
    throw new Error(`chess.com lookup failed (${archivesResp.status}). Check the username.`);
  }
  const { archives } = await archivesResp.json();
  const recentUrls = archives.slice(-monthsBack);

  const games = [];
  for (const url of recentUrls) {
    const resp = await fetch(url);
    if (!resp.ok) continue;
    const data = await resp.json();
    games.push(...(data.games || []));
  }
  return games.sort((a, b) => (b.end_time || 0) - (a.end_time || 0)); // newest first, by actual timestamp
}

function gameRow(game, username) {
  const white = game.white?.username || 'White';
  const black = game.black?.username || 'Black';
  const isUserWhite = white.toLowerCase() === username.toLowerCase();
  const opponent = isUserWhite ? black : white;
  const userResult = isUserWhite ? game.white.result : game.black.result;
  const date = new Date((game.end_time || 0) * 1000).toLocaleDateString();
  const timeClass = game.time_class || '';
  const color = isUserWhite ? 'White' : 'Black';
  return { date, opponent, timeClass, color, outcome: resultLabel(userResult) };
}

function resultLabel(result) {
  if (result === 'win') return 'win';
  if (['checkmated', 'timeout', 'resigned', 'lose', 'abandoned'].includes(result)) return 'loss';
  return 'draw';
}

// ---------- Board rendering ----------
// Hand-rolled 8x8 grid using chess.js's board() output, with the open-source
// Cburnett SVG piece set (same set lichess uses) vendored under
// vendor/pieces/ — real piece graphics instead of Unicode glyphs, which
// render inconsistently thin across fonts/OSes.
const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

// orientation 'w' = White's home row at the bottom (standard); 'b' = flipped
// so Black's home row is at the bottom — used to always put the selected
// chess.com user's own pieces closest to them, like chess.com does.
function renderBoard(fen, highlight = {}, orientation = 'w') {
  const boardChess = new Chess(fen);
  const rows = boardChess.board(); // rows[0] = rank 8 ... rows[7] = rank 1
  const boardEl = el('board');
  let html = '';

  for (let displayRow = 0; displayRow < 8; displayRow++) {
    for (let displayCol = 0; displayCol < 8; displayCol++) {
      const r = orientation === 'w' ? displayRow : 7 - displayRow;
      const c = orientation === 'w' ? displayCol : 7 - displayCol;
      const square = `${FILES[c]}${8 - r}`;
      const isLight = (r + c) % 2 === 0;
      const classes = ['sq', isLight ? 'light' : 'dark'];
      if (square === highlight.from) classes.push('from-square');
      if (square === highlight.to) classes.push('to-square');

      const piece = rows[r][c];
      const pieceImg = piece
        ? `<img class="piece" src="./vendor/pieces/${piece.color}${piece.type.toUpperCase()}.svg" alt="${piece.color}${piece.type}" draggable="false" />`
        : '';

      html += `<div class="${classes.join(' ')}">${pieceImg}</div>`;
    }
  }

  boardEl.innerHTML = html;
}

// ---------- App wiring ----------
const el = (id) => document.getElementById(id);

const state = {
  engine: null,
  games: [],
  username: '',
  // In-memory only (cleared on page reload) — keyed by `${game.url}|${movetimeMs}`
  // so re-clicking an already-analyzed game skips re-running the engine.
  analysisCache: new Map(),
  replay: {
    positions: [], // index 0 = starting position; index i = after perMove[i-1]
    currentIndex: 0,
    white: 'White',
    black: 'Black',
  },
};

async function ensureEngine() {
  if (!state.engine) {
    state.engine = new Engine();
    await state.engine.ready;
  }
  return state.engine;
}

function setStatus(msg) {
  el('status').textContent = msg;
}

el('fetch-btn').addEventListener('click', async () => {
  const username = el('username').value.trim();
  if (!username) return;
  state.username = username;

  el('fetch-btn').disabled = true;
  setStatus('Fetching game history from chess.com...');
  el('game-table-wrap').innerHTML = '';
  el('replay').classList.add('hidden');
  el('results').innerHTML = '';
  el('progress').textContent = '';

  try {
    const games = await fetchRecentGames(username, 2);
    state.games = games;
    if (games.length === 0) {
      setStatus('No games found for that username in the last couple of months.');
    } else {
      setStatus(`Found ${games.length} games. Pick one to analyze.`);
      renderGameTable(games, username);
    }
  } catch (err) {
    setStatus(err.message);
  } finally {
    el('fetch-btn').disabled = false;
  }
});

function renderGameTable(games, username) {
  const wrap = el('game-table-wrap');
  const rows = games.map((game) => gameRow(game, username));

  wrap.innerHTML = `
    <table class="game-table">
      <thead>
        <tr><th>Date</th><th>Opponent</th><th>Time control</th><th>You played</th><th>Result</th><th>Score</th></tr>
      </thead>
      <tbody>
        ${rows.map((r, i) => `
          <tr class="outcome-${r.outcome}">
            <td>${r.date}</td>
            <td>${r.opponent}</td>
            <td>${r.timeClass}</td>
            <td><span class="piece-dot ${r.color.toLowerCase()}"></span>${r.color}</td>
            <td><span class="badge badge-${r.outcome}">${r.outcome}</span></td>
            <td class="score-cell" data-idx="${i}"><button class="analyze-row-btn" data-idx="${i}">Analyze</button></td>
          </tr>`).join('')}
      </tbody>
    </table>
  `;

  wrap.querySelectorAll('.analyze-row-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx, 10);
      renderLoadingCell(idx);
      analyzeGame(games[idx], username, idx);
    });
  });

  // If a game in this list was already analyzed earlier in the session
  // (e.g. re-fetching the same range), show its cached score right away
  // instead of the Analyze button.
  const movetimeMs = parseInt(el('depth').value, 10) || 3000;
  games.forEach((game, i) => {
    const cached = state.analysisCache.get(cacheKey(game, movetimeMs));
    if (cached) renderScoreCell(i, cached.userAccuracy);
  });
}

function cacheKey(game, movetimeMs) {
  return `${game.url || game.pgn}|${movetimeMs}`;
}

function renderLoadingCell(idx) {
  const cell = document.querySelector(`.score-cell[data-idx="${idx}"]`);
  if (!cell) return;
  cell.innerHTML = '<span class="progress-circle" style="--pct: 0" role="status" aria-label="Analyzing"></span>';
}

// Fills in the mini circular progress indicator as analysis moves through
// the game, instead of a plain indefinite spinner.
function updateLoadingProgress(idx, pct) {
  const circle = document.querySelector(`.score-cell[data-idx="${idx}"] .progress-circle`);
  if (circle) circle.style.setProperty('--pct', pct);
}

// Restores the plain Analyze button — used when analysis fails partway
// through, so the row doesn't get stuck showing a spinner forever.
function renderAnalyzeCell(idx) {
  const cell = document.querySelector(`.score-cell[data-idx="${idx}"]`);
  if (!cell) return;
  cell.innerHTML = `<button class="analyze-row-btn" data-idx="${idx}">Analyze</button>`;
  cell.querySelector('.analyze-row-btn').addEventListener('click', () => {
    renderLoadingCell(idx);
    analyzeGame(state.games[idx], state.username, idx);
  });
}

function renderScoreCell(idx, userAccuracy) {
  const cell = document.querySelector(`.score-cell[data-idx="${idx}"]`);
  if (!cell) return;
  cell.innerHTML = `<button class="score-btn" data-idx="${idx}">${userAccuracy}%</button>`;
  cell.querySelector('.score-btn').addEventListener('click', () => {
    renderLoadingCell(idx);
    const game = state.games[idx];
    analyzeGame(game, state.username, idx);
  });
}

async function analyzeGame(game, username, idx) {
  const movetimeMs = parseInt(el('depth').value, 10) || 3000;
  el('results').innerHTML = '';
  el('progress').textContent = '';

  const white = game.white?.username || 'White';
  const black = game.black?.username || 'Black';
  const orientation = (username && black.toLowerCase() === username.toLowerCase()) ? 'b' : 'w';

  const key = cacheKey(game, movetimeMs);
  const cached = state.analysisCache.get(key);

  if (cached) {
    setStatus('Loaded from cache — no re-analysis needed.');
    state.replay = {
      positions: cached.positions,
      currentIndex: 0,
      white,
      black,
      orientation,
    };
    showReplay();
    updatePlayerLabels(username);
    goToIndex(0);
    renderSummary(cached.perMove, game, username, cached.positions);
    if (idx !== undefined) renderScoreCell(idx, cached.userAccuracy);
    setStatus('Done (cached).');
    return;
  }

  let chess;
  try {
    chess = new Chess();
    chess.loadPgn(game.pgn);
  } catch (err) {
    setStatus('Could not parse that game\'s PGN.');
    if (idx !== undefined) renderAnalyzeCell(idx);
    return;
  }

  const history = chess.history({ verbose: true });
  chess.reset();

  setStatus('Loading Stockfish (first run downloads ~7MB, then it\'s cached)...');
  const engine = await ensureEngine();
  setStatus(`Analyzing ${history.length} moves at ${movetimeMs / 1000}s per move...`);

  // Reset replay state and show the starting position immediately.
  const startFen = chess.fen();
  const startEval = await engine.evaluate(startFen, movetimeMs); // white to move, so score is already white-relative
  state.replay = {
    positions: [{
      fen: startFen,
      moveNumber: 0,
      playerColor: null,
      san: null,
      from: null,
      to: null,
      classification: null,
      whiteRelativeEval: startEval.score,
      betterMove: null,
    }],
    currentIndex: 0,
    white,
    black,
    orientation,
  };
  showReplay();
  updatePlayerLabels(username);
  goToIndex(0);

  const perMove = [];
  let prevEval = startEval.score;
  let suggestedFromPrevPosition = startEval.bestMove;

  for (let i = 0; i < history.length; i++) {
    const move = history[i];
    const playerColor = i % 2 === 0 ? 'w' : 'b';

    chess.move(move);
    const fenAfter = chess.fen();

    const evalResult = await engine.evaluate(fenAfter, movetimeMs);
    // Stockfish reports score from the side-to-move's perspective *after* the
    // move (i.e. the opponent's perspective). Flip to a White-relative score.
    const sideToMoveAfter = playerColor === 'w' ? 'b' : 'w';
    const whiteRelativeEval = sideToMoveAfter === 'w' ? evalResult.score : -evalResult.score;

    // Loss is measured from the mover's own perspective: how much the
    // position's value (for the side who just moved) dropped versus before.
    const evalBeforeForMover = playerColor === 'w' ? prevEval : -prevEval;
    const evalAfterForMover = playerColor === 'w' ? whiteRelativeEval : -whiteRelativeEval;
    const lossPawns = Math.max(0, evalBeforeForMover - evalAfterForMover);
    const classification = classifyLoss(Math.round(lossPawns * 100));
    const winPercentBefore = cpToWinPercent(evalBeforeForMover * 100);
    const winPercentAfter = cpToWinPercent(evalAfterForMover * 100);
    const accuracy = moveAccuracyFromWinPercent(winPercentBefore, winPercentAfter);

    const moveEntry = {
      moveNumber: Math.floor(i / 2) + 1,
      playerColor,
      san: move.san,
      whiteRelativeEval,
      classification,
      accuracy,
    };
    perMove.push(moveEntry);

    // suggestedFromPrevPosition was computed BEFORE this move was played, so
    // it's what the engine wanted instead of the move that was actually made.
    const betterMove = (suggestedFromPrevPosition && suggestedFromPrevPosition !== `${move.from}${move.to}`)
      ? suggestedFromPrevPosition
      : null;

    state.replay.positions.push({
      fen: fenAfter,
      moveNumber: moveEntry.moveNumber,
      playerColor,
      san: move.san,
      from: move.from,
      to: move.to,
      classification,
      whiteRelativeEval,
      betterMove,
    });

    prevEval = whiteRelativeEval;
    suggestedFromPrevPosition = evalResult.bestMove;

    // Live-advance the board/replay view as each move finishes analyzing.
    goToIndex(state.replay.positions.length - 1);

    const pct = Math.round(((i + 1) / history.length) * 100);
    el('progress').textContent = `${pct}%`;
    if (idx !== undefined) updateLoadingProgress(idx, pct);
  }

  const { w: whiteAccuracy, b: blackAccuracy } = gameAccuracy(state.replay.positions, perMove);
  const userAccuracy = orientation === 'w' ? whiteAccuracy : blackAccuracy;

  state.analysisCache.set(key, {
    positions: state.replay.positions,
    perMove,
    userAccuracy,
  });

  renderSummary(perMove, game, username, state.replay.positions);
  if (idx !== undefined) renderScoreCell(idx, userAccuracy);
  setStatus('Done.');
}

// ---------- Replay navigation ----------
function showReplay() {
  el('replay').classList.remove('hidden');
}

// The board orientation puts the selected chess.com user's pieces at the
// bottom (state.replay.orientation) — labels follow the same orientation so
// "you" always shows up on the bottom row, matching the board.
function updatePlayerLabels(selectedUsername) {
  const { white, black, orientation } = state.replay;
  const isSelectedWhite = selectedUsername && white.toLowerCase() === selectedUsername.toLowerCase();
  const isSelectedBlack = selectedUsername && black.toLowerCase() === selectedUsername.toLowerCase();

  const bottomIsWhite = orientation === 'w';
  const bottomName = bottomIsWhite ? white : black;
  const topName = bottomIsWhite ? black : white;
  const bottomIsSelected = bottomIsWhite ? isSelectedWhite : isSelectedBlack;
  const topIsSelected = bottomIsWhite ? isSelectedBlack : isSelectedWhite;

  const topEl = el('player-top');
  const bottomEl = el('player-bottom');

  topEl.innerHTML = `<span class="piece-dot ${bottomIsWhite ? 'black' : 'white'}"></span>${topName}${topIsSelected ? ' <span class="you-tag">(you)</span>' : ''}`;
  bottomEl.innerHTML = `<span class="piece-dot ${bottomIsWhite ? 'white' : 'black'}"></span>${bottomName}${bottomIsSelected ? ' <span class="you-tag">(you)</span>' : ''}`;

  topEl.classList.toggle('is-you', topIsSelected);
  bottomEl.classList.toggle('is-you', bottomIsSelected);
}

function goToIndex(idx) {
  const positions = state.replay.positions;
  if (positions.length === 0) return;
  const clamped = Math.max(0, Math.min(idx, positions.length - 1));
  state.replay.currentIndex = clamped;
  const pos = positions[clamped];

  renderBoard(pos.fen, { from: pos.from, to: pos.to }, state.replay.orientation);
  el('nav-position').textContent = `Move ${clamped} / ${positions.length - 1}`;
  el('nav-first').disabled = clamped === 0;
  el('nav-prev').disabled = clamped === 0;
  el('nav-next').disabled = clamped === positions.length - 1;
  el('nav-last').disabled = clamped === positions.length - 1;

  renderMovePanel(pos);
}

function renderMovePanel(pos) {
  const panel = el('move-panel');
  if (pos.moveNumber === 0) {
    panel.innerHTML = `<div class="mp-san">Starting position</div>
      <div class="mp-eval">Eval: ${pos.whiteRelativeEval.toFixed(2)} (white persp.)</div>`;
    return;
  }

  const sideLabel = pos.playerColor === 'w' ? state.replay.white : state.replay.black;
  panel.innerHTML = `
    <span class="mp-badge ${pos.classification}">${pos.classification}</span>
    <div class="mp-san">${pos.moveNumber}${pos.playerColor === 'w' ? '.' : '...'} ${pos.san} <small>(${sideLabel})</small></div>
    <div class="mp-eval">Eval: ${pos.whiteRelativeEval.toFixed(2)} (white persp.)</div>
    ${pos.betterMove ? `<div class="mp-suggestion">Engine preferred: ${pos.betterMove}</div>` : ''}
  `;
}

el('nav-first').addEventListener('click', () => goToIndex(0));
el('nav-prev').addEventListener('click', () => goToIndex(state.replay.currentIndex - 1));
el('nav-next').addEventListener('click', () => goToIndex(state.replay.currentIndex + 1));
el('nav-last').addEventListener('click', () => goToIndex(state.replay.positions.length - 1));

document.addEventListener('keydown', (e) => {
  if (el('replay').classList.contains('hidden')) return;
  if (e.key === 'ArrowLeft') goToIndex(state.replay.currentIndex - 1);
  if (e.key === 'ArrowRight') goToIndex(state.replay.currentIndex + 1);
});

function renderSummary(perMove, game, username, positions) {
  const white = game.white?.username || 'White';
  const black = game.black?.username || 'Black';

  const whiteMoves = perMove.filter((m) => m.playerColor === 'w');
  const blackMoves = perMove.filter((m) => m.playerColor === 'b');

  const counts = (moves) => {
    const c = { best: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 };
    for (const m of moves) c[m.classification]++;
    return c;
  };

  const { w: whiteAcc, b: blackAcc } = gameAccuracy(positions, perMove);
  const whiteCounts = counts(whiteMoves);
  const blackCounts = counts(blackMoves);

  const resultsEl = el('results');
  resultsEl.innerHTML = `
    <div class="summary-grid">
      <div class="player-col">
        <h3>${white}</h3>
        <div class="accuracy">${whiteAcc}%</div>
        ${renderCounts(whiteCounts)}
      </div>
      <div class="player-col">
        <h3>${black}</h3>
        <div class="accuracy">${blackAcc}%</div>
        ${renderCounts(blackCounts)}
      </div>
    </div>
    <div class="table-scroll">
      <table class="move-table">
        <thead><tr><th>#</th><th>Move</th><th>Side</th><th>Eval (white persp.)</th><th>Class</th></tr></thead>
        <tbody>
          ${perMove.map((m, i) => `
            <tr class="row-${m.classification} clickable-row" data-position-idx="${i + 1}">
              <td>${m.moveNumber}</td>
              <td>${m.san}</td>
              <td>${m.playerColor === 'w' ? 'White' : 'Black'}</td>
              <td>${m.whiteRelativeEval.toFixed(2)}</td>
              <td>${m.classification}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;

  resultsEl.querySelectorAll('.clickable-row').forEach((row) => {
    row.addEventListener('click', () => {
      goToIndex(parseInt(row.dataset.positionIdx, 10));
    });
  });
}

function renderCounts(counts) {
  return `
    <ul class="counts">
      <li><span class="dot best"></span>Best: ${counts.best}</li>
      <li><span class="dot good"></span>Good: ${counts.good}</li>
      <li><span class="dot inaccuracy"></span>Inaccuracy: ${counts.inaccuracy}</li>
      <li><span class="dot mistake"></span>Mistake: ${counts.mistake}</li>
      <li><span class="dot blunder"></span>Blunder: ${counts.blunder}</li>
    </ul>
  `;
}
