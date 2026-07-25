import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(
  new URL("../src/styles.css", import.meta.url),
  "utf8",
);

function mediaSection(start: string, end: string): string {
  const startIndex = styles.indexOf(start);
  const endIndex = styles.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) return "";
  return styles.slice(startIndex, endIndex);
}

describe("手机端聊天优先布局", () => {
  it("720px 以下明确覆盖桌面双列为单列", () => {
    const tablet = mediaSection(
      "@media (max-width: 720px)",
      "@media (max-width: 480px)",
    );
    expect(tablet).toMatch(
      /\.chat-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/u,
    );
  });

  it("480px 以下隐藏口号并压缩会话与输入区域", () => {
    const mobile = mediaSection(
      "@media (max-width: 480px)",
      "@media (hover: hover)",
    );
    expect(mobile).toMatch(
      /\.chat-sidebar\s*>\s*div:first-child\s*\{[^}]*display:\s*none/u,
    );
    expect(mobile).toMatch(
      /\.conversation-header\s*\{[^}]*min-height:\s*52px/u,
    );
    expect(mobile).toMatch(
      /\.composer\s*\{[^}]*padding-top:\s*12px/u,
    );
  });
});
