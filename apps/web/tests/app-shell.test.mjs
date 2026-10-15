import "./source-loader.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { Layout } = await import("../src/components/layout/app-shell.tsx");
const { Button } = await import("../src/components/ui/button.tsx");
const { Input } = await import("../src/components/ui/input.tsx");
const { Badge } = await import("../src/components/ui/badge.tsx");

test("the shell renders seven business sections, one active link, and a content landmark", () => {
  const html = renderToStaticMarkup(createElement(Layout, null, createElement("h1", null, "Page content")));
  for (const label of ["Sales", "Expenses", "Banking", "Reports", "Documents", "AI Assistant", "Settings"]) {
    assert.ok(html.includes(`>${label}</span>`), `Missing section: ${label}`);
  }
  assert.equal((html.match(/<main\b/g) ?? []).length, 1);
  assert.match(html, /<nav[^>]+aria-label="Main navigation"/);
  assert.match(html, /<a[^>]+href="#sales"[^>]+aria-current="page"/);
  assert.equal((html.match(/<a[^>]+aria-current="page"/g) ?? []).length, 1);
  assert.match(html, /<main[^>]+id="main-content"[^>]*><h1>Page content<\/h1>/);
  assert.doesNotMatch(html, />Journal<|>Ledger<|>Chart of Accounts</);
});

test("navigation controls and profile trigger have accessible labels and state", () => {
  const html = renderToStaticMarkup(createElement(Layout, null, "Content"));
  assert.match(html, /aria-label="Collapse sidebar"[^>]+aria-controls="desktop-navigation"[^>]+aria-expanded="true"/);
  assert.match(html, /aria-label="Open navigation"/);
  assert.match(html, /aria-label="Open user menu"[^>]+aria-haspopup="menu"/);
  assert.match(html, /href="#main-content"[^>]*>Skip to content<\/a>/);
  assert.ok(html.includes("Acme Studio"));
  assert.match(html, /<nav[^>]+aria-label="Breadcrumb"/);
});

test("base controls preserve native disabled and invalid input semantics", () => {
  const button = renderToStaticMarkup(createElement(Button, { disabled: true }, "Save"));
  assert.match(button, /<button[^>]+disabled=""/);
  const input = renderToStaticMarkup(createElement(Input, { "aria-label": "Amount", "aria-invalid": true, disabled: true }));
  assert.match(input, /aria-invalid="true"/);
  assert.match(input, /aria-label="Amount"/);
  assert.match(input, /disabled=""/);
});

test("financial status badges keep explicit text and semantic token variants", () => {
  for (const variant of ["paid", "overdue", "pending"]) {
    const html = renderToStaticMarkup(createElement(Badge, { variant }, variant));
    assert.ok(html.includes(`bg-status-${variant}-surface`));
    assert.ok(html.includes(`text-status-${variant}`));
    assert.ok(html.includes(`>${variant}</span>`));
  }
});
