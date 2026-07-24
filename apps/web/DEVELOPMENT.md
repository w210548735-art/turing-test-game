# 前端开发记录

## 2026-07-24 / Demo 0.1

状态：前端实现及 Cookie/CSRF 联调完成。

### 已完成

- 建立 React 19 + TypeScript + Vite 工程。
- 实现昵称和自定义思考状态设置。
- 实现容量排队、寻找对手和匹配成功后的统一 5 秒入场三个独立页面。
- 实现聊天消息、对方 typing 状态、自定义思考文案和消息序号去重。
- 实现开局 20 秒后才可提交的单次身份判断，以及置信度。
- 实现判断锁定、身份揭晓、对局数据和再来一局。
- 实现举报、主动离开、断线与重连状态提示。
- 实现线上 REST/WebSocket 传输和明确标记的本地演示传输。
- 完成瑞士网格、黑白与荧光绿视觉，适配移动端、键盘焦点及
  `prefers-reduced-motion`。
- 为入场状态、20 秒门槛和消息幂等添加单元测试。

### 接口约定

REST：

- `POST /api/session` → `{ userId, csrfToken, wsTicket, sessionExpiresAt }`，长期会话仅写入 HttpOnly Cookie
- `PUT /api/profile`，携带 Cookie 凭据和 `X-CSRF-Token`，请求体
  `{ nickname, typingStatus }`
- `POST /api/ws-ticket`，携带 Cookie 凭据和 `X-CSRF-Token`，返回一次性短期 Ticket

WebSocket：

- 地址：`/ws?ticket=<一次性短期票据>`
- 客户端：`match.join`、`match.cancel`、`chat.send`、
  `chat.typing_start/stop`、`guess.submit`、`game.report`、`game.leave`
- 服务端：`match.queued`、`match.searching`、`match.admission`、
  `match.progress`、`match.found`、
  `chat.message`、`chat.typing_start/stop`、`guess.accepted`、
  `game.finished`、`game.error`、`game.disconnected/reconnected`、
  `game.reported`

### 安全边界

- 前端不读取、不保存也不展示 DeepSeek Key。
- 昵称、思考状态和消息均有长度限制；React 默认转义显示用户文本。
- 举报提交后等待服务端确认，不在前端伪造成功。
- 网络失败会给出明确错误，并允许用户主动进入本地演示；本地演示在顶部标记
  `LOCAL DEMO`，不会与真实数据混淆。
- 后端已执行内容审核、组合频率限制、一次性 WebSocket Ticket 鉴权和举报证据留存。

### 联调记录

- 校验后端 `chat.message.sender` 使用 `self | opponent | system`。
- 校验后端时间字段为 ISO 字符串或毫秒时间戳。
- 确认服务端在 `guess.accepted` 中回传 `targetGuess`；前端也兼容不回传。
- 仓库级 `npm run typecheck`、118 项 `npm test` 与 `npm run build` 均已通过。
- 前端传输测试确认不持有长期 Session Token，Cookie 请求使用
  `credentials: include` 且修改请求携带 CSRF。
