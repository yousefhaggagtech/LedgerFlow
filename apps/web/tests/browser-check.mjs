// Local browser acceptance checks use Node built-ins and an isolated Chromium profile.
// Start the web app first; see docs/design-tokens.md for environment variables.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const output = fileURLToPath(new URL("../../../test-results/ui/", import.meta.url));
const executable = process.env.UI_BROWSER_EXECUTABLE;
if (!executable) throw new Error("Set UI_BROWSER_EXECUTABLE to an installed Chromium or Chrome executable.");
const baseUrl = process.env.UI_BASE_URL ?? "http://127.0.0.1:3000";
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
    if (message.method === "Runtime.exceptionThrown") runtimeErrors.push(message.params.exceptionDetails.text);
    const handler = pending.get(message.id);
    if (handler) {
      pending.delete(message.id);
      clearTimeout(handler.timer);
      message.error ? handler.reject(new Error(JSON.stringify(message.error))) : handler.resolve(message.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolveCommand, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => reject(new Error(`Timed out: ${method}`)), 15000);
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
    const until = Date.now() + 20000;
    while (Date.now() < until) {
      if (await evaluate(expression)) return;
      await new Promise((done) => setTimeout(done, 100));
    }
    await screenshot("failure");
    console.log(await evaluate("JSON.stringify({active:document.activeElement.tagName,label:document.activeElement.getAttribute('aria-label'),text:document.activeElement.textContent?.slice(0,80),width:document.querySelector('aside').getBoundingClientRect().width,collapsed:document.querySelector('aside').dataset.collapsed})"));
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
  const sidebarWidth = () => evaluate("document.querySelector('aside').getBoundingClientRect().width");
  const summary = [];
  await resize(1280);
  await send("Page.navigate", { url: baseUrl });
  await waitFor("document.readyState === 'complete' && document.querySelector('h1')?.textContent === 'Workspace'");
  await waitFor("Object.keys(document.querySelector('[aria-label=\"Collapse sidebar\"]')).some(k=>k.startsWith('__reactProps'))");
  assert.equal(await sidebarWidth(), 240);
  assert.equal(await evaluate("document.querySelectorAll('#desktop-navigation a').length"), 7);
  await noOverflow();
  await screenshot("desktop-expanded-1280");
  await evaluate("document.querySelector('[aria-label=\"Collapse sidebar\"]').focus()");
  await key("Enter", "Enter", 13);
  await waitFor("document.querySelector('aside').getBoundingClientRect().width === 64");
  assert.equal(await evaluate("document.activeElement.getAttribute('aria-label')"), "Expand sidebar", "Collapse must retain keyboard focus on the toggle");
  await screenshot("desktop-collapsed-1280");
  await key("Tab", "Tab", 9, 8);
  await waitFor("document.querySelector('[role=tooltip]')?.textContent === 'Settings'");
  assert.equal(await evaluate("document.activeElement.textContent"), "Settings");
  assert.ok(await evaluate("getComputedStyle(document.activeElement).outlineStyle !== 'none' || getComputedStyle(document.activeElement).boxShadow !== 'none'"));
  await key("Enter", "Enter", 13);
  await waitFor("document.querySelector('#desktop-navigation a[aria-current=page]')?.textContent === 'Settings'");
  assert.equal(await evaluate("document.querySelector('[data-slot=breadcrumb-page]').textContent"), "Settings");
  summary.push("1280px: 240px expanded / 64px collapsed, seven links, keyboard toggle, focus tooltip, active link/breadcrumb, no overflow");
  await evaluate("document.querySelector('[aria-label=\"Open user menu\"]').focus()");
  await key("Enter", "Enter", 13);
  await waitFor("document.querySelector('[role=menu]') !== null");
  await waitFor("document.activeElement.textContent === 'My profile'");
  await key("ArrowDown", "ArrowDown", 40);
  await waitFor("document.activeElement.textContent === 'Account settings'");
  await key("Enter", "Enter", 13);
  await waitFor("document.querySelector('[role=status]')?.textContent.includes('Account settings will be available')");
  await screenshot("profile-menu");
  await key("Escape", "Escape", 27);
  await waitFor("document.querySelector('[role=menu]') === null");
  assert.equal(await evaluate("document.activeElement.getAttribute('aria-label')"), "Open user menu");
  summary.push("Profile: Enter opens, arrows navigate, Enter announces placeholder, Escape closes and restores focus");
  await resize(768);
  assert.equal(await sidebarWidth(), 64);
  await evaluate("document.querySelector('[aria-label=\"Expand sidebar\"]').focus()");
  await key("Enter", "Enter", 13);
  await waitFor("document.querySelector('aside').getBoundingClientRect().width === 240");
  await noOverflow();
  await screenshot("tablet-expanded-768");
  summary.push("768px: desktop rail is visible, collapse state preserved, keyboard expansion, no overflow");
  await resize(375, 812);
  await waitFor("getComputedStyle(document.querySelector('aside')).display === 'none'");
  await noOverflow();
  await screenshot("mobile-closed-375");
  await evaluate("document.querySelector('[aria-label=\"Open navigation\"]').focus()");
  await key("Enter", "Enter", 13);
  await waitFor("document.querySelector('[role=dialog]') !== null");
  assert.equal(await evaluate("document.querySelector('[role=dialog]').getBoundingClientRect().width"), 240);
  assert.equal(await evaluate("document.querySelectorAll('#mobile-navigation a').length"), 7);
  await waitFor("document.activeElement.textContent === 'Close navigation'");
  await key("Tab", "Tab", 9);
  assert.equal(await evaluate("document.activeElement.textContent"), "Sales");
  await key("Tab", "Tab", 9, 8);
  assert.equal(await evaluate("document.activeElement.textContent"), "Close navigation");
  await key("Tab", "Tab", 9);
  assert.equal(await evaluate("document.activeElement.textContent"), "Sales");
  await screenshot("mobile-drawer-375");
  await key("Escape", "Escape", 27);
  await waitFor("document.querySelector('[role=dialog]') === null");
  await waitFor("document.activeElement.getAttribute('aria-label') === 'Open navigation'");
  await key("Enter", "Enter", 13);
  await waitFor("document.querySelector('[role=dialog]') !== null");
  await key("Tab", "Tab", 9);
  await key("Tab", "Tab", 9);
  assert.equal(await evaluate("document.activeElement.textContent"), "Expenses");
  await key("Enter", "Enter", 13);
  await waitFor("document.querySelector('[role=dialog]') === null");
  assert.equal(await evaluate("document.querySelector('[data-slot=breadcrumb-page]').textContent"), "Expenses");
  await waitFor("document.activeElement.getAttribute('aria-label') === 'Open navigation'");
  await key("Enter", "Enter", 13);
  await waitFor("document.querySelector('[role=dialog]') !== null");
  await evaluate("new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))");
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 320, y: 300 });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 320, y: 300, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 320, y: 300, button: "left", clickCount: 1 });
  await waitFor("document.querySelector('[role=dialog]') === null");
  await evaluate("document.querySelector('[aria-label=\"Open navigation\"]').click()");
  await waitFor("document.querySelector('[role=dialog]') !== null");
  await resize(768);
  await waitFor("document.querySelector('[role=dialog]') === null");
  assert.notEqual(await evaluate("getComputedStyle(document.body).pointerEvents"), "none");
  await resize(375, 460);
  await evaluate("document.querySelector('[aria-label=\"Open navigation\"]').click()");
  await waitFor("document.querySelector('[role=dialog]') !== null");
  await evaluate("document.querySelector('#mobile-navigation > ul a').focus()");
  assert.ok(await evaluate("document.querySelector('[data-slot=sheet-content]').getBoundingClientRect().bottom <= innerHeight"));
  await screenshot("mobile-short-drawer");
  await evaluate("document.querySelector('[data-slot=sheet-close]').click()");
  await waitFor("document.querySelector('[role=dialog]') === null");
  await waitFor("document.activeElement.getAttribute('aria-label') === 'Open navigation'");
  summary.push("375px: 240px drawer, seven links, keyboard focus loop, selection/Escape/backdrop/close dismissal, focus restoration, resize cleanup, short-screen fit, no overflow");
  await evaluate("document.querySelector('a[href=\"#main-content\"]').focus()");
  await key("Enter", "Enter", 13);
  await waitFor("document.activeElement.id === 'main-content'");
  assert.ok(await evaluate("getComputedStyle(document.body).fontFamily.includes('Inter')"));
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.tabular-nums')).fontVariantNumeric"), "tabular-nums");
  assert.equal(await evaluate("document.querySelectorAll('main').length"), 1);
  assert.deepEqual(runtimeErrors, []);
  summary.push("Inter, tabular numbers, one main landmark, no uncaught browser exceptions");
  await writeFile(resolve(output, "results.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally {
  socket?.close();
  browser.kill();
}
