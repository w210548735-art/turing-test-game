import type { EchoComment } from "@turing-game/protocol";

export type EchoCommentSort = "latest" | "popular";
export type EchoCommentGateView = "playback" | "result" | "review";

export function shouldLoadEchoComments(
  view: EchoCommentGateView,
  loaded: boolean,
  loading: boolean,
): boolean {
  return view === "review" && !loaded && !loading;
}

export function commentsForEvent(
  comments: readonly EchoComment[],
  eventSequence: number,
): EchoComment[] {
  return comments.filter(
    (comment) => comment.eventSequence === eventSequence,
  );
}

export function sortEchoComments(
  comments: readonly EchoComment[],
  sort: EchoCommentSort,
): EchoComment[] {
  return [...comments].sort((left, right) =>
    sort === "popular"
      ? right.likeCount - left.likeCount ||
        Date.parse(right.createdAt) - Date.parse(left.createdAt)
      : Date.parse(right.createdAt) - Date.parse(left.createdAt),
  );
}

export function applyLikeSnapshot(
  comments: readonly EchoComment[],
  commentId: string,
  likedByMe: boolean,
  likeCount: number,
): EchoComment[] {
  return comments.map((comment) =>
    comment.id === commentId
      ? {
          ...comment,
          likedByMe,
          likeCount: Math.max(0, likeCount),
        }
      : comment,
  );
}
