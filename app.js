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
    this.worker.postMessage('isready');
  }

  // Runs `go depth N` on a FEN and resolves with { bestMove, score, isMate, mateIn }.
  // score is in pawns from the side-to-move's perspective (UCI cp / 100).
  evaluate(fen, depth = 14) {
    return new Promise((resolve) => {
      let lastScore = null;
      let lastIsMate = false;
      let lastMateIn = undefined;

      const onMessage = (e) => {
        const line = e.data;
        if (typeof line !== 'string') return;

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
      this.worker.postMessage(`go depth ${depth}`);
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
// White's perspective, and buckets the loss into a classification.
const CLASSIFICATION_WEIGHTS = {
  best: 1.0,
  good: 0.9,
  inaccuracy: 0.7,
  mistake: 0.4,
  blunder: 0.1,
};

function classifyLoss(centipawnLoss) {
  if (centipawnLoss <= 5) return 'best';
  if (centipawnLoss <= 30) return 'good';
  if (centipawnLoss <= 80) return 'inaccuracy';
  if (centipawnLoss <= 200) return 'mistake';
  return 'blunder';
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
        <tr><th>Date</th><th>Opponent</th><th>Time control</th><th>You played</th><th>Result</th><th></th></tr>
      </thead>
      <tbody>
        ${rows.map((r, i) => `
          <tr class="outcome-${r.outcome}">
            <td>${r.date}</td>
            <td>${r.opponent}</td>
            <td>${r.timeClass}</td>
            <td><span class="piece-dot ${r.color.toLowerCase()}"></span>${r.color}</td>
            <td><span class="badge badge-${r.outcome}">${r.outcome}</span></td>
            <td><button class="analyze-row-btn" data-idx="${i}">Analyze</button></td>
          </tr>`).join('')}
      </tbody>
    </table>
  `;

  wrap.querySelectorAll('.analyze-row-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx, 10);
      analyzeGame(games[idx], username);
    });
  });
}

async function analyzeGame(game, username) {
  const depth = parseInt(el('depth').value, 10) || 14;
  el('results').innerHTML = '';
  el('progress').textContent = '';

  const white = game.white?.username || 'White';
  const black = game.black?.username || 'Black';

  let chess;
  try {
    chess = new Chess();
    chess.loadPgn(game.pgn);
  } catch (err) {
    setStatus('Could not parse that game\'s PGN.');
    return;
  }

  const history = chess.history({ verbose: true });
  chess.reset();

  setStatus('Loading Stockfish (first run downloads ~7MB, then it\'s cached)...');
  const engine = await ensureEngine();
  setStatus(`Analyzing ${history.length} moves at depth ${depth}...`);

  // Reset replay state and show the starting position immediately.
  const startFen = chess.fen();
  const startEval = await engine.evaluate(startFen, depth); // white to move, so score is already white-relative
  const orientation = (username && black.toLowerCase() === username.toLowerCase()) ? 'b' : 'w';
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

    const evalResult = await engine.evaluate(fenAfter, depth);
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

    const moveEntry = {
      moveNumber: Math.floor(i / 2) + 1,
      playerColor,
      san: move.san,
      whiteRelativeEval,
      classification,
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
  }

  renderSummary(perMove, game, username);
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

function renderSummary(perMove, game, username) {
  const white = game.white?.username || 'White';
  const black = game.black?.username || 'Black';

  const whiteMoves = perMove.filter((m) => m.playerColor === 'w');
  const blackMoves = perMove.filter((m) => m.playerColor === 'b');

  const accuracy = (moves) => {
    if (moves.length === 0) return 0;
    const total = moves.reduce((sum, m) => sum + (CLASSIFICATION_WEIGHTS[m.classification] || 0), 0);
    return Math.round((total / moves.length) * 100);
  };

  const counts = (moves) => {
    const c = { best: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 };
    for (const m of moves) c[m.classification]++;
    return c;
  };

  const whiteAcc = accuracy(whiteMoves);
  const blackAcc = accuracy(blackMoves);
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
