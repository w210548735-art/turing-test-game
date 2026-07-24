import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AiRuntimeController } from "../src/ai/runtime-controller.js";

describe("AI 预算与熔断", () => {
  it("达到小时请求上限后拒绝新调用", async () => {
    const controller = new AiRuntimeController(2, 1, 1000);
    const first = await controller.execute(async () => ({
      value: "ok",
      usage: { promptTokens: 10, completionTokens: 5 },
    }));
    assert.equal(first, "ok");
    await assert.rejects(
      controller.execute(async () => ({
        value: "blocked",
        usage: { promptTokens: 0, completionTokens: 0 },
      })),
      /使用上限/,
    );
  });

  it("累计五次失败后打开熔断器", async () => {
    let now = 1_000;
    const controller = new AiRuntimeController(1, 100, 1000, () => now);
    for (let index = 0; index < 5; index += 1) {
      await assert.rejects(
        controller.execute(async () => {
          throw new Error("provider failed");
        }),
      );
      now += 100;
    }
    assert.ok(controller.snapshot().circuitOpenUntil);
    await assert.rejects(
      controller.execute(async () => ({
        value: "blocked",
        usage: { promptTokens: 0, completionTokens: 0 },
      })),
      /暂时繁忙/,
    );
  });
});
