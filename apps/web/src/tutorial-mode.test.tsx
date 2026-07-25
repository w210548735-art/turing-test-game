import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  ChatRoom,
  CreatorDialog,
  Onboarding,
  ResultScreen,
} from "./App";

const noop = vi.fn();

describe("教学模式引导", () => {
  it("在入场页解释临时名称并突出教学入口", () => {
    const markup = renderToStaticMarkup(
      <Onboarding
        nickname="迟疑的人"
        thinkingStatus="正在组织语言…"
        isStarting={false}
        onlineEnabled={false}
        tutorialMode
        onNicknameChange={noop}
        onThinkingStatusChange={noop}
        onSubmit={noop}
        onDemo={noop}
        onEcho={noop}
      />,
    );

    expect(markup).toContain("教学 01");
    expect(markup).toContain("先起一个本局名字");
    expect(markup).toContain("开始教学对局");
    expect(markup).toContain("tutorial-ring");
  });

  it("在聊天页依次提示选题、发送与最终判断", () => {
    const markup = renderToStaticMarkup(
      <ChatRoom
        nickname="迟疑的人"
        opponentLabel="纸飞机"
        openingQuestions={["你最近一次改变看法，是因为什么？"]}
        thinkingStatus="正在组织语言…"
        messages={[]}
        opponentTyping={false}
        opponentTypingStatus=""
        messageDraft=""
        gameRemaining={280_000}
        guessRemaining={12_000}
        guessReady={false}
        guessSubmitted={null}
        reportConfirmed={false}
        tutorialMode
        messagesEndRef={{ current: null }}
        onMessageChange={noop}
        onMessageSubmit={noop}
        onMessageBlur={noop}
        onMessageKeyDown={noop}
        onGuess={noop}
        onReport={noop}
        onLeave={noop}
      />,
    );

    expect(markup).toContain("教学 04");
    expect(markup).toContain("点一个问题试试");
    expect(markup).toContain("教学 05 · 写好后点发送");
    expect(markup).toContain("教学 06 · 最后在这里判断");
  });

  it("在结算页明确提示教学完成", () => {
    const markup = renderToStaticMarkup(
      <ResultScreen
        result={{
          opponentType: "ai",
          guess: "ai",
          isCorrect: true,
          outcome: "won",
        }}
        nickname="迟疑的人"
        messageCount={4}
        tutorialMode
        onAgain={noop}
        onHome={noop}
      />,
    );

    expect(markup).toContain("教学 07");
    expect(markup).toContain("教学完成");
  });
});

describe("关注作者弹窗", () => {
  it("同时提供 B 站、抖音和 GitHub 项目链接", () => {
    const markup = renderToStaticMarkup(<CreatorDialog onClose={noop} />);

    expect(markup).toContain("BILIBILI / 哔哩哔哩");
    expect(markup).toContain("DOUYIN / 抖音");
    expect(markup).toContain("GITHUB / OPEN SOURCE");
    expect(markup).toContain(
      'href="https://github.com/w210548735-art/turing-test-game"',
    );
    expect(markup).toContain("FOLLOW THE CREATOR / 03");
  });
});
