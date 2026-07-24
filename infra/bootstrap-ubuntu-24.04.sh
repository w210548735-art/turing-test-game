#!/usr/bin/env bash
set -euo pipefail

# 腾讯云 Ubuntu 24.04 宿主机的一次性、可重复执行初始化脚本。
# 本脚本不接收、不读取也不输出任何业务密钥。

DEPLOY_USER="${DEPLOY_USER:-ubuntu}"
APP_ROOT="${APP_ROOT:-/opt/turing-gate}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "请使用 sudo 运行此脚本。" >&2
  exit 1
fi

if ! id "${DEPLOY_USER}" >/dev/null 2>&1; then
  echo "部署用户不存在：${DEPLOY_USER}" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update

if apt-cache show docker-compose-v2 >/dev/null 2>&1; then
  compose_package="docker-compose-v2"
elif apt-cache show docker-compose-plugin >/dev/null 2>&1; then
  compose_package="docker-compose-plugin"
else
  echo "Ubuntu 软件源中未找到 Docker Compose v2。" >&2
  exit 1
fi

apt-get install -y \
  ca-certificates \
  curl \
  git \
  jq \
  openssl \
  docker.io \
  "${compose_package}"

install -d -m 0755 /etc/docker
if [[ ! -e /etc/docker/daemon.json ]]; then
  cat >/etc/docker/daemon.json <<'JSON'
{
  "live-restore": true,
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
JSON
fi

systemctl enable --now docker
usermod -aG docker "${DEPLOY_USER}"

install -d -o "${DEPLOY_USER}" -g docker -m 0750 "${APP_ROOT}"
install -d -o "${DEPLOY_USER}" -g docker -m 0750 \
  "${APP_ROOT}/releases" \
  "${APP_ROOT}/shared" \
  "${APP_ROOT}/shared/env" \
  "${APP_ROOT}/backups"
install -d -o "${DEPLOY_USER}" -g docker -m 0750 \
  "${APP_ROOT}/shared/secrets"

systemctl is-active --quiet docker
docker version --format 'Docker Engine {{.Server.Version}}'
docker compose version

echo "宿主机初始化完成。重新登录 SSH 后，${DEPLOY_USER} 将获得 docker 组权限。"
