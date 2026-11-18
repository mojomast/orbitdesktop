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
  await p.setViewportSize({ width: 1920, height: 1080 });
  await p.locator("#scenario").selectOption("dense");
  await p.waitForFunction(
    () => document.querySelector("#flight").textContent === "14",
  );
  await shot("02-desktop-dense");
  const worldNodes = await p.locator("#world *").count();
  for (let i = 0; i < 25; i++) {
    const t = performance.now();
    await p.locator("#focus-b").click();
    await p.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
    interactions.push(performance.now() - t);
  }
  await p.getByRole("button", { name: "Work register", exact: true }).click();
  await p
    .getByRole("heading", { name: "PARTIAL · reconciliation suggestion" })
    .waitFor();
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
  await p
    .locator(".mastnav")
    .getByRole("button", { name: "Release desk" })
    .click();
  await p.getByRole("heading", { name: /release HOLD/ }).waitFor();
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
