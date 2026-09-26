import http from "node:http";
import os from 'node:os';
import { existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { tokenMatches, geometry, allowedRequest, publicHost } from "./security.mjs";
import { LocalHostProvider } from "./local-host.mjs";
import { createAgentHandler } from "./agent.mjs";
import { createWorkspaceService, runtimeRoot } from "./workspace.mjs";
import { createWorkspaceEvents } from './workspace-events.mjs';
import { createWorkbench } from './workbench.mjs';
import {WorkbenchData} from './workbench-data.mjs';
import {createWorkbenchGate} from './workbench-gate.mjs';
import {legacyQueueSnapshot} from './workbench-legacy-state.mjs';
import {workbenchOwnerRoute} from './workbench-owner-route.mjs';
import {createWorkbenchTerminalSource} from './workbench-terminal-source.mjs';
import {createWorkbenchContext} from './workbench-context.mjs';
import {createWorkbenchExecution} from './workbench-execution.mjs';
import {createWorkbenchEnvironments} from './workbench-environments.mjs';
import {createWorkbenchWorkflow} from './workbench-workflow.mjs';
import {createWorkbenchNative} from './workbench-native.mjs';
import {createWorkbenchNativeRuntime,nativeRuntimeEnvironmentOptions,nativeRuntimeMetadata} from './workbench-native-runtime.mjs';
const port = Number(process.env.PORT || 4318);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw Error("PORT must be between 1024 and 65535");
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
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src https: http:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};
function reply(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...securityHeaders,
  });
  res.end(JSON.stringify(data));
}
const workspaceService = createWorkspaceService({ token, port, devOrigins, reply });
// Never put a configured or generated owner credential in routine service logs.
// A generated bootstrap credential is discoverable only through this private
// runtime file; atomic rename avoids following an existing destination symlink.
if(!process.env.ORBIT_TOKEN){
  const temporary=path.join(runtimeRoot,`.session-token-${randomBytes(12).toString('hex')}`);
  writeFileSync(temporary,token+'\n',{mode:0o600,flag:'wx'});
  renameSync(temporary,path.join(runtimeRoot,'session-token'));
}
const workspaceEvents = createWorkspaceEvents({store:workspaceService.store,token,port,devOrigins,reply});
const workbenchServices={};
const workbench = createWorkbench({store:workspaceService.store,token,port,devOrigins,reply,services:workbenchServices});
const workbenchData=new WorkbenchData(workspaceService.store);
const executionGate=createWorkbenchGate({legacySnapshot:legacyQueueSnapshot(runtimeRoot)});
const agentHandler = createAgentHandler({ token, port, devOrigins, reply, workspaceContext: workspaceService.context, workspaceRead:workspaceService.read, runtimeDirectory:runtimeRoot,executionGate });
const environments=createWorkbenchEnvironments({store:workspaceService.store,records:workbench.records,data:workbenchData,gate:executionGate});
const execution=createWorkbenchExecution({store:workspaceService.store,records:workbench.records,data:workbenchData,gate:executionGate,environments});
workbenchServices.execution=execution;
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
const contextSharing=createWorkbenchContext({store:workspaceService.store,records:workbench.records,data:workbenchData,hermes:agentHandler.workbench,execution,gate:executionGate,
  terminalSource:createWorkbenchTerminalSource({store:workspaceService.store,records:workbench.records,broker:managedTerminals?.broker}),
  retentionMs:process.env.ORBIT_CONTEXT_RETENTION_MS===undefined?undefined:Number(process.env.ORBIT_CONTEXT_RETENTION_MS)});
workbenchServices.context=contextSharing;
const contextHandler=workbenchOwnerRoute({token,port,devOrigins,reply,dispatch:body=>contextSharing.dispatch(body)});
const executionHandler=workbenchOwnerRoute({token,port,devOrigins,reply,dispatch:body=>execution.dispatch(body)});
const workflow=createWorkbenchWorkflow({store:workspaceService.store,records:workbench.records,data:workbenchData,execution});
const nativeOptions=nativeRuntimeEnvironmentOptions({root:path.join(runtimeRoot,'workbench-native-runtime'),gate:executionGate});
const nativeRuntimes=new Map();
const nativeQuarantines=new Map();
const nativeHermes={
  quarantineNative({grant_id}){if(!nativeQuarantines.has(grant_id))nativeQuarantines.set(grant_id,executionGate.quarantine(`native:${grant_id}`));},
  acknowledgeNativeUnknown({grant_id}){nativeQuarantines.get(grant_id)?.();nativeQuarantines.delete(grant_id);},
  async readBinding(body){
    const binding=await agentHandler.workbench.readBinding(body);
    if(!nativeOptions||binding.profile_id!==nativeOptions.profile_id)return binding;
    const native_runtime=nativeRuntimeMetadata(nativeOptions);
    const config_generation=binding.config_generation+':'+native_runtime.configuration_hash;
    if(!nativeRuntimes.has(config_generation))nativeRuntimes.set(config_generation,createWorkbenchNativeRuntime({...nativeOptions,config_generation}));
    return {...binding,config_generation,native_runtime};
  },
  async startNative(body){const runtime=nativeRuntimes.get(body.scope.recipient.config_generation);if(!runtime)throw Object.assign(Error('unavailable'),{code:'unavailable',native_outcome:'not_started'});if(agentHandler.workbench.hasActiveConversation({workspace_id:body.scope.workspace_id,pane_id:body.scope.recipient.pane_id}))throw Object.assign(Error('busy'),{code:'busy',native_outcome:'not_started'});return runtime.startNative(body);},
  async stopNative(body){return Promise.all([...nativeRuntimes.values()].map(runtime=>runtime.stopNative(body)));},
};
const native=createWorkbenchNative({store:workspaceService.store,records:workbench.records,data:workbenchData,execution,hermes:nativeOptions?nativeHermes:{readBinding:nativeHermes.readBinding,quarantineNative:nativeHermes.quarantineNative,acknowledgeNativeUnknown:nativeHermes.acknowledgeNativeUnknown}});
workbenchServices.native=native;workbenchServices.nativeConfigured=!!nativeOptions;
const nativeHandler=workbenchOwnerRoute({token,port,devOrigins,reply,dispatch:body=>native.dispatch(body)});
const workflowHandler=workbenchOwnerRoute({token,port,devOrigins,reply,dispatch:body=>workflow.dispatch(body)});
const environmentHandler=workbenchOwnerRoute({token,port,devOrigins,reply,dispatch:body=>environments.dispatch(body)});
const server = http.createServer(async (req, res) => {
  const allowedHosts = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
    ...(publicHost ? [publicHost] : []),
  ]);
  if (!allowedHosts.has(req.headers.host))
    return reply(res, 403, { error: "Host rejected" });
  const url = new URL(req.url, "http://localhost");
  if(url.pathname==='/api/workbench')return workbench.handle(req,res);
  if(url.pathname==='/api/workbench/context')return contextHandler(req,res);
  if(url.pathname==='/api/workbench/execution')return executionHandler(req,res);
  if(url.pathname==='/api/workbench/native')return nativeHandler(req,res);
  if(url.pathname==='/api/workbench/workflow')return workflowHandler(req,res);
  if(url.pathname==='/api/workbench/environments')return environmentHandler(req,res);
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
  if (url.pathname === "/api/workspace/control") return workspaceService.handle(req, res, true);
  if (url.pathname.startsWith("/apps/")) return workspaceService.serveApp(req, res, url.pathname);
  if (url.pathname === "/api/agent") return agentHandler(req, res);
  if (url.pathname === "/api/health")
    return reply(res, 200, {
      service: "orbit",
      protocol: 1,
      host: "local",
      sessions: sessions.size,
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
      ".css": "text/css; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".woff2": "font/woff2",
    };
    const headers = {...securityHeaders};
    res.writeHead(200, {
      ...headers,
      "Content-Type": types[ext] || "application/octet-stream",
    });
    res.end(req.method === "HEAD" ? undefined : await readFile(file));
  } catch {
    reply(res, 404, { error: "Build the client with npm run build first." });
  }
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
server.listen(port, "127.0.0.1", () => {
  console.log(
    `\nOrbit Desktop\nOpen: http://127.0.0.1:${port}\nOwner authentication: ${process.env.ORBIT_TOKEN?'configured token (not logged)':'generated token in the private runtime session-token file'}\n\nBound to loopback. Shells run as your current user.\n`,
  );
});
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    execution.close();
    contextSharing.close?.();
    native.close();
    for (const ws of wss.clients) ws.terminate();
    server.close(() => {workspaceService.close();process.exit(0);});
    setTimeout(() => process.exit(0), 2000).unref();
  });
