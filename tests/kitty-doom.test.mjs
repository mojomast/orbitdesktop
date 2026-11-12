import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createKittyGraphicsParser, createKittyDoomProcess, kittyCapabilityReply, KITTY_DOOM_COLUMNS, KITTY_DOOM_PROGRAMS, KITTY_DOOM_ROWS } from "../server/kitty-doom.mjs";

const apc = (control, payload = "") => `\x1b_G${control};${payload}\x1b\\`;

function collect(options = {}) {
  const frames = [];
  const notices = [];
  const replies = [];
  const capabilities = [];
  const parser = createKittyGraphicsParser({
    onFrame: frame => frames.push(frame),
    onNotice: notice => notices.push(notice),
    onReply: reply => replies.push(reply),
    onCapability: id => capabilities.push(id),
    ...options,
  });
  return { parser, frames, notices, replies, capabilities };
}

const binary = process.env.ORBIT_KITTY_DOOM_BINARY || path.join(os.homedir(), "src", "kitty-doom", "build", "kitty-doom");
const directory = process.env.ORBIT_KITTY_DOOM_DIR || path.join(os.homedir(), "src", "kitty-doom");
const installed = existsSync(binary) && existsSync(path.join(directory, "wads", "freedoom1.wad"));

function hash(frame) {
  return createHash("sha256").update(frame.data).digest("hex");
}

function meanDifference(a, b) {
  const length = Math.min(a.data.length, b.data.length);
  let total = 0;
  for (let index = 0; index < length; index += 1) total += Math.abs(a.data[index] - b.data[index]);
  return total / (length || 1);
}

test("chunked RGB transmission is assembled from every m=1 continuation", () => {
  const { parser, frames } = collect();
  const pixels = Buffer.from([1, 2, 3, 4, 5, 6]);
  const encoded = pixels.toString("base64");
  parser.push(Buffer.from(apc(`a=T,i=7,f=24,s=2,v=1,q=2,c=2,r=1,C=1,m=1`, encoded.slice(0, 4)), "latin1"));
  parser.push(Buffer.from(apc("m=1", encoded.slice(4, 6)), "latin1"));
  parser.push(Buffer.from(apc("m=0", encoded.slice(6)), "latin1"));
  assert.equal(frames.length, 1);
  assert.deepEqual(
    { width: frames[0].width, height: frames[0].height, format: frames[0].format, columns: frames[0].columns, rows: frames[0].rows },
    { width: 2, height: 1, format: "rgb", columns: 2, rows: 1 },
  );
  assert.deepEqual(frames[0].data, pixels);
});

test("animation frames reuse the transmission metadata and are not emitted twice", () => {
  const { parser, frames } = collect();
  const first = Buffer.from([9, 9, 9]);
  const second = Buffer.from([8, 8, 8]);
  parser.push(Buffer.from(apc(`a=T,i=11,f=24,s=1,v=1,q=2,c=1,r=1,C=1,m=0`, first.toString("base64")), "latin1"));
  parser.push(Buffer.from(apc(`a=f,r=1,i=11,f=24,q=2,x=0,y=0,s=1,v=1,m=1`, second.toString("base64").slice(0, 2)), "latin1"));
  parser.push(Buffer.from(apc(`a=f,r=1,q=2,m=0`, second.toString("base64").slice(2)), "latin1"));
  parser.push(Buffer.from(apc(`a=a,q=2,c=1,i=11`), "latin1")); // animation control: never a frame
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0].data, first);
  assert.deepEqual(frames[1].data, second);
});

test("PNG transmissions pass through untouched and malformed input is refused", () => {
  const { parser, frames, notices } = collect();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  parser.push(Buffer.from(apc(`a=T,i=1,f=100,s=4,v=4,m=0`, png.toString("base64")), "latin1"));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].format, "png");
  assert.deepEqual(frames[0].data, png);
  // geometry mismatch, unsupported format, orphan chunk and a truncated APC
  parser.push(Buffer.from(apc(`a=T,i=1,f=24,s=4,v=4,m=0`, Buffer.from([1, 2, 3]).toString("base64")), "latin1"));
  parser.push(Buffer.from(apc(`a=T,i=1,f=3,s=1,v=1,m=0`, Buffer.from([1]).toString("base64")), "latin1"));
  parser.push(Buffer.from(apc("m=0", ""), "latin1"));
  parser.push(Buffer.from("\x1b_Ga=T,i=1,f=24,s=4", "latin1"));
  parser.push(Buffer.from("\x00\x01\x02 binary noise ", "latin1"));
  assert.equal(frames.length, 1);
  assert.ok(notices.length >= 3, `expected notices, saw ${JSON.stringify(notices)}`);
});

test("terminal queries are answered once, including when split across reads", () => {
  const { parser, replies } = collect();
  parser.setSize(320, 200);
  parser.push(Buffer.from("probe \x1b[?u", "latin1"));
  parser.push(Buffer.from("\x1b[9", "latin1"));
  parser.push(Buffer.from("999;9999H\x1b[6n", "latin1"));
  parser.push(Buffer.from("nothing here", "latin1"));
  assert.deepEqual(replies, ["\x1b[?11u", "\x1b[200;320R"]);
  parser.setSize(160, 100);
  parser.push(Buffer.from("\x1b[6n", "latin1"));
  assert.equal(replies.at(-1), "\x1b[100;160R");
});

test("a graphics capability probe is reported and answered with OK", () => {
  const { parser, capabilities, frames } = collect();
  parser.push(Buffer.from(apc("i=31,s=1,v=1,a=q,t=d,f=24", "AAAA"), "latin1"));
  assert.deepEqual(capabilities, ["31"]);
  assert.equal(frames.length, 0);
  assert.equal(kittyCapabilityReply("31"), "\x1b_Gi=31;OK\x1b\\");
  assert.equal(kittyCapabilityReply("a;b\x1b"), "\x1b_Gi=ab;OK\x1b\\");
});

test("a graphics sequence split between ESC, underscore and G is still decoded", () => {
  const { parser, frames } = collect();
  const pixels = Buffer.from([7, 7, 7, 7, 7, 7]);
  const encoded = pixels.toString("base64");
  parser.push(Buffer.from("\x1b", "latin1"));
  parser.push(Buffer.from("_G", "latin1"));
  parser.push(Buffer.from(`a=T,i=3,f=24,s=2,v=1,m=1;${encoded.slice(0, 4)}`, "latin1"));
  parser.push(Buffer.from("\x1b\\", "latin1"));
  parser.push(Buffer.from(`\x1b_Gm=0;${encoded.slice(4)}\x1b\\`, "latin1"));
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0].data, pixels);
});

test("a real kitty-doom process renders frames and accepts kitty-encoded input", { timeout: 60000 }, async t => {
  if (!installed) {
    t.skip(`kitty-doom is not installed at ${binary}`);
    return;
  }
  const frames = [];
  const notices = [];
  let exit = null;
  const process = createKittyDoomProcess({
    binary,
    directory,
    wad: "freedoom1",
    columns: KITTY_DOOM_COLUMNS,
    rows: KITTY_DOOM_ROWS,
    onFrame: frame => frames.push(frame),
    onNotice: notice => notices.push(notice),
    onExit: event => (exit = event),
  });
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const waitFor = async (predicate, ms = 15000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await wait(100);
    }
    return false;
  };
  try {
    assert.ok(await waitFor(() => frames.length >= 3), `no frames rendered (${notices.join(" | ")})`);
    // The very first frames can be the blank screen kitty-doom clears before the
    // title screen draws, so settle on a frame that actually carries a picture.
    assert.ok(
      await waitFor(() => frames.some(frame => new Set(frame.data).size > 8), 15000),
      "no frame with visible content was rendered",
    );
    const first = frames.find(frame => new Set(frame.data).size > 8);
    assert.equal(first.width, 320);
    assert.equal(first.height, 200);
    assert.equal(first.format, "rgb");
    assert.equal(first.data.length, 320 * 200 * 3);
    // Only the transmit+display frame carries the cell box (c/r); its value proves
    // the app accepted the bridge's cursor-position reply instead of falling back
    // to its 80x24 default.
    const placed = frames.find(frame => frame.columns > 0);
    assert.ok(placed, "no frame carried a placement cell box");
    assert.equal(placed.columns, 320);
    assert.equal(placed.rows, 200);
    const distinct = new Set(first.data).size;
    assert.ok(first.data.some(byte => byte !== 0), "first frame is entirely black");

    // Input: Enter is "start game" on the title screen. The demo loop animates on
    // its own, so the deterministic proof is the Kitty-encoded Ctrl+C that only
    // the app's kkp parser can act on.
    const before = frames.at(-1);
    const beforeCount = frames.length;
    process.write("\x1b[13u");
    assert.ok(await waitFor(() => frames.length > beforeCount + 2, 10000), "no frames after Enter");
    const after = frames.at(-1);
    const changed = hash(before) !== hash(after);
    const immediateDiff = meanDifference(before, after);
    assert.ok(changed, "the rendered frame did not change after a keypress");
    const hashes = new Set(frames.slice(-12).map(hash)).size;
    console.log(`kitty-doom frames=${frames.length} distinct_last12=${hashes} diff_after_enter=${immediateDiff.toFixed(1)} distinct_bytes=${distinct}`);

    process.write("\x1b[99;5u"); // kitty-encoded Ctrl+C: the app exits only if it parsed it
    assert.ok(await waitFor(() => exit !== null, 8000), "kitty-encoded Ctrl+C did not reach the app");
    // kitty-doom's Ctrl+C path sets only its internal exit flag, so main() returns
    // EXIT_FAILURE (1) by design; the proof is that the process ended on our input.
    assert.equal(exit.exitCode, 1);
  } finally {
    process.kill();
  }
});

test("each decoded frame reports how many APC chunks the bridge assembled", () => {
  const { parser, frames } = collect();
  const pixels = Buffer.from([4, 5, 6, 7, 8, 9]);
  const encoded = pixels.toString("base64");
  parser.push(Buffer.from(apc(`a=T,i=5,f=24,s=2,v=1,c=2,r=1,m=1`, encoded.slice(0, 3)), "latin1"));
  parser.push(Buffer.from(apc("m=1", encoded.slice(3, 6)), "latin1"));
  parser.push(Buffer.from(apc("m=0", encoded.slice(6)), "latin1"));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].chunks, 3);
  // A single-chunk transmission reports one chunk, not zero.
  parser.push(Buffer.from(apc(`a=T,i=6,f=24,s=2,v=1,c=2,r=1,m=0`, encoded), "latin1"));
  assert.equal(frames.at(-1).chunks, 1);
});

test("the program allowlist refuses anything that is not a known key", () => {
  const attempt = program => createKittyDoomProcess({ binary, directory, program, columns: 320, rows: 200 });
  for (const hostile of ["/bin/sh", "rm -rf /", "freedoom1; ls", "", "graphics-tour.js"]) {
    assert.throws(() => attempt(hostile), error => error.code === "invalid_request",
      `expected "${hostile}" to be refused`);
  }
  // Every advertised program is a real, resolvable entry.
  for (const [key, entry] of Object.entries(KITTY_DOOM_PROGRAMS)) {
    assert.ok(entry.title && (entry.wad || entry.script), `${key} is missing its definition`);
  }
});

test("the graphics tour program renders RGB, RGBA and PNG through the real bridge", { timeout: 90000 }, async t => {
  if (!existsSync("/usr/bin/python3")) {
    t.skip("python3 is not available");
    return;
  }
  const frames = [];
  const notices = [];
  const process = createKittyDoomProcess({
    binary,
    directory,
    program: "graphics-tour",
    columns: KITTY_DOOM_COLUMNS,
    rows: KITTY_DOOM_ROWS,
    onFrame: frame => frames.push(frame),
    onNotice: notice => notices.push(notice),
  });
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const waitFor = async (predicate, ms = 40000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await wait(100);
    }
    return false;
  };
  try {
    assert.ok(
      await waitFor(() => ["rgb", "rgba", "png"].every(kind => frames.some(frame => frame.format === kind))),
      `the tour did not produce all three formats: ${[...new Set(frames.map(f => f.format))].join(",")} ${notices.join(" | ")}`,
    );
    const rgb = frames.find(frame => frame.format === "rgb");
    assert.equal(rgb.width, 320);
    assert.equal(rgb.height, 200);
    assert.equal(rgb.data.length, 320 * 200 * 3);
    // The tour is the point of the chunked path: a full frame cannot fit one chunk.
    assert.ok(rgb.chunks > 1, `expected a chunked transmission, saw ${rgb.chunks}`);
    const rgba = frames.find(frame => frame.format === "rgba");
    assert.equal(rgba.data.length, 320 * 200 * 4);
    const png = frames.find(frame => frame.format === "png");
    assert.deepEqual([...png.data.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    // The animation scene adds many frames to one image id, which cannot happen
    // until the earlier scenes have finished — so wait for them, don't sample.
    assert.ok(
      await waitFor(() => frames.filter(frame => frame.format === "rgb").length > 5, 30000),
      `the animation scene did not stream frames: ${frames.filter(frame => frame.format === "rgb").length} rgb frames, ${notices.join(" | ")}`,
    );
    console.log(`graphics tour frames=${frames.length} formats=${[...new Set(frames.map(f => f.format))].join(",")} max_chunks=${Math.max(...frames.map(f => f.chunks))}`);
  } finally {
    process.kill();
  }
});

test("the terminal probe gets real answers for every query it asks", { timeout: 60000 }, async () => {
  const frames = [];
  const notices = [];
  const text = [];
  const process = createKittyDoomProcess({
    binary,
    directory,
    program: "terminal-probe",
    columns: KITTY_DOOM_COLUMNS,
    rows: KITTY_DOOM_ROWS,
    onFrame: frame => frames.push(frame),
    onNotice: notice => notices.push(notice),
    onText: value => text.push(value),
  });
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && notices.length < 4) await wait(100);
  // The probe only draws once every answer has arrived, so wait for the drawing
  // instead of killing the session the moment the last reply lands.
  const drawDeadline = Date.now() + 20000;
  while (Date.now() < drawDeadline && frames.length === 0) await wait(100);
  process.kill();
  // The bridge answers four different queries; each answer is announced once.
  const joined = notices.join(" | ");
  assert.match(joined, /capability probe/, `no capability answer: ${joined}`);
  assert.match(joined, /keyboard-protocol query/, `no keyboard-protocol answer: ${joined}`);
  assert.match(joined, /cursor-position query/, `no cursor-position answer: ${joined}`);
  assert.match(joined, /device-attributes query/, `no device-attributes answer: ${joined}`);
  // The probe draws only after the answers arrive, which proves the reply path.
  assert.ok(frames.length > 0, "the probe drew no frames after being answered");
  assert.ok(text.join("").includes("TERM=xterm-kitty"), "the probe did not report an xterm-kitty TERM");
});
