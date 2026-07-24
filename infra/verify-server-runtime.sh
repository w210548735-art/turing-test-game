#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/turing-gate}"
ENV_FILE="${APP_ROOT}/shared/env/infra.env"
SECRETS_DIR="${APP_ROOT}/shared/secrets"

failures=0

check() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    printf '[通过] %s\n' "${label}"
  else
    printf '[失败] %s\n' "${label}" >&2
    failures=$((failures + 1))
  fi
}

check "Docker 服务运行中" systemctl is-active --quiet docker
check "Docker Engine 可用" docker info
check "Docker Compose v2 可用" docker compose version
check "部署配置存在" test -s "${ENV_FILE}"
check "部署配置权限为 0600" test "$(stat -c '%a' "${ENV_FILE}")" = "600"
check "Secret 读取组已配置" grep -Eq '^SECRET_GID=[0-9]+$' "${ENV_FILE}"
check "Secret 目录权限为 0750" test "$(stat -c '%a' "${SECRETS_DIR}")" = "750"
check "DeepSeek Secret 权限为 0640" test "$(stat -c '%a' "${SECRETS_DIR}/deepseek_api_key.txt")" = "640"
check "QQ SMTP Secret 权限为 0640" test "$(stat -c '%a' "${SECRETS_DIR}/qq_smtp_auth_code.txt")" = "640"
check "DeepSeek Secret 已写入" test -s "${SECRETS_DIR}/deepseek_api_key.txt"
check "QQ SMTP Secret 已写入" test -s "${SECRETS_DIR}/qq_smtp_auth_code.txt"
check "80 端口当前未被占用" bash -c "! ss -H -ltn '( sport = :80 )' | grep -q ."
check "443 端口当前未被占用" bash -c "! ss -H -ltn '( sport = :443 )' | grep -q ."

if [[ "${failures}" -ne 0 ]]; then
  echo "运行环境检查发现 ${failures} 项未通过。" >&2
  exit 1
fi

echo "服务器运行环境检查全部通过。"
