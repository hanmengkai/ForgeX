#!/usr/bin/env bash

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DEPLOY_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
ENV_FILE="${DEPLOY_DIR}/.env"
ENV_EXAMPLE_FILE="${DEPLOY_DIR}/.env.example"
COMPOSE_FILE="${DEPLOY_DIR}/compose.yaml"
RUNTIME_CONFIG_FILE="${DEPLOY_DIR}/config/control-plane.json"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf '缺少命令：%s\n' "$1" >&2
    return 1
  }
}

assert_docker_ready() {
  require_command docker
  docker compose version >/dev/null
  docker info >/dev/null 2>&1 || {
    printf 'Docker Engine 未运行，或当前用户无权访问 Docker。\n' >&2
    return 1
  }
}

assert_forgex_configuration() {
  [[ -f "${ENV_FILE}" && ! -L "${ENV_FILE}" ]] || {
    printf '缺少 %s，请先运行 deploy/ubuntu/deploy.sh。\n' "${ENV_FILE}" >&2
    return 1
  }
  [[ -f "${RUNTIME_CONFIG_FILE}" && ! -L "${RUNTIME_CONFIG_FILE}" ]] || {
    printf '缺少 %s，请先运行 deploy/ubuntu/deploy.sh。\n' "${RUNTIME_CONFIG_FILE}" >&2
    return 1
  }
  local expected_hash
  local actual_hash
  expected_hash="$(env_value FORGEX_CONTROL_PLANE_CONFIG_SHA256)"
  actual_hash="$(sha256sum "${RUNTIME_CONFIG_FILE}" | awk '{print $1}')"
  [[ -n "${expected_hash}" && "${expected_hash}" == "${actual_hash}" ]] || {
    printf 'control-plane.json 摘要与 FORGEX_CONTROL_PLANE_CONFIG_SHA256 不一致。\n' >&2
    return 1
  }
}

compose() {
  docker compose -p forgex --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" "$@"
}

env_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "${ENV_FILE}" | tail -n 1
}

set_env_value() {
  local key="$1"
  local value="$2"
  local temporary
  temporary="$(mktemp "${ENV_FILE}.XXXXXX")"
  awk -v key="${key}" -v value="${value}" '
    BEGIN { updated = 0 }
    index($0, key "=") == 1 { print key "=" value; updated = 1; next }
    { print }
    END { if (!updated) print key "=" value }
  ' "${ENV_FILE}" >"${temporary}"
  chmod 600 "${temporary}"
  mv -f -- "${temporary}" "${ENV_FILE}"
}

generate_random_hex() {
  local byte_count="$1"
  od -An -N "${byte_count}" -tx1 /dev/urandom | tr -d ' \n'
}

generate_uuid() {
  local value
  value="$(generate_random_hex 16)"
  printf '%s-%s-4%s-8%s-%s\n' \
    "${value:0:8}" "${value:8:4}" "${value:13:3}" \
    "${value:17:3}" "${value:20:12}"
}

replace_config_value() {
  local search="$1"
  local replacement="$2"
  local escaped
  local temporary
  [[ "${replacement}" != *'|'* ]] || {
    printf '配置值不能包含竖线：%s\n' "${replacement}" >&2
    return 1
  }
  escaped="${replacement//\\/\\\\}"
  escaped="${escaped//&/\\&}"
  temporary="$(mktemp "${RUNTIME_CONFIG_FILE}.XXXXXX")"
  sed "s|${search}|${escaped}|g" "${RUNTIME_CONFIG_FILE}" >"${temporary}"
  chmod 600 "${temporary}"
  mv -f -- "${temporary}" "${RUNTIME_CONFIG_FILE}"
}

wait_for_health() {
  local port="$1"
  local timeout_seconds="${2:-120}"
  local elapsed=0
  local health_url="http://127.0.0.1:${port}/healthz"
  require_command curl
  while ((elapsed < timeout_seconds)); do
    if [[ "$(curl --silent --show-error --max-time 5 "${health_url}" 2>/dev/null || true)" == "ok" ]]; then
      printf 'ForgeX 已就绪：%s\n' "${health_url}"
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  compose ps >&2 || true
  printf 'ForgeX 在 %s 秒内未通过健康检查。\n' "${timeout_seconds}" >&2
  return 1
}
