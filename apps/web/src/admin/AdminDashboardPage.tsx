import type { AdminDashboardResponse } from "@turing-game/protocol";

function compact(value: number): string {
  return new Intl.NumberFormat("zh-CN", {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

function percentChange(current: number, previous: number): string {
  if (previous === 0) return current === 0 ? "持平" : "新增";
  const delta = ((current - previous) / previous) * 100;
  return `${delta >= 0 ? "↑" : "↓"} ${Math.abs(delta).toFixed(0)}%`;
}

function safeRatio(value: number, total: number): number {
  return total > 0 ? Math.min(1, Math.max(0, value / total)) : 0;
}

function points(values: readonly number[], width = 320, height = 88): string {
  const maximum = Math.max(...values, 1);
  return values
    .map((value, index) => {
      const x = 8 + (index / Math.max(values.length - 1, 1)) * (width - 16);
      const y = height - 8 - (value / maximum) * (height - 20);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function GrowthChart({ data }: { data: AdminDashboardResponse }) {
  const recentTotal = data.daily.reduce(
    (sum, item) => sum + item.registrations,
    0,
  );
  let cumulative = Math.max(
    0,
    data.metrics.registeredUsers - recentTotal,
  );
  const values = data.daily.map((item) => {
    cumulative += item.registrations;
    return cumulative;
  });
  return (
    <section className="admin-chart admin-growth-chart" tabIndex={0}>
      <header>
        <div>
          <span>GROWTH / 7 DAYS</span>
          <h2>注册用户</h2>
        </div>
        <strong>{compact(data.metrics.registeredUsers)}</strong>
      </header>
      <div className="admin-chart-meta">
        <span>今日 +{data.metrics.newUsersToday}</span>
        <b>
          {percentChange(
            data.metrics.newUsers7d,
            data.metrics.previous7dUsers,
          )}{" "}
          较前 7 日
        </b>
      </div>
      <svg
        viewBox="0 0 320 88"
        role="img"
        aria-label="近 7 日注册趋势"
      >
        <title>当前注册总数 {data.metrics.registeredUsers}</title>
        <line x1="8" y1="80" x2="312" y2="80" />
        <polyline points={points(values)} />
        {points(values)
          .split(" ")
          .map((point, index) => {
            const [cx, cy] = point.split(",");
            return (
              <circle
                key={data.daily[index]?.date}
                cx={cx}
                cy={cy}
                r="2.6"
              >
                <title>
                  {data.daily[index]?.date}：累计 {values[index] ?? 0} 位用户
                </title>
              </circle>
            );
          })}
      </svg>
    </section>
  );
}

function VisitsChart({ data }: { data: AdminDashboardResponse }) {
  const values = data.daily.map((item) => item.visits);
  return (
    <section className="admin-chart admin-visits-chart" tabIndex={0}>
      <header>
        <div>
          <span>VISITS / SESSION</span>
          <h2>访问情况</h2>
        </div>
        <strong>{compact(data.metrics.visits7d)}</strong>
      </header>
      <div className="admin-chart-meta">
        <span>今日 {data.metrics.visitsToday}</span>
        <b>
          {percentChange(
            data.metrics.visits7d,
            data.metrics.previous7dVisits,
          )}{" "}
          较前 7 日
        </b>
      </div>
      <svg
        viewBox="0 0 320 88"
        role="img"
        aria-label="近 7 日访问趋势"
      >
        {values.map((value, index) => {
          const x = 8 + (index / 6) * 304;
          return (
            <line
              key={data.daily[index]?.date}
              className="visit-tick"
              x1={x}
              x2={x}
              y1={80}
              y2={Math.max(18, 80 - value * 3)}
            />
          );
        })}
        <polyline points={points(values)} />
        {points(values)
          .split(" ")
          .map((point, index) => {
            const [cx, cy] = point.split(",");
            return (
              <circle
                key={data.daily[index]?.date}
                cx={cx}
                cy={cy}
                r="2.6"
              >
                <title>
                  {data.daily[index]?.date}：{values[index] ?? 0} 次访问
                </title>
              </circle>
            );
          })}
      </svg>
    </section>
  );
}

function TokenGauge({ data }: { data: AdminDashboardResponse }) {
  const ratio = Math.min(
    1,
    data.metrics.tokensToday / data.metrics.tokenBudgetToday,
  );
  return (
    <section className="admin-chart admin-token-chart" tabIndex={0}>
      <header>
        <div>
          <span>AI BUDGET / TODAY</span>
          <h2>Token 消耗</h2>
        </div>
        <strong>{Math.round(ratio * 100)}%</strong>
      </header>
      <div
        className="token-gauge"
        title={`${data.metrics.tokensToday} / ${data.metrics.tokenBudgetToday} Token`}
        role="meter"
        aria-label="今日 Token 预算使用率"
        aria-valuemin={0}
        aria-valuemax={data.metrics.tokenBudgetToday}
        aria-valuenow={data.metrics.tokensToday}
      >
        <i style={{ width: `${ratio * 100}%` }} />
        {Array.from({ length: 11 }, (_, index) => (
          <span key={index} style={{ left: `${index * 10}%` }} />
        ))}
      </div>
      <div className="admin-chart-meta">
        <span>{compact(data.metrics.tokensToday)} 已使用</span>
        <b>{compact(data.metrics.tokenBudgetToday)} 日预算</b>
      </div>
    </section>
  );
}

function MetricCard({
  code,
  label,
  value,
  note,
  live = false,
}: {
  code: string;
  label: string;
  value: number;
  note: string;
  live?: boolean;
}) {
  return (
    <article className="admin-metric-card" tabIndex={0}>
      <header>
        <span className={live ? "is-live" : ""}>{code}</span>
        <i aria-hidden="true">↗</i>
      </header>
      <strong>{compact(value)}</strong>
      <h2>{label}</h2>
      <p>{note}</p>
    </article>
  );
}

function OperationsInsights({ data }: { data: AdminDashboardResponse }) {
  const verifiedRatio = safeRatio(
    data.metrics.verifiedUsers,
    data.metrics.registeredUsers,
  );
  const totalKnownGames =
    data.metrics.humanGames + data.metrics.aiGames;
  const humanRatio = safeRatio(
    data.metrics.humanGames,
    totalKnownGames,
  );
  const roomRatio = safeRatio(
    data.metrics.activeGames,
    data.metrics.roomCapacity,
  );
  const pendingItems =
    data.metrics.pendingFeedback + data.metrics.pendingReports;

  return (
    <div className="admin-insight-grid">
      <article className="admin-insight is-account" tabIndex={0}>
        <header>
          <span>ACCOUNT HEALTH</span>
          <h2>账户健康</h2>
          <strong>{Math.round(verifiedRatio * 100)}%</strong>
        </header>
        <div
          className="admin-segment-bar"
          role="progressbar"
          aria-label="账户邮箱验证率"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(verifiedRatio * 100)}
        >
          <i style={{ width: `${verifiedRatio * 100}%` }} />
        </div>
        <dl>
          <div><dt>已验证</dt><dd>{data.metrics.verifiedUsers}</dd></div>
          <div><dt>待验证</dt><dd>{data.metrics.pendingVerificationUsers}</dd></div>
          <div><dt>活跃会话</dt><dd>{data.metrics.activeSessions}</dd></div>
        </dl>
      </article>

      <article className="admin-insight is-match" tabIndex={0}>
        <header>
          <span>MATCH PULSE</span>
          <h2>匹配态势</h2>
          <strong>{Math.round(roomRatio * 100)}%</strong>
        </header>
        <div
          className="admin-game-mix"
          role="img"
          aria-label={`真人对局 ${data.metrics.humanGames}，AI 对局 ${data.metrics.aiGames}`}
        >
          <i style={{ width: `${humanRatio * 100}%` }} />
          <b style={{ width: `${(1 - humanRatio) * 100}%` }} />
        </div>
        <dl>
          <div><dt>等待玩家</dt><dd>{data.metrics.waitingPlayers}</dd></div>
          <div><dt>入场玩家</dt><dd>{data.metrics.admittingPlayers}</dd></div>
          <div><dt>房间容量</dt><dd>{data.metrics.roomCapacity}</dd></div>
        </dl>
        <p>
          真人 {data.metrics.humanGames} · AI {data.metrics.aiGames}
        </p>
      </article>

      <article className="admin-insight is-ops" tabIndex={0}>
        <header>
          <span>OPERATIONS INBOX</span>
          <h2>运营待办</h2>
          <strong>{pendingItems}</strong>
        </header>
        <div className="admin-inbox-signal" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <dl>
          <div><dt>待处理反馈</dt><dd>{data.metrics.pendingFeedback}</dd></div>
          <div><dt>待处理举报</dt><dd>{data.metrics.pendingReports}</dd></div>
          <div><dt>可用回声</dt><dd>{data.metrics.savedEchoArchives}</dd></div>
        </dl>
      </article>
    </div>
  );
}

export function AdminDashboardPage({
  data,
  loading,
  error,
  onBack,
  onRefresh,
}: {
  data: AdminDashboardResponse | null;
  loading: boolean;
  error: string | null;
  onBack: () => void;
  onRefresh: () => void;
}) {
  return (
    <section className="admin-dashboard-page view-page-enter">
      <header className="admin-dashboard-header">
        <button type="button" className="record-back" onClick={onBack}>
          ← 返回账户设置
        </button>
        <div>
          <p>ROOT / OPERATIONS</p>
          <h1>运营后台</h1>
          <span>仅 ROOT 账户可见</span>
        </div>
        <button
          type="button"
          className="admin-refresh"
          disabled={loading}
          onClick={onRefresh}
        >
          {loading ? "刷新中…" : "刷新数据"}
        </button>
      </header>

      {error && (
        <div className="admin-dashboard-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={onRefresh}>重试</button>
        </div>
      )}

      {!data && loading && (
        <div className="admin-dashboard-loading" role="status">
          正在整理运营数据…
        </div>
      )}

      {data && (
        <>
          <div className="admin-primary-grid">
            <GrowthChart data={data} />
            <VisitsChart data={data} />
            <TokenGauge data={data} />
          </div>
          <div className="admin-metric-grid">
            <MetricCard
              code="LIVE"
              label="在线人数"
              value={data.metrics.onlineUsers}
              note="当前 WebSocket 在线账户"
              live
            />
            <MetricCard
              code="GAMES"
              label="总对局数量"
              value={data.metrics.totalGames}
              note="已创建的全部 1v1 对局"
            />
            <MetricCard
              code="ACTIVE"
              label="当前对局"
              value={data.metrics.activeGames}
              note="服务器内仍在进行的房间"
              live
            />
            <MetricCard
              code="ECHO"
              label="回声档案"
              value={data.metrics.savedEchoArchives}
              note="双方同意后可用的匿名档案"
            />
            <MetricCard
              code="AI / H"
              label="AI 小时请求"
              value={data.metrics.aiRequestsThisHour}
              note="当前滚动小时窗口"
            />
          </div>
          <OperationsInsights data={data} />
          <footer className="admin-dashboard-footer">
            <span>
              数据源：{data.databaseMode === "postgresql" ? "云端 PostgreSQL" : "本地演示内存"}
            </span>
            <time dateTime={data.generatedAt}>
              更新于 {new Date(data.generatedAt).toLocaleTimeString("zh-CN")}
            </time>
          </footer>
        </>
      )}
    </section>
  );
}
