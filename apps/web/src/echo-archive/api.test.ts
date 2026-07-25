import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimEchoAssignment,
  createEchoComment,
  createEchoRequestId,
  deleteEchoComment,
  getEchoComments,
  getEchoRecords,
  setEchoCommentLike,
  submitArchiveConsent,
  submitEchoJudgment,
} from "./api";

const CSRF = "csrf-token-with-enough-entropy";
const GAME_ID = "d64b6f5e-e83c-4c3d-93eb-99049e59bbf4";
const ASSIGNMENT_ID = "8111e9ca-797a-4d40-a863-934ec6356e0f";
const REQUEST_ID = "32693156-161f-4a69-8828-1262ea1ff290";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("回声档案 API", () => {
  it("生成符合协议 UUID 约束的幂等请求 ID", () => {
    expect(createEchoRequestId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("归档意愿使用 Cookie、CSRF 与幂等请求 ID", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          accepted: true,
          message: "选择已记录，仅在双方同意时归档。",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await submitArchiveConsent(CSRF, GAME_ID, {
      decision: "approve",
      clientRequestId: REQUEST_ID,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/games/${GAME_ID}/archive-consent`);
    expect(init.method).toBe("PUT");
    expect(init.credentials).toBe("include");
    expect(new Headers(init.headers).get("X-CSRF-Token")).toBe(CSRF);
    expect(JSON.parse(String(init.body))).toMatchObject({
      decision: "approve",
      clientRequestId: REQUEST_ID,
    });
  });

  it("没有未读档案时把指定 404 转换为空状态", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: "ECHO_ARCHIVE_UNAVAILABLE",
            message: "暂时没有新的回声档案，请稍后再来看看。",
          }),
          { status: 404, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    await expect(claimEchoAssignment(CSRF)).resolves.toBeNull();
  });

  it("判读请求在网络发送前校验双身份与 UUID", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      submitEchoJudgment(CSRF, ASSIGNMENT_ID, {
        guessA: "human",
        confidenceA: 68,
        guessB: "ai",
        confidenceB: 75,
        clientRequestId: "not-a-uuid",
      }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("完成判读后的批注读取使用独立 GET 且不发送 CSRF", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          comments: [],
          countsByEventSequence: { "3": 0 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getEchoComments(ASSIGNMENT_ID)).resolves.toEqual({
      comments: [],
      countsByEventSequence: { "3": 0 },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/echo/assignments/${ASSIGNMENT_ID}/comments`);
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("include");
    expect(new Headers(init.headers).has("X-CSRF-Token")).toBe(false);
  });

  it("读取云端鉴证战绩使用受保护的独立 GET", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          stats: {
            reviewsPlayed: 0,
            identitiesCorrect: 0,
            perfectJudgments: 0,
            score: 0,
          },
          records: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getEchoRecords()).resolves.toMatchObject({ records: [] });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/echo/records");
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("include");
    expect(new Headers(init.headers).has("X-CSRF-Token")).toBe(false);
  });

  it("发布批注会先校验公开事件序号、长度和幂等 UUID", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createEchoComment(CSRF, ASSIGNMENT_ID, {
        eventSequence: 3,
        content: "短",
        clientRequestId: REQUEST_ID,
      }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("点赞和取消点赞使用同一路径的 PUT/DELETE", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            commentId: "62d37e16-b8b4-4740-a813-e92e9c2710e5",
            liked: true,
            likeCount: 3,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            commentId: "62d37e16-b8b4-4740-a813-e92e9c2710e5",
            liked: false,
            likeCount: 2,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const commentId = "62d37e16-b8b4-4740-a813-e92e9c2710e5";

    await setEchoCommentLike(CSRF, ASSIGNMENT_ID, commentId, true);
    await setEchoCommentLike(CSRF, ASSIGNMENT_ID, commentId, false);

    expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual([
      "PUT",
      "DELETE",
    ]);
    expect(
      fetchMock.mock.calls.map((call) => String(call[0])),
    ).toEqual([
      `/api/echo/assignments/${ASSIGNMENT_ID}/comments/${commentId}/like`,
      `/api/echo/assignments/${ASSIGNMENT_ID}/comments/${commentId}/like`,
    ]);
  });

  it("删除自己的批注校验服务端删除回执", async () => {
    const commentId = "62d37e16-b8b4-4740-a813-e92e9c2710e5";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ commentId, deleted: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      deleteEchoComment(CSRF, ASSIGNMENT_ID, commentId),
    ).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("DELETE");
  });
});
