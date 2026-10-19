import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as argon2 from "argon2";
import { createDatabase } from "@ledgerflow/db";
import { createMigrator } from "../../../packages/db/dist/migrator.js";
import { createApp } from "../../api/dist/app.js";
import { PostgresAuthStore } from "../../api/dist/infrastructure/auth-store.js";
import { PostgresOrganizationStore } from "../../api/dist/infrastructure/organization-store.js";
import { OrganizationService } from "../../api/dist/modules/organizations/service.js";
import { loadAuthConfig } from "../../api/dist/modules/auth/config.js";
export async function startIdentityFixture() {
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must point to disposable PostgreSQL.");
  const schema = `identity_ui_${randomUUID().replaceAll("-", "")}`;
  const admin = createDatabase(process.env.TEST_DATABASE_URL);
  await admin.schema.createSchema(schema).execute();
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  const db = createDatabase(url.toString());
  let api;
  let web;
  let logs = "";
  const stop = async () => {
    if (web && web.exitCode === null) {
      const exited = once(web, "exit");
      if (process.platform === "win32") {
        const terminate = spawn("taskkill", ["/PID", String(web.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        await once(terminate, "exit");
      } else web.kill();
      await exited;
    }
    if (api) await new Promise((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
    await db.destroy();
    await admin.schema.dropSchema(schema).cascade().execute();
    await admin.destroy();
  };
  try {
    const migration = await createMigrator(db, schema).migrateToLatest();
    if (migration.error) throw migration.error;
    const password = "Disposable UI Password 123!";
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    const ownerId = "10000000-0000-0000-0000-000000000001";
    const viewerId = "20000000-0000-0000-0000-000000000001";
    const targetId = "30000000-0000-0000-0000-000000000001";
    await db.insertInto("users").values([
      { id: ownerId, email: "owner@ui.example", full_name: "Olivia Owner", password_hash: hash },
      { id: viewerId, email: "viewer@ui.example", full_name: "Victor Viewer", password_hash: hash },
      { id: targetId, email: "target@ui.example", full_name: "Target", password_hash: "!" }
    ]).execute();
    const service = new OrganizationService(new PostgresOrganizationStore(db));
    const actor = { userId: ownerId, correlationId: randomUUID() };
    const { organization } = await service.create(actor, { name: "Acme Studio", baseCurrency: "EGP", accountingTimezone: "Africa/Cairo" }, randomUUID());
    await service.add(organization.id, actor, { userId: viewerId, role: "VIEWER" });
    const extraIds = Array.from({ length: 25 }, (_, index) => `40000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`);
    await db.insertInto("users").values(extraIds.map((id) => ({ id, email: `${id}@ui.example`, full_name: "Team member", password_hash: "!" }))).execute();
    await db.insertInto("memberships").values(extraIds.map((id) => ({ organization_id: organization.id, user_id: id, role: "VIEWER" }))).execute();
    const baseUrl = "http://127.0.0.1:3135";
    api = createApp({ authStore: new PostgresAuthStore(db), organizationStore: new PostgresOrganizationStore(db),
      authConfig: loadAuthConfig({ NODE_ENV: "test", WEB_ORIGIN: baseUrl }), checkDatabase: async () => {} }).listen(0, "127.0.0.1");
    await once(api, "listening");
    const apiUrl = `http://127.0.0.1:${api.address().port}`;
    web = spawn(process.execPath, [fileURLToPath(new URL("../../../node_modules/next/dist/bin/next", import.meta.url)), "dev", "--hostname", "127.0.0.1", "--port", "3135", "--webpack"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)), windowsHide: true,
      env: { ...process.env, NODE_ENV: "development", API_URL: apiUrl, NEXT_PUBLIC_API_URL: apiUrl }, stdio: ["ignore", "pipe", "pipe"]
    });
    web.stdout.on("data", (chunk) => { logs += chunk; }); web.stderr.on("data", (chunk) => { logs += chunk; });
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (web.exitCode !== null) throw new Error(`Next.js exited: ${logs}`);
      try { const response = await fetch(`${baseUrl}/login`, { signal: AbortSignal.timeout(5_000) }); if (response.status === 200) break; } catch { /* Wait for startup. */ }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (Date.now() >= deadline) throw new Error(`Next.js did not become ready: ${logs}`);
    await mkdir(new URL("../../../test-results/identity-ui/", import.meta.url), { recursive: true });
    await writeFile(new URL("../../../test-results/identity-ui/server.log", import.meta.url), logs);
    return { baseUrl, apiUrl, getLogs: () => logs, password, ownerId, viewerId, targetId, organizationId: organization.id, stop,
      expireOwner: () => db.deleteFrom("sessions").where("user_id", "=", ownerId).execute(),
      revokeInvite: async () => {
        const permission = await db.selectFrom("permissions").select("id").where("code", "=", "member:invite").executeTakeFirstOrThrow();
        await db.deleteFrom("role_permissions").where("role", "=", "OWNER").where("permission_id", "=", permission.id).execute();
      }
    };
  } catch (error) { console.error(logs); await stop(); throw error; }
}
