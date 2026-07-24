import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FeedbackDigestWorker,
  FeedbackService,
  latestBeijingTenAmCutoff,
  MemoryFeedbackRepository,
  type FeedbackDigestEmailMessage,
} from "../src/feedback/index.js";

const USER_ID = "7febf16e-48ef-4ef4-8422-edb227b6b7fe";

describe("FeedbackService", () => {
  it("提交反馈时只持久化，不承担邮件投递", async () => {
    const repository = new MemoryFeedbackRepository();
    repository.now = () => new Date("2026-07-25T01:59:00.000Z");
    const service = new FeedbackService({ repository });

    const result = await service.submit({
      userId: USER_ID,
      category: "suggestion",
      title: "增加历史筛选",
      details: "希望历史记录可以按照对手类型进行筛选。",
    });

    assert.equal(repository.records[0]?.id, result.feedbackId);
    assert.equal(repository.records[0]?.deliveryStatus, "pending");
    assert.equal(repository.records[0]?.deliveredAt, null);
  });
});

describe("FeedbackDigestWorker", () => {
  it("按北京时间 10:00 计算最近截止点并支持启动补跑", () => {
    assert.equal(
      latestBeijingTenAmCutoff(
        new Date("2026-07-25T01:59:59.999Z"),
      ).toISOString(),
      "2026-07-24T02:00:00.000Z",
    );
    assert.equal(
      latestBeijingTenAmCutoff(
        new Date("2026-07-25T02:00:00.000Z"),
      ).toISOString(),
      "2026-07-25T02:00:00.000Z",
    );
    assert.equal(
      latestBeijingTenAmCutoff(
        new Date("2026-07-25T08:00:00.000Z"),
      ).toISOString(),
      "2026-07-25T02:00:00.000Z",
    );
  });

  it("只汇总截止时间及以前的反馈，晚于截止点的留到次日", async () => {
    const repository = new MemoryFeedbackRepository();
    const service = new FeedbackService({ repository });
    const messages: FeedbackDigestEmailMessage[] = [];
    repository.now = () => new Date("2026-07-25T02:00:00.000Z");
    const atCutoff = await service.submit({
      userId: USER_ID,
      category: "suggestion",
      title: "截止点反馈",
      details: "这条反馈恰好在北京时间十点提交。",
    });
    repository.now = () => new Date("2026-07-25T02:00:00.001Z");
    await service.submit({
      userId: USER_ID,
      category: "other",
      title: "截止后反馈",
      details: "这条反馈应该留到下一次每日汇总。",
    });
    const worker = new FeedbackDigestWorker({
      repository,
      recipientEmail: "redacted@example.com",
      now: () => new Date("2026-07-25T02:00:01.000Z"),
      leaseOwner: "cutoff-worker",
      delivery: {
        async sendFeedbackDigest(message) {
          messages.push(message);
        },
      },
    });

    await worker.runOnce();

    assert.equal(messages.length, 1);
    assert.deepEqual(
      messages[0]?.digest.feedback.map((item) => item.id),
      [atCutoff.feedbackId],
    );
    assert.equal(repository.records[0]?.deliveryStatus, "sent");
    assert.equal(repository.records[1]?.deliveryStatus, "pending");
  });

  it("SMTP 失败后按退避重试，并在所有尝试中保持相同 Message-ID", async () => {
    const repository = new MemoryFeedbackRepository();
    const failures: Array<{ id: string; errorName: string }> = [];
    const messageIds: string[] = [];
    let now = new Date("2026-07-25T02:00:01.000Z");
    repository.now = () => new Date("2026-07-25T01:00:00.000Z");
    await new FeedbackService({ repository }).submit({
      userId: USER_ID,
      category: "bug",
      title: "加载失败",
      details: "刷新页面以后加载状态一直没有结束。",
    });
    let attempt = 0;
    const worker = new FeedbackDigestWorker({
      repository,
      recipientEmail: "redacted@example.com",
      leaseOwner: "retry-worker",
      now: () => now,
      delivery: {
        async sendFeedbackDigest(message) {
          messageIds.push(message.digest.messageId);
          attempt += 1;
          if (attempt === 1) {
            throw new TypeError("包含敏感正文的模拟错误");
          }
        },
      },
      onFailure(digestId, errorName) {
        failures.push({ id: digestId, errorName });
      },
    });

    await worker.runOnce();
    assert.equal(repository.records[0]?.deliveryStatus, "failed");
    assert.equal(failures[0]?.errorName, "TypeError");
    await worker.runOnce();
    assert.equal(messageIds.length, 1);

    now = new Date(now.getTime() + 5 * 60_000);
    await worker.runOnce();
    assert.equal(repository.records[0]?.deliveryStatus, "sent");
    assert.equal(messageIds.length, 2);
    assert.equal(messageIds[0], messageIds[1]);
    assert.equal(repository.digests[0]?.attemptCount, 2);
  });

  it("多个实例竞争同一批次时只有租约持有者投递", async () => {
    const repository = new MemoryFeedbackRepository();
    repository.now = () => new Date("2026-07-25T01:00:00.000Z");
    await new FeedbackService({ repository }).submit({
      userId: USER_ID,
      category: "suggestion",
      title: "多实例测试",
      details: "同一批反馈只能由一个摘要实例投递。",
    });
    const messages: FeedbackDigestEmailMessage[] = [];
    const workerOptions = {
      repository,
      recipientEmail: "redacted@example.com",
      now: () => new Date("2026-07-25T02:00:01.000Z"),
      delivery: {
        async sendFeedbackDigest(message: FeedbackDigestEmailMessage) {
          messages.push(message);
        },
      },
    };
    const first = new FeedbackDigestWorker({
      ...workerOptions,
      leaseOwner: "instance-a",
    });
    const second = new FeedbackDigestWorker({
      ...workerOptions,
      leaseOwner: "instance-b",
    });

    await Promise.all([first.runOnce(), second.runOnce()]);

    assert.equal(messages.length, 1);
    assert.equal(repository.digests.length, 1);
    assert.equal(repository.records[0]?.deliveryStatus, "sent");
  });

  it("实例中断后由新实例接管过期租约并沿用原 Message-ID", async () => {
    const repository = new MemoryFeedbackRepository();
    repository.now = () => new Date("2026-07-25T01:00:00.000Z");
    await new FeedbackService({ repository }).submit({
      userId: USER_ID,
      category: "bug",
      title: "租约接管测试",
      details: "原实例中断后应由另一个实例继续投递。",
    });
    const claimed = await repository.claimDigest({
      cutoffAt: new Date("2026-07-25T02:00:00.000Z"),
      now: new Date("2026-07-25T02:00:01.000Z"),
      leaseOwner: "abandoned-instance",
      leaseMs: 60_000,
    });
    assert.ok(claimed);
    const originalMessageId = claimed.messageId;
    const messages: FeedbackDigestEmailMessage[] = [];
    const worker = new FeedbackDigestWorker({
      repository,
      recipientEmail: "redacted@example.com",
      now: () => new Date("2026-07-25T02:01:02.000Z"),
      leaseOwner: "replacement-instance",
      delivery: {
        async sendFeedbackDigest(message) {
          messages.push(message);
        },
      },
    });

    await worker.runOnce();

    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.digest.id, claimed.id);
    assert.equal(messages[0]?.digest.messageId, originalMessageId);
    assert.equal(repository.records[0]?.deliveryStatus, "sent");
  });
});
