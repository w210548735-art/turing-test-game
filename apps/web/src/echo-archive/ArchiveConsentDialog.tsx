import { useEffect, useRef, useState } from "react";
import { createEchoRequestId, submitArchiveConsent } from "./api";

type Decision = "approve" | "decline";

export function ArchiveConsentDialog({
  csrfToken,
  gameId,
  onClose,
}: {
  csrfToken: string;
  gameId: string;
  onClose: () => void;
}) {
  const [decision, setDecision] = useState<Decision | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef<string | null>(null);

  useEffect(() => {
    const previousFocus = document.activeElement;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("keydown", handleEscape);
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, [busy, onClose]);

  async function decide(nextDecision: Decision) {
    if (busy || message) return;
    setDecision(nextDecision);
    setBusy(true);
    setError(null);
    requestIdRef.current ??= createEchoRequestId();
    try {
      const response = await submitArchiveConsent(csrfToken, gameId, {
        decision: nextDecision,
        clientRequestId: requestIdRef.current,
      });
      setMessage(response.message);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "选择暂时没有送达，请重试。",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop archive-consent-backdrop" role="presentation">
      <dialog
        className="modal archive-consent-modal"
        open
        aria-modal="true"
        aria-labelledby="archive-consent-title"
      >
        <button
          className="modal-close"
          type="button"
          aria-label="关闭"
          disabled={busy}
          onClick={onClose}
        >
          ×
        </button>
        <p className="eyebrow">ECHO ARCHIVE / VOLUNTARY</p>
        <h2 id="archive-consent-title">愿意留下这段回声吗？</h2>
        {message ? (
          <div className="archive-consent-result" role="status">
            <span aria-hidden="true">✓</span>
            <strong>选择已经记下啦</strong>
            <p>{message}</p>
            <button className="primary-action" type="button" onClick={onClose}>
              好的喵 <span aria-hidden="true">↗</span>
            </button>
          </div>
        ) : (
          <>
            <p className="modal-lead">
              只有双方都愿意，这局才会在安全处理后成为“回声档案”。
              原始账户 ID 不会出现，鉴证官只会看到匿名玩家 A 与 B。
            </p>
            <ul className="archive-consent-facts">
              <li>仅归档已经发送的消息与服务器观察到的相对时间轴</li>
              <li>举报局、隐私信息或高风险内容不会进入档案池</li>
              <li>若对方是 AI，系统会代它默认同意归档</li>
            </ul>
            {error && (
              <p className="archive-consent-error" role="alert">
                {error}
              </p>
            )}
            <div className="archive-consent-actions">
              <button
                className="primary-action"
                type="button"
                disabled={busy || (decision !== null && decision !== "approve")}
                onClick={() => void decide("approve")}
              >
                {busy && decision === "approve"
                  ? "正在记录…"
                  : "愿意匿名归档"}
                <span aria-hidden="true">↗</span>
              </button>
              <button
                className="text-action"
                type="button"
                disabled={busy || (decision !== null && decision !== "decline")}
                onClick={() => void decide("decline")}
              >
                {busy && decision === "decline"
                  ? "正在记录…"
                  : "不保存这局"}
              </button>
            </div>
          </>
        )}
      </dialog>
    </div>
  );
}
