import {
  type FormEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  EchoAssignmentResponse,
  Identity,
  SubmitEchoJudgmentResponse,
} from "@turing-game/protocol";
import {
  claimEchoAssignment,
  createEchoRequestId,
  getEchoComments,
  submitEchoJudgment,
  type EchoComment,
} from "./api";
import { EchoCommentsPanel } from "./EchoCommentsPanel";
import { EchoRecordPage } from "./EchoRecordPage";
import {
  commentsForEvent,
  shouldLoadEchoComments,
  type EchoCommentGateView,
} from "./comments";
import {
  formatReplayTime,
  type EchoActor,
  type PlaybackSpeed,
} from "./playback";
import { useEchoPlayback } from "./useEchoPlayback";

type LoadState = "idle" | "loading" | "empty" | "ready" | "error";
type ReplaySessionView = EchoCommentGateView;

export function EchoArchivePage({
  csrfToken,
  onBack,
}: {
  csrfToken: string;
  onBack: () => void;
}) {
  const [pageView, setPageView] = useState<"archive" | "records">(
    "archive",
  );
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [assignment, setAssignment] =
    useState<EchoAssignmentResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function claimArchive() {
    setLoadState("loading");
    setError(null);
    try {
      const next = await claimEchoAssignment(csrfToken);
      if (!next) {
        setAssignment(null);
        setLoadState("empty");
        return;
      }
      setAssignment(next);
      setLoadState("ready");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "档案领取失败，请稍后重试。",
      );
      setLoadState("error");
    }
  }

  if (pageView === "records") {
    return <EchoRecordPage onBack={() => setPageView("archive")} />;
  }

  return (
    <section className="echo-page">
      <header className="echo-page-header">
        <button className="echo-back" type="button" onClick={onBack}>
          ← 返回实验
        </button>
        <div>
          <p>ECHO ARCHIVE / ASYNCHRONOUS MODE</p>
          <h1>回声档案</h1>
          <span>你是本次回声鉴证官</span>
          <button
            className="echo-record-action"
            type="button"
            onClick={() => setPageView("records")}
          >
            查看我的鉴证战绩 <span aria-hidden="true">↗</span>
          </button>
        </div>
        <p>
          沿服务器时间轴重看一段匿名对话，分别判断玩家 A 与 B：
          真人，还是 AI。
        </p>
      </header>

      {loadState === "idle" && (
        <div className="echo-intro">
          <div className="echo-intro-index" aria-hidden="true">
            02
          </div>
          <p className="eyebrow">CASE FILE / READY TO CLAIM</p>
          <h2>听见过去，<br />判断此刻。</h2>
          <p>
            每份档案均获得原对局双方授权，并经过匿名化与安全处理。
            回放结束后，你需要提交两份独立身份判断。
          </p>
          <ol>
            <li><span>01</span>领取一份随机匿名档案</li>
            <li><span>02</span>按原始节奏或倍速查看回放</li>
            <li><span>03</span>判断 A、B 身份并获得鉴证分</li>
          </ol>
          <button
            className="primary-action echo-claim-action"
            type="button"
            onClick={() => void claimArchive()}
          >
            领取一份档案 <span aria-hidden="true">↗</span>
          </button>
        </div>
      )}

      {loadState === "loading" && (
        <div className="echo-state" role="status">
          <span className="echo-loader" aria-hidden="true" />
          <strong>正在调取匿名档案…</strong>
          <p>服务器正在避开你参与过、看过或已过期的记录。</p>
        </div>
      )}

      {loadState === "empty" && (
        <div className="echo-state">
          <span>NO UNREAD SIGNAL / 204</span>
          <strong>暂时没有新的回声</strong>
          <p>等更多对局完成双向授权后，再回来听听看吧 ฅ( ̳• ·̫ • ̳ฅ)</p>
          <button
            className="primary-action"
            type="button"
            onClick={() => void claimArchive()}
          >
            再找一次
          </button>
        </div>
      )}

      {loadState === "error" && (
        <div className="echo-state is-error" role="alert">
          <span>SIGNAL INTERRUPTED</span>
          <strong>档案没有成功抵达</strong>
          <p>{error}</p>
          <button
            className="primary-action"
            type="button"
            onClick={() => void claimArchive()}
          >
            重新领取
          </button>
        </div>
      )}

      {loadState === "ready" && assignment && (
        <EchoReplaySession
          key={assignment.assignmentId}
          csrfToken={csrfToken}
          assignment={assignment}
          onNext={() => void claimArchive()}
        />
      )}
    </section>
  );
}

function EchoReplaySession({
  csrfToken,
  assignment,
  onNext,
}: {
  csrfToken: string;
  assignment: EchoAssignmentResponse;
  onNext: () => void;
}) {
  const playback = useEchoPlayback(
    assignment.assignmentId,
    assignment.events,
    assignment.durationMs,
  );
  const [guessA, setGuessA] = useState<Identity | null>(null);
  const [guessB, setGuessB] = useState<Identity | null>(null);
  const [confidenceA, setConfidenceA] = useState(68);
  const [confidenceB, setConfidenceB] = useState(68);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] =
    useState<SubmitEchoJudgmentResponse | null>(null);
  const [sessionView, setSessionView] =
    useState<ReplaySessionView>("playback");
  const [comments, setComments] = useState<EchoComment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [commentsLoaded, setCommentsLoaded] = useState(false);
  const [commentsLoadAttempt, setCommentsLoadAttempt] = useState(0);
  const [selectedMessageSequence, setSelectedMessageSequence] =
    useState<number | null>(null);
  const judgmentRequestIdRef = useRef<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [
    playback.frame.messages.length,
    playback.frame.typing.A,
    playback.frame.typing.B,
  ]);

  useEffect(() => {
    if (
      !shouldLoadEchoComments(
        sessionView,
        commentsLoaded,
        commentsLoading,
      )
    ) {
      return;
    }
    let cancelled = false;
    setCommentsLoading(true);
    setCommentsError(null);
    void getEchoComments(assignment.assignmentId)
      .then((response) => {
        if (cancelled) return;
        setComments(response.comments);
        setCommentsLoaded(true);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setCommentsError(
          cause instanceof Error
            ? cause.message
            : "批注没有加载成功，请稍后重试。",
        );
      })
      .finally(() => {
        if (!cancelled) setCommentsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    assignment.assignmentId,
    commentsLoadAttempt,
    commentsLoaded,
    sessionView,
  ]);

  async function submitJudgment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!playback.completed || !guessA || !guessB || busy || result) return;
    setBusy(true);
    setError(null);
    judgmentRequestIdRef.current ??= createEchoRequestId();
    try {
      const next = await submitEchoJudgment(
        csrfToken,
        assignment.assignmentId,
        {
          guessA,
          confidenceA,
          guessB,
          confidenceB,
          clientRequestId: judgmentRequestIdRef.current,
        },
      );
      setResult(next);
      setSessionView("result");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "身份判断提交失败，请重试。",
      );
    } finally {
      setBusy(false);
    }
  }

  function enterReview() {
    playback.seek(assignment.durationMs);
    setSessionView("review");
    setSelectedMessageSequence(null);
    setCommentsError(null);
  }

  function retryComments() {
    setCommentsLoaded(false);
    setCommentsError(null);
    setCommentsLoadAttempt((attempt) => attempt + 1);
  }

  const selectedMessage =
    playback.frame.messages.find(
      (message) => message.eventSequence === selectedMessageSequence,
    ) ?? null;

  function identityLabel(actor: EchoActor): string {
    if (sessionView !== "review" || !result) return `匿名玩家 ${actor}`;
    return `匿名玩家 ${actor} · ${
      result.identities[actor] === "human" ? "真人" : "AI"
    }`;
  }

  return (
    <div
      className={`echo-workbench ${
        sessionView === "review" ? "is-reviewing" : ""
      }`}
    >
      <aside className="echo-case-sidebar">
        <div>
          <p className="eyebrow">ACTIVE CASE / ANONYMOUS</p>
          <h2>观察<br />回声，<br /><span>鉴定身份。</span></h2>
        </div>
        <dl>
          <div>
            <dt>档案时长</dt>
            <dd>{formatReplayTime(assignment.durationMs)}</dd>
          </div>
          <div>
            <dt>可见消息</dt>
            <dd>
              {assignment.events
                .filter((event) => event.type === "message.visible")
                .length.toString()
                .padStart(2, "0")}
            </dd>
          </div>
          <div>
            <dt>匿名对象</dt>
            <dd>A / B</dd>
          </div>
        </dl>
        <p className="echo-case-note">
          时间均为服务端观察值，不包含草稿、删除文字或键盘内容。
        </p>
      </aside>

      <div className="echo-replay-stage">
        <header className="echo-replay-header">
          <div>
            <span className="presence-mark" />
            <strong>{identityLabel("A")}</strong>
          </div>
          <span>
            {sessionView === "review"
              ? "IDENTITIES REVEALED / NOTES UNLOCKED"
              : "SERVER TIMELINE"}
          </span>
          <div>
            <strong>{identityLabel("B")}</strong>
            <span className="presence-mark" />
          </div>
        </header>

        <div
          className="echo-message-list"
          role="log"
          aria-live="polite"
          aria-label="回声档案消息"
        >
          {playback.frame.messages.length === 0 && (
            <div className="echo-replay-empty">
              <span>00:00 / WAITING FOR FIRST SIGNAL</span>
              <strong>播放后，回声会依次出现。</strong>
            </div>
          )}
          {playback.frame.messages.map((message) => (
            <article
              key={message.id}
              className={`echo-message is-${message.actor.toLowerCase()} ${
                selectedMessageSequence === message.eventSequence
                  ? "is-comment-selected"
                  : ""
              }`}
            >
              <div>
                <strong>{identityLabel(message.actor as EchoActor)}</strong>
                <time>{formatReplayTime(message.atMs)}</time>
              </div>
              <p>{message.content}</p>
              <span>
                {message.typingDurationMs === null
                  ? "未观察到完整输入状态"
                  : `服务器观察到输入约 ${(
                      message.typingDurationMs / 1_000
                    ).toFixed(1)} 秒`}
                {message.moderated ? " · 内容已做安全处理" : ""}
              </span>
              {sessionView === "review" && (
                <button
                  className="echo-message-comments"
                  type="button"
                  disabled={!commentsLoaded}
                  onClick={() =>
                    setSelectedMessageSequence(message.eventSequence)
                  }
                >
                  {commentsLoading
                    ? "批注加载中…"
                    : commentsError || !commentsLoaded
                      ? "批注暂不可用"
                    : `查看批注 · ${
                        commentsForEvent(
                          comments,
                          message.eventSequence,
                        ).length
                      }`}
                </button>
              )}
            </article>
          ))}
          {(["A", "B"] as const).map(
            (actor) =>
              sessionView !== "review" &&
              playback.frame.typing[actor] && (
                <TypingReplay
                  key={actor}
                  actor={actor}
                  elapsedMs={
                    playback.clock.positionMs -
                    (playback.frame.typingStartedAtMs[actor] ??
                      playback.clock.positionMs)
                  }
                />
              ),
          )}
          <div ref={messagesEndRef} />
        </div>

        {sessionView === "review" ? (
          <div className="echo-review-navigation">
            <button type="button" onClick={() => setSessionView("result")}>
              ← 返回结算
            </button>
            <p>身份已经揭晓，点选任意一句，看看其他鉴证官听见了什么。</p>
            <button type="button" onClick={onNext}>
              下一份档案 ↗
            </button>
          </div>
        ) : (
          <PlaybackControls
            positionMs={playback.clock.positionMs}
            durationMs={assignment.durationMs}
            speed={playback.clock.speed}
            playing={playback.clock.playing}
            lastSkippedMs={playback.lastSkippedMs}
            onToggle={playback.toggle}
            onSeek={playback.seek}
            onSpeed={playback.setSpeed}
            onSkip={playback.skipToNext}
          />
        )}
      </div>

      <aside className="echo-judgment-panel">
        {sessionView === "review" && selectedMessage ? (
          <EchoCommentsPanel
            csrfToken={csrfToken}
            assignmentId={assignment.assignmentId}
            message={selectedMessage}
            comments={commentsForEvent(
              comments,
              selectedMessage.eventSequence,
            )}
            onCommentsChange={(nextForMessage) =>
              setComments((current) => [
                ...current.filter(
                  (comment) =>
                    comment.eventSequence !== selectedMessage.eventSequence,
                ),
                ...nextForMessage,
              ])
            }
            onClose={() => setSelectedMessageSequence(null)}
          />
        ) : sessionView === "review" ? (
          <div className="echo-review-guide">
            <p className="eyebrow">ECHO NOTES / UNLOCKED</p>
            <h2>批注已经解锁</h2>
            <p>
              身份已经揭晓，看看其他鉴证官是怎么理解这些回声的吧
              ฅ( ̳• ·̫ • ̳ฅ)
            </p>
            {commentsLoading && <strong role="status">正在加载批注…</strong>}
            {commentsError && (
              <div role="alert">
                <strong>批注没有成功抵达</strong>
                <p>{commentsError}</p>
                <button type="button" onClick={retryComments}>
                  重新加载
                </button>
              </div>
            )}
            {!commentsLoading && !commentsError && (
              <p>点击聊天中的任意一句话，就可以查看或留下批注。</p>
            )}
          </div>
        ) : result ? (
          <JudgmentResult
            result={result}
            onReview={enterReview}
            onNext={onNext}
          />
        ) : (
          <JudgmentForm
            completed={playback.completed}
            guessA={guessA}
            guessB={guessB}
            confidenceA={confidenceA}
            confidenceB={confidenceB}
            busy={busy}
            error={error}
            onGuessA={setGuessA}
            onGuessB={setGuessB}
            onConfidenceA={setConfidenceA}
            onConfidenceB={setConfidenceB}
            onSubmit={submitJudgment}
          />
        )}
      </aside>
    </div>
  );
}

function TypingReplay({
  actor,
  elapsedMs,
}: {
  actor: EchoActor;
  elapsedMs: number;
}) {
  return (
    <div className={`echo-typing is-${actor.toLowerCase()}`} role="status">
      <div aria-hidden="true"><span /><span /><span /></div>
      匿名玩家 {actor} 正在输入 · {(elapsedMs / 1_000).toFixed(1)} 秒
    </div>
  );
}

function PlaybackControls({
  positionMs,
  durationMs,
  speed,
  playing,
  lastSkippedMs,
  onToggle,
  onSeek,
  onSpeed,
  onSkip,
}: {
  positionMs: number;
  durationMs: number;
  speed: PlaybackSpeed;
  playing: boolean;
  lastSkippedMs: number;
  onToggle: () => void;
  onSeek: (positionMs: number) => void;
  onSpeed: (speed: PlaybackSpeed) => void;
  onSkip: () => void;
}) {
  return (
    <div className="echo-controls">
      <div className="echo-control-row">
        <button type="button" onClick={onToggle}>
          {playing ? "暂停" : positionMs >= durationMs ? "重新播放" : "播放"}
        </button>
        <span className="echo-time">
          {formatReplayTime(positionMs)} / {formatReplayTime(durationMs)}
        </span>
        <div className="echo-speeds" aria-label="回放速度">
          {([0.5, 1, 2, 4] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={speed === option ? "is-active" : ""}
              aria-pressed={speed === option}
              onClick={() => onSpeed(option)}
            >
              {option}×
            </button>
          ))}
        </div>
        <button type="button" onClick={onSkip}>
          快进到下一条 ↠
        </button>
      </div>
      <input
        type="range"
        min={0}
        max={Math.max(1, durationMs)}
        step={100}
        value={Math.min(positionMs, Math.max(1, durationMs))}
        aria-label="回放进度"
        onChange={(event) => onSeek(Number(event.target.value))}
      />
      {lastSkippedMs > 0 && (
        <p role="status">
          已快进，但保留原始沉默信息：跳过约{" "}
          {(lastSkippedMs / 1_000).toFixed(1)} 秒。
        </p>
      )}
    </div>
  );
}

interface JudgmentFormProps {
  completed: boolean;
  guessA: Identity | null;
  guessB: Identity | null;
  confidenceA: number;
  confidenceB: number;
  busy: boolean;
  error: string | null;
  onGuessA: (value: Identity) => void;
  onGuessB: (value: Identity) => void;
  onConfidenceA: (value: number) => void;
  onConfidenceB: (value: number) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

function JudgmentForm(props: JudgmentFormProps) {
  return (
    <form className="echo-judgment-form" onSubmit={props.onSubmit}>
      <p className="eyebrow">FINAL VERDICT / TWO IDENTITIES</p>
      <h2>分别判断他们是谁</h2>
      {!props.completed && (
        <p className="echo-judgment-lock">
          看完回放后才可以锁定身份。你可以倍速播放或快进到下一条消息。
        </p>
      )}
      <IdentityVerdict
        actor="A"
        value={props.guessA}
        confidence={props.confidenceA}
        disabled={!props.completed || props.busy}
        onChange={props.onGuessA}
        onConfidence={props.onConfidenceA}
      />
      <IdentityVerdict
        actor="B"
        value={props.guessB}
        confidence={props.confidenceB}
        disabled={!props.completed || props.busy}
        onChange={props.onGuessB}
        onConfidence={props.onConfidenceB}
      />
      {props.error && (
        <p className="echo-judgment-error" role="alert">
          {props.error}
        </p>
      )}
      <button
        className="primary-action"
        type="submit"
        disabled={
          !props.completed ||
          !props.guessA ||
          !props.guessB ||
          props.busy
        }
      >
        {props.busy ? "正在锁定判断…" : "提交双重判断"}
        <span aria-hidden="true">↗</span>
      </button>
    </form>
  );
}

function IdentityVerdict({
  actor,
  value,
  confidence,
  disabled,
  onChange,
  onConfidence,
}: {
  actor: EchoActor;
  value: Identity | null;
  confidence: number;
  disabled: boolean;
  onChange: (value: Identity) => void;
  onConfidence: (value: number) => void;
}) {
  return (
    <fieldset className="echo-identity-verdict" disabled={disabled}>
      <legend>匿名玩家 {actor}</legend>
      <div>
        {(["human", "ai"] as const).map((identity) => (
          <label
            key={identity}
            className={value === identity ? "is-selected" : ""}
          >
            <input
              type="radio"
              name={`identity-${actor}`}
              checked={value === identity}
              onChange={() => onChange(identity)}
            />
            {identity === "human" ? "真人" : "AI"}
          </label>
        ))}
      </div>
      <label className="echo-confidence">
        <span>把握程度 <strong>{confidence}%</strong></span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={confidence}
          onChange={(event) => onConfidence(Number(event.target.value))}
        />
      </label>
    </fieldset>
  );
}

function JudgmentResult({
  result,
  onReview,
  onNext,
}: {
  result: SubmitEchoJudgmentResponse;
  onReview: () => void;
  onNext: () => void;
}) {
  return (
    <div className="echo-judgment-result" role="status">
      <p className="eyebrow">IDENTITIES REVEALED</p>
      <h2>
        {result.correctCount === 2
          ? "双重命中"
          : result.correctCount === 1
            ? "命中一半"
            : "回声骗过了你"}
      </h2>
      <div className="echo-result-identities">
        {(["A", "B"] as const).map((actor) => (
          <div
            key={actor}
            className={result.correct[actor] ? "is-correct" : "is-wrong"}
          >
            <span>匿名玩家 {actor}</span>
            <strong>
              {result.identities[actor] === "human" ? "真人" : "AI"}
            </strong>
            <i aria-hidden="true">
              {result.correct[actor] ? "✓" : "×"}
            </i>
          </div>
        ))}
      </div>
      <dl className="echo-result-stats">
        <div><dt>本次得分</dt><dd>+{result.scoreDelta}</dd></div>
        <div><dt>置信校准</dt><dd>{result.confidenceCalibration}%</dd></div>
        <div><dt>完美判读</dt><dd>{result.stats.perfectJudgments}</dd></div>
        <div><dt>鉴证总分</dt><dd>{result.stats.score}</dd></div>
      </dl>
      <p>
        {result.bothCorrect
          ? "两道回声都被你听懂啦 ( •̀ ω •́ )✧"
          : "别担心，最像人的停顿有时恰好来自机器。"}
      </p>
      <button className="primary-action" type="button" onClick={onReview}>
        带着答案重看 <span aria-hidden="true">↗</span>
      </button>
      <button className="echo-secondary-action" type="button" onClick={onNext}>
        领取下一份档案 <span aria-hidden="true">↗</span>
      </button>
    </div>
  );
}
