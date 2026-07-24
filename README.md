# 人类，或 AI？

一个匿名文字聊天判断游戏 Demo。玩家经过统一的五秒入场校准后，与真人或 DeepSeek V4 Flash 驱动的 AI 聊天，并在倒计时内判断对方身份。

## 本地运行

要求 Node.js 22 或更高版本。

```bash
npm install
npm run dev
```

浏览器打开 `http://localhost:5173`。后端默认监听 `http://localhost:8787`。

账户联调使用被 `.gitignore` 排除的 `.env.qq-smtp.local`，授权码只通过
`QQ_SMTP_AUTH_CODE_FILE` 指向 `infra/secrets/` 内的只读文件，然后运行：

```bash
npm run dev:account
```

该模式开放邮箱注册并关闭线上游客 Session；页面中的“本地演示”仍可离线旁路。

DeepSeek 密钥按以下顺序读取：

1. `DEEPSEEK_API_KEY` 环境变量；
2. `DEEPSEEK_API_KEY_FILE` 指向的本地文件；
3. 本地开发时工作区根目录的 `新建 文本文档.txt`。

密钥不会下发到浏览器，也不会写入日志。第三种方式仅用于本地 Demo。

## 常用命令

```bash
npm run dev
npm run dev:account
npm run typecheck
npm test
npm run build
```

详细进度见 [DEVELOPMENT.md](./DEVELOPMENT.md)，游戏规则见 [docs/GAME_RULES.md](./docs/GAME_RULES.md)，安全方案见 [docs/SECURITY.md](./docs/SECURITY.md)。

## 封闭 Alpha 部署

受控部署使用 `infra/docker-compose.yml`：Caddy 提供 HTTPS/WSS，PostgreSQL 保存对局与审核数据，Redis 保存一次性 WebSocket 票据、AI 配额和断线补发状态。数据库迁移成功后服务才会启动，`/api/ready` 会同时检查 PostgreSQL、Redis 和 DeepSeek 配置。

当前匹配队列和连接路由仍按单个 server 实例设计；可用于小规模受邀测试，不能在未完成跨实例路由前直接水平扩容。部署步骤与上线前必填项见 [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)、[docs/PRIVACY.md](./docs/PRIVACY.md) 和 [docs/TERMS.md](./docs/TERMS.md)。

### Windows 本机 DNS 故障

若 Meta Tunnel 等代理把 `203-0-113-10.sslip.io` 解析到 `28.0.0.0/8`
虚拟地址并出现 `ERR_CONNECTION_CLOSED`，请在管理员 PowerShell 中运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\fix-local-test-dns.ps1
```

脚本只管理一条带标记的 hosts 记录，修改前会生成备份，并拒绝覆盖已有的
非托管同名记录。测试结束后可精确撤销：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\fix-local-test-dns.ps1 -Remove
```
