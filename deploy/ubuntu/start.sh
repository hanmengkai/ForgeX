#!/usr/bin/env bash
set -Eeuo pipefail

# shellcheck source=common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

assert_docker_ready
assert_forgex_configuration
compose up -d
wait_for_health "$(env_value FORGEX_HTTP_PORT)"
