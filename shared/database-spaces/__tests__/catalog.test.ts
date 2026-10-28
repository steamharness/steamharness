// @vitest-environment node
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { assertDatabaseAuthorization, emptyDatabasePermissions, type DatabaseActor, type DatabasePermissions } from "../index";
import { DatabaseCatalog } from "../catalog";
const applicant: DatabaseActor = { userId: "alice", isSystemAdmin: false };
const admin: DatabaseActor = { userId: "admin", isSystemAdmin: true };
const all: DatabasePermissions = { kv: { read: { mode: "all" }, write: { mode: "all" } }, knowledge: { read: { mode: "all" }, write: { mode: "all" } } };
const input = () => ({ projectId: randomUUID(), entryId: "agent", alias: "data", target: { kind: "create" as const, name: "shared data" }, permissions: all });
const catalog = (host: "local" | "server" = "server") => new DatabaseCatalog(host, { spaces: [], requests: [], grants: [], bindings: [] }, randomUUID, () => new Date().toISOString());
describe.each(["local", "server"] as const)("%s database approval", (host) => {
  it("never creates space/grant/binding before explicit administrator approval", () => {
    const c = catalog(host); const request = c.request(input(), applicant);
    expect(c.state.spaces).toHaveLength(0); expect(c.state.bindings).toHaveLength(0);
    expect(() => c.review(request.requestId, { approve: true }, applicant)).toThrow("administrator");
    const approved = c.review(request.requestId, { approve: true }, admin);
    expect(c.authorization(approved.bindingRef!)!.space.ownerId).toBe("alice");
    expect(() => c.review(request.requestId, { approve: true }, admin)).toThrow("already");
  });
  it("supports rejection, retry, duplicate protection, and reduced approval", () => {
    const c = catalog(host); const consumer = input(); const first = c.request(consumer, applicant);
    expect(() => c.request(consumer, applicant)).toThrow("pending");
    c.review(first.requestId, { approve: false, reason: "too broad" }, admin);
    const retry = c.request(consumer, applicant);
    const reduced = emptyDatabasePermissions(); reduced.kv.read = { mode: "prefixes", prefixes: ["public:"] };
    const approved = c.review(retry.requestId, { approve: true, permissions: reduced }, admin);
    const auth = c.authorization(approved.bindingRef!)!;
    const consumerWithBinding = { ...consumer, host, bindingRef: approved.bindingRef };
    expect(() => assertDatabaseAuthorization(auth, consumerWithBinding, "kv", "read", "public:a")).not.toThrow();
    expect(() => assertDatabaseAuthorization(auth, consumerWithBinding, "kv", "write", "public:a")).toThrow("does not allow");
    expect(() => assertDatabaseAuthorization(auth, { ...consumerWithBinding, entryId: "other" }, "kv", "read", "public:a")).toThrow("different consumer");
    expect(() => assertDatabaseAuthorization(auth, { ...consumerWithBinding, host: host === "local" ? "server" : "local" }, "kv", "read", "public:a")).toThrow("different consumer");
  });
  it("requires space-owner approval for another project, and supports rotation and revocation", () => {
    const c = catalog(host); const first = c.request(input(), applicant); const approved = c.review(first.requestId, { approve: true }, admin);
    const spaceId = c.authorization(approved.bindingRef!)!.space.spaceId;
    const consumer = { ...input(), target: { kind: "access" as const, spaceId } };
    const second = c.request(consumer, { userId: "bob", isSystemAdmin: false });
    expect(() => c.review(second.requestId, { approve: true }, { userId: "bob", isSystemAdmin: false })).toThrow();
    const granted = c.review(second.requestId, { approve: true }, applicant);
    const auth = c.authorization(granted.bindingRef!)!;
    expect(auth.space.spaceId).toBe(spaceId); expect(c.state.spaces).toHaveLength(1);
    const bound = { ...consumer, host, bindingRef: granted.bindingRef };
    c.rotate(auth.grant.grantId, applicant);
    expect(() => assertDatabaseAuthorization(c.authorization(granted.bindingRef!)!, bound, "kv", "read", "a", 1)).toThrow("no longer valid");
    c.revoke(auth.grant.grantId, applicant);
    expect(() => assertDatabaseAuthorization(c.authorization(granted.bindingRef!)!, bound, "kv", "read", "a")).toThrow("no longer valid");
    expect(c.state.spaces).toHaveLength(1);
  });
  it("refuses grant escalation and unbound access", () => {
    const c = catalog(host); const consumer = { ...input(), permissions: emptyDatabasePermissions() };
    const request = c.request(consumer, applicant);
    expect(() => c.review(request.requestId, { approve: true, permissions: all }, admin)).toThrow("widen");
    expect(() => assertDatabaseAuthorization(undefined, { ...consumer, host }, "kv", "read", "x")).toThrow("approved binding");
    expect(c.visible({ userId: "stranger", isSystemAdmin: false }).requests).toHaveLength(0);
  });
  it("does not accept approval metadata or another consumer's binding in a request", () => {
    const c = catalog(host);
    const privateRequest = c.request(input(), applicant);
    const approved = c.review(privateRequest.requestId, { approve: true }, admin);
    const stranger = { userId: "stranger", isSystemAdmin: false };
    const pending = c.request({
      ...input(), bindingRef: approved.bindingRef, reviewerId: admin.userId,
      reviewedAt: new Date().toISOString(), reason: "forged approval",
    } as ReturnType<typeof input>, stranger);
    expect(pending.status).toBe("pending");
    expect(pending).not.toHaveProperty("bindingRef");
    expect(pending).not.toHaveProperty("reviewerId");
    expect(pending).not.toHaveProperty("reviewedAt");
    expect(pending).not.toHaveProperty("reason");
    const visible = c.visible(stranger);
    expect(visible.spaces).toEqual([]);
    expect(visible.grants).toEqual([]);
    expect(visible.bindings).toEqual([]);
  });
});
