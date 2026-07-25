import { type FormEvent, useMemo, useRef, useState } from "react";
import {
  createEchoComment,
  createEchoRequestId,
  deleteEchoComment,
  setEchoCommentLike,
  type EchoComment,
} from "./api";
import {
  applyLikeSnapshot,
  sortEchoComments,
  type EchoCommentSort,
} from "./comments";
import type { EchoReplayMessage } from "./playback";

export function EchoCommentsPanel({
  csrfToken,
  assignmentId,
  message,
  comments,
  onCommentsChange,
  onClose,
}: {
  csrfToken: string;
  assignmentId: string;
  message: EchoReplayMessage;
  comments: EchoComment[];
  onCommentsChange: (comments: EchoComment[]) => void;
  onClose: () => void;
}) {
  const [sort, setSort] = useState<EchoCommentSort>("latest");
  const [content, setContent] = useState("");
  const [posting, setPosting] = useState(false);
  const [busyCommentId, setBusyCommentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef<string | null>(null);

  const sortedComments = useMemo(
    () => sortEchoComments(comments, sort),
    [comments, sort],
  );

  async function publish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = content.trim();
    if (trimmed.length < 2 || trimmed.length > 200 || posting) return;
    setPosting(true);
    setError(null);
    requestIdRef.current ??= createEchoRequestId();
    try {
      const created = await createEchoComment(
        csrfToken,
        assignmentId,
        {
          eventSequence: message.eventSequence,
          content: trimmed,
          clientRequestId: requestIdRef.current,
        },
      );
      onCommentsChange([created, ...comments]);
      setContent("");
      requestIdRef.current = null;
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "批注没有发送成功，请稍后重试。",
      );
    } finally {
      setPosting(false);
    }
  }

  async function toggleLike(comment: EchoComment) {
    if (comment.mine || busyCommentId) return;
    const likedByMe = !comment.likedByMe;
    const optimistic = applyLikeSnapshot(
      comments,
      comment.id,
      likedByMe,
      comment.likeCount + (likedByMe ? 1 : -1),
    );
    onCommentsChange(optimistic);
    setBusyCommentId(comment.id);
    setError(null);
    try {
      const updated = await setEchoCommentLike(
        csrfToken,
        assignmentId,
        comment.id,
        likedByMe,
      );
      onCommentsChange(
        applyLikeSnapshot(
          optimistic,
          updated.commentId,
          updated.liked,
          updated.likeCount,
        ),
      );
    } catch (cause) {
      onCommentsChange(comments);
      setError(
        cause instanceof Error
          ? cause.message
          : "点赞状态没有同步成功，已经为你恢复啦。",
      );
    } finally {
      setBusyCommentId(null);
    }
  }

  async function remove(comment: EchoComment) {
    if (!comment.mine || busyCommentId) return;
    setBusyCommentId(comment.id);
    setError(null);
    try {
      await deleteEchoComment(csrfToken, assignmentId, comment.id);
      onCommentsChange(
        comments.filter((candidate) => candidate.id !== comment.id),
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "批注没有删除成功，请稍后重试。",
      );
    } finally {
      setBusyCommentId(null);
    }
  }

  return (
    <section className="echo-comments-panel" aria-label="回声批注">
      <header>
        <div>
          <p className="eyebrow">ECHO NOTES / UNLOCKED</p>
          <h2>回声批注</h2>
        </div>
        <button type="button" onClick={onClose} aria-label="关闭回声批注">
          ×
        </button>
      </header>

      <blockquote>
        <span>匿名玩家 {message.actor} · {formatCommentTime(message.atMs)}</span>
        <p>{message.content}</p>
      </blockquote>

      <div className="echo-comment-toolbar">
        <strong>{comments.length} 条批注</strong>
        <div>
          {(["latest", "popular"] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={sort === option ? "is-active" : ""}
              aria-pressed={sort === option}
              onClick={() => setSort(option)}
            >
              {option === "latest" ? "最新" : "热门"}
            </button>
          ))}
        </div>
      </div>

      <div className="echo-comment-list">
        {sortedComments.length === 0 ? (
          <div className="echo-comment-empty">
            <strong>这里还没有批注</strong>
            <p>要不要留下第一句想法喵 ฅ( ̳• ·̫ • ̳ฅ)</p>
          </div>
        ) : (
          sortedComments.map((comment) => (
            <article key={comment.id}>
              <header>
                <strong>{comment.authorAlias}</strong>
                <time dateTime={comment.createdAt}>
                  {formatCreatedAt(comment.createdAt)}
                </time>
              </header>
              <p>{comment.content}</p>
              <footer>
                <button
                  type="button"
                  className={comment.likedByMe ? "is-liked" : ""}
                  aria-pressed={comment.likedByMe}
                  disabled={comment.mine || busyCommentId === comment.id}
                  title={comment.mine ? "不能给自己的批注点赞" : undefined}
                  onClick={() => void toggleLike(comment)}
                >
                  ♡ {comment.likeCount}
                </button>
                {comment.mine && (
                  <button
                    type="button"
                    disabled={busyCommentId === comment.id}
                    onClick={() => void remove(comment)}
                  >
                    删除
                  </button>
                )}
              </footer>
            </article>
          ))
        )}
      </div>

      <form className="echo-comment-composer" onSubmit={publish}>
        <label htmlFor={`echo-comment-${message.eventSequence}`}>
          写给后来听见这句话的人
        </label>
        <textarea
          id={`echo-comment-${message.eventSequence}`}
          value={content}
          minLength={2}
          maxLength={200}
          placeholder="说说你从这句话里听见了什么…"
          onChange={(event) => {
            setContent(event.target.value);
            requestIdRef.current = null;
          }}
        />
        <div>
          <span>{content.length}/200</span>
          <button
            className="primary-action"
            type="submit"
            disabled={
              posting || content.trim().length < 2 || content.trim().length > 200
            }
          >
            {posting ? "正在留下回声…" : "发送批注"}
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
      </form>
    </section>
  );
}

function formatCommentTime(milliseconds: number): string {
  const totalSeconds = Math.floor(Math.max(0, milliseconds) / 1_000);
  return `${String(Math.floor(totalSeconds / 60)).padStart(2, "0")}:${String(
    totalSeconds % 60,
  ).padStart(2, "0")}`;
}

function formatCreatedAt(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "刚刚";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}
