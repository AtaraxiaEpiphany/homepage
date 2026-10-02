#!/usr/bin/env bash
# Swap the ubuntu:24.04 apt sources to a fast mirror with the linuxmirrors
# project script (same approach as ~/Workspaces/git/netshoot) instead of
# hand-maintained sed rules: the script understands noble's deb822
# ubuntu.sources, points the security suite at the mirror too, and enables
# main restricted universe multiverse (the base image ships main only).
#
# Plain http by default: mirror TLS chains can be newer than the CA snapshot
# in the base image, and apt verifies everything via GPG-signed Release files.
#
# Knobs (build ARGs in the Dockerfile): UBUNTU_MIRROR, MIRROR_PROTOCOL.
set -Eeuo pipefail

# curl isn't in the base image, so this bootstrap update hits the slow
# default sources once; the linuxmirrors run below rewrites them.
apt-get update
apt-get install -y --no-install-recommends curl ca-certificates

# Non-interactive via documented flags: no backup prompt, no package
# upgrade, keep lists (the install script below updates them itself).
curl -fsSL https://linuxmirrors.cn/main.sh | bash -s -- \
  --source "${UBUNTU_MIRROR:?UBUNTU_MIRROR not set}" \
  --protocol "${MIRROR_PROTOCOL:-http}" \
  --backup false \
  --updata-software false \
  --clean-cache false \
  --ignore-backup-tips
