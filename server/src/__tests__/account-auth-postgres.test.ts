import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { AccountRepository } from "../account-db";
import { AuthService } from "../account-auth";

const databaseUrl = process.env.STEAMHARNESS_TEST_DATABASE_URL?.trim();

test("native PostgreSQL auth preserves sessions, invitations, API keys, locks, transactions, and notifications", {
  skip: databaseUrl ? false : "STEAMHARNESS_TEST_DATABASE_URL is not configured",
}, async () => {
  assert.ok(databaseUrl);
  const accountDb = new AccountRepository(databaseUrl);
  const auth = new AuthService({ databaseUrl, accountDb });
  const pool = new pg.Pool({ connectionString: databaseUrl });
  await accountDb.init();

  try {
    const admin = await auth.signInBootstrapAdmin({
      email: "admin@example.com",
      password: "bootstrap-password",
      displayName: "SteamHarness Admin",
    });
    const adminProfile = await accountDb.getUserProfileOrThrow(admin.user.userId);
    assert.ok(adminProfile.permissions.includes("system.admin"));

    const signedInAdmin = await auth.signInWithPassword({
      email: "admin@example.com",
      password: "bootstrap-password",
    });
    assert.equal(signedInAdmin.user.userId, admin.user.userId);
    const adminSessionRow = (await pool.query<{
      access_expires_at: Date;
      expires_at: Date;
      access_token_hash: string;
      refresh_token_hash: string;
    }>(
      `select access_expires_at, expires_at, access_token_hash, refresh_token_hash
       from steamharness_auth_sessions where refresh_token_hash = $1`,
      [sha256Text(signedInAdmin.refreshToken)],
    )).rows[0];
    assert.ok(adminSessionRow);
    assert.match(adminSessionRow.access_token_hash, /^[a-f0-9]{64}$/u);
    assert.match(adminSessionRow.refresh_token_hash, /^[a-f0-9]{64}$/u);
    assert.notEqual(adminSessionRow.access_token_hash, signedInAdmin.accessToken);
    assert.notEqual(adminSessionRow.refresh_token_hash, signedInAdmin.refreshToken);
    assertTtlNear(adminSessionRow.access_expires_at, 60 * 60 * 1000);
    assertTtlNear(adminSessionRow.expires_at, 30 * 24 * 60 * 60 * 1000);

    await pool.query(
      "update steamharness_auth_sessions set access_expires_at = now() - interval '1 second' where refresh_token_hash = $1",
      [sha256Text(signedInAdmin.refreshToken)],
    );
    await assert.rejects(auth.getUserByAccessToken(signedInAdmin.accessToken), /invalid/u);
    await auth.updateAuthUser({ userId: admin.user.userId, password: "changed-bootstrap-password" });
    await assert.rejects(
      auth.signInBootstrapAdmin({ email: "admin@example.com", password: "bootstrap-password" }),
      /invalid/u,
    );
    assert.equal(
      (await auth.signInWithPassword({ email: "admin@example.com", password: "changed-bootstrap-password" })).user.userId,
      admin.user.userId,
    );
    await assert.rejects(
      auth.signInBootstrapAdmin({ email: "second-admin@example.com", password: "bootstrap-password" }),
      /invalid/u,
    );

    const invited = await auth.inviteUser({
      email: "invited@example.com",
      displayName: "Invited User",
      createdByUserId: admin.user.userId,
      redirectTo: "https://api.steamharness.example.com",
    });
    assert.ok(invited.invitationLink);
    const firstInvitationToken = new URL(invited.invitationLink).pathname.split("/").at(-1);
    if (!firstInvitationToken?.startsWith("wf_invite_")) throw new Error("Invitation token is missing.");
    const invitation = await auth.getInvitation(firstInvitationToken);
    assert.equal(invitation.email, "invited@example.com");
    assertTtlNear(new Date(invitation.expiresAt), 24 * 60 * 60 * 1000);
    const invitationRow = (await pool.query<{ token_hash: string }>(
      `select token_hash from steamharness_auth_invitations
       where user_id = (select id from steamharness_auth_users where email = $1)`,
      ["invited@example.com"],
    )).rows[0];
    assert.match(invitationRow?.token_hash ?? "", /^[a-f0-9]{64}$/u);
    assert.notEqual(invitationRow?.token_hash, firstInvitationToken);

    const replacementInvitation = await auth.generateInviteLink("invited@example.com", "https://api.steamharness.example.com");
    const invitationToken = new URL(replacementInvitation.invitationLink).pathname.split("/").at(-1);
    if (!invitationToken?.startsWith("wf_invite_")) throw new Error("Replacement invitation token is missing.");
    await assert.rejects(auth.getInvitation(firstInvitationToken), /not found/u);

    const accepted = await auth.acceptInvitation({
      token: invitationToken,
      password: "invited-password",
      displayName: "Activated User",
    });
    const acceptedProfile = await accountDb.getUserProfileOrThrow(accepted.user.userId);
    assert.equal(acceptedProfile.status, "active");
    assert.deepEqual(acceptedProfile.roleIds, ["builtin_viewer"]);
    await assert.rejects(
      auth.acceptInvitation({ token: invitationToken, password: "another-password" }),
      /already been accepted/u,
    );

    const refreshed = await auth.refreshSession(accepted.refreshToken);
    assert.notEqual(refreshed.accessToken, accepted.accessToken);
    await auth.revokeSession(accepted.refreshToken);
    await assert.rejects(auth.refreshSession(accepted.refreshToken), /expired/u);

    const invitedLogin = await auth.signInWithPassword({
      email: "invited@example.com",
      password: "invited-password",
    });
    const apiKey = await accountDb.createApiKey({
      userId: invitedLogin.user.userId,
      name: "Integration CLI",
      source: "cli",
    });
    const apiPrincipal = await auth.resolvePrincipal(createBearerRequest(apiKey.token));
    assert.equal(apiPrincipal?.kind, "api_key");
    await accountDb.revokeApiKey(apiKey.record.id);
    await assert.rejects(auth.resolvePrincipal(createBearerRequest(apiKey.token)), /Unauthorized/u);

    const resetInvitation = await auth.generateInviteLink("invited@example.com", "https://api.steamharness.example.com");
    const resetInvitationToken = new URL(resetInvitation.invitationLink).pathname.split("/").at(-1);
    if (!resetInvitationToken) throw new Error("Reset invitation token is missing.");
    await auth.acceptInvitation({ token: resetInvitationToken, password: "reset-password" });
    await assert.rejects(auth.refreshSession(invitedLogin.refreshToken), /expired/u);
    const resetPasswordLogin = await auth.signInWithPassword({
      email: "invited@example.com",
      password: "reset-password",
    });
    await auth.updateAuthUser({ userId: invitedLogin.user.userId, password: "changed-password" });
    await assert.rejects(auth.refreshSession(resetPasswordLogin.refreshToken), /expired/u);
    await assert.rejects(
      auth.signInWithPassword({ email: "invited@example.com", password: "invited-password" }),
      /invalid/u,
    );
    const changedPasswordLogin = await auth.signInWithPassword({
      email: "invited@example.com",
      password: "changed-password",
    });
    await auth.updateAuthUser({ userId: invitedLogin.user.userId, disabled: true });
    await assert.rejects(auth.refreshSession(changedPasswordLogin.refreshToken), /expired/u);
    await assert.rejects(
      auth.signInWithPassword({ email: "invited@example.com", password: "changed-password" }),
      /invalid/u,
    );

    const expiredInvite = await auth.inviteUser({ email: "expired@example.com" });
    const expiredInviteToken = new URL(expiredInvite.invitationLink!).pathname.split("/").at(-1);
    if (!expiredInviteToken) throw new Error("Expired invitation token is missing.");
    await pool.query(
      "update steamharness_auth_invitations set expires_at = now() - interval '1 second' where token_hash = $1",
      [sha256Text(expiredInviteToken)],
    );
    await assert.rejects(
      auth.acceptInvitation({ token: expiredInviteToken, password: "expired-password" }),
      /expired/u,
    );

    const transactionClient = await pool.connect();
    try {
      await transactionClient.query("begin");
      await transactionClient.query(
        "insert into steamharness_auth_users (id, email, display_name) values ($1, $2, $3)",
        ["rollback-user", "rollback@example.com", "Rollback User"],
      );
      await transactionClient.query("rollback");
    } finally {
      transactionClient.release();
    }
    assert.equal((await pool.query("select 1 from steamharness_auth_users where id = $1", ["rollback-user"])).rowCount, 0);

    const lockOwner = await pool.connect();
    const lockContender = await pool.connect();
    try {
      await lockOwner.query("select pg_advisory_lock(424242)");
      const locked = await lockContender.query<{ acquired: boolean }>("select pg_try_advisory_lock(424242) as acquired");
      assert.equal(locked.rows[0]?.acquired, false);
      await lockOwner.query("select pg_advisory_unlock(424242)");
      const acquired = await lockContender.query<{ acquired: boolean }>("select pg_try_advisory_lock(424242) as acquired");
      assert.equal(acquired.rows[0]?.acquired, true);
      await lockContender.query("select pg_advisory_unlock(424242)");
    } finally {
      lockOwner.release();
      lockContender.release();
    }

    const listener = await pool.connect();
    try {
      await listener.query("listen steamharness_auth_test");
      const notification = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("LISTEN/NOTIFY timed out")), 5_000);
        listener.once("notification", (message) => {
          clearTimeout(timeout);
          resolve(message.payload ?? "");
        });
      });
      await pool.query("select pg_notify('steamharness_auth_test', 'ready')");
      assert.equal(await notification, "ready");
    } finally {
      await listener.query("unlisten steamharness_auth_test");
      listener.release();
    }
  } finally {
    await pool.end();
    await auth.close();
    await accountDb.close();
  }
});

function createBearerRequest(token: string) {
  return {
    headers: { authorization: `Bearer ${token}` },
    header() {
      return undefined;
    },
    get() {
      return undefined;
    },
    ip: "127.0.0.1",
  } as never;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertTtlNear(value: Date, expectedMs: number): void {
  const ttlMs = value.getTime() - Date.now();
  assert.ok(ttlMs > expectedMs - 10_000, `expected TTL near ${expectedMs}ms, received ${ttlMs}ms`);
  assert.ok(ttlMs <= expectedMs, `expected TTL at most ${expectedMs}ms, received ${ttlMs}ms`);
}
