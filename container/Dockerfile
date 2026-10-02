# debian:trixie-slim over ubuntu:24.04 — same apt ecosystem, ~half the base
# size, current packages (tmux 3.5, ripgrep 14, zoxide). glibc base keeps the
# vendored gnu builds (eza, gitstatusd) working; alpine/musl would not.
FROM debian:trixie-slim

ARG TARGETARCH
ARG FZF_VERSION=0.67.0
ARG EZA_VERSION=v0.23.5
ARG ZIMFW_URL=https://github.com/zimfw/zimfw/releases/latest/download/zimfw.zsh

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Asia/Shanghai \
    LANG=C.UTF-8

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      zsh git curl ca-certificates fd-find bat less procps time \
      tmux ripgrep jq zoxide \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/* /usr/share/info/*

# fzf: apt ships 0.44 (< 0.48, no `fzf --zsh`) — install the pinned release binary.
RUN curl -fsSL --retry 3 \
      "https://github.com/junegunn/fzf/releases/download/v${FZF_VERSION}/fzf-${FZF_VERSION}-linux_${TARGETARCH}.tar.gz" \
      | tar -xz -C /usr/local/bin && chmod 755 /usr/local/bin/fzf

# eza: no longer published as .deb — pinned release tarball (statically
# vendored libgit2, so `eza --git` works).
RUN curl -fsSL --retry 3 -o /tmp/eza.tgz \
      "https://github.com/eza-community/eza/releases/download/${EZA_VERSION}/eza_x86_64-unknown-linux-gnu.tar.gz" \
 && tar -xzf /tmp/eza.tgz -C /tmp \
 && install -m 755 /tmp/eza /usr/local/bin/eza \
 && rm -rf /tmp/eza /tmp/eza.tgz

# fd: apt installs as fdfind; the user's config expects `fd`.
# bat: Ubuntu installs as batcat, Debian as bat — shim whichever exists.
RUN ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && ln -s "$(command -v batcat 2>/dev/null || command -v bat)" /usr/local/bin/bat

# tmux: user's daily config, vendored system-wide (HOME is an ephemeral tmpfs
# at runtime, so ~/.tmux.conf would not survive).
COPY dotfiles/tmux/tmux.conf /etc/tmux.conf
COPY dotfiles/tmux/theme-dark.conf dotfiles/tmux/theme-light.conf /etc/tmux/
RUN chmod -R a+rX /etc/tmux.conf /etc/tmux

# Non-root shell user (debian slim has no uid-1000 user to clean up).
RUN useradd -m -u 1000 -s /usr/bin/zsh dev

# zimfw headless install: download once, run `init` (≡ install, but startup-
# tailored) against .zimrc → /opt/zim/init.zsh + 19 modules.
# .zimrc is copied alone first so later dotfiles edits don't re-run this layer.
ARG GITSTATUS_VERSION=v1.5.4
ENV ZIM_HOME=/opt/zim \
    ZIM_CONFIG_FILE=/opt/dotfiles/.zimrc \
    ZDOTDIR=/opt/dotfiles \
    GITSTATUS_CACHE_DIR=/opt/cache/gitstatus
COPY dotfiles/.zimrc /opt/dotfiles/.zimrc
RUN mkdir -p "$ZIM_HOME" \
 && curl -fsSL --retry 3 -o "$ZIM_HOME/zimfw.zsh" "$ZIMFW_URL" \
 && zsh -c 'source ${ZIM_HOME}/zimfw.zsh init' \
 && zsh -c 'source ${ZIM_HOME}/init.zsh' \
 && mkdir -p "$GITSTATUS_CACHE_DIR" \
 && curl -fsSL --retry 3 "https://github.com/romkatv/gitstatus/releases/download/${GITSTATUS_VERSION}/gitstatusd-linux-x86_64.tar.gz" \
      | tar -xz -C "$GITSTATUS_CACHE_DIR" \
 && test -x "$GITSTATUS_CACHE_DIR/gitstatusd-linux-x86_64"

# The rest of the config (rc files, p10k theme, shell functions).
COPY dotfiles/ /opt/dotfiles/
RUN chmod -R a+rX /opt/dotfiles

USER dev
WORKDIR /home/dev/content

CMD ["zsh", "-l"]
