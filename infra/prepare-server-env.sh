#!/usr/bin/env bash
set -euo pipefail

# 在服务器上生成只读部署配置和 Secret 挂载位。
# 随机值只写入权限为 0600 的文件，不写到终端输出。

APP_ROOT="${APP_ROOT:-/opt/turing-gate}"
SITE_ADDRESS="${SITE_ADDRESS:-}"
ACME_EMAIL="${ACME_EMAIL:-}"
QQ_SMTP_USER="${QQ_SMTP_USER:-}"
QQ_SMTP_FROM_NAME="${QQ_SMTP_FROM_NAME:-图灵测试}"
ENV_FILE="${APP_ROOT}/shared/env/infra.env"
SECRETS_DIR="${APP_ROOT}/shared/secrets"
SECRET_GROUP="${SECRET_GROUP:-docker}"

if [[ -z "${SITE_ADDRESS}" || "${SITE_ADDRESS}" != https://* ]]; then
  echo "SITE_ADDRESS 必须是 HTTPS Origin。" >&2
  exit 1
fi

if [[ ! "${ACME_EMAIL}" =~ ^[^[:space:]@]+@[^[:space:]@]+$ ]]; then
  echo "ACME_EMAIL 必须是有效联系邮箱，Caddy 证书配置不接受空值。" >&2
  exit 1
fi

if [[ ! "${QQ_SMTP_USER}" =~ ^[^[:space:]@]+@(qq\.com|foxmail\.com)$ ]]; then
  echo "QQ_SMTP_USER 必须是 QQ 或 Foxmail 邮箱地址。" >&2
  exit 1
fi

secret_gid="$(getent group "${SECRET_GROUP}" | cut -d: -f3)"
if [[ ! "${secret_gid}" =~ ^[0-9]+$ ]]; then
  echo "无法解析 Secret 读取组：${SECRET_GROUP}" >&2
  exit 1
fi

if [[ -e "${ENV_FILE}" ]]; then
  echo "配置文件已存在，拒绝覆盖：${ENV_FILE}" >&2
  exit 1
fi

install -d -m 0750 "$(dirname "${ENV_FILE}")"
install -d -m 0750 "${SECRETS_DIR}"
chgrp "${SECRET_GROUP}" "${SECRETS_DIR}"
chmod 0750 "${SECRETS_DIR}"
umask 077

postgres_password="$(openssl rand -hex 32)"
ban_identifier_pepper="$(openssl rand -hex 32)"
csrf_secret="$(openssl rand -hex 32)"
temporary_file="${ENV_FILE}.tmp"

cat >"${temporary_file}" <<EOF
SITE_ADDRESS=${SITE_ADDRESS}
ACME_EMAIL=${ACME_EMAIL}
HTTP_PORT=80
HTTPS_PORT=443

POSTGRES_USER=turing
POSTGRES_DB=turing
POSTGRES_PASSWORD=${postgres_password}

BAN_IDENTIFIER_PEPPER=${ban_identifier_pepper}
CSRF_SECRET=${csrf_secret}
ADMIN_PRINCIPALS_JSON=[]
DEEPSEEK_API_KEY_SECRET_FILE=${SECRETS_DIR}/deepseek_api_key.txt
QQ_SMTP_USER=${QQ_SMTP_USER}
QQ_SMTP_FROM_NAME=${QQ_SMTP_FROM_NAME}
QQ_SMTP_AUTH_CODE_SECRET_FILE=${SECRETS_DIR}/qq_smtp_auth_code.txt
SECRET_GID=${secret_gid}

REGISTRATION_OPEN=true
ALLOW_ONLINE_GUESTS=false
AI_MAX_CONCURRENCY=20
AI_HOURLY_REQUEST_LIMIT=1000
AI_DAILY_TOKEN_BUDGET=1000000
EOF

chmod 0600 "${temporary_file}"
mv "${temporary_file}" "${ENV_FILE}"

for secret_file in deepseek_api_key.txt qq_smtp_auth_code.txt; do
  if [[ ! -e "${SECRETS_DIR}/${secret_file}" ]]; then
    install -m 0640 /dev/null "${SECRETS_DIR}/${secret_file}"
  fi
  chgrp "${SECRET_GROUP}" "${SECRETS_DIR}/${secret_file}"
  chmod 0640 "${SECRETS_DIR}/${secret_file}"
done

echo "部署配置已生成：${ENV_FILE}"
echo "Secret 挂载位已准备：${SECRETS_DIR}"
echo "在两个 Secret 文件写入有效内容前，不要启动应用。"
