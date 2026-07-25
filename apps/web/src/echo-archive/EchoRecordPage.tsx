import { useEffect, useState } from "react";
import type {
  EchoRecordEntry,
  EchoRecordsResponse,
  Identity,
} from "@turing-game/protocol";
import { getEchoRecords } from "./api";
import {
  echoIdentityHitRate,
  echoRecordOutcome,
} from "./records";

type RecordLoadState = "loading" | "ready" | "error";

export function EchoRecordPage({ onBack }: { onBack: () => void }) {
  const [loadState, setLoadState] =
    useState<RecordLoadState>("loading");
  const [records, setRecords] = useState<EchoRecordsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoadState("loading");
    setError(null);
    void getEchoRecords()
      .then((response) => {
        if (cancelled) return;
        setRecords(response);
        setLoadState("ready");
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(
          cause instanceof Error
            ? cause.message
            : "回声战绩暂时没有成功抵达，请稍后重试。",
        );
        setLoadState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  return (
    <section className="record-page echo-record-page">
      <div className="record-page-heading">
        <button className="record-back" type="button" onClick={onBack}>
          ← 返回回声档案
        </button>
        <div>
          <p>ECHO REVIEWER / CLOUD RECORD</p>
          <h1>鉴证战绩</h1>
          <span>已登录账户 · 云端同步</span>
        </div>
        <p>
          每次双身份判断都会留下鉴证切片。这里仅展示你的判断结果与匿名档案
          元数据，不会重新暴露原玩家、源对局或聊天正文。
        </p>
      </div>

      {loadState === "loading" && (
        <RecordState
          eyebrow="SYNCING REVIEW FILE"
          title="正在整理你的回声…"
          message="云端正在汇总身份命中、置信校准和逐局鉴证结果。"
        />
      )}

      {loadState === "error" && (
        <RecordState
          eyebrow="RECORD SIGNAL INTERRUPTED"
          title="战绩没有成功抵达"
          message={error ?? "请稍后再试一次。"}
          actionLabel="重新加载"
          onAction={() => setLoadAttempt((attempt) => attempt + 1)}
        />
      )}

      {loadState === "ready" && records && (
        <>
          <div className="record-overview">
            <dl className="record-stats">
              <div>
                <dt>REVIEW FILES / 判读档案</dt>
                <dd>
                  {String(records.stats.reviewsPlayed).padStart(2, "0")}
                </dd>
              </div>
              <div>
                <dt>IDENTITY HIT / 身份命中率</dt>
                <dd>{echoIdentityHitRate(records.stats)}%</dd>
              </div>
              <div>
                <dt>PERFECT CASES / 完美判读</dt>
                <dd>{records.stats.perfectJudgments}</dd>
              </div>
              <div>
                <dt>REVIEW SCORE / 累计鉴证分</dt>
                <dd>{records.stats.score}</dd>
              </div>
            </dl>
            <div className="echo-record-note">
              <strong>判读口径</strong>
              <p>
                每份档案包含 A、B 两个身份。身份命中率按正确身份数除以已判断
                身份总数计算；双身份全对才计为一次完美判读。
              </p>
              <button className="primary-action" type="button" onClick={onBack}>
                继续鉴证新的回声 <span aria-hidden="true">↗</span>
              </button>
            </div>
          </div>

          <div className="record-history">
            <div className="record-history-title">
              <div>
                <span>REVIEW ARCHIVE</span>
                <h2>历史战绩</h2>
              </div>
              <strong>
                最近 {records.records.length} 条云端记录
              </strong>
            </div>
            {records.records.length === 0 ? (
              <div className="record-empty">
                <span>NO ECHO REVIEW YET / 000</span>
                <strong>还没有鉴证记录</strong>
                <p>
                  完成第一次双身份判断后，这里就会留下你的回声足迹啦
                  ฅ( ̳• ·̫ • ̳ฅ)
                </p>
                <button className="text-action" type="button" onClick={onBack}>
                  先去领取一份档案叭 →
                </button>
              </div>
            ) : (
              <ol className="record-game-list echo-record-list">
                {records.records.map((record, index) => (
                  <EchoRecordRow
                    key={record.id}
                    record={record}
                    index={records.records.length - index}
                  />
                ))}
              </ol>
            )}
          </div>
        </>
      )}
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
    <div className="echo-record-state" role="status">
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

function EchoRecordRow({
  record,
  index,
}: {
  record: EchoRecordEntry;
  index: number;
}) {
  const outcome = echoRecordOutcome(record.correctCount);
  return (
    <li className={`is-${outcome.tone}`}>
      <div className="record-game-index" aria-hidden="true">
        {String(index).padStart(3, "0")}
      </div>
      <div className="record-game-result">
        <span>{outcome.label}</span>
        <strong>{outcome.marker}</strong>
      </div>
      <dl>
        <IdentityRecord
          actor="A"
          identity={record.identities.A}
          guess={record.guesses.A}
          confidence={record.confidence.A}
          correct={record.correct.A}
        />
        <IdentityRecord
          actor="B"
          identity={record.identities.B}
          guess={record.guesses.B}
          confidence={record.confidence.B}
          correct={record.correct.B}
        />
        <div>
          <dt>档案情况</dt>
          <dd>
            {record.messageCount} 条 · {formatDuration(record.durationMs)}
          </dd>
        </div>
        <div>
          <dt>置信校准</dt>
          <dd>{record.confidenceCalibration}%</dd>
        </div>
      </dl>
      <div className="record-game-meta">
        <time dateTime={record.submittedAt}>
          {formatRecordDate(record.submittedAt)}
        </time>
        <span>鉴证得分</span>
        <strong>+{record.scoreDelta}</strong>
      </div>
    </li>
  );
}

function IdentityRecord({
  actor,
  identity,
  guess,
  confidence,
  correct,
}: {
  actor: "A" | "B";
  identity: Identity;
  guess: Identity;
  confidence: number;
  correct: boolean;
}) {
  return (
    <div className={correct ? "is-hit" : "is-miss"}>
      <dt>
        玩家 {actor} · {correct ? "命中" : "偏差"}
      </dt>
      <dd>
        {identityName(identity)} / 判断 {identityName(guess)}
        <small>{confidence}% 把握</small>
      </dd>
    </div>
  );
}

function identityName(identity: Identity): string {
  return identity === "human" ? "真人" : "AI";
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.floor(Math.max(0, milliseconds) / 1_000);
  return `${String(Math.floor(totalSeconds / 60)).padStart(2, "0")}:${String(
    totalSeconds % 60,
  ).padStart(2, "0")}`;
}

function formatRecordDate(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}
