import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server renders the Meridian portal choice", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Meridian Multimodal Research Platform<\/title>/i);
  assert.match(html, /Subject display/);
  assert.match(html, /Instructor console/);
  assert.match(html, /href="\/subject"/);
  assert.match(html, /href="\/instructor"/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("keeps the experiences separate and copy free of em dashes", async () => {
  const [subject, instructor, protocol, hosting] = await Promise.all([
    readFile(new URL("../app/subject/subject-portal.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/instructor/instructor-console.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/protocol.ts", import.meta.url), "utf8"),
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
  ]);
  assert.match(subject, /Watch naturally|Please wait/i);
  assert.match(instructor, /Recording health/);
  assert.match(instructor, /Live event log/);
  assert.match(instructor, /Session report/);
  assert.match(protocol, /WILLIAMS6/);
  assert.match(protocol, /Guided body scan/);
  assert.match(hosting, /"d1": "DB"/);
  assert.match(hosting, /"r2": "MEDIA"/);
  assert.doesNotMatch(`${subject}\n${instructor}\n${protocol}`, /—/);
});
