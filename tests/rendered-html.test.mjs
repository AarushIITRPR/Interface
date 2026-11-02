import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
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
    readFile(new URL("../app/instructor/editorial-operator-console.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/protocol.ts", import.meta.url), "utf8"),
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
  ]);
  assert.match(subject, /Watch naturally|Please wait/i);
  assert.match(subject, /removeItem\("meridian\.subject\.code"\)/);
  assert.match(subject, /role="alert"/);
  assert.match(subject, /Session code or participant ID/);
  assert.match(subject, /operatorConnected/);
  assert.match(subject, /Change session/);
  assert.match(subject, /participantSessionRequest/);
  assert.match(subject, /next\.revision > current\.revision/);
  assert.match(subject, /\["complete","aborted"\]/);
  for (const label of ['Live study','Session sequence','Recording review','Recording setup','Sensor input','OPEN LEDGER'])assert.ok(instructor.includes(label));
  assert.match(subject,/acquisitionReady/);
  assert.match(subject,/End my session/);

  assert.match(protocol, /WILLIAMS6/);
  assert.match(protocol, /Guided body scan/);
  assert.match(hosting, /"d1": "DB"/);
  assert.match(hosting, /"r2": "MEDIA"/);
  assert.doesNotMatch(`${subject}\n${instructor}\n${protocol}`, /—/);
});

test("ships every registered protocol stimulus", async () => {
  const media = ["happy", "sad", "anger", "fear", "surprise", "disgust", "bodyscan", "relaxing-nature"];
  const types = await readFile(new URL("../lib/types.ts", import.meta.url), "utf8");
  const subject = await readFile(new URL("../app/subject/subject-portal.tsx", import.meta.url), "utf8");
  for (const name of media) {
    const file = await stat(new URL(`../public/protocol-media/${name}.mp4`, import.meta.url));
    assert.ok(file.size > 0, `${name}.mp4 is empty`);
    assert.match(types, new RegExp(`/protocol-media/${name}\\.mp4`));
  }
  assert.match(subject, /className="stimulus-video"/);
  assert.match(subject, /className="body-scan-video"/);
  assert.match(subject, /className="breathing-video"/);
});

test("keeps the legacy SAM questions with discrete ten-point responses", async () => {
  const [subject, protocol, route] = await Promise.all([
    readFile(new URL("../app/subject/subject-portal.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/protocol.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/sessions/route.ts", import.meta.url), "utf8"),
  ]);
  for (const label of ["How pleasant did you feel", "How calm or energized did you feel", "How in control did you feel"]) {
    assert.match(subject, new RegExp(label.replace(/[()]/g, "\\$&")));
  }
  for (const anchor of ["Very unpleasant", "Very pleasant", "Very calm", "Very energized", "Not in control", "Fully in control"]) {
    assert.match(subject, new RegExp(anchor));
  }
  assert.match(subject, /Array\.from\(\{length:10\}/);
  assert.doesNotMatch(subject, /type="range"/);
  assert.match(protocol, /Valence, arousal, and dominance/);
  assert.match(route, /Math\.min\(10,/);
});
