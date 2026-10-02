# homepage — terminal edition

A terminal-styled personal homepage backed by a **real shell** (zsh + fzf + eza + p10k, running inside a disposable isolated container) — not a command simulation.

## Features

- **Real terminal**: xterm.js ↔ WebSocket ↔ node-pty ↔ containerized zsh. Terminal shortcuts work as-is: Ctrl-R (fzf history search), Tab (fzf-tab completion), Ctrl-A/E line editing, and the rest of your muscle memory.
- **`open <path>`**: opens documents in-page. Markdown renders with GFM, mermaid diagrams, KaTeX math, and syntax-highlighted code; anything else shows as `<pre>` text. Bare `open` launches an fzf fuzzy picker with bat previews. Esc closes and returns focus to the terminal.
- **`cat` / `ll` / etc.**: the container ships bat, eza, fd, fzf, with aliases matching a daily-driver setup.
- **`demo`**: AIGC-style typewriter tour of the basics. `Space` pauses/resumes, `q` or Ctrl-C quits.
- **Ctrl+Shift+P**: VS Code-style command palette — fuzzy-search commands and `content/` files, shows recently opened; Enter routes markdown to the viewer, commands go to the real shell.
- **Page structure**: hero, other sites, contact links, terminal, footer (all placeholder content for now).
- When the backend is unreachable an offline overlay appears (startup hints + retry button), with exponential-backoff reconnects; reloading reattaches to a still-live session.

## Architecture

```
Browser (GitHub Pages, static)  apps/web    React 19 + Vite + @xterm/xterm
  │  WS  ws(s)://…/ws           JSON control frames + raw binary I/O frames
  │  HTTP /api/file /api/files  viewer content + file listing (same jail check)
  └─ OSC 7770                   `open` in the shell → in-page viewer
        │
Host  apps/shell-server          Fastify + @fastify/websocket + node-pty (Node 22)
  └─ one disposable container per WS session   docker run --rm homepage-shell
        │
Container  container/Dockerfile  ubuntu:24.04 · zimfw + p10k + fzf + eza + bat + fd
```

Sandboxing: each session gets `docker run --rm` with a `--read-only` rootfs, `--network none`, `--cap-drop ALL`, `no-new-privileges`, pids/mem/cpu limits, the content directory bind-mounted read-only, running as non-root. Path validation for `open` (jail + size cap) happens twice — in the shell function and at the HTTP layer — so a forged OSC gains nothing.

## Local development

Prerequisites: Node ≥ 22 (see `.nvmrc`) and Docker.

```sh
docker compose build shell     # build the container image (a few minutes)
npm install
npm run dev:server             # shell-server on :8787
npm run dev:web                # web on :5173, /ws and /api proxied to 8787
```

Open <http://localhost:5173/homepage/>.

Configuration lives in `.env.example` (shell-server env: port, `WS_TOKEN`, session limits, idle reaping, etc.).

## Deployment

The frontend deploys to GitHub Pages (base `/homepage/`):

1. Push to `main`; GitHub Actions (`.github/workflows/deploy.yml`) builds and publishes.
2. In the repo's *Settings → Secrets and variables → Actions → Variables*, set:
   - `VITE_WS_URL`: a reachable shell backend WebSocket URL (e.g. `wss://…/ws`)
   - `VITE_API_URL`: the matching HTTP URL (e.g. `https://…`)

The backend is a host process (it needs `docker run`), so Pages cannot host it — run it on a Docker-capable machine behind a wss-capable reverse proxy, with optional `WS_TOKEN`. Without those variables the site still deploys and just shows the offline overlay.

## Content

Markdown files under `content/` are what `open` and the command palette can open. They are mounted read-only at runtime, so editing content needs no image rebuild.

## Explicitly out of scope (post-MVP)

Warm container pools, public-facing auth/TLS termination (reverse proxy territory), tmux session persistence, deep mobile adaptation.
