import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { resolveTrustProxy } from "../src/server.js";

const caddyfileUrl = new URL("../../../infra/Caddyfile", import.meta.url);
const composeUrl = new URL(
  "../../../infra/docker-compose.yml",
  import.meta.url,
);

describe("生产部署安全配置", () => {
  it("Caddy 访问日志删除邮件 Token 与 WebSocket Ticket", async () => {
    const caddyfile = await readFile(caddyfileUrl, "utf8");
    assert.match(
      caddyfile,
      /request>uri\s+query\s*\{[\s\S]*delete\s+token[\s\S]*delete\s+ticket[\s\S]*\}/u,
    );
  });

  it("服务端仅信任受限代理网段，禁止无条件 trustProxy", async () => {
    const compose = await readFile(composeUrl, "utf8");
    assert.match(
      compose,
      /TRUST_PROXY:\s+\$\{TRUST_PROXY:-loopback, linklocal, uniquelocal\}/u,
    );
    assert.doesNotMatch(compose, /TRUST_PROXY:\s+(?:true|"true"|'true')/iu);
    assert.equal(resolveTrustProxy(false, undefined), false);
    assert.equal(
      resolveTrustProxy(true, undefined),
      "loopback, linklocal, uniquelocal",
    );
    assert.equal(resolveTrustProxy(true, "10.20.0.0/16"), "10.20.0.0/16");
    assert.throws(
      () => resolveTrustProxy(true, "true"),
      /禁止配置为 true/u,
    );
  });
});
