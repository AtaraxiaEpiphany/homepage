#!/usr/bin/env bash
# Point the ubuntu:24.04 apt sources at the configured mirror before any
# network fetch happens — the base image's default sources
# (archive.ubuntu.com) can be unreachable from build environments, and the
# old bootstrap (update + curl install from defaults, then a mirror script)
# died whenever they were. A plain sed over the deb822 ubuntu.sources file
# needs no download at all: it rewrites both the archive and security URIs
# and enables universe (needed by the toolchain packages) in the same pass.
#
# Plain http by default: mirror TLS chains can be newer than the CA snapshot
# in the base image, and apt verifies everything via GPG-signed Release files.
#
# Knobs (build ARGs in the Dockerfile): UBUNTU_MIRROR, MIRROR_PROTOCOL.
set -Eeuo pipefail

sources=/etc/apt/sources.list.d/ubuntu.sources
mirror="${MIRROR_PROTOCOL:-http}://${UBUNTU_MIRROR:?UBUNTU_MIRROR not set}/ubuntu"

[[ -f $sources ]]
sed -i \
  -e "s|http://archive.ubuntu.com/ubuntu/|$mirror|g" \
  -e "s|http://security.ubuntu.com/ubuntu/|$mirror|g" \
  -e "s|^Components: main.*|Components: main universe restricted multiverse|" \
  "$sources"

apt-get update
apt-get install -y --no-install-recommends curl ca-certificates
