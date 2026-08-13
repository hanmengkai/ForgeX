#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# shellcheck source=common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

mode="local"
public_origin=""
http_port="8080"
admin_username="super.admin"
admin_name="超级管理员"
generation_in_progress=0

cleanup_partial_configuration() {
  local status=$?
  trap - EXIT
  if ((status != 0 && generation_in_progress == 1)); then
    rm -f -- "${ENV_FILE}" "${RUNTIME_CONFIG_FILE}"
    printf '首次配置生成失败，已清理不完整的私有配置。\n' >&2
  fi
  exit "${status}"
}
trap cleanup_partial_configuration EXIT

usage() {
  cat <<'EOF'
用法：deploy.sh [选项]
  --mode local|production
  --public-origin https://forgex.example.com   production 必填
  --port 8080
  --admin-username super.admin
  --admin-name 超级管理员
EOF
}

while (($#)); do
  case "$1" in
    --mode) mode="${2:-}"; shift 2 ;;
    --public-origin) public_origin="${2:-}"; shift 2 ;;
    --port) http_port="${2:-}"; shift 2 ;;
    --admin-username) admin_username="${2:-}"; shift 2 ;;
    --admin-name) admin_name="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) printf '未知参数：%s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ "${mode}" == "local" || "${mode}" == "production" ]] || {
  printf -- '--mode 只能是 local 或 production。\n' >&2
  exit 2
}
[[ "${http_port}" =~ ^[0-9]+$ ]] && ((http_port >= 1 && http_port <= 65535)) || {
  printf -- '--port 必须是 1 到 65535。\n' >&2
  exit 2
}
[[ "${admin_username}" =~ ^[A-Za-z0-9._-]+$ ]] || {
  printf -- '--admin-username 只能包含字母、数字、点、下划线和连字符。\n' >&2
  exit 2
}
[[ "${admin_name}" != *$'\n'* && "${admin_name}" != *$'\r'* && "${admin_name}" != *'"'* && "${admin_name}" != *'\\'* && "${admin_name}" != *'|'* ]] || {
  printf -- '--admin-name 不能包含换行、双引号、反斜杠或竖线。\n' >&2
  exit 2
}

if [[ "${mode}" == "production" ]]; then
  [[ "${public_origin}" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]] || {
    printf 'production 模式必须提供不带路径的 HTTPS Origin，例如 https://forgex.example.com。\n' >&2
    exit 2
  }
  origin_authority="${public_origin#https://}"
  if [[ "${origin_authority}" == *:* ]]; then
    origin_port="${origin_authority##*:}"
    ((origin_port >= 1 && origin_port <= 65535)) || {
      printf 'HTTPS Origin 端口必须是 1 到 65535。\n' >&2
      exit 2
    }
  fi
elif [[ -n "${public_origin}" ]]; then
  printf 'local 模式不接受 --public-origin。\n' >&2
  exit 2
fi

assert_docker_ready
for required_command in curl od awk sed sha256sum mktemp; do
  require_command "${required_command}"
done

environment_exists=0
config_exists=0
if [[ -e "${ENV_FILE}" || -L "${ENV_FILE}" ]]; then
  [[ -f "${ENV_FILE}" && ! -L "${ENV_FILE}" ]] || {
    printf 'deploy/.env 必须是普通文件且不能是符号链接。\n' >&2
    exit 1
  }
  environment_exists=1
fi
if [[ -e "${RUNTIME_CONFIG_FILE}" || -L "${RUNTIME_CONFIG_FILE}" ]]; then
  [[ -f "${RUNTIME_CONFIG_FILE}" && ! -L "${RUNTIME_CONFIG_FILE}" ]] || {
    printf 'control-plane.json 必须是普通文件且不能是符号链接。\n' >&2
    exit 1
  }
  config_exists=1
fi
if ((environment_exists != config_exists)); then
  printf 'deploy/.env 与 deploy/config/control-plane.json 必须同时存在或同时缺失。\n' >&2
  exit 1
fi

bootstrap_password=""
if ((environment_exists == 0)); then
  generation_in_progress=1
  cp -- "${ENV_EXAMPLE_FILE}" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  database_password="$(generate_random_hex 32)"
  bootstrap_password="$(generate_random_hex 24)"
  set_env_value FORGEX_POSTGRES_PASSWORD "${database_password}"
  set_env_value FORGEX_DATABASE_URL "postgresql://forgex:${database_password}@postgres:5432/forgex"
  set_env_value FORGEX_BOOTSTRAP_ADMIN_USERNAME "${admin_username}"
  set_env_value FORGEX_BOOTSTRAP_ADMIN_NAME "${admin_name}"
  set_env_value FORGEX_BOOTSTRAP_ADMIN_PASSWORD "${bootstrap_password}"
  set_env_value FORGEX_HTTP_PORT "${http_port}"

  if [[ "${mode}" == "production" ]]; then
    cp -- "${DEPLOY_DIR}/config/control-plane.production.example.json" "${RUNTIME_CONFIG_FILE}"
    replace_config_value 'https://forgex.example.com' "${public_origin%/}"
    replace_config_value '生产产品负责人' "${admin_name}"
  else
    cp -- "${DEPLOY_DIR}/config/control-plane.example.json" "${RUNTIME_CONFIG_FILE}"
    replace_config_value 'http://localhost:8080' "http://localhost:${http_port}"
    replace_config_value '本地产品负责人' "${admin_name}"
  fi
  chmod 600 "${RUNTIME_CONFIG_FILE}"
  replace_config_value '22222222-2222-4222-8222-222222222222' "$(generate_uuid)"
  replace_config_value '33333333-3333-4333-8333-333333333333' "$(generate_uuid)"
  replace_config_value '44444444-4444-4444-8444-444444444444' "$(generate_uuid)"
  replace_config_value '11111111-1111-4111-8111-111111111111' "$(generate_uuid)"
  replace_config_value 'super.admin' "${admin_username}"
  config_hash="$(sha256sum "${RUNTIME_CONFIG_FILE}" | awk '{print $1}')"
  set_env_value FORGEX_CONTROL_PLANE_CONFIG_SHA256 "${config_hash}"
  generation_in_progress=0
else
  printf '检测到现有部署配置，将保留密码、标识与公开地址。\n'
fi

assert_forgex_configuration
compose config --quiet
compose up --build -d
port="$(env_value FORGEX_HTTP_PORT)"
wait_for_health "${port}"

if [[ -n "${bootstrap_password}" ]]; then
  printf '首次登录账号：%s\n' "${admin_username}"
  printf '首次登录密码：%s\n' "${bootstrap_password}"
  printf '请立即保存并登录修改密码；确认首个管理员已创建后，清空 deploy/.env 中的 FORGEX_BOOTSTRAP_ADMIN_PASSWORD。\n' >&2
fi
printf 'ForgeX 部署完成：http://localhost:%s\n' "${port}"
