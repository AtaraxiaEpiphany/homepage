#!/usr/bin/env bash
# System packages, pinned binaries, and command shims for the tulip shell
# image. Split from the Dockerfile (netshoot-style: COPY one script, RUN it)
# so the toolchain lives in reviewable shell instead of a 50-line RUN.
#
# Knobs (build ARGs in the Dockerfile): FZF_VERSION, EZA_VERSION; TARGETARCH
# selects the fzf tarball flavor (BuildKit sets it automatically).
set -Eeuo pipefail

# --- apt packages -----------------------------------------------------------
# ubuntu:24.04 ships tmux 3.4, ripgrep 14.1, zoxide 0.9.4 — all adequate.
# fzf is NOT installed here: apt's 0.44 predates `fzf --zsh`; pinned below.
apt-get update
apt-get install -y --no-install-recommends \
  zsh git curl ca-certificates fd-find bat less procps time \
  tmux ripgrep jq zoxide

# --- fzf: pinned release binary (apt's 0.44 lacks `fzf --zsh`) --------------
curl -fsSL --retry 3 \
  "https://github.com/junegunn/fzf/releases/download/v${FZF_VERSION:?}/fzf-${FZF_VERSION}-linux_${TARGETARCH:?}.tar.gz" \
  | tar -xz -C /usr/local/bin
chmod 755 /usr/local/bin/fzf

# --- eza: no longer published as .deb — pinned release tarball --------------
# (statically vendored libgit2, so `eza --git` works).
curl -fsSL --retry 3 -o /tmp/eza.tgz \
  "https://github.com/eza-community/eza/releases/download/${EZA_VERSION:?}/eza_x86_64-unknown-linux-gnu.tar.gz"
tar -xzf /tmp/eza.tgz -C /tmp
install -m 755 /tmp/eza /usr/local/bin/eza
rm -rf /tmp/eza /tmp/eza.tgz

# --- shims ------------------------------------------------------------------
# fd: apt installs as fdfind; the user's config expects `fd`.
# bat: Ubuntu installs as batcat, Debian as bat — shim whichever exists.
ln -s /usr/bin/fdfind /usr/local/bin/fd
ln -s "$(command -v batcat 2>/dev/null || command -v bat)" /usr/local/bin/bat

# --- same-layer cleanup: keep lists and docs out of the image layer ---------
rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/* /usr/share/info/*
