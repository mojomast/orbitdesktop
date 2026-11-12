#!/usr/bin/env bash
# Fresh-container smoke check for the stranger-facing first run.
#
# It builds the image, starts one disposable container with an empty volume on a
# random loopback port, reads the login URL with the documented launcher command,
# confirms the onboarding UI is reachable, asserts that a plain Compose up did not
# start a router container, and removes everything it created. It never uses
# port 4318 and never touches a container, volume or image it did not create.
#
# Usage:
#   scripts/smoke-fresh-container.sh [--dry-run]
#
# Environment:
#   ENGINE                  docker or podman (auto-detected by default)
#   SMOKE_ARTIFACT_DIR      where the onboarding screenshot is written
#   ORBIT_PLAYWRIGHT_EXECUTABLE  optional Chromium path for Playwright
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY_RUN=false
for argument in "$@"; do
  case "$argument" in
    --dry-run) DRY_RUN=true ;;
    -h|--help)
      sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      printf 'SMOKE: unknown argument: %s\n' "$argument" >&2
      exit 2
      ;;
  esac
done

log() { printf 'SMOKE: %s\n' "$*"; }
fail() { printf 'SMOKE: %s\n' "$*" >&2; exit 1; }

detect_engine() {
  if [ -n "${ENGINE:-}" ]; then
    case "$ENGINE" in
      docker|podman) printf '%s\n' "$ENGINE"; return 0 ;;
      *) fail "ENGINE must be docker or podman (got: $ENGINE)" ;;
    esac
  fi
  if command -v docker >/dev/null 2>&1; then printf 'docker\n'; return 0; fi
  if command -v podman >/dev/null 2>&1; then printf 'podman\n'; return 0; fi
  fail "Neither docker nor podman is available. Set ENGINE to the engine you use."
}

if [ "$DRY_RUN" = true ]; then
  if [ -n "${ENGINE:-}" ]; then
    engine="$ENGINE"
  elif command -v docker >/dev/null 2>&1; then
    engine="docker (detected)"
  elif command -v podman >/dev/null 2>&1; then
    engine="podman (detected)"
  else
    engine="none found; install docker or podman"
  fi
  log "dry run: no image, container, volume, port or token will be created"
  log "engine: ${engine}"
  log "image: orbit-desktop:smoke-<random>"
  log "container: orbit-smoke-<random> (unique; an existing container is never touched)"
  log "port: random loopback port in 20000-39999, never 4318"
  log "volume: fresh project-scoped volume with an empty runtime directory"
  log "steps: build image; compose up with COMPOSE_PROFILES unset; wait for /api/health"
  log "       read login URL with orbit-up.mjs --print-login-url"
  log "       assert no router container; run Playwright or curl-only onboarding check"
  log "       remove the container and volume"
  exit 0
fi

ENGINE="$(detect_engine)"
case "$ENGINE" in docker|podman) ;; *) fail "Unsupported engine: $ENGINE" ;; esac
command -v curl >/dev/null 2>&1 || fail "curl is required."

PROJECT="orbit-smoke-${RANDOM}-$$"
CONTAINER="orbit-smoke-${RANDOM}-$$"
IMAGE="orbit-desktop:smoke-${RANDOM}-$$"
VOLUME="orbit-smoke-runtime-${RANDOM}-$$"
ARTIFACT_DIR="${SMOKE_ARTIFACT_DIR:-$REPO_ROOT/smoke-artifacts}"
SCREENSHOT="$ARTIFACT_DIR/onboarding.png"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/orbit-smoke.XXXXXX")"
EMPTY_ENV="$TMP_DIR/empty.env"
OVERRIDE="$TMP_DIR/compose.override.yml"
: > "$EMPTY_ENV"

# The router service lives in an opt-in profile. Give Compose the file and the
# private env file it expects, then leave COMPOSE_PROFILES unset so the service
# stays stopped.
export ORBIT_RUNTIME_DIR="$TMP_DIR/runtime"
mkdir -p "$ORBIT_RUNTIME_DIR/router/data"
: > "$ORBIT_RUNTIME_DIR/router/router.env"
# docker-compose.yml includes compose.router.yml itself; passing it again with
# -f would declare the router service twice.
COMPOSE_FILES=(-f "$REPO_ROOT/docker-compose.yml")

STATE="none"
COMPOSE_MODE=false
COMPOSE=()

pick_port() {
  local candidate
  for _ in $(seq 1 100); do
    candidate=$((20000 + RANDOM % 20000))
    [ "$candidate" -eq 4318 ] && continue
    if ! (exec 3<>"/dev/tcp/127.0.0.1/$candidate") 2>/dev/null; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

PORT="$(pick_port)" || fail "Could not find a free loopback port."

cleanup() {
  set +e
  if [ "$STATE" = "compose" ] && [ "${#COMPOSE[@]}" -gt 0 ]; then
    "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1
  elif [ "$STATE" = "raw" ]; then
    "$ENGINE" rm -f "$CONTAINER" >/dev/null 2>&1
    "$ENGINE" volume rm -f "$VOLUME" >/dev/null 2>&1
  fi
  "$ENGINE" image rm -f "$IMAGE" >/dev/null 2>&1
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

log "engine: $ENGINE"
log "building $IMAGE"
"$ENGINE" build -t "$IMAGE" "$REPO_ROOT"

cat > "$OVERRIDE" <<YAML
services:
  orbit:
    image: ${IMAGE}
    container_name: ${CONTAINER}
    ports: !override
      - "127.0.0.1:${PORT}:${PORT}"
    environment:
      PORT: "${PORT}"
      ORBIT_HOST: "0.0.0.0"
      ORBIT_PUBLIC_ORIGIN: "http://127.0.0.1:${PORT}"
      ORBIT_RUNTIME_DIR: "/home/node/.orbit-runtime"
YAML

if "$ENGINE" compose version >/dev/null 2>&1; then
  COMPOSE=("$ENGINE" compose --project-name "$PROJECT" --env-file "$EMPTY_ENV" \
    "${COMPOSE_FILES[@]}" -f "$OVERRIDE")
  COMPOSE_MODE=true
elif [ "$ENGINE" = "docker" ] && command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose --project-name "$PROJECT" --env-file "$EMPTY_ENV" \
    "${COMPOSE_FILES[@]}" -f "$OVERRIDE")
  COMPOSE_MODE=true
elif [ "$ENGINE" = "podman" ] && command -v podman-compose >/dev/null 2>&1; then
  COMPOSE=(podman-compose --project-name "$PROJECT" --env-file "$EMPTY_ENV" \
    "${COMPOSE_FILES[@]}" -f "$OVERRIDE")
  COMPOSE_MODE=true
fi

if [ "$COMPOSE_MODE" = true ]; then
  log "starting Compose project $PROJECT on 127.0.0.1:$PORT (COMPOSE_PROFILES unset)"
  if ! compose_error="$(env -u COMPOSE_PROFILES "${COMPOSE[@]}" up -d --no-build 2>&1 >/dev/null)"; then
    log "Compose path failed; falling back to a direct container run"
    printf '%s\n' "$compose_error" | tail -n 5 | sed 's/^/SMOKE: compose: /' >&2
    env -u COMPOSE_PROFILES "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
    COMPOSE_MODE=false
    STATE="none"
  else
    STATE="compose"
  fi
fi

if [ "$COMPOSE_MODE" = false ]; then
  log "starting direct container $CONTAINER on 127.0.0.1:$PORT"
  "$ENGINE" volume create "$VOLUME" >/dev/null
  "$ENGINE" run -d --name "$CONTAINER" \
    --label "orbit.smoke.project=$PROJECT" \
    --user node \
    -e "PORT=$PORT" \
    -e "ORBIT_HOST=0.0.0.0" \
    -e "ORBIT_PUBLIC_ORIGIN=http://127.0.0.1:$PORT" \
    -e "ORBIT_RUNTIME_DIR=/home/node/.orbit-runtime" \
    -p "127.0.0.1:$PORT:$PORT" \
    -v "$VOLUME:/home/node/.orbit-runtime" \
    "$IMAGE" >/dev/null
  STATE="raw"
fi

log "waiting for http://127.0.0.1:$PORT/api/health"
deadline=$((SECONDS + 180))
until curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    if [ "$STATE" = "compose" ]; then
      "${COMPOSE[@]}" logs --no-color orbit >&2 || true
    else
      "$ENGINE" logs "$CONTAINER" >&2 || true
    fi
    fail "the server did not become healthy"
  fi
  sleep 1
done
log "health endpoint is ready"

# The router is opt-in. A plain up (COMPOSE_PROFILES unset) must not create a
# router service container for this project.
if "$ENGINE" ps -a -q \
    --filter "label=com.docker.compose.project=$PROJECT" \
    --filter "label=com.docker.compose.service=router" 2>/dev/null | grep -q .; then
  fail "a router container exists after a default up"
fi
if [ "$STATE" = "raw" ] && "$ENGINE" ps -a -q --filter "name=${CONTAINER}-router" 2>/dev/null | grep -q .; then
  fail "a router container exists after a default run"
fi

if [ "$COMPOSE_MODE" = true ]; then
  login_output="$(env -u COMPOSE_PROFILES "${COMPOSE[@]}" exec -T orbit node scripts/orbit-up.mjs --print-login-url 2>&1)" \
    || fail "the documented login command failed"
else
  login_output="$("$ENGINE" exec "$CONTAINER" node scripts/orbit-up.mjs --print-login-url 2>&1)" \
    || fail "the documented login command failed"
fi
LOGIN_URL="$(printf '%s\n' "$login_output" | sed -n 's/^Orbit login: //p' | head -n 1)"
LOGIN_TOKEN="$(printf '%s\n' "$login_output" | sed -n 's/^One-time token: //p' | head -n 1)"
[ -n "$LOGIN_URL" ] || fail "the login command printed no URL"
[ "$LOGIN_URL" = "http://127.0.0.1:$PORT" ] || fail "the login URL did not match the published loopback port"
log "login URL: $LOGIN_URL"

root_html="$(curl -fsS --max-time 15 "$LOGIN_URL/" 2>/dev/null || true)"
printf '%s' "$root_html" | grep -qi 'Orbit' || fail "the root page did not look like Orbit"
log "root page served"

if [ -n "$LOGIN_TOKEN" ]; then
  state_json="$(curl -fsS --max-time 15 -H "Authorization: Bearer $LOGIN_TOKEN" \
    "$LOGIN_URL/api/onboarding/state" 2>/dev/null || true)"
  if [ -n "$state_json" ]; then
    log "onboarding state endpoint responded"
  fi
fi

mkdir -p "$ARTIFACT_DIR"
PLAYWRIGHT_STATUS=0
if [ -d "$REPO_ROOT/node_modules/playwright-core" ] || [ -d "$REPO_ROOT/node_modules/playwright" ]; then
  log "checking the onboarding screen with Playwright"
  set +e
  ORBIT_SMOKE_TOKEN="$LOGIN_TOKEN" node --input-type=module - "$LOGIN_URL" "$SCREENSHOT" <<'NODE'
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';

const url = process.argv[2];
const screenshot = process.argv[3];
const requireFromRepo = createRequire(path.join(process.cwd(), 'package.json'));
let chromium;
try {
  ({chromium} = requireFromRepo('playwright-core'));
} catch {
  try {
    ({chromium} = requireFromRepo('playwright'));
  } catch {
    console.error('playwright-core could not be loaded');
    process.exit(3);
  }
}
const candidates = [
  process.env.ORBIT_PLAYWRIGHT_EXECUTABLE,
  process.env.CHROME_BIN,
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);
let executablePath = candidates.find(candidate => existsSync(candidate));
if (!executablePath) {
  try {
    const bundled = chromium.executablePath();
    if (bundled && existsSync(bundled)) executablePath = bundled;
  } catch {}
}
if (!executablePath) {
  console.error('no Chromium executable is available');
  process.exit(3);
}
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
} catch (error) {
  console.error(`Chromium did not launch: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(3);
}
const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
try {
  // A person sees the welcome tour, unlocks the host with the token, then the
  // setup wizard opens on its own. Automation skips the tour and asks for the
  // wizard explicitly (?setup=1), because it never auto-opens for webdriver.
  await page.addInitScript(() => { localStorage.setItem('orbit.onboarding.v1', 'done'); });
  await page.goto(`${url}/?setup=1`, {waitUntil: 'load', timeout: 60_000});
  const token = process.env.ORBIT_SMOKE_TOKEN || '';
  if (token) {
    await page.getByRole('button', {name: 'Connect local host', exact: true}).click({timeout: 30_000});
    await page.getByRole('textbox', {name: 'Host session token'}).fill(token);
    await page.getByRole('button', {name: 'Unlock local host', exact: true}).click();
  }
  const found = await page.waitForFunction(() => {
    const text = document.body?.innerText ?? '';
    return /Choose what to install|Minimal install/.test(text);
  }, {timeout: 45_000}).then(() => true).catch(() => false);
  await page.screenshot({path: screenshot, fullPage: true});
  if (!found) {
    console.error('the onboarding heading was not reached');
    process.exit(4);
  }
} finally {
  await browser.close().catch(() => {});
}
process.exit(0);
NODE
  PLAYWRIGHT_STATUS=$?
  set -e
  case "$PLAYWRIGHT_STATUS" in
    0) log "onboarding screen reached; screenshot: $SCREENSHOT" ;;
    3) log "Playwright is present but no browser was usable; curl-only checks passed. The onboarding visual was not asserted." ;;
    *) fail "the onboarding screen check failed (screenshot: $SCREENSHOT)" ;;
  esac
else
  log "Playwright is not installed in node_modules; using curl-only checks. The onboarding visual is not asserted."
fi

log "removing the disposable container, volume and image"
exit 0
