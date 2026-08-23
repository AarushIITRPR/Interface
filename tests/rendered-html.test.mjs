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
  assert.match(subject, /removeItem\("meridian\.subject\.code"\)/);
  assert.match(subject, /role="alert"/);
  assert.match(subject, /Code shown by instructor/);
  assert.match(subject, /operatorConnected/);
  assert.match(subject, /Change session/);
  assert.match(subject, /participantSessionRequest/);
  assert.match(subject, /next\.revision > current\.revision/);
  assert.match(subject, /\["complete","aborted"\]/);
  assert.match(instructor, /Recording health/);
  assert.match(instructor, /Subject code/);
  assert.match(instructor, /Acquisition token/);
  assert.match(instructor, /Acquisition agent offline/);
  assert.match(instructor, /Sensor CSV/);
  assert.match(instructor, /Recording manifest/);
  assert.match(subject, /acquisitionReady/);
  assert.match(instructor, /Previous task/);
  assert.match(instructor, /Next task/);
  assert.match(instructor, /Live event log/);
  assert.match(instructor, /Session report/);
  assert.match(instructor, /Connect, detect, validate/);
  assert.match(instructor, /Hardware detected/);
  assert.match(instructor, /Data detected/);
  assert.match(instructor, /Quality acceptable/);
  assert.match(instructor, /Test all selected devices/);
  assert.match(instructor, /Start recording and protocol/);
  assert.match(instructor, /Short rolling quality windows/);
  assert.match(instructor, /Session quality report/);
  for (const mode of ["setup","monitor","protocol","review"]) assert.match(instructor,new RegExp(`"${mode}"`));
  assert.match(protocol, /WILLIAMS6/);
  assert.match(protocol, /Guided body scan/);
  assert.match(hosting, /"d1": "DB"/);
  assert.match(hosting, /"r2": "MEDIA"/);
  assert.doesNotMatch(`${subject}\n${instructor}\n${protocol}`, /—/);
});
