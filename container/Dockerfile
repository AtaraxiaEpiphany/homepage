# ubuntu:24.04 — glibc base keeps the vendored gnu builds (eza) working;
# alpine/musl would not. Package and binary installation lives in
# container/scripts/ (netshoot-style: thin declarative Dockerfile, COPY a
# script and run it) so the toolchain stays reviewable and cache-friendly:
# each script is its own layer, so bumping fzf below doesn't redo apt.
FROM ubuntu:24.04

# Build-time knobs, passed to the scripts as environment variables.
ARG UBUNTU_MIRROR=mirrors.aliyun.com
ARG MIRROR_PROTOCOL=http
ARG FZF_VERSION=0.67.0
ARG EZA_VERSION=v0.23.5
# BuildKit sets TARGETARCH itself (fzf tarball flavor in install-utils.sh).
ARG TARGETARCH
ARG ZIMFW_URL=https://github.com/zimfw/zimfw/releases/latest/download/zimfw.zsh

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Asia/Shanghai \
    LANG=C.UTF-8

# Point apt at a fast mirror (the linuxmirrors project script — understands
# noble's deb822 ubuntu.sources, covers the security suite, enables universe).
COPY container/scripts/apt-mirror.sh /tmp/apt-mirror.sh
RUN chmod +x /tmp/apt-mirror.sh && /tmp/apt-mirror.sh

# System packages, pinned fzf/eza binaries, fd/bat shims, layer cleanup.
COPY container/scripts/install-utils.sh /tmp/install-utils.sh
RUN chmod +x /tmp/install-utils.sh && /tmp/install-utils.sh

# tmux: user's daily config, vendored system-wide (HOME is an ephemeral tmpfs
# at runtime, so ~/.tmux.conf would not survive).
COPY dotfiles/tmux/tmux.conf /etc/tmux.conf
COPY dotfiles/tmux/theme-dark.conf dotfiles/tmux/theme-light.conf /etc/tmux/
RUN chmod -R a+rX /etc/tmux.conf /etc/tmux

# Non-root shell user "tulip" (uid 1000, what the shell-server runs as) —
# ubuntu:24.04 ships an 'ubuntu' user at that uid; drop it and reuse it.
RUN userdel -r ubuntu 2>/dev/null; useradd -m -u 1000 -s /usr/bin/zsh tulip

# zimfw headless install: download once, run `init` (≡ install, but startup-
# tailored) against .zimrc → /opt/zim/init.zsh + 14 modules.
# .zimrc is copied alone first so later dotfiles edits don't re-run this layer.
ENV ZIM_HOME=/opt/zim \
    ZIM_CONFIG_FILE=/opt/dotfiles/.zimrc \
    ZDOTDIR=/opt/dotfiles
COPY dotfiles/.zimrc /opt/dotfiles/.zimrc
RUN mkdir -p "$ZIM_HOME" \
 && curl -fsSL --retry 3 -o "$ZIM_HOME/zimfw.zsh" "$ZIMFW_URL" \
 && zsh -c 'source ${ZIM_HOME}/zimfw.zsh init' \
 && zsh -c 'source ${ZIM_HOME}/init.zsh'

# The rest of the config (rc files, welcome screen, shell functions).
COPY dotfiles/ /opt/dotfiles/
RUN chmod -R a+rX /opt/dotfiles

USER tulip
WORKDIR /home/tulip/content

CMD ["zsh", "-l"]
