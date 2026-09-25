"use strict";
const $ = (id) => document.getElementById(id);
const labels = {
  all: "All plugins",
  memory: "Memory",
  desktop: "Desktop",
  platform: "Platforms",
  web: "Web & browser",
  tools: "Tools",
  voice: "Voice",
  automation: "Automation",
  models: "Models",
  general: "General",
};
let entries = [],
  installed = [],
  category = "all",
  session = {},
  selected = null,
  pending = null,
  polling = false,
  lastJobs = "";
function el(tag, text, cls) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = String(text);
  if (cls) n.className = cls;
  return n;
}
function notice(text) {
  $("notice").textContent = text;
  $("notice").hidden = !text;
}
async function api(path, body) {
  const r = await fetch("/api/" + path, {
    method: body ? "POST" : "GET",
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(session.session_token
        ? { Authorization: "Bearer " + session.session_token }
        : {}),
    },
    body: body ? JSON.stringify({ ...body, csrf: session.csrf }) : undefined,
  });
  const d = await r.json();
  if (!r.ok) throw Error(d.error || "Request failed");
  return d;
}
function norm(url) {
  return String(url || "")
    .split("#")[0]
    .replace(/\/$/, "")
    .replace(/\.git$/, "")
    .toLowerCase();
}
function current(e) {
  return installed.find(
    (p) =>
      norm(p.source) === norm(e.repo) &&
      (String(p.source).split("#")[1] || "") === (e.subdir || ""),
  );
}
function safeLink(label, url) {
  const a = el("a", label);
  try {
    if (new URL(url).protocol !== "https:") return el("span", label);
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  } catch {
    return el("span", label);
  }
  return a;
}
function updateSession() {
  $("connection").textContent = session.unlocked
    ? "Management unlocked"
    : "Browse mode";
  $("unlock").textContent = session.unlocked
    ? "Lock management"
    : "Unlock installs";
  $("profile").textContent =
    "Target: " + (session.profile || "configured Hermes profile");
}
async function localState() {
  if (session.unlocked) {
    installed = (await api("installed")).plugins;
  } else installed = [];
  render();
}
async function load(refresh = false) {
  try {
    notice("");
    const d =
      refresh && session.unlocked
        ? await api("refresh", {})
        : await api("catalog");
    entries = d.entries.sort((a, b) => a.name.localeCompare(b.name));
    $("stamp").textContent =
      "Catalog build " + new Date(d.generated_at).toLocaleString();
    render();
  } catch (e) {
    notice("Catalog unavailable: " + e.message);
    $("count").textContent = "Could not load catalog";
  }
}
function render() {
  const nav = $("categories");
  nav.replaceChildren();
  for (const [key, label] of Object.entries(labels)) {
    const n =
      key === "all"
        ? entries.length
        : entries.filter((e) => (e.category || "desktop") === key).length;
    if (!n && key !== "all") continue;
    const b = el("button", label, key === category ? "active" : "");
    b.setAttribute("aria-pressed", String(key === category));
    b.append(el("span", n));
    b.onclick = () => {
      category = key;
      render();
    };
    nav.append(b);
  }
  const q = $("search").value.toLowerCase().trim(),
    tier = $("tier").value,
    scope = $("scope").value;
  const visible = entries.filter(
    (e) =>
      (category === "all" || (e.category || "desktop") === category) &&
      (!tier || (e.tier || "community") === tier) &&
      (!q ||
        [e.name, e.description, e.maintainer, JSON.stringify(e.capabilities)]
          .join(" ")
          .toLowerCase()
          .includes(q)) &&
      (!scope ||
        (session.unlocked &&
          (scope === "installed" ? !!current(e) : !current(e)))),
  );
  $("heading").textContent = labels[category];
  $("count").textContent =
    `${visible.length} of ${entries.length} plugins · exact commit pins`;
  const grid = $("grid");
  grid.replaceChildren();
  if (!visible.length) {
    grid.append(
      el(
        "div",
        scope && !session.unlocked
          ? "Unlock management to view installed plugins."
          : "No plugins match. Try another search or category.",
        "empty",
      ),
    );
    return;
  }
  for (const e of visible) {
    const c = el("article", undefined, "card"),
      top = el("div", undefined, "card-top");
    top.append(
      el("div", e.name.slice(0, 2).toUpperCase(), "icon"),
      el("span", e.tier || "community", "chip"),
    );
    c.append(
      top,
      el("h3", e.name),
      el("div", "by " + (e.maintainer || "Community"), "author"),
      el("p", e.description, "description"),
    );
    const bottom = el("div", undefined, "bottom"),
      p = current(e);
    bottom.append(
      el(
        "span",
        p ? p.status : labels[e.category || "desktop"] || "General",
        p ? "state" : "chip",
      ),
    );
    const b = el("button", "View plugin");
    b.setAttribute("aria-label", "View " + e.name);
    b.onclick = () => details(e);
    bottom.append(b);
    c.append(bottom);
    grid.append(c);
  }
}
function details(e) {
  selected = e;
  const root = $("detailBody");
  root.replaceChildren();
  root.append(
    el("h2", e.name),
    el(
      "div",
      `by ${e.maintainer || "Community"} · ${e.tier || "community"} · ${e.version || "pinned release"}`,
      "muted",
    ),
    el("p", e.description, "full-desc"),
  );
  root.append(el("h3", "Reviewed commit"), el("code", e.sha));
  const meta = el(
    "p",
    `Hermes: ${e.requires_hermes || "No minimum declared"} · Platforms: ${(e.platforms || []).join(", ") || "All declared platforms"}`,
  );
  root.append(meta);
  for (const [key, label] of Object.entries({
    provides_tools: "Tools",
    provides_hooks: "Hooks",
    provides_middleware: "Middleware",
    requires_env: "Environment variables",
  })) {
    root.append(el("h3", label));
    const chips = el("div", undefined, "chips"),
      vals = e.capabilities?.[key] || [];
    for (const value of vals) chips.append(el("span", value, "chip"));
    if (!vals.length) chips.append(el("span", "None declared", "muted"));
    root.append(chips);
  }
  root.append(
    el(
      "p",
      "Desktop-only UI plugins target Hermes Desktop, not Orbit. Native tools load in Hermes after enabling. Dependencies and API keys may need separate setup; this app never asks for plugin API keys.",
      "warning",
    ),
  );
  const links = el("div", undefined, "links");
  links.append(
    safeLink("Repository ↗", e.repo),
    safeLink(
      "Official plugin page ↗",
      "https://hermes-agent.nousresearch.com/docs/plugins/" +
        encodeURIComponent(e.name),
    ),
  );
  if (e.docs_url) links.append(safeLink("Documentation ↗", e.docs_url));
  root.append(links);
  const p = current(e),
    actions = el("div", undefined, "actions");
  if (p) {
    root.append(
      el(
        "p",
        `Installed as ${p.name} · ${p.status} · ${p.revision || "unknown revision"}`,
      ),
    );
    if (p.revision !== e.sha)
      root.append(
        el(
          "p",
          "Your installed revision differs from the catalog. Automatic updates and force reinstalls are intentionally unavailable.",
          "warning",
        ),
      );
    const b = el(
      "button",
      p.status === "enabled" ? "Disable plugin" : "Review & enable",
      "primary",
    );
    b.onclick = () => review(e, p.status === "enabled" ? "disable" : "enable");
    if (p.status !== "enabled" && p.revision !== e.sha) b.disabled = true;
    actions.append(b);
  } else {
    const b = el(
      "button",
      session.unlocked ? "Review installation" : "Unlock to install",
      "primary",
    );
    b.onclick = () =>
      session.unlocked ? review(e, "install") : $("auth").showModal();
    actions.append(b);
  }
  const copy = el("button", "Copy pinned CLI command");
  copy.onclick = async () => {
    const command = `hermes plugins install '${e.repo}${e.subdir ? "#" + e.subdir : ""}' --ref ${e.sha} --no-enable`;
    try {
      await navigator.clipboard.writeText(command);
      copy.textContent = "Copied";
    } catch {
      const code = el("code", command);
      root.append(code);
      copy.textContent = "Select command below";
    }
  };
  actions.append(copy);
  root.append(actions);
  if (!$("detail").open) $("detail").showModal();
}
function review(e, action) {
  pending = { e, action };
  $("consent").checked = false;
  $("confirm").disabled = true;
  $("reviewError").textContent = "";
  $("reviewTitle").textContent =
    action === "install"
      ? "Review installation"
      : action === "enable"
        ? "Enable this plugin?"
        : "Disable this plugin?";
  const body = $("reviewBody");
  body.replaceChildren(
    el("h2", e.name),
    el("p", e.description, "full-desc"),
    el("h3", "Exact reviewed SHA"),
    el("code", e.sha),
    el("p", "Target: " + session.profile),
  );
  body.append(
    el(
      "p",
      action === "install"
        ? "This downloads code into your active Hermes profile. The current catalog and removal list are checked again, the Hermes scanner runs, and the plugin stays disabled. No force reinstall, shell script or automatic dependency setup. Scanner caution prompts are NOT automatically accepted."
        : action === "enable"
          ? "Enabled plugins can run code with Hermes’s privileges when a new session starts. Verify dependencies, required environment variables and the source first. This does not restart your current sessions."
          : "Disables this plugin for future Hermes sessions. Already running sessions may retain loaded tools.",
      "warning",
    ),
  );
  $("confirm").textContent =
    action === "install"
      ? "Install disabled"
      : action === "enable"
        ? "Enable plugin"
        : "Disable plugin";
  $("review").showModal();
}
$("confirm").onclick = async () => {
  if (!$("consent").checked || !pending) return;
  $("confirm").disabled = true;
  try {
    await api("action", {
      action: pending.action,
      name: pending.e.name,
      sha: pending.e.sha,
      confirm: true,
    });
    $("review").close();
    $("detail").close();
    notice("Operation submitted. See Installation activity below.");
    await jobs();
    $("activity").scrollIntoView({ behavior: "smooth" });
  } catch (e) {
    $("reviewError").textContent = e.message;
    $("confirm").disabled = false;
  }
};
$("consent").onchange = () => {
  $("confirm").disabled = !$("consent").checked;
};
async function jobs() {
  if (!session.unlocked || polling) return;
  polling = true;
  try {
    const d = await api("jobs");
    if (!session.unlocked) return;
    const signature = d.jobs.map((j) => j.id + j.status).join();
    if (signature === lastJobs) return;
    $("activity").hidden = !d.jobs.length;
    const list = $("jobs");
    list.replaceChildren();
    for (const j of [...d.jobs].reverse()) {
      const item = el("div", undefined, "job");
      item.append(
        el("strong", `${j.action} · ${j.name} · ${j.status}`),
        el(
          "p",
          j.message || "Checking the current catalog and running Hermes…",
        ),
      );
      if (j.log) {
        const dd = el("details");
        dd.append(el("summary", "Hermes output"), el("pre", j.log));
        item.append(dd);
      }
      list.append(item);
    }
    if (signature !== lastJobs && !d.jobs.some((j) => j.status === "running")) {
      lastJobs = signature;
      await localState();
    }
  } catch (e) {
    notice(e.message);
  } finally {
    polling = false;
  }
}
$("authForm").onsubmit = async (event) => {
  event.preventDefault();
  const b = event.target.querySelector("button[type=submit]");
  b.disabled = true;
  try {
    const d = await api("unlock", { token: $("token").value });
    $("token").value = "";
    session = {
      ...session,
      unlocked: true,
      csrf: d.csrf,
      session_token: d.session_token,
    };
    $("auth").close();
    $("authError").textContent = "";
    updateSession();
    await localState();
    await jobs();
    if (selected && $("detail").open) details(selected);
  } catch (e) {
    $("authError").textContent = e.message;
  } finally {
    b.disabled = false;
  }
};
$("auth").addEventListener("close", () => {
  $("token").value = "";
});
$("unlock").onclick = async () => {
  if (!session.unlocked) {
    $("auth").showModal();
    return;
  }
  try {
    await api("lock", {});
    session = { profile: session.profile };
    installed = [];
    updateSession();
    render();
    $("activity").hidden = true;
    if ($("detail").open) details(selected);
  } catch (e) {
    notice(e.message);
  }
};
$("refresh").onclick = async () => {
  await load(true);
  try {
    await localState();
  } catch (e) {
    notice(e.message);
  }
};
for (const id of ["search", "tier", "scope"])
  $(id).addEventListener(id === "search" ? "input" : "change", render);
for (const b of document.querySelectorAll("[data-close]"))
  b.onclick = () => $(b.dataset.close).close();
setInterval(() => {
  if (session.unlocked) jobs();
}, 2000);
(async () => {
  try {
    session = await api("session");
    updateSession();
    await load();
    await localState();
    await jobs();
  } catch (e) {
    notice(e.message);
  }
})();
