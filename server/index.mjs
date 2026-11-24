import http from "node:http";
import os from 'node:os';
import { existsSync, mkdirSync, writeFileSync, renameSync, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { tokenMatches, geometry, allowedRequest, resolveListenHost, acceptedHosts } from "./security.mjs";
import { discoverAgentBackends, publicBackendSummary } from "./agent-discovery.mjs";
import { createOrbitSetup } from "./onboarding-wiring.mjs";
import { LocalHostProvider } from "./local-host.mjs";
import { createAgentHandler } from "./agent.mjs";
import { startPiGateway } from "./pi-gateway.mjs";
import { createWorkspaceService, runtimeRoot } from "./workspace.mjs";
import { installBuiltinApps } from "./builtin-apps.mjs";
import {observeFeatureReadiness} from './feature-readiness.mjs';
import {featureCapabilities} from '../contracts/feature-capabilities.mjs';
import { createWorkspaceLayouts } from './workspace-layouts.mjs';
import { createOutputLibrary } from './output-library.mjs';
import { createWorkspaceEvents } from './workspace-events.mjs';
import { assetCacheControl, loadImmutableAssetManifest } from './static-cache.mjs';
import {ownerRoute} from './owner-route.mjs';
import {createExtensionStudio} from './extension-studio.mjs';
import {technologyOwnerRoute,lazyTechnologyService} from './technology-owner-route.mjs';
import { createColabOrchestrator } from './colab-orchestrator.mjs';
import { createGrokBotsApp } from './grokbots-app.mjs';
import { createAgentStatus } from './agent-status.mjs';
import { createCollabBoard } from './collab-board.mjs';
import { createLocalWorkersRoute } from './local-workers-route.mjs';
import { createAcddEvidenceRoute } from './acdd-evidence-route.mjs';
import { createHiveReportsRoute, HIVE_REPORTS_ROUTE, observeLocalRelease } from './hive-reports.mjs';
import { createRailsProxy } from './rails-proxy.mjs';
import { ownerRelay, fixedSshExchange } from './rails-owner-relay.mjs';
import { loadExtensionManifests, createExtensionProxy } from './extension-proxy.mjs';
const port = Number(process.env.PORT || 4318);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw Error("PORT must be between 1024 and 65535");
const listenHost = resolveListenHost();
const explicitHermes = Boolean(process.env.HERMES_API_URL || process.env.HERMES_API_KEY || process.env.HERMES_PROFILES_JSON);
let discovered = { hermes: null, grok: null, pi: null };
// ORBIT_AGENT_DISCOVERY=off boots with only explicitly configured agents (fresh-install tests).
try { if (process.env.ORBIT_AGENT_DISCOVERY !== 'off') discovered = discoverAgentBackends(); }
catch (error) { console.error("Agent backend discovery failed; explicit configuration still applies.", error instanceof Error ? error.message : ""); }
const token = process.env.ORBIT_TOKEN || randomBytes(32).toString("base64url");
if (token.length < 32)
  throw Error("ORBIT_TOKEN must have at least 32 characters");
const devOrigins = process.env.ORBIT_DEV_ORIGINS
  ? process.env.ORBIT_DEV_ORIGINS.split(",")
  : [];
const root = path.resolve(fileURLToPath(new URL("../dist/", import.meta.url)));
const provider = new LocalHostProvider();
const sessions = new Set();
const maxSessions = 16;
let pending = 0;
const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src https: http:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};
const releaseIdentity = await (await import('./release-identity.mjs')).pinnedReleaseIdentity();
// Content-hashed build assets only; enumerated from the served build at startup.
const immutableAssets = await loadImmutableAssetManifest(root);
function reply(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...securityHeaders,
  });
  res.end(JSON.stringify(data));
}
const capabilityDescription=audience=>featureCapabilities({audience,observation:observeFeatureReadiness({root:fileURLToPath(new URL('../',import.meta.url)),runtimeRoot})});
// Built-in apps (Grok Bots) ship in apps/ and are installed before the bundle index refresh.
installBuiltinApps({ runtimeRoot, log: message => console.log(message) });
const workspaceService = createWorkspaceService({ token, port, devOrigins, reply, capabilityDescription });
const workspaceLayouts = createWorkspaceLayouts({ store: workspaceService.store, token, port, devOrigins, reply, root: runtimeRoot });
const outputLibrary = createOutputLibrary({ store: workspaceService.store, workspaceRead: workspaceService.read, token, port, devOrigins, reply, root: runtimeRoot });
// Never put a configured or generated owner credential in routine service logs.
// A generated bootstrap credential is discoverable only through this private
// runtime file; atomic rename avoids following an existing destination symlink.
if(!process.env.ORBIT_TOKEN){
  const temporary=path.join(runtimeRoot,`.session-token-${randomBytes(12).toString('hex')}`);
  writeFileSync(temporary,token+'\n',{mode:0o600,flag:'wx'});
  renameSync(temporary,path.join(runtimeRoot,'session-token'));
}
const workspaceEvents = createWorkspaceEvents({store:workspaceService.store,token,port,devOrigins,reply});
let normalResources;
const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
// Pi is hosted by this process when the harness binary exists: one loopback
// gateway with a token generated in memory, so the Pi profile reaches the same
// agent command surface the Grok Bot host gateway serves. Nothing here reads a
// model-vendor key; Pi authenticates through its own configuration.
let piGateway = null;
let piProfile = null;
if (discovered.pi) {
  if (discovered.pi.apiUrl) piProfile = discovered.pi;
  else {
    try {
      piGateway = await startPiGateway({
        directory: path.join(runtimeRoot, 'pi-gateway'),
        token: randomBytes(32).toString('base64url'),
        binary: discovered.pi.binary,
        cwd: repoRoot,
      });
      piProfile = { id: 'pi', label: discovered.pi.label, provider: 'pi', apiUrl: piGateway.url, apiKey: piGateway.token, source: discovered.pi.source };
    } catch (error) {
      console.error('Pi gateway did not start; the Pi profile stays out of the agent menu.', error instanceof Error ? error.message : '');
    }
  }
}
// Onboarding, Settings, the opt-in router and SSH hosts (orbit-config.json).
// A chat role mapped to an OpenAI-compatible endpoint becomes one more agent
// profile; with nothing configured Orbit boots with zero agents.
const orbitSetup = createOrbitSetup({ runtimeDir: runtimeRoot, env: process.env, discovered, log: message => console.log(message), hasAgents: () => (agentHandler.profileCatalog?.()?.list?.length ?? 0) > 0 });
let configuredProfiles = [];
try { configuredProfiles = await orbitSetup.agentProfiles(); }
catch { console.error('Configured agents from orbit-config.json did not start.'); }
const colab = createColabOrchestrator({ token, port, devOrigins, reply, root: path.join(runtimeRoot, 'colab-orchestrator') });
// Grok Bots app: capability-scoped list/history/send for the sandboxed app iframe.
const agentStatus = createAgentStatus({ runtimeRoot });
// The configured evidence directory is also the delivery path for a read-only
// observation of this deployment's own Git checkouts (server/hive-reports.mjs).
const hiveReportDir = process.env.ORBIT_HIVE_REPORT_DIR;
if (observeLocalRelease({dir: hiveReportDir, repoRoot, env: process.env}) === 'failed')
  console.warn('Hive local release observation unavailable.');
const hiveReports = createHiveReportsRoute({dir: hiveReportDir, token, port, devOrigins, reply});
const acddEvidence = createAcddEvidenceRoute({ stateDir: process.env.ORBIT_ACDD_STATE_DIR || '', authorize: req => allowedRequest(req, port, devOrigins) && tokenMatches(String(req.headers.authorization || '').replace(/^Bearer /, ''), token) });
const railsProxy = createRailsProxy({token, port, devOrigins, upstreamPort:process.env.ORBIT_RAILS_PORT,
  readTokenFile:process.env.ORBIT_RAILS_READ_TOKEN_FILE,
  ownerFeedback:ownerRelay({workspace:process.env.ORBIT_RAILS_FEEDBACK_WORKSPACE,workspaceRead:workspaceService.read,exchange:fixedSshExchange(process.env)})});
// This renderer is reviewed release source, never a mutable runtime app slug.
const railsAssets = new Map(Object.entries({'index.html':'text/html','styles.css':'text/css','app.js':'text/javascript','rails.js':'text/javascript','inspector.js':'text/javascript','feedback.js':'text/javascript'}));
const grokBotsApp = createGrokBotsApp({ runtimeRoot, catalog: () => agentHandler.profileCatalog?.(), agentStatus, chats: () => agentHandler.gatewayChats?.(), workspaceContext: workspaceService.context });
const agentHandler = createAgentHandler({ token, port, devOrigins, reply, workspaceContext: workspaceService.context, workspaceRead:workspaceService.read, runtimeDirectory:runtimeRoot,onRunEvent:event=>observeTechnologyTrace(event,'observeAgentRunEvent'),onNormalAccepted:record=>normalResources?.normalAccepted(record),
  ...(!explicitHermes && discovered.hermes ? { apiUrl: null, apiKey: null, profiles: [{ id: "default", label: discovered.hermes.label, apiUrl: discovered.hermes.apiUrl, apiKey: discovered.hermes.apiKey }] } : {}),
  ...(discovered.grok || piProfile || configuredProfiles.length ? { additionalProfiles: [...(discovered.grok ? [discovered.grok] : []), ...(piProfile ? [piProfile] : []), ...configuredProfiles] } : {}),
});
// Group-chat build tracking on the Collab board (loopback CLI ~/bin/collab-board).
const collabBoard = createCollabBoard({ runtimeRoot, collab: () => agentHandler.collabOperate, groups: () => grokBotsApp.groupsApi(), workspace: () => {
  if (/^[0-9a-f-]{36}$/i.test(process.env.ORBIT_BOARD_WORKSPACE || '')) return process.env.ORBIT_BOARD_WORKSPACE;
  try { return JSON.parse(readFileSync(path.join(runtimeRoot, 'collab-board.json'), 'utf8')).workspace || ''; } catch { return ''; }
} });
// Local workers (Cua/OpenCode on a tailnet PC). Off unless ORBIT_LOCAL_WORKERS=1.
const localWorkers = process.env.ORBIT_LOCAL_WORKERS === '1' ? createLocalWorkersRoute({ runtimeRoot, port, env: process.env, log: m => console.log(m) }) : null;
// Managed terminals: strictly optional. A failure here (no tmux, readonly runtime,
// unsupported platform) disables the route; it must never block the host server or
// touch any existing session/server. Attach mode never creates, kills, respawns or
// attaches anything; grants are process-local and are never restored from disk.
const managedDirectory = path.join(runtimeRoot, "managed-terminals");
const managedLedgerPath = path.join(managedDirectory, "identity-ledger.json");
const managedSentinelPath = path.join(managedDirectory, "identity-ledger.json.initialized");
const managedTerminals = await (async () => {
  try {
    const directory = managedDirectory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // Dynamic imports so a partial release that is missing a managed-terminal
    // module cannot crash the host server at load time; the route degrades to a
    // fixed 503. Full delivery is still required for the feature to be reachable.
    const [{ ManagedTerminalIdentityLedger }, { ManagedTerminalProvider },
      { ManagedTerminalBroker }, { createManagedTerminalHandler }] = await Promise.all([
      import("./managed-terminal-ledger.mjs"),
      import("./managed-terminal-provider.mjs"),
      import("./managed-terminal-broker.mjs"),
      import("./managed-terminal-routes.mjs"),
    ]);
    const ledger = new ManagedTerminalIdentityLedger({ directory, filename: "identity-ledger.json" });
    const managedProvider = await ManagedTerminalProvider.create({
      mode: "attach",
      socket: provider.tmuxSocket,
      ledger,
      tmuxTmpDir: process.env.TMUX_TMPDIR,
    });
    const broker = new ManagedTerminalBroker({
      ownerId: "owner",
      providerId: `local-${provider.tmuxSocket}`,
      provider: managedProvider,
      workspaceRead: workspaceService.read,
      journalPath: path.join(directory, "operations.json"),
    });
    const handler = createManagedTerminalHandler({ broker, token, port, devOrigins, reply });
    // Reconcile only previously consented workspace references. This reads exact
    // identities, never enumerates tmux, captures output, adopts, or grants. Do not
    // delay HTTP startup on a suspended external tmux server.
    void (async () => {
      for (const workspaceId of [...new Set(ledger.list().map(entry => entry.workspaceId))].slice(0, 100)) {
        try { await broker.reconcile({ workspaceId }); } catch { /* UI retry reports current availability. */ }
      }
    })();
    return { provider: managedProvider, ledger, broker, handler };
  } catch (error) {
    console.error(`Managed terminals unavailable (${error && error.code ? error.code : "error"})`);
    return null;
  }
})();
const managedTerminalHandler = managedTerminals
  ? managedTerminals.handler
  : (req, res) => reply(res, 503, { ok: false, error: "Managed terminals unavailable", code: "unavailable" });
// A durable sentinel with no ledger means the private ledger was lost after prior
// initialization. Continuity cannot be proven for ANY pane, so the legacy
// attach/create fallback is refused until an owner recovery restores the ledger.
const managedLedgerLost = existsSync(managedSentinelPath) && !existsSync(managedLedgerPath);
const extensionStudio=createExtensionStudio({store:workspaceService.store});
const extensionStudioHandler=ownerRoute({token,port,devOrigins,reply,maxBytes:16384,dispatch:body=>extensionStudio.dispatch(body)});
// The Observatory snapshot is served only through the owner-authenticated
// extension proxy (/api/ext/rizzstack-observatory/snapshot/...). The old
// unauthenticated /obs-snapshot route was removed.
const extensionProxy=createExtensionProxy({
  manifests:loadExtensionManifests(fileURLToPath(new URL('../extensions/',import.meta.url))),
  token,port,devOrigins,env:process.env,
});
const technologyOptions={root:runtimeRoot,workspaceRead:workspaceService.read};
const technologyServices={
  '/api/resource-grants':lazyTechnologyService(async()=> normalResources=await (await import('./resource-delegation.mjs')).createResourceDelegation({...technologyOptions,normalBindings:agentHandler.resourceBindings,knowledge:await technologyServices['/api/search'].get(),documents:await technologyServices['/api/documents'].get()})),
  '/api/search':lazyTechnologyService(async()=> (await import('./knowledge-index.mjs')).createKnowledgeSearch(technologyOptions)),
  '/api/interactive-results':lazyTechnologyService(async()=> (await import('./interactive-results.mjs')).createInteractiveResults(technologyOptions)),
  '/api/documents':lazyTechnologyService(async()=> (await import('./documents-store.mjs')).createDocumentsService(technologyOptions)),
  '/api/run-traces':lazyTechnologyService(async()=> (await import('./run-traces.mjs')).createRunTraces(technologyOptions)),
};
// Load the derived projection on its first observed event rather than on shell
// startup. Limit pending deliveries while an optional module is initializing.
let pendingTraceObservations=0;
function observeTechnologyTrace(change,method){
  if(pendingTraceObservations>=4000)return;
  pendingTraceObservations++;
  void technologyServices['/api/run-traces'].get().then(traces=>traces[method](change)).catch(()=>{}).finally(()=>{pendingTraceObservations--;});
}
const technologyHandlers=Object.fromEntries(Object.entries(technologyServices).map(([route,service])=>[route,technologyOwnerRoute({token,port,devOrigins,reply,
  maxBytes:route==='/api/documents'?4*1024*1024:route==='/api/run-traces'?16384:route==='/api/search'?400*1024:1024*1024,
  maxResponseBytes:route==='/api/run-traces'?4*1024*1024+65536:2*1024*1024,
  publicReasons:['recovery_hold','operation_mismatch'],dispatch:body=>service.dispatch(body),
  publicDetail:route==='/api/search',
  conflictDetails:route==='/api/search'?error=>Number.isSafeInteger(error.current?.consent_generation)&&error.current.consent_generation>=0?{current:{consent_generation:error.current.consent_generation}}:{}:undefined,
})]));
const technologyAssets=lazyTechnologyService(async()=> (await import('./technology-assets.mjs')).createTechnologyAssets({root:path.resolve(fileURLToPath(new URL('../',import.meta.url))),runtimeRoot,securityHeaders}));
const technologyCapabilities=technologyOwnerRoute({token,port,devOrigins,reply,maxBytes:256,dispatch:async body=>{
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==1||body.action!=='capabilities')throw {code:'invalid_request'};
  return {descriptors:capabilityDescription('owner')};
}});
async function handleOrbitRequest(req, res) {
  const allowedHosts = acceptedHosts(port, devOrigins, listenHost).hosts;
  if (!allowedHosts.has(req.headers.host))
    return reply(res, 403, { error: "Host rejected" });
  const url = new URL(req.url, "http://localhost");
  if(url.pathname===HIVE_REPORTS_ROUTE) return hiveReports(req,res);
  if(url.pathname.startsWith('/api/rizzstack/rails/')) return railsProxy(req,res);
  if(url.pathname.startsWith('/rails-pane/')) {
    const file=url.pathname.slice('/rails-pane/'.length);
    if(req.method!=='GET'||!railsAssets.has(file)||url.search)return reply(res,404,{error:'not_found'});
    try {
      const bytes=await readFile(new URL(`../apps/rizzstack-rails/${file}`,import.meta.url));
      res.writeHead(200,{'Content-Type':railsAssets.get(file),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
        'Referrer-Policy':'no-referrer',...(file==='index.html'?{'Content-Security-Policy':"sandbox allow-scripts; default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"}:{'Access-Control-Allow-Origin':'*'})});
      return res.end(bytes);
    }catch{return reply(res,503,{error:'unavailable'});}
  }
  if(url.pathname==='/api/technology-capabilities')return technologyCapabilities(req,res);
  if(Object.hasOwn(technologyHandlers,url.pathname))return technologyHandlers[url.pathname](req,res);
  if(url.pathname.startsWith('/vendor/')){
    try{return (await technologyAssets.get()).handle(req,res,url.pathname);}catch{return reply(res,503,{ok:false,code:'unavailable'});}
  }
  if(url.pathname==='/api/extension-studio')return extensionStudioHandler(req,res);
  if (url.pathname === "/api/managed-terminals") return managedTerminalHandler(req, res);
  if(url.pathname==='/api/workspace/events')return workspaceEvents(req,res);
  if(url.pathname==='/api/workspace/control/events')return workspaceEvents(req,res,true);
  if (url.pathname === '/api/workspace/recovery') return workspaceService.handle(req, res, false, true);
  // Serve independently of dist/index and the normal renderer's dependency graph.
  const recoveryAssets = {'/recovery':['recovery.html','text/html; charset=utf-8'],'/recovery.js':['recovery.js','text/javascript; charset=utf-8'],'/recovery.css':['recovery.css','text/css; charset=utf-8']};
  if(Object.hasOwn(recoveryAssets,url.pathname)) {
    if(!['GET','HEAD'].includes(req.method))return reply(res,405,{error:'Method not allowed'});
    try {
      const [file,type]=recoveryAssets[url.pathname];
      const data=await readFile(new URL(`../public/${file}`,import.meta.url));
      res.writeHead(200,{...securityHeaders,'Content-Type':type,'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"});
      return res.end(req.method==='HEAD'?undefined:data);
    } catch {return reply(res,503,{error:'Recovery files unavailable'});}
  }
  if (url.pathname === "/api/workspace") return workspaceService.handle(req, res);
  if (url.pathname === '/api/workspace-layouts') return workspaceLayouts.handle(req, res);
  if (url.pathname === '/api/output-library') return outputLibrary.handle(req, res);
  if (url.pathname === "/api/workspace/control") return workspaceService.handle(req, res, true);
  if (url.pathname.startsWith("/apps/")) return workspaceService.serveApp(req, res, url.pathname);
  if (url.pathname === "/api/agent") return agentHandler(req, res);
  if (url.pathname === '/api/colab-runtime' || url.pathname.startsWith('/api/colab-runtime/')) return colab.handle(req, res, url);
  if (url.pathname === '/api/grokbots-app/launch') {
    // Host-only: hands the Orbit page the capability URL for the sandboxed Grok Bots pane.
    if (req.method !== 'POST' || !allowedRequest(req, port, devOrigins) || !tokenMatches(String(req.headers.authorization || '').replace(/^Bearer /, ''), token)) return reply(res, 403, { error: 'Orbit authentication required' });
    return reply(res, 200, { url: grokBotsApp.launchUrl() });
  }
  if (url.pathname === '/api/grokbots-app') return grokBotsApp.handle(req, res);
  if (url.pathname === '/api/grokbots-app/upload') return grokBotsApp.upload(req, res);
  if (url.pathname === '/api/agent-status') return agentStatus.handle(req, res);
  if (url.pathname === '/api/acdd-evidence') return acddEvidence.handle(req, res, url);
  if (url.pathname.startsWith('/api/ext/')) return extensionProxy(req, res);
  // /api/approvals deliberately falls through to the API 404. The Orbit
  // bearer is not a workspace-bound BundleBees approval session (SECURITY.md).
  if (url.pathname === '/api/collab-board') return collabBoard.handle(req, res);
  if (url.pathname === '/api/local-workers') { if (localWorkers) return localWorkers.handle(req, res); res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":"local workers disabled"}'); }
  if (url.pathname === "/api/health")
    return reply(res, 200, {
      service: "orbit",
      protocol: 1,
      host: "local",
      sessions: sessions.size,
      ...(releaseIdentity ?? {}),
    });
  if (url.pathname === "/api/auth") {
    if (req.method !== "POST" || !allowedRequest(req, port, devOrigins))
      return reply(res, 403, { error: "Origin rejected" });
    let raw = "";
    try {
      for await (const part of req) {
        raw += part;
        if (raw.length > 2048) {
          reply(res, 413, { error: "Request too large" });
          req.destroy();
          return;
        }
      }
      const body = JSON.parse(raw);
      return tokenMatches(body.token, token)
        ? reply(res, 200, { ok: true })
        : reply(res, 401, { error: "Invalid token" });
    } catch {
      return reply(res, 400, { error: "Invalid JSON" });
    }
  }
  if (url.pathname === '/api/onboarding' || url.pathname.startsWith('/api/onboarding/') || url.pathname === '/api/settings' || url.pathname.startsWith('/api/settings/') || url.pathname === '/api/hosts') {
    // Owner bearer token always; a cross-origin Origin is always refused. Same-origin
    // GETs carry no Origin header in browsers, so its absence is accepted here.
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedRequest(req, port, devOrigins)) return reply(res, 403, { error: 'Origin rejected' });
    if (!tokenMatches(String(req.headers.authorization || '').replace(/^Bearer /, ''), token)) return reply(res, 401, { error: 'Orbit authentication required' });
    return orbitSetup.handle(req, res, url);
  }
  if (url.pathname.startsWith("/api/"))
    return reply(res, 404, { error: "Not found" });
  if (req.method !== "GET" && req.method !== "HEAD")
    return reply(res, 405, { error: "Method not allowed" });
  try {
    const decoded = decodeURIComponent(url.pathname);
    let file = path.resolve(root, "." + decoded);
    if (!file.startsWith(root + path.sep) && file !== root)
      return reply(res, 403, { error: "Forbidden" });
    if (decoded === "/") file = path.join(root, "index.html");
    const info = await stat(file);
    if (!info.isFile()) return reply(res, 404, { error: "Not found" });
    const ext = path.extname(file);
    const types = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".mjs": "text/javascript; charset=utf-8",
      ".wasm": "application/wasm",
      ".css": "text/css; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".woff2": "font/woff2",
      ".woff": "font/woff",
      ".ttf": "font/ttf",
    };
    const headers = {...securityHeaders};
    res.writeHead(200, {
      ...headers,
      "Content-Type": types[ext] || "application/octet-stream",
      // Overrides the no-store default only for enumerated content-hashed assets.
      "Cache-Control": assetCacheControl(decoded, immutableAssets),
    });
    res.end(req.method === "HEAD" ? undefined : await readFile(file));
  } catch {
    reply(res, 404, { error: "Build the client with npm run build first." });
  }
}
const server = http.createServer((req, res) => {
  // A provider rejection must not become an unhandled rejection and stop the process.
  void handleOrbitRequest(req, res).catch(error => {
    console.error("Orbit request failed.", error instanceof Error ? error.message : "");
    if (res.headersSent || res.writableEnded) { try { res.end(); } catch {} return; }
    try { reply(res, 500, { error: "Orbit could not complete the request." }); }
    catch { try { res.end(); } catch {} }
  });
});
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 32 * 1024,
  perMessageDeflate: false,
});
server.on("upgrade", (req, socket, head) => {
  if (
    req.url !== "/api/terminal" ||
    !allowedRequest(req, port, devOrigins) ||
    sessions.size + pending >= maxSessions
  ) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
});
wss.on("connection", (ws) => {
  pending++;
  let shell = null,
    authed = false,
    authenticating = false,
    closed = false,
    outstanding = 0,
    paused = false,
    lastAck = Date.now(),
    lastSeen = Date.now();
  const send = (m) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  };
  const timeout = setTimeout(
    () => ws.close(1008, "Authentication timeout"),
    5000,
  );
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timeout);
    clearInterval(health);
    if (!authed) pending--;
    if (shell) {
      sessions.delete(shell);
      try {
        shell.kill();
      } catch {}
    }
  };
  const health = setInterval(() => {
    if (
      Date.now() - lastSeen > 70000 ||
      (paused && Date.now() - lastAck > 30000)
    ) {
      ws.terminate();
      return;
    }
    ws.ping();
  }, 15000);
  ws.on("pong", () => (lastSeen = Date.now()));
  let historyPane = null, historyBusy = false;
  ws.on("message", async (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      ws.close(1008, "Invalid JSON");
      return;
    }
    if (!m || typeof m !== "object") {
      ws.close(1008, "Invalid message");
      return;
    }
    if (!authed) {
      if (
        authenticating ||
        m.type !== "auth" ||
        !tokenMatches(m.token, token) ||
        !geometry(m.cols, m.rows)
      ) {
        ws.close(1008, "Authentication rejected");
        return;
      }
      clearTimeout(timeout);
      authenticating = true;
      try {
        let tmuxArguments;
        if (typeof m.pane_id === 'string' && /^[a-f0-9-]{36}$/.test(m.pane_id)) {
          if (!managedTerminals && (managedLedgerLost || existsSync(managedLedgerPath))) throw Error('Managed identity unavailable');
          const sessionName = 'pane-' + m.pane_id;
          const recorded = managedTerminals?.ledger.get(sessionName);
          if (recorded) {
            tmuxArguments = await managedTerminals.provider.attachmentArguments({sessionName});
            if (!tmuxArguments) throw Error('Managed identity changed; no replacement shell was created');
          } else if (managedTerminals) {
            // Not recorded: refuse the legacy attach/create fallback when the exact
            // session still carries ANY adopted markers, so a lost/partial ledger
            // can never make an adopted shell look unmanaged. The probe is side
            // effect free: it never captures output, adopts or creates a shell.
            const observed = await managedTerminals.provider.observeExact({ sessionName });
            if (observed && Object.values(observed.markers).some(value => value !== '')) throw Error('Managed identity unavailable');
          }
        }
        if (closed || ws.readyState !== WebSocket.OPEN) return;
        shell = provider.spawn(m, {tmuxArguments});
        authed = true;
        pending--;
        sessions.add(shell);
        historyPane = m.pane_id;
        send({ type: "ready", history: true, protocol: 1, user: os.userInfo().username, host: os.hostname(), cwd: process.env.ORBIT_CWD || os.homedir() });
        shell.onData((data) => {
          outstanding += data.length;
          send({ type: "data", data });
          if (outstanding > 128000 && !paused) {
            shell.pause();
            paused = true;
            lastAck = Date.now();
          }
          if (outstanding > 1048576 || ws.bufferedAmount > 2097152)
            ws.close(1009, "Output buffer exceeded");
        });
        shell.onExit(({ exitCode }) => {
          send({ type: "exit", code: exitCode });
          ws.close(1000, "Shell exited");
        });
      } catch {
        send({
          type: "error",
          message: "Unable to start the configured shell.",
        });
        ws.close(1011, "Spawn failed");
      }
      return;
    }
    if (m.type === 'history') {
      if (historyBusy) return;
      historyBusy = true;
      import('./local-host.mjs').then(({ captureHistory }) => captureHistory(historyPane, provider.tmuxSocket))
        .then(text => send({ type: 'history', text }))
        .catch(() => send({ type: 'history', error: 'Retained history unavailable (legacy shell, missing session, or capture limit exceeded).' }))
        .finally(() => { historyBusy = false; });
      return;
    }
    if (
      m.type === "input" &&
      typeof m.data === "string" &&
      m.data.length <= 16384
    )
      shell.write(m.data);
    else if (m.type === "resize" && geometry(m.cols, m.rows))
      shell.resize(m.cols, m.rows);
    else if (
      m.type === "ack" &&
      Number.isInteger(m.length) &&
      m.length > 0 &&
      m.length <= outstanding
    ) {
      outstanding -= m.length;
      lastAck = Date.now();
      if (paused && outstanding < 32000) {
        shell.resume();
        paused = false;
      }
    } else ws.close(1008, "Invalid protocol message");
  });
  ws.on("close", close);
  ws.on("error", close);
});
server.listen(port, listenHost, () => {
  const wildcard = listenHost === "0.0.0.0" || listenHost === "::" || listenHost === "[::]";
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(listenHost);
  const openHost = wildcard || loopback ? "127.0.0.1" : (listenHost.includes(":") ? `[${listenHost}]` : listenHost);
  const lines = [
    "",
    "Orbit Desktop",
    `Open: http://${openHost}:${port}`,
    `Owner authentication: ${process.env.ORBIT_TOKEN ? "configured token (not logged)" : "generated token in the private runtime session-token file"}`,
    "",
    loopback ? "Bound to loopback. Shells run as your current user." : `Listening on ${listenHost}:${port}. Shells run as your current user.`,
  ];
  if (wildcard && !process.env.ORBIT_PUBLIC_ORIGIN) lines.push("Browsers that open a tailnet address are rejected until ORBIT_PUBLIC_ORIGIN is that exact origin, for example http://100.101.102.104:4318.");
  if (explicitHermes) lines.push("Hermes profiles: explicit server environment.");
  else if (discovered.hermes) {
    const hermes = publicBackendSummary(discovered.hermes);
    lines.push(`Hermes API server: ${hermes.apiUrl}${hermes.model ? ` model ${hermes.model}` : ""}${hermes.modelProvider ? ` via ${hermes.modelProvider}` : ""} (${hermes.source}).`);
  }
  if (discovered.grok) {
    const grok = publicBackendSummary(discovered.grok);
    lines.push(`Grok Bot gateway: ${grok.apiUrl}${grok.model ? ` model ${grok.model}` : ""} (${grok.source}).`);
  }
  if (piProfile) lines.push(`Pi agent: ${publicBackendSummary(piProfile).apiUrl} (${discovered.pi?.source || 'gateway'}).`);
  else if (discovered.pi && !discovered.pi.apiUrl) lines.push("Pi harness was found but its gateway did not start; the Pi profile stays out of the agent menu.");
  console.log(lines.join("\n") + "\n");
});
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    piGateway?.close?.();
    colab.close();
    grokBotsApp.close?.();
    const technologyClosed=Promise.allSettled([...Object.values(technologyServices).map(service=>service.close()),technologyAssets.close()]);
    for (const ws of wss.clients) ws.terminate();
    server.close(() => {void technologyClosed.finally(()=>{workspaceService.close();process.exit(0);});});
    setTimeout(() => process.exit(0), 2000).unref();
  });
