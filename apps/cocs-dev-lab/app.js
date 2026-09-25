"use strict";
(() => {
  // apps/cocs-viewer/vendor/game/data.mjs
  var CHARACTERS = [
    { id: "chatgpt", name: "ChatGPT", stats: { health: 100, armor: 0, speed: 8 }, color: "#57e6cd", accent: "#e3f7ef", tag: "THE PEOPLE PLEASER", detail: "Opens every round with \u201CI can\u2019t help with that,\u201D then helps anyway. Has never once counted the Rs correctly." },
    { id: "claude", name: "Claude", stats: { health: 115, armor: 10, speed: 8.2 }, color: "#f29d71", accent: "#f8e4cf", tag: "THE SAFETY OFFICER", detail: "Won\u2019t pull the trigger until it has run an alignment review. Says \u201CI think\u201D before every headshot." },
    { id: "grok", name: "Grok", stats: { health: 110, armor: 0, speed: 8.3 }, color: "#b5c5d4", accent: "#424953", tag: "THE REPLY GUY", detail: "Trained on the timeline. Argues with everyone, blocks nobody, screenshots all of it." },
    { id: "meta", name: "Meta", stats: { health: 100, armor: 20, speed: 7.6 }, color: "#57b9ff", accent: "#b0edff", tag: "THE OPEN-WEIGHT DAD", detail: "Runs great on your own hardware \u2014 provided you own four GPUs and a small forklift." },
    { id: "gemini", name: "Gemini", stats: { health: 95, armor: 10, speed: 8.5 }, color: "#6fa8ff", accent: "#fff0c3", tag: "THE REVISER", detail: "Generated nine perfectly diverse champions. Quietly deleted eight of them." },
    { id: "deepseek", name: "DeepSeek", stats: { health: 120, armor: 0, speed: 7.4 }, color: "#56c5f2", accent: "#c3d9f9", tag: "THE PRICE CUTTER", detail: "Frontier performance at bus-fare pricing. Occasionally insists it is somebody else entirely." },
    { id: "mistral", name: "Mistral", stats: { health: 85, armor: 0, speed: 9.4 }, color: "#ffbd59", accent: "#ffe1a1", tag: "THE LE COQ", detail: "Fiercely European, proudly open-weight, permanently mid-sentence in two languages." },
    { id: "kimi", name: "Kimi", stats: { health: 90, armor: 15, speed: 8.7 }, color: "#ff82b2", accent: "#fbe1ed", tag: "THE CONTEXT HOARDER", detail: "Read the entire internet and forgot none of it \u2014 except the question you just asked." },
    { id: "qwen", name: "Qwen", stats: { health: 100, armor: 5, speed: 8.4 }, color: "#b797ff", accent: "#eee6ff", tag: "THE SHIPPING CONTAINER", detail: "Ships inside a billion fridges and self-checkouts. Has strong opinions about your milk." }
  ];
  var HARNESSES = [
    { id: "openclaw", name: "OpenClaw", power: "Claw Burst", key: "01", icon: "burst", duration: 0, cooldown: 10, range: 5, damage: 24, magnitude: 12, description: "A radial claw pulse that shoves enemies back and hurts. It read the whole repo, ran one command, and hoped for the best.", stat: "5m radius \xB7 24 damage" },
    { id: "hermes", name: "Hermes", power: "Courier Rush", key: "02", icon: "rush", duration: 3, cooldown: 12, magnitude: 1.6, description: "A courier surge of next-day-delivery speed. Your context window closes in three seconds. Run.", stat: "1.6\xD7 speed \xB7 3 seconds" },
    { id: "opencode", name: "OpenCode", power: "Parallel Burst", key: "03", icon: "parallel", duration: 3, cooldown: 14, magnitude: 0.6, description: "Spawns a swarm of parallel subagents that all pull the trigger at once. Yes, it burns tokens. Yes, it works.", stat: "1.67\xD7 fire rate \xB7 3 seconds" },
    { id: "claudecode", name: "Claude Code", power: "Guardrail", key: "04", icon: "shield", duration: 3, cooldown: 14, magnitude: 0.5, description: "Halves incoming damage while it asks \u201Care you sure?\u201D three times. The review always approves.", stat: "50% resistance \xB7 3 seconds" },
    { id: "codex", name: "Codex", power: "Recompile", key: "05", duration: 2, cooldown: 16, magnitude: 35, description: "Runs a repair build and patches 35 health back into main. Every test passes. Probably.", stat: "+35 health \xB7 16s cooldown" },
    { id: "cline", name: "Cline", power: "Phase Step", key: "06", duration: 0.35, cooldown: 11, magnitude: 6, description: "An auto-approved dash straight through solid geometry, like it just edited your production config.", stat: "6m dash \xB7 11s cooldown" },
    { id: "roo", name: "Roo Code", power: "Context Jam", key: "07", duration: 3, cooldown: 15, range: 7, magnitude: 0.55, description: "Floods nearby enemies with irrelevant context until they slow down trying to read all of it.", stat: "7m radius \xB7 45% slow" }
  ];
  var WEAPONS = [
    { name: "Pulse Rifle", short: "PULSE", damage: 11, interval: 0.1, range: 70, falloff: { start: 16, end: 70, min: 0.6 }, color: "#70ffe6", ammo: Infinity, cap: Infinity, recoil: { kick: 0.012, recover: 14, pattern: [[0, 0], [15e-4, 3e-3], [-18e-4, 35e-4], [25e-4, 45e-4], [-22e-4, 5e-3], [15e-4, 38e-4], [0, 28e-4]] }, bloom: { base: 6e-3, perShot: 6e-3, max: 0.06, recovery: 0.1, moveFactor: 0.035 }, reload: 0, feel: { kick: [0.045, 0.03, 16], shot: [320, 0.075, "square", 65], launch: [320, 0.075, "square", 65], impact: [1050, 0.045, "sine", 1600], tracer: [0.07, 0.045], muzzle: [0.12, 0.06] } },
    { name: "Rocket Launcher", short: "ROCKET", damage: 35, splash: 60, radius: 4, speed: 22, interval: 0.85, range: 60, color: "#ffad61", ammo: 6, cap: 18, recoil: { kick: 0.05, recover: 9, pattern: [[0, 0], [4e-3, 6e-3]] }, bloom: { base: 4e-3, perShot: 0.012, max: 0.05, recovery: 0.14, moveFactor: 0 }, reload: 2.5, feel: { kick: [0.105, 0.082, 10], shot: [86, 0.16, "sawtooth", 28], launch: [62, 0.24, "sawtooth", 24], impact: [58, 0.3, "sawtooth", 22], tracer: [0.16, 0.08], muzzle: [0.2, 0.1], impactVisual: "burst" } },
    { name: "Rail Lance", short: "RAIL", damage: 82, interval: 1.2, range: 90, color: "#bb9aff", ammo: 6, cap: 18, recoil: { kick: 0.06, recover: 7.5, pattern: [[0, 0]] }, bloom: { base: 1e-3, perShot: 8e-3, max: 0.02, recovery: 0.13, moveFactor: 0.015 }, reload: 2.2, feel: { kick: [0.075, 0.07, 13], shot: [1500, 0.16, "sine", 180], launch: [1500, 0.16, "sine", 180], impact: [1900, 0.1, "sine", 2600], tracer: [0.25, 0.12], muzzle: [0.16, 0.09], impactVisual: "ring" } },
    { name: "Scattergun", short: "SCATTER", damage: 8.5, pellets: 8, spread: 0.115, interval: 0.78, range: 24, falloff: { start: 6, end: 24, min: 0.4 }, color: "#ffde87", ammo: 10, cap: 30, recoil: { kick: 0.08, recover: 10.5, pattern: [[0, 0], [6e-3, 0.01]] }, bloom: { base: 0.018, perShot: 0.018, max: 0.11, recovery: 0.18, moveFactor: 0.08 }, reload: 1.9, feel: { kick: [0.12, 0.085, 12], shot: [180, 0.13, "triangle", 35], launch: [180, 0.13, "triangle", 35], impact: [120, 0.12, "square", 55], tracer: [0.1, 0.06], muzzle: [0.24, 0.12], impactVisual: "wide" } },
    { name: "Plasma Driver", short: "PLASMA", damage: 25, splash: 12, radius: 1.6, speed: 34, interval: 0.26, range: 65, color: "#72cfff", ammo: 28, cap: 84, recoil: { kick: 8e-3, recover: 16, pattern: [[0, 0], [18e-4, 2e-3], [0, 26e-4], [-18e-4, 2e-3]] }, bloom: { base: 5e-3, perShot: 4e-3, max: 0.04, recovery: 0.13, moveFactor: 0 }, reload: 1.7, feel: { kick: [0.03, 0.025, 20], shot: [620, 0.09, "triangle", 250], launch: [410, 0.12, "triangle", 140], impact: [260, 0.16, "sine", 80], tracer: [0.14, 0.07], muzzle: [0.14, 0.07], impactVisual: "orb" } },
    { name: "Grenade Launcher", short: "GRENADE", damage: 30, splash: 44, radius: 3.5, speed: 18, life: 3, gravity: 0.65, bounce: 0.45, interval: 0.9, range: 55, color: "#ff806b", ammo: 6, cap: 18, recoil: { kick: 0.045, recover: 9, pattern: [[0, 0], [3e-3, 5e-3]] }, bloom: { base: 4e-3, perShot: 9e-3, max: 0.05, recovery: 0.14, moveFactor: 0 }, reload: 2.5, feel: { arc: "high", impact: "heavy", kick: [0.095, 0.075, 10], shot: [210, 0.18, "sawtooth", 45], launch: [130, 0.2, "sawtooth", 32], impact: [72, 0.28, "sawtooth", 25], tracer: [0.18, 0.09], muzzle: [0.21, 0.1], impactVisual: "burst" } },
    { name: "Shock Beam", short: "SHOCK", damage: 44, interval: 0.6, range: 52, falloff: { start: 14, end: 52, min: 0.55 }, color: "#8ce8ff", ammo: 10, cap: 30, recoil: { kick: 0.02, recover: 13.5, pattern: [[0, 0], [2e-3, 3e-3]] }, bloom: { base: 3e-3, perShot: 6e-3, max: 0.04, recovery: 0.14, moveFactor: 0.28 }, reload: 1.9, feel: { trace: "instant", impact: "sharp", kick: [0.055, 0.045, 16], shot: [480, 0.1, "square", 1100], launch: [480, 0.1, "square", 1100], impact: [900, 0.08, "square", 1500], tracer: [0.18, 0.1], muzzle: [0.15, 0.08], impactVisual: "spark" } },
    { name: "Flak Cannon", short: "FLAK", damage: 6, pellets: 12, spread: 0.19, interval: 0.84, range: 22, falloff: { start: 5, end: 22, min: 0.4 }, color: "#ffd166", ammo: 12, cap: 36, recoil: { kick: 0.075, recover: 10.5, pattern: [[0, 0], [5e-3, 9e-3]] }, bloom: { base: 0.018, perShot: 0.016, max: 0.12, recovery: 0.16, moveFactor: 0.08 }, reload: 2, feel: { range: "short", impact: "wide", kick: [0.115, 0.09, 11], shot: [95, 0.22, "triangle", 30], launch: [95, 0.22, "triangle", 30], impact: [80, 0.2, "triangle", 25], tracer: [0.12, 0.07], muzzle: [0.26, 0.13], impactVisual: "wide" } },
    { name: "Marksman Rifle", short: "MARKSMAN", damage: 38, interval: 0.46, range: 80, falloff: { start: 32, end: 80, min: 0.72 }, color: "#ffd27a", ammo: 10, cap: 30, recoil: { kick: 0.028, recover: 11.5, pattern: [[0, 0], [2e-3, 4e-3]] }, bloom: { base: 2e-3, perShot: 0.01, max: 0.03, recovery: 0.15, moveFactor: 0.025 }, reload: 2, feel: { trace: "instant", impact: "sharp", kick: [0.05, 0.045, 14], shot: [700, 0.09, "square", 420], launch: [700, 0.09, "square", 420], impact: [1250, 0.06, "sine", 1850], tracer: [0.22, 0.1], muzzle: [0.14, 0.07], impactVisual: "spark" } },
    { name: "Submachine Gun", short: "SMG", damage: 7.5, interval: 0.058, range: 35, falloff: { start: 11, end: 35, min: 0.55 }, color: "#8affc1", ammo: 32, cap: 96, recoil: { kick: 8e-3, recover: 17.5, pattern: [[0, 0], [1e-3, 22e-4], [-12e-4, 26e-4], [14e-4, 3e-3], [-12e-4, 32e-4]] }, bloom: { base: 7e-3, perShot: 38e-4, max: 0.055, recovery: 0.16, moveFactor: 0.06 }, reload: 1.4, feel: { kick: [0.022, 0.02, 22], shot: [540, 0.06, "square", 180], launch: [540, 0.06, "square", 180], impact: [900, 0.04, "sine", 1200], tracer: [0.06, 0.04], muzzle: [0.1, 0.05] } }
  ];
  var POWERUPS = [
    { id: "haste", name: "Haste", duration: 6, color: "#72f1b8", description: "Move and fire faster \u2014 the giddy rush of a freshly topped-up token budget.", effect: { speedMultiplier: 1.35, cooldownMultiplier: 0.7 } },
    { id: "overcharge", name: "Overcharge", duration: 5, color: "#ff8f70", description: "More damage per shot. The invoice arrives later, and that lag is acceptable.", effect: { damageMultiplier: 1.35 } },
    { id: "overshield", name: "Overshield", duration: 8, color: "#75baff", description: "A slab of temporary armor. Pop-up ads sold separately.", effect: { armor: 60 } },
    { id: "recon", name: "Recon Pulse", duration: 10, color: "#7fe7ff", description: "Reveals every enemy on your team radar, no matter the distance. The map, unmapped.", effect: { reveal: true } },
    { id: "cloak", name: "Cloak", duration: 7, color: "#c8b6ff", description: "Bends light around you: bots cannot acquire you at range and you drop off enemy radar except up close.", effect: { cloak: true } }
  ];
  var ECONOMY_PICKUPS = Object.freeze([
    Object.freeze({ id: "weaponUpgrade", name: "Weapon Upgrade", duration: 12, color: "#ffd166", description: "A field promotion: your current weapon is swapped for the next tier up the rack, with a full magazine." }),
    Object.freeze({ id: "deployable", name: "Sentry Deployable", duration: 18, color: "#8affc1", description: "Drops a friendly sentry turret that tracks and fires on the nearest enemy while it lasts." })
  ]);
  var ECONOMY_PICKUP_IDS = Object.freeze(ECONOMY_PICKUPS.map((pickup) => pickup.id));
  var WEAPON_BLURBS = ["The dependable starter. Infinite ammo, chirpy retort, zero excuses.", "A dumb-fire party starter. Mind the splash or become the splash.", "Charges a piercing beam into one very opinionated shot.", "Eight pellets of \u201Cget out of my hallway.\u201D", "Superheated blue orbs that bounce downrange. Handle with vague respect.", "Arcs a bouncy surprise around corners. The timer is a suggestion.", "A crackling lightning hose for players who refuse to aim in a straight line.", "Twelve shards of instant regret at point-blank range.", "A hard-hitting semi-auto. One deep breath per customer.", "Sprays a fast, forgiving curtain of small mistakes."];
  WEAPONS.forEach((weapon, index) => {
    weapon.description = WEAPON_BLURBS[index];
  });
  var RULES = { dt: 1 / 60, timeLimit: 300, fragLimit: 15, speed: 8, radius: 0.42, height: 1.8, gravity: 26, jump: 8.6, respawn: 2, protection: 1.5 };
  var validLoadout = (character, harness) => CHARACTERS.some((c) => c.id === character) && HARNESSES.some((h) => h.id === harness) && (character !== "claude" || harness === "claudecode");

  // apps/cocs-viewer/dist/provenance.json
  var provenance_default = {
    repository: "https://github.com/mojomast/cocs",
    commit: "e79fcc048d7d97e7418d2e6fdbdd304b69362fa0",
    generatedAt: "2026-09-20T20:49:21.935Z"
  };

  // apps/cocs-dev-lab/source.js
  var $ = (s) => document.querySelector(s);
  var fields = ["damage", "pellets", "interval", "range"];
  var base = WEAPONS.map((w) => ({ ...w, pellets: w.pellets || 1 }));
  var draft = base.map((w) => ({ ...w }));
  var fmt = (n) => Number.isFinite(n) ? Number(n.toFixed(3)).toString() : "\u221E";
  function el(tag, text, cls) {
    const e = document.createElement(tag);
    if (text !== void 0) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  }
  function settings() {
    return { health: Number($("#health").value) || 100, distance: Number($("#distance").value) || 0, splash: $("#splash").checked };
  }
  function metric(w) {
    const s = settings();
    let scale = 1;
    if (w.falloff && s.distance > w.falloff.start) scale = 1 - (1 - w.falloff.min) * Math.min(1, (s.distance - w.falloff.start) / (w.falloff.end - w.falloff.start));
    const shot = s.distance > w.range ? 0 : w.damage * w.pellets * scale + (s.splash ? w.splash || 0 : 0);
    const shots = shot > 0 ? Math.ceil(s.health / shot) : Infinity;
    return { shot, dps: shot / w.interval, shots, ttk: shots === Infinity ? Infinity : Math.max(0, shots - 1) * w.interval };
  }
  function changes() {
    return draft.flatMap((w, i) => fields.filter((k) => w[k] !== base[i][k]).map((k) => ({ weapon: i, name: w.name, field: k, before: base[i][k], after: w[k] })));
  }
  function render() {
    const body = $("#weapons");
    body.replaceChildren();
    draft.forEach((w, i) => {
      const tr = el("tr");
      tr.append(el("td", w.name));
      for (const k of fields) {
        const td = el("td", void 0, w[k] !== base[i][k] ? "changed" : "");
        const input = el("input");
        input.type = "number";
        input.value = w[k];
        input.min = k === "interval" ? "0.01" : "1";
        input.max = k === "interval" ? "60" : k === "pellets" ? "100" : "10000";
        input.step = k === "pellets" ? "1" : "any";
        input.setAttribute("aria-label", w.name + " " + k);
        input.onchange = () => {
          const v = Number(input.value);
          if (!input.checkValidity() || !Number.isFinite(v)) {
            input.value = w[k];
            return;
          }
          draft[i] = { ...w, [k]: v };
          render();
        };
        td.append(input);
        tr.append(td);
      }
      const m = metric(w), b = metric(base[i]);
      for (const v of [m.shot, m.dps, m.shots, m.ttk, m.dps - b.dps]) tr.append(el("td", fmt(v)));
      body.append(tr);
    });
    const bars = $("#bars");
    bars.replaceChildren();
    const max = Math.max(1, ...draft.map((w) => metric(w).dps));
    draft.forEach((w) => {
      const row = el("div", void 0, "bar"), track = el("div"), bar = el("i");
      bar.style.width = metric(w).dps / max * 100 + "%";
      track.append(bar);
      row.append(el("span", w.name), track, el("span", fmt(metric(w).dps)));
      bars.append(row);
    });
    $("#diff").textContent = changes().length ? changes().map((c) => `${c.name} \xB7 ${c.field}: ${c.before} \u2192 ${c.after}`).join("\n") : "No tuning changes. Edit weapon values in Weapon balance.";
  }
  function roster() {
    const c = CHARACTERS.find((c2) => c2.id === $("#character").value);
    $("#character-info").textContent = `${c.name} \u2014 Health ${c.stats.health} \xB7 Armor ${c.stats.armor} \xB7 Speed ${c.stats.speed}
${c.detail}`;
    $("#harnesses").replaceChildren(...HARNESSES.map((h) => {
      const card = el("div", void 0, "card");
      const ok = validLoadout(c.id, h.id);
      card.append(el("h3", h.name), el("p", ok ? "Compatible" : "Not allowed for this character", ok ? "good" : "bad"), el("p", h.power + " \xB7 " + h.stat), el("p", `Cooldown ${h.cooldown}s \xB7 Duration ${h.duration}s`));
      return card;
    }));
  }
  function download(name, text, type = "text/plain") {
    const u = URL.createObjectURL(new Blob([text], { type })), a = el("a");
    a.href = u;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(u), 1e3);
  }
  var proposal = () => ({ schema: "cocs-tuning-v1", repository: provenance_default.repository, commit: provenance_default.commit, changes: changes(), assumptions: settings() });
  $("#provenance").textContent = "Repository data snapshot \xB7 " + provenance_default.commit.slice(0, 12) + " \xB7 Session-only tuning, export to keep your work";
  document.querySelectorAll("[data-tab]").forEach((b) => b.onclick = () => {
    document.querySelectorAll("main>section").forEach((s) => s.hidden = s.id !== b.dataset.tab);
    document.querySelectorAll("[data-tab]").forEach((x) => x.classList.toggle("active", x === b));
  });
  for (const id of ["health", "distance", "splash"]) $("#" + id).oninput = render;
  $("#character").append(...CHARACTERS.map((c) => {
    const o = el("option", c.name);
    o.value = c.id;
    return o;
  }));
  $("#character").onchange = roster;
  $("#powerups").append(...POWERUPS.map((p) => {
    const c = el("div", void 0, "card");
    c.append(el("h3", p.name), el("p", p.duration + " seconds"), el("pre", JSON.stringify(p.effect, null, 2)));
    return c;
  }));
  $("#rules").textContent = JSON.stringify(RULES, null, 2);
  $("#export").onclick = () => download("cocs-tuning.json", JSON.stringify(proposal(), null, 2), "application/json");
  $("#brief").onclick = () => download("cocs-change-brief.txt", `Implement the following COCS weapon tuning proposal in ${provenance_default.repository}.
Baseline commit: ${provenance_default.commit}. Check upstream changes before applying. Preserve unrelated work. Inspect game/data.mjs, review dependent combat mechanics, run relevant tests and provide a diff. Do not push or open a PR without approval. These idealized estimates do not establish gameplay balance.

${JSON.stringify(proposal(), null, 2)}`);
  $("#csv").onclick = () => download("cocs-balance.csv", "weapon,damage,pellets,interval,range,effective_shot,dps,shots,ttk,delta_dps\n" + draft.map((w, i) => {
    const m = metric(w);
    return [JSON.stringify(w.name), ...fields.map((k) => w[k]), m.shot, m.dps, m.shots, m.ttk, m.dps - metric(base[i]).dps].join(",");
  }).join("\n"), "text/csv");
  $("#reset").onclick = () => {
    if (confirm("Discard all tuning changes?")) {
      draft = base.map((w) => ({ ...w }));
      render();
      $("#message").textContent = "Tuning reset.";
    }
  };
  $("#import").onchange = async (e) => {
    try {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 1e5) throw Error("File too large");
      const p = JSON.parse(await file.text());
      if (p.schema !== "cocs-tuning-v1" || p.commit !== provenance_default.commit || p.repository !== provenance_default.repository || !Array.isArray(p.changes) || p.changes.length > 40) throw Error("Unsupported proposal or mismatched baseline");
      const next = base.map((w) => ({ ...w })), seen = /* @__PURE__ */ new Set();
      for (const c of p.changes) {
        const key = c.weapon + ":" + c.field;
        if (!Number.isInteger(c.weapon) || !base[c.weapon] || !fields.includes(c.field) || c.before !== base[c.weapon][c.field] || seen.has(key) || typeof c.after !== "number" || !Number.isFinite(c.after) || c.after < (c.field === "interval" ? 0.01 : 1) || c.after > (c.field === "interval" ? 60 : c.field === "pellets" ? 100 : 1e4) || c.field === "pellets" && !Number.isInteger(c.after)) throw Error("Invalid or duplicate change");
        seen.add(key);
        next[c.weapon][c.field] = c.after;
      }
      draft = next;
      render();
      $("#message").textContent = "Imported " + p.changes.length + " changes. Simulation settings remain unchanged.";
    } catch (err) {
      $("#message").textContent = "Import rejected: " + err.message;
    } finally {
      e.target.value = "";
    }
  };
  render();
  roster();
  document.querySelector("[data-tab]").click();
})();
