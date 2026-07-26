# 部署指南

本仓库只提供通用部署模板，不记录真实生产环境信息。

## 基础依赖

- Ubuntu 24.04 LTS 或等价 Linux；
- Docker Engine 与 Docker Compose v2；
- 可持久化的 PostgreSQL、Redis 和 Caddy 数据卷；
- 指向服务器的正式域名以及可用的 80/443 端口。

## 配置

复制 `infra/.env.example` 为服务器外部的私有环境文件，并替换其中所有
`example.com` 与 `replace-with-*` 占位值。真实 Secret 放入服务器受权限
保护的 Secret 目录，不得提交到 Git。

```bash
docker compose \
  --env-file /path/to/private/infra.env \
  -f infra/docker-compose.yml \
  config
```

## 发布

1. 从已通过 CI 的提交生成不可变发布包；
2. 创建 PostgreSQL 自定义格式备份并记录在私有运维台账；
3. 构建 Server、Migrate 与 Web 镜像；
4. 使用真实环境变量执行 `caddy validate`；
5. 运行数据库迁移；
6. 依次重建 Server 与 Web，等待健康检查；
7. 验证 `/healthz`、`/api/ready`、静态资源与账户门禁；
8. 至少定期执行一次隔离恢复演练。

不要把真实 IP、账户邮箱、备份哈希、发布目录或凭据写入公开开发文档。
