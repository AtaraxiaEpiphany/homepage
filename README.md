# tulip

A full-page light terminal as the homepage, backed by a **real shell** (zsh + fzf + eza, running inside a disposable isolated container) — not a command simulation. Visual style follows [jyy's homepage](https://jiangyy.github.io/): one 80-column rounded frame on `#fafafa`, Maple Mono, CRT scanlines + vignette + smudge, minimal purple/blue/gray prompt — except this shell is real.

## Features

- **Full-page terminal**: xterm.js ↔ WebSocket ↔ node-pty ↔ containerized zsh. Terminal shortcuts work as-is: Ctrl-R (fzf history search), Tab (fzf-tab completion), Ctrl-A/E line editing, and the rest of your muscle memory (Ctrl+P excepted — the page keeps it for the palette).
- **`open <path>`**: opens documents in-page. Markdown renders with GFM, mermaid diagrams, KaTeX math, and syntax-highlighted code; anything else shows as `<pre>` text. Bare `open` launches an fzf fuzzy picker with bat previews. Esc closes and returns focus to the terminal.
- **`cat` / `ll` / etc.**: the container ships bat, eza, fd, fzf, with aliases matching a daily-driver setup. bat auto-switches its syntax theme with the terminal background (Coldark-Cold on the light page, Coldark-Dark in dark mode).
- **`demo`**: AIGC-style typewriter tour of the basics. `Space` pauses/resumes, `q` or Ctrl-C quits.
- **`theme dark` / `theme light`**: swaps the page and terminal palette live, persists the choice in `localStorage` (defaults to the OS preference). Also in the command palette.
- **`?cmd=<line>` deep link**: runs one command line once the shell is online — e.g. `/?cmd=open%20hello.md`. Length-capped, newline-stripped, and typed into the same jailed shell as ordinary keystrokes, so it grants no extra authority.
- **`status`**: prints live shell-server stats (sessions, uptime, image) into the terminal via a JSON control frame; the shell stays stateless.
- **Ctrl+P / Ctrl+Shift+P / ⌘P / ⌘⇧P**: VS Code-style command palette — fuzzy-search commands and `content/` files, shows recently opened; Enter routes markdown to the viewer, commands go to the real shell. Bound at the page level, so it works without focusing the terminal first. The page keeps Ctrl+P for the palette, so shell previous-history lives on ↑ / Ctrl-R (inside the fzf picker, navigate with the arrows or Ctrl-J/K).
- **Welcome screen**: the motd doubles as the site's hero — a one-line tagline and a quickstart (`open hello.md`, `demo`, `theme dark`, `status`) with the key hints, printed once per shell in English.
- When the backend is unreachable an offline overlay appears (startup hints + retry button), with exponential-backoff reconnects; reloading reattaches to a still-live session.
- **Concurrency ladder**: a warm pool pre-spawns shells so creates land in ~20ms; when capacity is full visitors queue in a waiting room (live position, fairness keyed by a per-browser token); per-IP floors throttle create spam, auth-failure lockout and connection caps; grace/idle timeouts tighten under saturation; `/api/metrics` exposes the counters. Pool shells count inside `MAX_SESSIONS`, so the worst-case host load is unchanged. With `BROKER_REDIS_URL` set, several hosts share one waiting room through redis — a saturated host's queued visitors are granted on whichever host drains next (see *Broker mode* below).
- **Demo replay fallback**: when the queue runs deep or admission rejects, the overlay plays `content/replay.cast` (asciinema v2, served from the content jail) into a small read-only terminal so waiting visitors see what the shell does; the cast is optional and deployments without one just skip it.

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

Sandboxing: each session gets `docker run --rm` with a `--read-only` rootfs, `--network none`, `--cap-drop ALL`, `no-new-privileges`, pids/mem/cpu limits, the content directory bind-mounted read-only, running as non-root. Path validation for `open` (jail + size cap) happens twice — in the shell function and at the HTTP layer — so a forged OSC gains nothing. Sessions are bound to a per-session secret issued at create; the id alone grants nothing.

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

Configuration lives in `.env.example` (shell-server env: port, bind host, `WS_TOKEN`, session limits, idle reaping, etc.).

## Deployment

The frontend deploys to GitHub Pages (base `/homepage/`):

1. Push to `main`; GitHub Actions (`.github/workflows/deploy.yml`) builds and publishes.
2. In the repo's *Settings → Secrets and variables → Actions → Variables*, set the build vars:

   | Variable          | Purpose                                                                                                       |
   | ----------------- | ------------------------------------------------------------------------------------------------------------- |
   | `VITE_WS_URL`     | Shell backend WebSocket URL (e.g. `wss://…/ws`); required unless only the broker is used.                      |
   | `VITE_API_URL`    | Matching HTTP base (e.g. `https://…`) for `/api/file*` and `/api/replay`.                                      |
   | `VITE_WS_TOKEN`   | Same value as the server's `WS_TOKEN` — private mode only; it ships in the bundle, so never for public sites.  |
   | `VITE_BROKER_URL` | Base URL of a broker-enabled host (`https://…`); enables the multi-host pre-flight. Optional — see below.       |

The backend is a host process (it needs `docker run`), so Pages cannot host it — run it on a Docker-capable machine behind a wss-capable reverse proxy. It has two auth modes:

- **Public mode** (default): `WS_TOKEN` unset. Every visitor gets a jailed shell. The server binds `127.0.0.1` and *refuses to start* on any wider `WS_HOST` without a token — put a local reverse proxy in front for TLS and public reachability.
- **Private mode**: `WS_TOKEN` set. Clients must send the token as the first WebSocket message (the legacy `?token=` query form is gone — it leaked the token into request logs); without it they see the offline overlay. Build the frontend with `VITE_WS_TOKEN` set to the same value. Caveat: that token is baked into the shipped JS bundle, so private mode only makes sense with private frontend hosting.

Without `VITE_WS_URL` the site still deploys and just shows the offline overlay.

### Broker mode (multi-host waiting room)

One host is a ceiling (`MAX_SESSIONS` per machine). To run several hosts behind
one public origin, point them all at a shared redis with `BROKER_REDIS_URL` —
each instance then joins the broker:

- **Capacity stays per-host.** Redis holds only the control plane: the global
  waiting-room queue (`hp:queue`), admission tickets (`hp:ticket:<t>`), visitor
  budgets (`hp:visitor:<id>`) and a presence heartbeat (`hp:hosts`, 5s tick, a
  host reads as gone after 15s). Session data-plane traffic stays
  client↔host WebSocket direct; session secrets never touch redis.
- **Any host drains when it has room.** A saturated host answers client
  preflights with a waiting-room ticket; whichever host finds local headroom
  next grants the ticket against *its own* capacity, stamping the ticket with
  its `HOST_PUBLIC_URL` (or none — clients then stay on the same public
  origin, which is what you want when a reverse proxy fronts all hosts).
- **The control plane is plain HTTP**: `POST /api/admit` →
  `{granted, ticket, endpoint}` or `{queued, ticket, position}`; the client
  then connects to the endpoint and opens its WS with `create{ticket}`, which
  the host redeems. `GET /api/queue/:ticket` polls position/grant;
  `GET /api/hosts` is an ops view of who is alive and how loaded. The two ops
  endpoints (`/api/hosts`, `/api/metrics`) are not public surface: they
  require `Authorization: Bearer <OPS_TOKEN>`, falling back to `WS_TOKEN`
  when `OPS_TOKEN` is unset. Set
  `CORS_ORIGINS` to the site's origin when you front the broker publicly —
  the API tightens from reflect-any to the allowlist the moment the variable
  is set.
- **Old clients keep working** unchanged: a WS `create` without a ticket falls
  back to the answering host's own hard cap and local waiting room.
- Dead hosts self-heal: their heartbeat ages out (≤20s), queue tickets expire,
  and leaked visitor-budget counters expire within an hour.

Locally, the two-host shape is:

```sh
docker run -d --rm -p 6399:6379 redis:7-alpine
BROKER_REDIS_URL=redis://127.0.0.1:6399 HOST_ID=a WS_PORT=8787 npm run start -w apps/shell-server
BROKER_REDIS_URL=redis://127.0.0.1:6399 HOST_ID=b WS_PORT=8788 npm run start -w apps/shell-server
```

The frontend's broker pre-flight (`VITE_BROKER_URL`) points at any
broker-enabled host; visitors then land on whichever host admits them,
and a page reload reattaches on the granting host directly. Without it,
direct-WS visitors still queue — just per-host.

## Content

Markdown files under `content/` are what `open` and the command palette can open. They are mounted read-only at runtime, so editing content needs no image rebuild.

## Explicitly out of scope (post-MVP)

Public-facing auth/TLS termination (reverse proxy territory), tmux session persistence, deep mobile adaptation. (Warm container pools shipped — see the concurrency ladder in Features.)
