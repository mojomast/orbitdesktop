// Local Chromium render/interaction gate; a new static server, profile and no outbound reads.
import { chromium } from "playwright-core";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import assert from "node:assert/strict";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
const app = fileURLToPath(new URL("../apps/rizzstack-hive/", import.meta.url)),
  out = process.argv[2];
if (!out) throw Error("Pass an evidence directory");
await fs.mkdir(out, { recursive: true });
const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, "http://local").pathname;
  if (!/^\/(?:[\w.-]+)?$/.test(p)) {
    res.writeHead(404).end();
    return;
  }
  const basename = p === "/" ? "index.html" : p.slice(1);
  if (!/^(?:[a-zA-Z0-9_-]+\.(?:js|html|css))$/.test(basename)) {
    res.writeHead(404).end();
    return;
  }
  try {
    const bytes = await fs.readFile(path.join(app, basename));
    res
      .writeHead(200, {
        "Content-Type": basename.endsWith(".js")
          ? "text/javascript"
          : basename.endsWith(".css")
            ? "text/css"
            : "text/html",
        "Cache-Control": "no-store",
      })
      .end(bytes);
  } catch {
    res.writeHead(404).end();
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`,
  br = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE,
    headless: true,
    args: ["--disable-dev-shm-usage"],
  });
try {
  const ctx = await br.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
      serviceWorkers: "block",
    }),
    p = await ctx.newPage();
  const errors = [],
    unexpected = [];
  p.on("pageerror", (e) => errors.push(String(e)));
  await ctx.route("**/*", (r) => {
    if (
      !r
        .request()
        .url()
        .startsWith(url + "/")
    ) {
      unexpected.push(r.request().url());
      return r.abort();
    }
    return r.continue();
  });
  p.setDefaultTimeout(8000);
  const timings = [],
    interactions = [],
    imgs = [];
  const nav = (name) => p.getByRole("navigation", { name: "Work surfaces" }).getByRole("button", { name, exact: true });
  const detail = p.locator("#inspection-body");
  const ticket = (id) => p.locator("#attention .ticket").filter({ hasText: id });
  const tab = (name) => p.getByRole("tab", { name, exact: true });
  async function containsAll(locator, values) {
    const text = await locator.innerText();
    for (const s of values) assert.ok(text.includes(s), `Missing ${s} in ${text}`);
  }
  async function shot(file) {
    await p.evaluate(() => document.fonts.ready);
    await p.screenshot({
      path: path.join(out, file + ".png"),
      animations: "disabled",
    });
    imgs.push(file);
  }
  for (let i = 0; i < 20; i++) {
    const t = performance.now();
    await p.goto(url + "/?demo=shift");
    await p.waitForFunction(
      () => document.querySelector("#flight").textContent === "4",
    );
    await p.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
    timings.push(performance.now() - t);
  }
  await shot("01-laptop-shift");
  // A: start from a different object; a static default decision cannot pass.
  await p.locator('#world [data-station="verify"]').click();
  assert.equal(await p.locator("#inspect-title").innerText(), "Verification");
  await ticket("decision:gate_handoff").click();
  assert.equal(await p.locator("#inspect-title").innerText(), "Accept the replay evidence for handoff?");
  await containsAll(detail, ["decision:gate_handoff", "snapshot/1:decisions", "Subject: Receiver gate (return)", "Downstream feature: Publish"]);
  await shot("journey-A-owner-decision");

  // B: same selectors used by the real opaque-frame host gate. Preserve search
  // and scope when returning to the workbench after inspecting a record.
  await nav("Work register").click();
  await p.locator("#scope").selectOption("attempt");
  await p.locator("#search").fill("att_digest");
  assert.equal(await p.locator("#rows .obj").count(), 1);
  await p.locator("#rows .obj").click();
  assert.equal(await p.locator("#inspect-title").innerText(), "att_digest");
  await containsAll(detail, ["att_digest", "deepseek", "snapshot/1:fleet:cli", "19:59:39 UTC", "Unproven", "job:replay"]);
  assert.ok(await detail.getByRole("button", {name:/Open Rails timeline/}).isDisabled());
  await shot("journey-B-attempt");
  await detail.getByRole("button", {name:/Back to previous/}).click();
  assert.equal(await p.locator("#search").inputValue(), "att_digest");
  assert.equal(await p.locator("#scope").inputValue(), "attempt");
  assert.ok(await p.locator("#rows .obj").isVisible());

  // C: verify the specific evidence record, not just a station summary.
  await nav("Factory floor").click();
  await ticket("bottleneck:verify").click();
  assert.equal(await p.locator("#inspect-title").innerText(), "verify queue");
  await containsAll(detail, ["bottleneck:verify", "snapshot/1:bottlenecks", "Queue: 2; oldest: 1620 s.", "Dwell median/p95: 820/820 s (known); target: 600 s.", "1/0.041667 (known)"]);
  await shot("journey-C-verify-pressure");

  await p.setViewportSize({ width: 1920, height: 1080 });
  await p.locator("#scenario").selectOption("dense");
  await p.waitForFunction(
    () => document.querySelector("#flight").textContent === "14",
  );
  await shot("02-desktop-dense");
  const worldNodes = await p.locator("#world *").count();
  assert.ok(worldNodes <= 500, `${worldNodes} map nodes exceeds the budget`);
  assert.equal(await p.locator("#world [data-station]").count(), 8);
  assert.ok(await p.locator("#world [data-attempt]").count() >= 14);
  for (let i = 0; i < 25; i++) {
    const t = performance.now();
    await p.locator("#focus-b").click();
    await p.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
    interactions.push(performance.now() - t);
  }
  await nav("Work register").click();
  await tab("Queue").click();
  await p
    .getByRole("heading", { name: "PARTIAL · reconciliation suggestion" })
    .waitFor();
  await containsAll(p.locator("#work"), ["AC-004", "AC-001", "AC-002", "AC-003", "3 of 4"]);
  await p.getByRole("heading", { name: "PARTIAL · reconciliation suggestion" }).scrollIntoViewIfNeeded();
  await shot("journey-D-queue-reconciliation");
  await p.locator("#scope").selectOption("attempt");
  await p.locator("#search").fill("att_");
  const count = await p.locator("#rows .obj").count();
  assert.ok(count >= 14);
  await p.locator("#rows .obj").first().click();
  assert.match(await p.locator("#inspect-title").innerText(), /att_/);
  await p.locator("#scenario").selectOption("replay");
  await p
    .getByRole("button", {
      name: "Combined tree / four cases pass",
      exact: true,
    })
    .click();
  await p
    .locator("#inspection-body")
    .getByText("test_tenant_scope".replace("test_", ""), { exact: true })
    .waitFor();
  await shot("03-incident-inspection");
  await p.getByRole("button", { name: "Play recording" }).click();
  await p.waitForFunction(() =>
    document.querySelector(".rail-bar output").textContent.startsWith("32"),
  );
  await p.getByRole("button", { name: "Pause recording" }).click();
  await p
    .getByRole("button", { name: "Windows / no run receipt", exact: true })
    .click();
  await p
    .locator("#inspection-body")
    .getByText("NOT_RUN", { exact: true })
    .first()
    .waitFor();
  await p.setViewportSize({ width: 390, height: 844 });
  await p.locator("#scenario").selectOption("shift");
  await p.waitForFunction(
    () => document.querySelector("#flight").textContent === "4",
  );
  await p.evaluate(() => scrollTo(0, 0));
  assert.equal(await p.locator("#board").evaluate((n) => n.open), true);
  assert.ok(
    await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  );
  await shot("04-mobile-shift");
  await p.locator("#scenario").selectOption("quiet");
  await p.waitForFunction(
    () => document.querySelector("#flight").textContent === "0",
  );
  await p.setViewportSize({ width: 1440, height: 900 });
  await shot("05-quiet");
  await p.locator("#scenario").selectOption("degraded");
  await p.waitForFunction(
    () => document.querySelector("#flight").textContent === "Unknown",
  );
  await shot("06-degraded");
  await p.locator("#scenario").selectOption("host");
  await p
    .locator("#connection")
    .getByText(/unavailable/i)
    .waitFor();
  assert.equal(await p.locator("#flight").innerText(), "Unknown");
  assert.equal(
    await p.locator("#source-caption").textContent(),
    "HOST READ NOT CONFIRMED",
  );
  await nav("Work register").click();
  await tab("Queue").click();
  await p.locator("#work").getByText(/no confirmed queue-evidence reader|queue evidence unavailable/i).waitFor();
  assert.doesNotMatch(await p.locator("#work").innerText(), /PARTIAL|AC-00[1-4]|3 of 4|att_digest/);
  await shot("journey-D-host-queue-unavailable");
  await nav("Release desk").click();
  await p.getByRole("heading", { name: /release HOLD/ }).waitFor();
  for (const [gate, finding] of [["Required software cases", "665 passed"], ["Component CI", "64 successful checks"],
    ["Human receiver", "pending"], ["Live Windows canary", "not run"], ["Loaded revisions", "unverified"],
    ["Owner promotion", "Withheld"]]) {
    await containsAll(p.locator("#release").getByRole("row").filter({has:p.getByRole("rowheader", {name:gate,exact:true})}), [finding]);
  }
  await p.getByRole("rowheader", {name:"Live Windows canary"}).scrollIntoViewIfNeeded();
  await shot("journey-E-release-gates");
  // H: no host confirmation is a distinct source, never substituted with demo.
  await p.locator("#scenario").selectOption("shift");
  await p.locator("#flight").filter({hasText:/^4$/}).waitFor();
  assert.match(await p.locator("#source-caption").textContent(), /synthetic/i);
  await p.locator("#scenario").selectOption("host");
  await p.locator("#connection").filter({hasText:/unavailable/i}).waitFor();
  assert.equal(await p.locator("#flight").innerText(), "Unknown");
  assert.doesNotMatch(await p.locator("body").innerText(), /decision:gate_handoff|att_digest/);
  await shot("journey-H-host-return");
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  const proj = await p.evaluate(async () => {
    const { project } = await import("./snapshot-adapter.js"),
      { fixtures, fixtureTime } = await import("./fixtures.js");
    const xs = [];
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      project(fixtures.dense, { now: fixtureTime });
      xs.push(performance.now() - start);
    }
    return xs;
  });
  const q = (a) => a.toSorted((a, b) => a - b)[Math.ceil(0.95 * a.length) - 1];
  const report = {
    browser: br.version(),
    sizes: ["1920x1080", "1440x900", "390x844"],
    worldNodes,
    screenshots: imgs,
    firstMeaningfulP95Ms: q(timings),
    firstMeaningfulSamples: timings,
    automationClickToFrameP95Ms: q(interactions),
    selectionSamples: interactions,
    denseProjectionP95Ms: q(proj),
    projectionSamples: proj,
    errors,
    unexpected,
  };
  await fs.writeFile(
    path.join(out, "browser.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    "PASS",
    JSON.stringify({
      ...report,
      firstMeaningfulSamples: undefined,
      selectionSamples: undefined,
      projectionSamples: undefined,
    }),
  );
} finally {
  await br.close();
  server.closeAllConnections();
  server.close();
}
