# TURING? Web Demo

匿名真人 / AI 判断游戏的 React 前端 Demo。界面遵循 Minimalism & Swiss Style，
支持线上 REST + WebSocket 和完全本地的演示模式。

## 启动

```bash
npm install
npm run dev
```

默认请求同源接口。分离部署时可创建 `.env.local`：

```dotenv
VITE_API_BASE=http://127.0.0.1:3000
VITE_WS_URL=ws://127.0.0.1:3000
```

`VITE_WS_URL` 只填写协议、域名和可选端口，不包含 `/ws`。DeepSeek API Key
只能由后端读取，绝不能写进 `VITE_*` 环境变量或浏览器代码。

## 验证

```bash
npm run typecheck
npm test
npm run build
```

如果后端未启动，首页可直接选择“本地演示”。本地演示不会发出外部网络请求，
仍会完整执行固定 5 秒入场和 20 秒判断门槛。
