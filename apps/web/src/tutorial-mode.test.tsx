import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  ChatRoom,
  CreatorDialog,
  FeedbackDialog,
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
    expect(markup).toContain("语言会伪装");
    expect(markup).toContain("你");
    expect(markup).toContain("相信");
    expect(markup).toContain("谁");
    expect(markup).toContain("停顿、措辞，甚至犹豫都可能成为证词");
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
    expect(markup).toContain("别急着问好");
    expect(markup).toContain("答案重要，迟疑也重要");
  });

  it("判断锁定后仍开放输入，并在最后三十秒持续提醒", () => {
    const markup = renderToStaticMarkup(
      <ChatRoom
        nickname="迟疑的人"
        opponentLabel="纸飞机"
        openingQuestions={[]}
        thinkingStatus="正在组织语言…"
        messages={[]}
        opponentTyping={false}
        opponentTypingStatus=""
        messageDraft="最后再问一句"
        gameRemaining={25_000}
        guessRemaining={0}
        guessReady={false}
        guessSubmitted="ai"
        reportConfirmed={false}
        tutorialMode={false}
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

    const composer = markup.match(/<textarea id="message"[^>]*>/u)?.[0];
    expect(composer).toBeTruthy();
    expect(composer).not.toContain("disabled");
    expect(markup).toContain("00:25 后结束");
    expect(markup).toContain("判断已锁定，但对话仍然开放");
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
  it("同时提供三个平台链接与商务合作微信", () => {
    const markup = renderToStaticMarkup(<CreatorDialog onClose={noop} />);

    expect(markup).toContain("BILIBILI / 哔哩哔哩");
    expect(markup).toContain("DOUYIN / 抖音");
    expect(markup).toContain("GITHUB / OPEN SOURCE");
    expect(markup).toContain("WECHAT / BUSINESS");
    expect(markup).toContain("W210548735");
    expect(markup).toContain("添加时请备注来意");
    expect(markup).toContain(
      'href="https://github.com/w210548735-art/turing-test-game"',
    );
    expect(markup).toContain("FOLLOW THE CREATOR / 04");
  });
});

describe("问题反馈弹窗", () => {
  it("教学或未登录状态也允许先填写完整反馈", () => {
    const markup = renderToStaticMarkup(
      <FeedbackDialog
        canSubmit={false}
        busy={false}
        error={null}
        message={null}
        onClose={noop}
        onSubmit={async () => undefined}
      />,
    );

    const fieldset = markup.match(/<fieldset[^>]*>/u)?.[0];
    expect(fieldset).toBeTruthy();
    expect(fieldset).not.toContain("disabled");
    expect(markup).toContain("发生了什么、你原本期待什么");
    expect(markup).toContain("可以先写完");
  });
});
