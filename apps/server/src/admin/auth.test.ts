import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AdminAuthenticator,
  hashBearerToken,
  type AdminPrincipal,
} from "./auth.js";

const principals: AdminPrincipal[] = [
  {
    id: "reviewer-1",
    role: "REVIEWER",
    tokenHash: hashBearerToken("local-test-token"),
    active: true,
  },
];

describe("AdminAuthenticator", () => {
  it("accepts a hashed bearer credential without exposing the token", () => {
    const authenticator = new AdminAuthenticator(principals);
    const authentication = authenticator.authenticate(
      "Bearer local-test-token",
      "trace-1",
    );
    assert.equal(authentication.principal.id, "reviewer-1");
    assert.equal(JSON.stringify(authentication).includes("local-test-token"), false);
  });

  it("returns the same generic failure for missing and invalid credentials", () => {
    const authenticator = new AdminAuthenticator(principals);
    assert.throws(() => authenticator.authenticate(undefined), {
      code: "UNAUTHORIZED",
    });
    assert.throws(() => authenticator.authenticate("Bearer invalid"), {
      code: "UNAUTHORIZED",
    });
  });

  it("enforces role permissions", () => {
    const authenticator = new AdminAuthenticator(principals);
    const authentication = authenticator.authenticate(
      "Bearer local-test-token",
    );
    authenticator.require(authentication, "REPORT_READ");
    assert.throws(
      () => authenticator.require(authentication, "BAN_ISSUE"),
      { code: "FORBIDDEN" },
    );
  });
});
