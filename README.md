# Blunderfish

Pull your recent chess.com games and get a real Stockfish-powered accuracy
score for each player, with a move-by-move replay board.

Live: https://srseshan.github.io/blunderfish/

## What it does

- Enter a chess.com username and fetch your recent game history (via
  chess.com's public, CORS-open API — no backend involved).
- Pick a game and it runs every move through a real Stockfish engine
  (compiled to WebAssembly, running in a Web Worker) at a chosen search
  depth — not a mock or an approximation.
- Each move gets classified (best / good / inaccuracy / mistake / blunder)
  based on how much it cost versus the engine's own top choice, and each
  player gets a 0–100% accuracy score for that game.
- A replay board lets you step through the game move by move, seeing the
  board, the eval, and — when relevant — what the engine would have played
  instead.

## Why no build step

This is a static site on purpose: three files (`index.html`, `app.js`,
`style.css`) plus a `vendor/` folder with the libraries it needs, vendored
locally instead of pulled from a CDN:

- [`chess.js`](https://github.com/jhlywa/chess.js) — PGN parsing and move
  stepping (MIT licensed).
- [`stockfish.js`](https://github.com/nmrugg/stockfish.js) — the official
  Stockfish engine compiled to WASM (GPLv3 licensed).
- The [Cburnett](https://github.com/lichess-org/lila/tree/master/public/piece/cburnett)
  piece set — the same open-source SVGs Lichess uses (CC BY-SA licensed).

No npm install, no bundler, no framework. That also means it deploys as-is
to GitHub Pages with nothing to build.

## Running it locally

Browsers block Web Workers and WASM loading from a bare `file://` page, so
open it through a local static server instead of double-clicking the HTML
file:

```
python3 serve.py
```

This serves the app at `http://127.0.0.1:8420` and opens it automatically.

## Notes

- First analysis in a session takes a few seconds longer since it's loading
  the ~7MB Stockfish WASM binary; it's cached by the browser after that.
- Analysis is genuinely sequential (one real engine search per move), so a
  higher depth setting or a longer game takes proportionally longer.
