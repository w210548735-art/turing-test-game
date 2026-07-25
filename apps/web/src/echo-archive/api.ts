import {
  archiveConsentResponseSchema,
  deleteEchoCommentResponseSchema,
  echoAssignmentResponseSchema,
  echoCommentLikeResponseSchema,
  echoCommentSchema,
  echoCommentsResponseSchema,
  echoRecordsResponseSchema,
  submitEchoCommentRequestSchema,
  submitArchiveConsentRequestSchema,
  submitEchoJudgmentRequestSchema,
  submitEchoJudgmentResponseSchema,
  type ArchiveConsentResponse,
  type EchoAssignmentResponse,
  type EchoComment,
  type EchoCommentLikeResponse,
  type EchoCommentsResponse,
  type EchoRecordsResponse,
  type SubmitEchoCommentRequest,
  type SubmitArchiveConsentRequest,
  type SubmitEchoJudgmentRequest,
  type SubmitEchoJudgmentResponse,
} from "@turing-game/protocol";

const API_BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");
export type { EchoComment } from "@turing-game/protocol";

interface ErrorBody {
  code?: string;
  message?: string;
  error?: string | { code?: string; message?: string };
}

export function createEchoRequestId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

async function readError(response: Response): Promise<{
  code?: string;
  message: string;
}> {
  try {
    const body = (await response.json()) as ErrorBody;
    return {
      code:
        body.code ??
        (typeof body.error === "object" ? body.error.code : undefined),
      message:
        body.message ??
        (typeof body.error === "string"
          ? body.error
          : body.error?.message) ??
        `请求失败（${response.status}）`,
    };
  } catch {
    return { message: `请求失败（${response.status}）` };
  }
}

async function requestJson(
  path: string,
  init: RequestInit,
  csrfToken?: string,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (csrfToken) headers.set("X-CSRF-Token", csrfToken);
  return fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    headers,
  });
}

function jsonBody(body: unknown): Pick<RequestInit, "body" | "headers"> {
  return {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  };
}

export async function submitArchiveConsent(
  csrfToken: string,
  gameId: string,
  input: SubmitArchiveConsentRequest,
): Promise<ArchiveConsentResponse> {
  const body = submitArchiveConsentRequestSchema.parse(input);
  const response = await requestJson(
    `/api/games/${encodeURIComponent(gameId)}/archive-consent`,
    { method: "PUT", ...jsonBody(body) },
    csrfToken,
  );
  if (!response.ok) {
    throw new Error((await readError(response)).message);
  }
  return archiveConsentResponseSchema.parse(await response.json());
}

export async function claimEchoAssignment(
  csrfToken: string,
): Promise<EchoAssignmentResponse | null> {
  const response = await requestJson(
    "/api/echo/assignments",
    { method: "POST" },
    csrfToken,
  );
  if (response.status === 404) {
    const error = await readError(response);
    if (error.code === "ECHO_ARCHIVE_UNAVAILABLE") return null;
    throw new Error(error.message);
  }
  if (!response.ok) {
    throw new Error((await readError(response)).message);
  }
  return echoAssignmentResponseSchema.parse(await response.json());
}

export async function resumeEchoAssignment(
  assignmentId: string,
): Promise<EchoAssignmentResponse> {
  const response = await requestJson(
    `/api/echo/assignments/${encodeURIComponent(assignmentId)}`,
    { method: "GET" },
  );
  if (!response.ok) {
    throw new Error((await readError(response)).message);
  }
  return echoAssignmentResponseSchema.parse(await response.json());
}

export async function submitEchoJudgment(
  csrfToken: string,
  assignmentId: string,
  input: SubmitEchoJudgmentRequest,
): Promise<SubmitEchoJudgmentResponse> {
  const body = submitEchoJudgmentRequestSchema.parse(input);
  const response = await requestJson(
    `/api/echo/assignments/${encodeURIComponent(assignmentId)}/judgment`,
    { method: "POST", ...jsonBody(body) },
    csrfToken,
  );
  if (!response.ok) {
    throw new Error((await readError(response)).message);
  }
  return submitEchoJudgmentResponseSchema.parse(await response.json());
}

export async function getEchoRecords(): Promise<EchoRecordsResponse> {
  const response = await requestJson(
    "/api/echo/records",
    { method: "GET" },
  );
  if (!response.ok) {
    throw new Error((await readError(response)).message);
  }
  return echoRecordsResponseSchema.parse(await response.json());
}

export async function getEchoComments(
  assignmentId: string,
): Promise<EchoCommentsResponse> {
  const response = await requestJson(
    `/api/echo/assignments/${encodeURIComponent(assignmentId)}/comments`,
    { method: "GET" },
  );
  if (!response.ok) {
    throw new Error((await readError(response)).message);
  }
  return echoCommentsResponseSchema.parse(await response.json());
}

export async function createEchoComment(
  csrfToken: string,
  assignmentId: string,
  input: SubmitEchoCommentRequest,
): Promise<EchoComment> {
  const body = submitEchoCommentRequestSchema.parse(input);
  const response = await requestJson(
    `/api/echo/assignments/${encodeURIComponent(assignmentId)}/comments`,
    { method: "POST", ...jsonBody(body) },
    csrfToken,
  );
  if (!response.ok) {
    throw new Error((await readError(response)).message);
  }
  return echoCommentSchema.parse(await response.json());
}

export async function setEchoCommentLike(
  csrfToken: string,
  assignmentId: string,
  commentId: string,
  liked: boolean,
): Promise<EchoCommentLikeResponse> {
  const response = await requestJson(
    `/api/echo/assignments/${encodeURIComponent(
      assignmentId,
    )}/comments/${encodeURIComponent(commentId)}/like`,
    { method: liked ? "PUT" : "DELETE" },
    csrfToken,
  );
  if (!response.ok) {
    throw new Error((await readError(response)).message);
  }
  return echoCommentLikeResponseSchema.parse(await response.json());
}

export async function deleteEchoComment(
  csrfToken: string,
  assignmentId: string,
  commentId: string,
): Promise<void> {
  const response = await requestJson(
    `/api/echo/assignments/${encodeURIComponent(
      assignmentId,
    )}/comments/${encodeURIComponent(commentId)}`,
    { method: "DELETE" },
    csrfToken,
  );
  if (!response.ok) {
    throw new Error((await readError(response)).message);
  }
  deleteEchoCommentResponseSchema.parse(await response.json());
}
