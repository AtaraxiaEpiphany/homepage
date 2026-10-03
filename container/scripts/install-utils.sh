#!/usr/bin/env bash
# System packages, pinned binaries, and command shims for the tulip shell
# image. Split from the Dockerfile (netshoot-style: COPY one script, RUN it)
# so the toolchain lives in reviewable shell instead of a 50-line RUN.
#
# Knobs (build ARGs in the Dockerfile): FZF_VERSION, EZA_VERSION, BAT_VERSION;
# TARGETARCH selects the fzf/bat tarball flavor (BuildKit sets it automatically).
set -Eeuo pipefail

# --- apt packages -----------------------------------------------------------
# ubuntu:24.04 ships tmux 3.4, ripgrep 14.1, zoxide 0.9.4 — all adequate.
# fzf is NOT installed here: apt's 0.44 predates `fzf --zsh`; pinned below.
# bat is NOT installed here either: apt's 0.24 predates dual-theme
# auto-switching (--theme dark:…,light:…); pinned below.
apt-get update
apt-get install -y --no-install-recommends \
  zsh git curl ca-certificates fd-find less procps time \
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

# --- bat: pinned release binary (dual-theme syntax needs ≥ 0.25) ------------
# Asset flavor follows the fzf pattern: TARGETARCH (amd64/aarch64) maps to
# the rust target triple.
case "${TARGETARCH:?}" in
  amd64) _bat_arch=x86_64 ;;
  arm64) _bat_arch=aarch64 ;;
  *) echo "install-utils: unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;;
esac
curl -fsSL --retry 3 -o /tmp/bat.tgz \
  "https://github.com/sharkdp/bat/releases/download/${BAT_VERSION:?}/bat-${BAT_VERSION}-${_bat_arch}-unknown-linux-gnu.tar.gz"
tar -xzf /tmp/bat.tgz -C /tmp
install -m 755 "/tmp/bat-${BAT_VERSION}-${_bat_arch}-unknown-linux-gnu/bat" /usr/local/bin/bat
rm -rf "/tmp/bat-${BAT_VERSION}-${_bat_arch}-unknown-linux-gnu" /tmp/bat.tgz

# --- shims ------------------------------------------------------------------
# fd: apt installs as fdfind; the user's config expects `fd`.
ln -s /usr/bin/fdfind /usr/local/bin/fd

# --- same-layer cleanup: keep lists and docs out of the image layer ---------
rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/* /usr/share/info/*
