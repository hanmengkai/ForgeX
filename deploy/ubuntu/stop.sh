#!/usr/bin/env bash
set -Eeuo pipefail

# shellcheck source=common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

assert_docker_ready
assert_forgex_configuration
compose stop
printf 'ForgeX 已停止，PostgreSQL 数据卷已保留。\n'
