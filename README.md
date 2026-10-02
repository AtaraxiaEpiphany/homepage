# tulip

A full-page light terminal as the homepage, backed by a **real shell** (zsh + fzf + eza, running inside a disposable isolated container) — not a command simulation. Visual style follows [jyy's homepage](https://jiangyy.github.io/): one 80-column rounded frame on `#fafafa`, Maple Mono, CRT scanlines + vignette + smudge, minimal purple/blue/gray prompt — except this shell is real.

## Features

- **Full-page terminal**: xterm.js ↔ WebSocket ↔ node-pty ↔ containerized zsh. Terminal shortcuts work as-is: Ctrl-R (fzf history search), Tab (fzf-tab completion), Ctrl-A/E line editing, and the rest of your muscle memory.
- **`open <path>`**: opens documents in-page. Markdown renders with GFM, mermaid diagrams, KaTeX math, and syntax-highlighted code; anything else shows as `<pre>` text. Bare `open` launches an fzf fuzzy picker with bat previews. Esc closes and returns focus to the terminal.
- **`cat` / `ll` / etc.**: the container ships bat, eza, fd, fzf, with aliases matching a daily-driver setup.
- **`demo`**: AIGC-style typewriter tour of the basics. `Space` pauses/resumes, `q` or Ctrl-C quits.
- **Ctrl+Shift+P / ⌘⇧P**: VS Code-style command palette — fuzzy-search commands and `content/` files, shows recently opened; Enter routes markdown to the viewer, commands go to the real shell.
- **Welcome screen**: the old hero/sites/contact sections now print as the shell's motd — `tulip` word-art banner, tagline, sites, contacts, and key hints.
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
Container  container/Dockerfile  ubuntu:24.04 · zimfw + fzf + eza + bat + fd
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

Build notes:
- The image build runs with `network: host` (see `docker-compose.yml`): the default bridge network uses the Docker daemon's DNS, which is unreachable on some restricted networks; host networking inherits the host resolver. Runtime containers are unaffected (they run `--network none`).
- apt sources are swapped at build time by the [linuxmirrors](https://linuxmirrors.cn) script (`ARG UBUNTU_MIRROR=mirrors.aliyun.com`, over plain http since apt verifies via GPG-signed Release files). The script rewrites noble's deb822 `ubuntu.sources` — mirror domain, security suite, and all components (`main restricted universe multiverse`; the base image ships `main` only) — in one maintained place instead of hand-rolled sed rules. Override the mirror with `--build-arg UBUNTU_MIRROR=…` if you build elsewhere.
- Package and binary installation lives in `container/scripts/` (`apt-mirror.sh`, `install-utils.sh`), not inline in the Dockerfile — thin declarative layers, reviewable shell, and version pins (`FZF_VERSION`, `EZA_VERSION`) passed in as build args.

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
