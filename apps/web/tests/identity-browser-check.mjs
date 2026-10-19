// Local browser acceptance checks use Node built-ins and an isolated Chromium profile.
// Starts its own real API/web servers and disposable PostgreSQL schema. See the organization feature spec.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const output = fileURLToPath(new URL("../../../test-results/identity-ui/", import.meta.url));
const executable = process.env.UI_BROWSER_EXECUTABLE;
if (!executable) throw new Error("Set UI_BROWSER_EXECUTABLE to an installed Chromium or Chrome executable.");
const { startIdentityFixture } = await import("./identity-fixture.mjs");
const fixture = await startIdentityFixture();
const baseUrl = fixture.baseUrl;
await mkdir(output, { recursive: true });
const browser = spawn(executable, [
  "--headless", "--remote-debugging-port=0", "--no-first-run", "--disable-gpu", `--user-data-dir=${resolve(output, "browser-profile")}`, "about:blank"
], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
let socket;
try {
  const address = await new Promise((resolveAddress, reject) => {
    let stderr = "";
    browser.on("error", reject);
    browser.stderr.on("data", (data) => {
      stderr += data;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) resolveAddress(match[1]);
    });
    browser.on("exit", (code) => reject(new Error(`Chromium exited: ${code}`)));
  });
  socket = new WebSocket(address);
  await once(socket, "open");
  let nextId = 0;
  let sessionId;
  const pending = new Map();
  const runtimeErrors = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") { runtimeErrors.push(JSON.stringify(message.params.exceptionDetails)); console.error(JSON.stringify(message.params.exceptionDetails)); }
    const handler = pending.get(message.id);
    if (handler) {
      pending.delete(message.id);
      clearTimeout(handler.timer);
      message.error ? handler.reject(new Error(JSON.stringify(message.error))) : handler.resolve(message.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolveCommand, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => reject(new Error(`Timed out: ${method}`)), 60000);
    pending.set(id, { resolve: resolveCommand, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const target = await send("Target.createTarget", { url: "about:blank" });
  sessionId = (await send("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
  await send("Page.enable");
  await send("Page.bringToFront");
  await send("Runtime.enable");
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const waitFor = async (expression) => {
    const until = Date.now() + 60000;
    while (Date.now() < until) {
      if (await evaluate(expression)) return;
      await new Promise((done) => setTimeout(done, 100));
    }
    await screenshot("failure");
    console.log(await evaluate("JSON.stringify({active:document.activeElement.tagName,label:document.activeElement.getAttribute('aria-label'),text:document.activeElement.textContent?.slice(0,80),width:document.querySelector('aside')?.getBoundingClientRect().width,collapsed:document.querySelector('aside')?.dataset.collapsed})"));
    console.log(runtimeErrors);
    throw new Error(`Timed out waiting for ${expression}`);
  };
  const resize = (width, height = 900) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  const key = async (keyName, code, keyCode, modifiers = 0) => {
    await send("Input.dispatchKeyEvent", { type: keyName === "Enter" ? "keyDown" : "rawKeyDown", key: keyName, code, windowsVirtualKeyCode: keyCode, modifiers, ...(keyName === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}) });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, windowsVirtualKeyCode: keyCode, modifiers });
  };
  const screenshot = async (name) => {
    await evaluate("document.fonts.ready");
    const result = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(resolve(output, `${name}.png`), Buffer.from(result.data, "base64"));
  };
  const noOverflow = async () => assert.ok(await evaluate("document.documentElement.scrollWidth <= innerWidth"), "Horizontal overflow");
  const summary = [];
  const click = (label) => evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(label)})?.click()`);
  const input = async (id, value) => {
    await evaluate(`document.getElementById(${JSON.stringify(id)}).focus()`);
    await send("Input.insertText", { text: value });
  };
  const login = async (email) => {
    await input("email", email); await input("password", fixture.password); await click("Sign in");
    await waitFor("location.pathname === '/organizations' && document.querySelector('h1')?.textContent === 'Choose an organization' && Array.from(document.querySelectorAll('button')).some(b=>b.textContent.includes('Acme Studio'))");
    await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Acme Studio')).click()");
  };
  const setRole = (id, role) => evaluate(`(() => { const select=document.querySelector('select[aria-label="Change role for ${id}"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(role)}); select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await resize(1280);
  await send("Page.navigate", { url: `${baseUrl}/settings/organization` });
  await waitFor("location.pathname === '/login' && document.querySelector('#email') !== null");
  await input("email", "wrong@ui.example"); await input("password", "Wrong password"); await click("Sign in");
  await waitFor("document.querySelector('[role=alert]')?.textContent.includes('Invalid email or password')");
  assert.equal(await evaluate("location.pathname"), "/login");
  await evaluate("location.reload()"); await waitFor("document.querySelector('#email') !== null && Object.keys(document.querySelector('#email')).some(k=>k.startsWith('__reactProps'))");
  await login("owner@ui.example");
  await waitFor("document.querySelector('table') !== null && document.body.textContent.includes('Africa/Cairo')");
  assert.ok(await evaluate("document.body.textContent.includes('EGP')"));
  assert.equal(await evaluate("localStorage.length + sessionStorage.length"), 0);
  assert.ok(!await evaluate("document.cookie.includes('ledgerflow_session')"));
  await noOverflow(); await screenshot("settings-desktop");
  await evaluate("document.querySelector('#desktop-navigation a[href=\"/settings/organization\"]').focus()");
  await key("Enter", "Enter", 13);
  await waitFor("location.pathname === '/settings/organization' && document.querySelector('table') !== null");
  await click("Next page"); await waitFor("document.querySelector('tbody')?.children.length === 2");
  await click("First page"); await waitFor("document.querySelector('tbody')?.children.length === 25");
  summary.push("Actual PostgreSQL/session/API flow: unauthenticated redirect, invalid login, valid login, organization selection, settings, 25-row cursor pagination, HttpOnly cookie and no browser-storage context");
  await click("Add member"); await waitFor("document.querySelector('#member-user-id') !== null");
  await evaluate("document.querySelector('[role=dialog] button[type=submit]').click()");
  await waitFor("document.querySelector('#member-user-error')?.textContent.includes('valid User UUID')");
  assert.equal(await evaluate("document.activeElement.id"), "member-user-id");
  await input("member-user-id", fixture.targetId);
  await evaluate("(() => { const select=document.querySelector('#member-role'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'VIEWER'); select.dispatchEvent(new Event('change',{bubbles:true})); })()");
  await evaluate("document.querySelector('[role=dialog] button[type=submit]').click()");
  await waitFor(`document.querySelector('[role=dialog]') === null && document.querySelector('select[aria-label="Change role for ${fixture.targetId}"]') !== null`);
  await setRole(fixture.targetId, "ACCOUNTANT");
  await waitFor(`document.querySelector('select[aria-label="Change role for ${fixture.targetId}"]')?.value === 'ACCOUNTANT' && document.querySelector('[role=status]')?.textContent.includes('Role updated')`);
  await setRole(fixture.ownerId, "ADMIN");
  await waitFor("document.querySelector('[role=alert]')?.textContent.includes('retain at least one active Owner')");
  assert.equal(await evaluate(`document.querySelector('select[aria-label="Change role for ${fixture.ownerId}"]').value`), "OWNER");
  summary.push("Direct Add persists ACTIVE membership; change role persists; last-Owner conflict refreshes and preserves committed role");
  await resize(375, 812); await noOverflow(); await screenshot("settings-mobile");
  await evaluate("Array.from(document.querySelectorAll('h2')).find(h=>h.textContent==='Members').scrollIntoView({block:'start'})");
  await noOverflow(); await screenshot("members-mobile");
  assert.ok(await evaluate("Array.from(document.querySelectorAll('tbody select')).every(select => { const rect=select.getBoundingClientRect(); return rect.left>=0 && rect.right<=innerWidth; })"), "Mobile role controls fit without horizontal scrolling");
  await click("Add member"); await waitFor("document.querySelector('[role=dialog]') !== null");
  await screenshot("add-member-mobile");
  assert.equal(await evaluate("document.querySelector('[role=dialog]').getBoundingClientRect().width"), 375);
  await key("Escape", "Escape", 27); await waitFor("document.querySelector('[role=dialog]') === null");
  assert.equal(await evaluate("document.activeElement.textContent"), "Add member");
  await fixture.revokeInvite();
  await click("Add member"); await waitFor("document.querySelector('#member-user-id') !== null");
  await input("member-user-id", fixture.targetId);
  await evaluate("(() => { const select=document.querySelector('#member-role'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'VIEWER'); select.dispatchEvent(new Event('change',{bubbles:true})); })()");
  await evaluate("document.querySelector('[role=dialog] button[type=submit]').click()");
  await waitFor("document.querySelector('[role=dialog] [role=alert]')?.textContent.includes('Permission Denied')");
  await screenshot("permission-denied");
  await key("Escape", "Escape", 27); await waitFor("document.querySelector('[role=dialog]') === null");
  summary.push("375px: no page overflow, drawer fits, Escape restores focus; live capability revocation produces clear 403 feedback");
  await fixture.expireOwner();
  await evaluate("location.reload()");
  await waitFor("location.pathname === '/login' && document.querySelector('#email') !== null && Object.keys(document.querySelector('#email')).some(k=>k.startsWith('__reactProps'))");
  await login("viewer@ui.example");
  await waitFor("document.querySelector('[role=alert]')?.textContent.includes('Permission Denied')");
  assert.equal(await evaluate(`document.querySelectorAll('select[aria-label^="Change role"]').length`), 0);
  await evaluate(`document.querySelector('[aria-label="Open user menu"]').focus()`);
  await key("Enter", "Enter", 13);
  await waitFor("document.querySelector('[role=menu]') !== null");
  await evaluate("Array.from(document.querySelectorAll('[role=menuitem]')).find(b=>b.textContent==='Sign out').click()");
  await waitFor("location.pathname === '/login'");
  assert.equal(await evaluate(`fetch(${JSON.stringify(`${fixture.apiUrl}/auth/me`)}, {credentials:"include"}).then(r=>r.status)`), 401);
  assert.deepEqual(runtimeErrors, []);
  summary.push("Expired session redirects to login; Viewer direct settings access is denied; sign out revokes the actual session; no uncaught browser errors");
  await writeFile(resolve(output, "results.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(fixture.getLogs());
  throw error;
} finally {
  socket?.close();
  browser.kill();
  await fixture.stop();
}
