import assert from "node:assert/strict";
import test from "node:test";
import { createLogin } from "../dist/modules/auth/login.js";

const clock = new Date("2026-10-21T12:00:00.000Z");
const user = { id: "user", email: "user@example.com", fullName: "Member", passwordHash: "private-hash", status: "ACTIVE" };
const credential = { token: "private-delivery-token", key: { id: "session", tokenHash: "private-token-hash" } };
const input = { email: user.email, password: "private-password  " };
const context = { previousSession: undefined, userAgent: "test", ipAddress: "127.0.0.1" };
function fixture(overrides = {}) {
  const calls = [];
  const writes = [];
  const dependencies = {
    store: { async findUserByEmail(email) { calls.push(["lookup", email]); return user; },
      async createSession(session, previous) { calls.push(["create"]); writes.push({ session, previous }); } },
    async verifyPassword(hash, password) { calls.push(["verify", hash, password]); return true; },
    issueSession() { calls.push(["issue"]); return credential; },
    now() { calls.push(["clock"]); return clock; }, ...overrides
  };
  return { login: createLogin(dependencies), calls, writes, dependencies };
}
test("login uses inward contracts in the existing order and returns only safe identity plus cookie delivery material", async () => {
  const { login, calls, writes } = fixture();
  const result = await login(input, context);
  assert.deepEqual(calls, [["lookup", input.email], ["verify", user.passwordHash, input.password], ["issue"], ["clock"], ["create"]]);
  assert.deepEqual(result, { user: { id: user.id, email: user.email, fullName: user.fullName },
    session: { token: credential.token, expiresAt: new Date(clock.getTime() + 86_400_000) } });
  assert.deepEqual(writes, [{ session: { ...credential.key, userId: user.id, createdAt: clock,
    expiresAt: result.session.expiresAt, userAgent: "test", ipAddress: "127.0.0.1" }, previous: undefined }]);
  assert.ok(!JSON.stringify(result).includes(user.passwordHash));
  assert.ok(!JSON.stringify(result).includes(credential.key.tokenHash));
});
for (const scenario of ["missing", "invalid", "inactive"]) {
  test(`login returns the same denial for ${scenario} credentials and still verifies exactly once`, async () => {
    let verifications = 0;
    const { login, calls, writes } = fixture({
      store: { async findUserByEmail() { return scenario === "missing" ? undefined : { ...user, status: scenario === "inactive" ? "INACTIVE" : "ACTIVE" }; },
        async createSession() { assert.fail("No session on denial"); } },
      async verifyPassword(hash, password) { verifications++; assert.equal(hash, scenario === "missing" ? undefined : user.passwordHash);
        assert.equal(password, input.password); return scenario !== "invalid"; }
    });
    assert.equal(await login(input, context), undefined);
    assert.equal(verifications, 1);
    assert.deepEqual(calls, []);
    assert.deepEqual(writes, []);
  });
}
for (const stage of ["lookup", "verifier", "issuance", "persistence"]) {
  test(`login propagates ${stage} failure unchanged and never returns success`, async () => {
    const failure = new Error(`private-${stage}`);
    const { login, dependencies, calls } = fixture();
    if (stage === "lookup") dependencies.store.findUserByEmail = async () => { throw failure; };
    if (stage === "verifier") dependencies.verifyPassword = async () => { throw failure; };
    if (stage === "issuance") dependencies.issueSession = () => { throw failure; };
    if (stage === "persistence") dependencies.store.createSession = async () => { throw failure; };
    // Build with the modified dependencies before invoking the use case.
    await assert.rejects(createLogin(dependencies)(input, context), (error) => error === failure);
    assert.ok(!calls.some(([name]) => name === "create"));
  });
}
test("login passes the full previous credential to atomic rotation without mutating metadata or the clock", async () => {
  const { login, writes } = fixture();
  const previousSession = { id: "old-session", tokenHash: "full-old-credential" };
  const metadata = Object.freeze({ ...context, previousSession });
  await login(input, metadata);
  assert.equal(writes[0].previous, previousSession);
  assert.equal(clock.toISOString(), "2026-10-21T12:00:00.000Z");
  assert.equal(writes[0].session.expiresAt - writes[0].session.createdAt, 86_400_000);
});
test("login forwards only a context-free verifier failure notification and keeps generic denial", async () => {
  let notifications = 0;
  const { login, writes } = fixture({ async verifyPassword(_hash, _password, onFailure) { onFailure(); return false; } });
  assert.equal(await login(input, context, () => { notifications++; }), undefined);
  assert.equal(notifications, 1);
  assert.deepEqual(writes, []);
});
