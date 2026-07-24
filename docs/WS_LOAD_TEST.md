# WebSocket 分级负载测试

`tools/ws-load-test.mjs` 通过真实游客链路创建会话、更新资料、消费一次性
WebSocket ticket，并统计 `match.searching`、`match.admission` 和
`match.found` 的成功率与延迟。

## 安全边界

- 默认目标是 `http://127.0.0.1:8787`，建议只在本机开发服务上运行。
- 工具不会自动读取部署配置，也不会默认连接线上域名。
- 非 localhost 目标必须同时提供与 URL 精确一致的 `--allow-host`，以及
  `--confirm-non-production=I_CONFIRM_TEST_TARGET`。
- 上述确认只应用于明确获准的测试环境，禁止用于生产域名或第三方服务。
- 工具完成匹配后立即关闭连接，不发送聊天、判断或举报内容。

## 使用方式

先启动本地服务：

```powershell
$env:NODE_ENV = "development"
$env:ALLOWED_ORIGINS = "http://localhost:5173"
npm run dev --workspace apps/server
```

另开终端依次执行：

```powershell
npm run load:ws -- --connections=10
npm run load:ws -- --connections=50 --ramp-ms=2000
npm run load:ws -- --connections=100 --ramp-ms=5000 --timeout-ms=45000
npm run load:ws -- --connections=200 --ramp-ms=10000 --timeout-ms=60000
```

也可以让工具临时启动并在测试后关闭本地服务：

```powershell
npm run load:ws -- --connections=60 --start-local-server
```

建议逐级执行 10、50、100、200，上一档成功率和资源占用正常后再进入下一档。
输出包括连接成功率、会话到连接，以及加入匹配到搜索、入场和匹配完成的
p50、p95、最大耗时。任一连接失败时进程退出码为 1，并最多展示前 20 个错误。

单一来源地址会受到真实的组合限流保护。默认策略下，同一 IP 在短时间创建
超过 10 个游客会话会得到 `429 RATE_LIMITED`；这表示限流正常工作，不能据此
宣称已完成 50+ 连接容量验收。50、100、200 档必须在隔离的非生产环境中，
使用多个受控来源地址或预先准备的测试账户执行，并同时采集服务端 CPU、内存、
事件循环、PostgreSQL 与 Redis 指标。不得为了让压测通过而降低生产限流。

明确获准的非生产测试环境示例：

```powershell
npm run load:ws -- --connections=50 --target=https://staging.example.test `
  --allow-host=staging.example.test `
  --confirm-non-production=I_CONFIRM_TEST_TARGET
```
