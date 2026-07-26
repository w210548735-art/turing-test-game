import { type ReactNode, useEffect, useMemo, useState } from "react";
import type {
  AccountSessionResponse,
  EchoRecordsResponse,
  Identity,
} from "@turing-game/protocol";
import type {
  LocalGameRecord,
  LocalPlayerRecord,
} from "../local-record";
import { hitRate } from "../local-record";
import { getEchoRecords } from "../echo-archive/api";
import {
  echoIdentityHitRate,
  echoRecordOutcome,
} from "../echo-archive/records";

export type RecordMode = "duel" | "echo";
type RecordTone = "success" | "partial" | "wrong";
type EchoLoadState = "idle" | "loading" | "ready" | "error";

interface RecordStatItem {
  label: string;
  eyebrow: string;
  value: string;
}

interface RecordFactItem {
  label: string;
  value: string;
  detail?: string;
  tone?: "hit" | "miss";
}

interface RecordRowViewModel {
  id: string;
  index: number;
  tone: RecordTone;
  resultLabel: string;
  resultMarker: string;
  facts: RecordFactItem[];
  dateTime: string;
  dateLabel: string;
  scoreLabel: string;
  scoreValue: number;
}

export interface RecordPageViewModel {
  mode: RecordMode;
  stats: RecordStatItem[];
  records: RecordRowViewModel[];
  countLabel: string;
  emptyEyebrow: string;
  emptyTitle: string;
  emptyMessage: string;
  privacyNote?: string;
}

interface RecordPageTemplateProps {
  model: RecordPageViewModel;
  identityName?: string;
  identityNumber?: string;
  /** 兼容旧模板调用；新代码应分别传名称与编号。 */
  identityLabel?: string;
  mode: RecordMode;
  echoEnabled: boolean;
  onModeChange: (mode: RecordMode) => void;
  onBack: () => void;
  onSettings: () => void;
}

export function PlayerRecordsPage({
  record,
  accountUser,
  mode,
  onModeChange,
  onBack,
  onSettings,
}: {
  record: LocalPlayerRecord;
  accountUser?: AccountSessionResponse["user"];
  mode: RecordMode;
  onModeChange: (mode: RecordMode) => void;
  onBack: () => void;
  onSettings: () => void;
}) {
  const [echoState, setEchoState] = useState<EchoLoadState>("idle");
  const [echoRecords, setEchoRecords] = useState<EchoRecordsResponse | null>(
    null,
  );
  const [echoError, setEchoError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    if (mode !== "echo" || !accountUser) return;
    let cancelled = false;
    setEchoState("loading");
    setEchoError(null);
    void getEchoRecords()
      .then((response) => {
        if (cancelled) return;
        setEchoRecords(response);
        setEchoState("ready");
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setEchoError(
          cause instanceof Error
            ? cause.message
            : "回声战绩暂时没有成功抵达，请稍后重试。",
        );
        setEchoState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [accountUser, loadAttempt, mode]);

  const duelModel = useMemo(() => buildDuelRecordModel(record), [record]);
  const model =
    mode === "echo" && echoRecords
      ? buildEchoRecordModel(echoRecords)
      : duelModel;
  const identityName = accountUser?.displayName ?? "教学观察员";
  const identityNumber = accountUser
    ? `NO. ${accountUser.playerNumber}`
    : "LOCAL / TEACHING";

  if (
    mode === "echo" &&
    accountUser &&
    (echoState === "idle" || echoState === "loading")
  ) {
    return (
      <RecordPageFrame
        identityName={identityName}
        identityNumber={identityNumber}
        mode={mode}
        echoEnabled
        onModeChange={onModeChange}
        onBack={onBack}
        onSettings={onSettings}
      >
        <RecordState
          eyebrow="SYNCING REVIEW FILE"
          title="正在整理你的回声…"
          message="正在同步身份命中与逐局鉴证结果。"
        />
      </RecordPageFrame>
    );
  }

  if (mode === "echo" && accountUser && echoState === "error") {
    return (
      <RecordPageFrame
        identityName={identityName}
        identityNumber={identityNumber}
        mode={mode}
        echoEnabled
        onModeChange={onModeChange}
        onBack={onBack}
        onSettings={onSettings}
      >
        <RecordState
          eyebrow="RECORD SIGNAL INTERRUPTED"
          title="战绩没有成功抵达"
          message={echoError ?? "请稍后再试一次。"}
          actionLabel="重新加载"
          onAction={() => setLoadAttempt((attempt) => attempt + 1)}
        />
      </RecordPageFrame>
    );
  }

  return (
    <RecordPageTemplate
      model={model}
      identityName={identityName}
      identityNumber={identityNumber}
      mode={mode}
      echoEnabled={Boolean(accountUser)}
      onModeChange={onModeChange}
      onBack={onBack}
      onSettings={onSettings}
    />
  );
}

export function RecordPageTemplate({
  model,
  identityName,
  identityNumber,
  mode,
  echoEnabled,
  onModeChange,
  onBack,
  onSettings,
}: RecordPageTemplateProps) {
  return (
    <RecordPageFrame
      identityName={identityName}
      identityNumber={identityNumber}
      mode={mode}
      echoEnabled={echoEnabled}
      onModeChange={onModeChange}
      onBack={onBack}
      onSettings={onSettings}
    >
      <div className="player-records-summary">
        <dl className="player-records-stats">
          {model.stats.map((stat) => (
            <div key={stat.label}>
              <dt>{stat.eyebrow} / {stat.label}</dt>
              <dd>{stat.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <section className="player-records-history">
        <header>
          <div>
            <span>
              {model.mode === "duel" ? "MATCH ARCHIVE" : "REVIEW ARCHIVE"}
            </span>
            <h2>历史战绩</h2>
          </div>
          <strong>{model.countLabel}</strong>
        </header>
        {model.privacyNote && (
          <p className="player-records-privacy">{model.privacyNote}</p>
        )}
        {model.records.length === 0 ? (
          <div className="player-records-empty">
            <span>{model.emptyEyebrow}</span>
            <strong>{model.emptyTitle}</strong>
            <p>{model.emptyMessage}</p>
            {model.mode === "duel" && (
              <button className="text-action" type="button" onClick={onBack}>
                去完成第一局叭 →
              </button>
            )}
          </div>
        ) : (
          <ol className="player-records-list">
            {model.records.map((record) => (
              <li key={record.id} className={`is-${record.tone}`}>
                <div className="player-records-index" aria-hidden="true">
                  {String(record.index).padStart(3, "0")}
                </div>
                <div className="player-records-result">
                  <span>{record.resultLabel}</span>
                  <strong>{record.resultMarker}</strong>
                </div>
                <dl className="player-records-facts">
                  {record.facts.map((fact) => (
                    <div
                      key={`${record.id}-${fact.label}`}
                      className={fact.tone ? `is-${fact.tone}` : undefined}
                    >
                      <dt>{fact.label}</dt>
                      <dd>
                        {fact.value}
                        {fact.detail && <small>{fact.detail}</small>}
                      </dd>
                    </div>
                  ))}
                </dl>
                <div className="player-records-meta">
                  <time dateTime={record.dateTime}>{record.dateLabel}</time>
                  <span>{record.scoreLabel}</span>
                  <strong>
                    {record.scoreValue >= 0 ? "+" : ""}
                    {record.scoreValue}
                  </strong>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </RecordPageFrame>
  );
}

function RecordPageFrame({
  identityName,
  identityNumber,
  identityLabel,
  mode,
  echoEnabled,
  onModeChange,
  onBack,
  onSettings,
  children,
}: Omit<RecordPageTemplateProps, "model"> & {
  children: ReactNode;
}) {
  const legacyIdentity = identityLabel?.split("·").map((part) => part.trim());
  const resolvedIdentityName =
    identityName?.trim() || legacyIdentity?.[0] || "教学观察员";
  const resolvedIdentityNumber =
    identityNumber?.trim() || legacyIdentity?.[1] || "LOCAL / TEACHING";
  return (
    <section className="player-records-shell view-page-enter">
      <header className="player-records-header">
        <button className="record-back" type="button" onClick={onBack}>
          ← 返回游戏
        </button>
        <div>
          <p>PLAYER FILE / RECORDS</p>
          <h1>玩家档案</h1>
          <div className="player-records-identity">
            <span className="player-records-avatar" aria-hidden="true">
              {resolvedIdentityName.slice(0, 1)}
            </span>
            <div>
              <small>全局玩家名称</small>
              <strong>{resolvedIdentityName}</strong>
              <span>{resolvedIdentityNumber}</span>
            </div>
          </div>
        </div>
        <button
          className="player-records-settings"
          type="button"
          onClick={onSettings}
        >
          {echoEnabled ? "账户设置" : "账户登录"} <span aria-hidden="true">⚙</span>
        </button>
      </header>

      <nav className="player-records-tabs" aria-label="战绩模式">
        <button
          className={mode === "duel" ? "is-active" : ""}
          type="button"
          aria-current={mode === "duel" ? "page" : undefined}
          onClick={() => onModeChange("duel")}
        >
          <strong>1v1 战绩</strong>
          <span>本机记录</span>
        </button>
        <button
          className={mode === "echo" ? "is-active" : ""}
          type="button"
          disabled={!echoEnabled}
          aria-current={mode === "echo" ? "page" : undefined}
          onClick={() => onModeChange("echo")}
        >
          <strong>回声鉴证</strong>
          <span>{echoEnabled ? "云端记录" : "登录后查看"}</span>
        </button>
      </nav>
      {children}
    </section>
  );
}

function RecordState({
  eyebrow,
  title,
  message,
  actionLabel,
  onAction,
}: {
  eyebrow: string;
  title: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="player-records-state" role="status">
      <span>{eyebrow}</span>
      <strong>{title}</strong>
      <p>{message}</p>
      {actionLabel && onAction && (
        <button className="primary-action" type="button" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}

export function buildDuelRecordModel(
  record: LocalPlayerRecord,
): RecordPageViewModel {
  const totalMessages = record.games.reduce(
    (total, game) => total + game.messageCount,
    0,
  );
  return {
    mode: "duel",
    stats: [
      {
        eyebrow: "MATCHES",
        label: "完成局数",
        value: String(record.rounds).padStart(2, "0"),
      },
      {
        eyebrow: "HIT RATE",
        label: "判断命中率",
        value: `${hitRate(record)}%`,
      },
      {
        eyebrow: "TOTAL SCORE",
        label: "累计得分",
        value: String(record.totalScore),
      },
      {
        eyebrow: "MESSAGES",
        label: "累计消息",
        value: String(totalMessages),
      },
    ],
    records: record.games.map((game, index) =>
      duelRecordRow(game, record.games.length - index),
    ),
    countLabel: `${record.games.length} 条本机记录`,
    emptyEyebrow: "NO MATCH YET / 000",
    emptyTitle: "还没有对局记录",
    emptyMessage: "完成第一次判断后，这里会留下你曾经相信过的答案。",
  };
}

export function buildEchoRecordModel(
  records: EchoRecordsResponse,
): RecordPageViewModel {
  return {
    mode: "echo",
    stats: [
      {
        eyebrow: "REVIEW FILES",
        label: "判读档案",
        value: String(records.stats.reviewsPlayed).padStart(2, "0"),
      },
      {
        eyebrow: "IDENTITY HIT",
        label: "身份命中率",
        value: `${echoIdentityHitRate(records.stats)}%`,
      },
      {
        eyebrow: "PERFECT CASES",
        label: "完美判读",
        value: String(records.stats.perfectJudgments),
      },
      {
        eyebrow: "REVIEW SCORE",
        label: "累计鉴证分",
        value: String(records.stats.score),
      },
    ],
    records: records.records.map((record, index) => {
      const outcome = echoRecordOutcome(record.correctCount);
      return {
        id: record.id,
        index: records.records.length - index,
        tone:
          outcome.tone === "perfect"
            ? "success"
            : outcome.tone === "partial"
              ? "partial"
              : "wrong",
        resultLabel: outcome.label,
        resultMarker: outcome.marker,
        facts: [
          {
            label: `玩家 A · ${record.correct.A ? "命中" : "偏差"}`,
            value: `${identityName(record.identities.A)} / 判断 ${identityName(record.guesses.A)}`,
            detail: `${record.confidence.A}% 把握`,
            tone: record.correct.A ? "hit" : "miss",
          },
          {
            label: `玩家 B · ${record.correct.B ? "命中" : "偏差"}`,
            value: `${identityName(record.identities.B)} / 判断 ${identityName(record.guesses.B)}`,
            detail: `${record.confidence.B}% 把握`,
            tone: record.correct.B ? "hit" : "miss",
          },
          {
            label: "档案情况",
            value: `${record.messageCount} 条 · ${formatDurationMs(record.durationMs)}`,
          },
          {
            label: "置信校准",
            value: `${record.confidenceCalibration}%`,
          },
        ],
        dateTime: record.submittedAt,
        dateLabel: formatRecordDate(record.submittedAt),
        scoreLabel: "鉴证得分",
        scoreValue: record.scoreDelta,
      };
    }),
    countLabel: `${records.records.length} 条云端记录`,
    emptyEyebrow: "NO ECHO REVIEW YET / 000",
    emptyTitle: "还没有鉴证记录",
    emptyMessage: "完成第一次双身份判断后，你听过的回声会在这里留下编号。",
    privacyNote: "匿名档案 · 仅展示判断结果，不展示原玩家或聊天正文",
  };
}

function duelRecordRow(
  game: LocalGameRecord,
  index: number,
): RecordRowViewModel {
  return {
    id: game.id,
    index,
    tone: game.isCorrect ? "success" : "wrong",
    resultLabel: game.isCorrect ? "判断命中" : "判断偏差",
    resultMarker: game.isCorrect ? "✓" : "×",
    facts: [
      {
        label: "真实身份",
        value: identityName(game.opponentType),
      },
      {
        label: "你的判断",
        value: game.guess ? identityName(game.guess) : "未提交",
      },
      {
        label: "对话消息",
        value: String(game.messageCount),
      },
      {
        label: "持续时间",
        value: formatDurationSeconds(game.durationSeconds),
      },
    ],
    dateTime: new Date(game.finishedAt).toISOString(),
    dateLabel: formatRecordDate(game.finishedAt),
    scoreLabel: "本局得分",
    scoreValue: game.scoreDelta,
  };
}

function identityName(identity: Identity): string {
  return identity === "human" ? "真人" : "AI";
}

function formatDurationSeconds(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safeSeconds / 60)).padStart(2, "0")}:${String(
    safeSeconds % 60,
  ).padStart(2, "0")}`;
}

function formatDurationMs(milliseconds: number): string {
  return formatDurationSeconds(milliseconds / 1_000);
}

function formatRecordDate(value: string | number): string {
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
