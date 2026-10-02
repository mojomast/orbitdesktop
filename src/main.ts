import "./style.css";
import "./windows.css";
import "./compact-windows.css";
import "./workspace-theme.css";
import { applyAppearance } from './workspace-appearance';
import { installViewport } from './viewport';
import { installOrbitMenu, type OrbitMenuItem, type OrbitMenuSection } from './orbit-menu';
import { workspaceExtensions } from './workspace-extensions';
import { installStart } from './taskbar';
import { showOrbitSettings, setOrbitSettingsNavigation } from './orbit-settings';
import { createWorkspaceCommands, type WorkspaceCommand } from './workspace-commands';
import { HOST_SURFACE_URLS, HOST_SURFACE_LABELS, type HostSurfaceId } from './host-surfaces';
import { TECHNOLOGY_SURFACES } from './technology-surfaces';
import { installCommandPalette } from './command-palette';
import { experimentalEnabled, subscribeExperimental } from './experimental';
import { showOnboarding, offerOnboarding } from './onboarding';
window.addEventListener('load', () => offerOnboarding(onboardingActions), { once: true });
import { installLayoutSwitcher } from './layout-switcher';
import './unified-taskbar.css';
import { xpraApps } from './xpra-apps';
import { installDesktopIcons } from './desktop-icons';
import { showConnectionPasswords } from './connection-passwords';
import { workspaceId, ensureWorkspaceSynced } from './workspace-sync';
import { pluginSelector, type PluginInstance } from './plugins';
import { readPanePrefs, writePanePrefs } from './pane-prefs';
import { workspaceFetch } from './workspace-client';
import { installMinimize } from './minimize';
import { el, button, select } from "./dom";
import {
  load,
  monitor,
  leaves,
  replace,
  remove,
  pane,
  validate,
  type Monitor,
  type Layout,
  type PaneKind,
} from "./model";
import { createPane, setToken, sessionToken, type PaneView } from "./panes";
import { moveConnected } from './connected-dom';
import { dockingRequested, installDockingRenderer, type DockingController } from './docking-renderer';
import { createDockingSync } from './docking-sync';
import type { DockingPlacement } from './docking-placement';
import { placeWindow, wireWindow } from "./windows";
import { connectWorkspace } from "./workspace-sync";
import { DesktopScene } from "./scene";
import { installSpatialControls } from './spatial-controls';
import { watchStyles } from './live-style';
watchStyles();
let state = load();
state.view ||= 'windows';
let applyingRemote = false;
let workspaceBridge: ReturnType<typeof connectWorkspace> | undefined;
const views = new Map<string, PaneView>();
const paneSignatures = new Map<string, string>();
const monitors = new Map<string, HTMLElement>();
const minimizer = installMinimize();
// Optional, off-by-default Dockview placement overlay. Stays null unless the local
// browser URL opts in with ?renderer=docking and the moveBefore capability exists.
// The v1 workspace stays authoritative; docking placement is a separate adjunct.
let docking: DockingController | null = null;
let dockingSync: ReturnType<typeof createDockingSync> | null = null;
// Placement notifications are also produced by passive/late Dockview layout work.
// Only an explicit gesture on library chrome may forward them to persistence;
// elapsed time since reconciliation is not evidence of a user edit.
let dockingPlacementGesture = 0;
let dockingPlacementAllowed = false;
let reconcilingDocking = false;
function cancelDockingPlacementGesture() {
  dockingPlacementGesture++;
  dockingPlacementAllowed = false;
}
let firstDockingSnapshot: { placement: DockingPlacement; revision: number } | null = null;
let focused: string | null = null;
window.addEventListener('orbit-focus-agent', event => {
  const paneId=(event as CustomEvent<string>).detail;
  const monitor=state.monitors.find(m=>leaves(m.layout).some(p=>p.id===paneId));
  if(monitor) {if(focused) unfocus(); choose(monitor.id);}
});
// Separate-window launchers. Both create genuine, independent agent panes (no
// new pane kind or schema); nothing is copied between them.
window.addEventListener('orbit-open-workbench-window', event => {
  const detail = (event as CustomEvent<{ paneId?: string }>).detail ?? {};
  openWorkbenchWindow(detail.paneId);
});
window.addEventListener('orbit-open-normal-window', event => {
  const detail = (event as CustomEvent<{ fromPaneId?: string }>).detail ?? {};
  openNormalWindow(detail.fromPaneId);
});
let saveTimer: ReturnType<typeof setTimeout>;
let layoutSwitcher: ReturnType<typeof installLayoutSwitcher> | undefined;
const app = document.querySelector<HTMLDivElement>("#app")!;
const top = el("header", "topbar");
const brand = el("div", "brand");
const logoButton = button("", "Open orbit menu", () => orbitMenu.toggle(), "orbit-logo");
logoButton.append(
  el("span", "brand-mark", "◉"),
  el("strong", "", "orbit"),
  el("span", "brand-tag", "SPATIAL DESKTOP"),
);
logoButton.setAttribute("aria-haspopup", "true");
logoButton.setAttribute("aria-controls", "orbit-menu");
brand.append(logoButton);
const hostStatus = button(
  "↗  Connect host",
  "Connect local host",
  () => connectHost(),
  "host-button",
);
const saved = el("span", "saved", "Saved locally");
const sidebarToggle = button('Hide panel', 'Toggle side panel', () => { state.sidebarHidden = !state.sidebarHidden; applySidebar(); save(); });
const themesButton = button('Themes', 'Choose workspace theme', async () => {
 const {showThemes}=await import('./theme-picker');
 showThemes(()=>sessionToken, (patch,resetKeys=[]) => {const appearance={...state.appearance};for(const key of resetKeys)delete appearance[key];state.appearance={...appearance,...patch};applyAppearance(state);save();},()=>state.appearance??{});
});
const orbitToolbar = el('div', 'orbit-toolbar');
const dockingToolbarHost = el('div', 'docking-toolbar-host');
top.append(brand, orbitToolbar, saved, dockingToolbarHost, hostStatus);
const shell = el("main", "shell"),
  work = el("section", "workspace"),
  stage = el("div", "stage");
stage.setAttribute("aria-label", "3D monitor workspace");
const sub = el("div", "workspace-heading");
const title = el("div");
title.append(
  el("span", "eyebrow", "WORKSPACE / 01"),
  el("h1", "", "Your command center"),
);
const sceneButton = button(
    "Spatial",
    "Switch to spatial view",
    () => setView('spatial'),
    "active",
  ),
  flatButton = button("Focus", "Focus selected display", () =>
    focus(state.selected),
  );
const windowsButton = button('Windows', 'Switch to movable windows', () => setView('windows'));
sub.append(title);
const guide = el(
  "div",
  "scene-guide",
  "Drag background to orbit · Shift drag to pan · Scroll to zoom · Navigate for WASD + Q/E",
);
const navigation = el("div", "scene-navigation");
const navDisplays = el("div", "display-tabs");
const cameraControls = el('div', 'taskbar-camera');
cameraControls.append(
  button("−", "Zoom out", () => scene.zoom(0.12)),
  button("⌖", "Reset camera", () => scene.reset()),
  button("+", "Zoom in", () => scene.zoom(-0.12)),
);
navigation.append(navDisplays, cameraControls);
navigation.append(button('▦ Desktop', 'Show desktop shortcuts', () => {
  if(focused)unfocus();setView('windows');
  state.monitors.forEach(m=>{const element=monitors.get(m.id);if(element)minimizer.hide(m.id,element);});renderTabs();
}));
const focusHost = el("div", "focus-host");
// Connected parking keeps surviving panes alive while their previous layout
// containers are removed (including source-first cross-window edits).
const paneParking = el('div', 'pane-parking');
paneParking.setAttribute('aria-hidden', 'true');
Object.assign(paneParking.style, { position: 'absolute', left: '-100000px', top: '0', width: '1px', height: '1px', overflow: 'hidden', pointerEvents: 'none' });
const desktopHost = el('div', 'desktop-host');
desktopHost.setAttribute('aria-label', 'Movable workspace windows');
const desktopIcons = installDesktopIcons(desktopHost, () => [
  ...xpraApps.map(a=>({id:`xpra-${a.id}`,title:a.title,icon:a.icon,run:()=>{
    if(focused)unfocus();
    const existing=state.monitors.find(m=>leaves(m.layout).some(p=>p.kind==='browser'&&p.url===a.url));
    if(existing){choose(existing.id);return;}
    const m=monitor(state.monitors.length+1,'browser');m.name=a.title;
    leaves(m.layout)[0].url=a.url;
    state.monitors.push(m);state.selected=m.id;state.view='windows';
    work.classList.add('windows-mode');renderAll();choose(m.id);
  }})),
  {id:'plugin-manager',title:'Plugin Manager',icon:'🧩',pinned:true,run:()=>{void commands.execute('hermes-plugins');}},
  {id:'connection-passwords',title:'Connection passwords',icon:'🔑',run:()=>{void commands.execute('connection-passwords');}},
  ...state.monitors.filter(m=>!leaves(m.layout).some(p=>xpraApps.some(a=>a.url===p.url))).map(m => ({id:m.id, title:m.name, icon:leaves(m.layout).some(p=>p.kind==='terminal')?'⌘':leaves(m.layout).some(p=>p.kind==='agent')?'✦':'▣', run:()=>{if(focused)unfocus();choose(m.id);}})),
  ...(state.plugins || []).filter(p=>!p.enabled).map(p=>({id:p.instance_id??p.manifest.id,title:p.window.name||p.manifest.title,icon:'◈',run:()=>{void launchDesktopPlugin(p);}})),
  {id:'new-terminal',title:'New terminal',icon:'>_',run:()=>{void commands.execute('new-terminal');}},
  {id:'new-agent',title:'New Hermes chat',icon:'✦',run:()=>{void commands.execute('new-agent');}},
  {id:'new-browser',title:'New browser',icon:'◎',run:()=>{void commands.execute('new-browser');}},
]);
const focusBack = button(
  "←  Back to spatial view",
  "Exit focus view",
  () => unfocus(),
  "focus-back",
);
focusHost.append(focusBack);
work.append(sub, stage, desktopHost, guide, navigation, focusHost, paneParking);
const inspector = el("aside", "inspector");
work.classList.toggle('windows-mode', state.view === 'windows');
shell.append(work, inspector);
const footer = el("footer", "footer");
footer.append(
  el("span", "", "ORBIT / LOCAL WORKSPACE"),
  el("span", "footer-status", "3D + DOM · v0.1 foundation"),
);
app.append(top, shell, footer);
const taskbarStatus = el('div', 'taskbar-status');
taskbarStatus.append(saved);
navigation.append(taskbarStatus);
footer.remove();
const globalTransparency = button('Transparency', 'Global transparency options', () => showGlobalTransparency(), 'global-transparency-button');
globalTransparency.dataset.icon = '◐';
const wallpaperMemoryKey = `orbit.wallpaper.previous.${localStorage.getItem('orbit.workspace.id') || 'local'}`;
let previousWallpaper: string | undefined;
try { previousWallpaper = JSON.parse(localStorage.getItem(wallpaperMemoryKey) || '{}').wallpaper; } catch {}
const wallpaperToggle = button('Wallpaper: on', 'Toggle background wallpaper', () => {
  const appearance = {...state.appearance};
  if (appearance.wallpaper === '') {
    if (previousWallpaper && /^\/[a-zA-Z0-9/_-]+\.(svg|png|jpg|jpeg|webp)$/.test(previousWallpaper) && !previousWallpaper.startsWith('//')) appearance.wallpaper = previousWallpaper;
    else delete appearance.wallpaper;
  } else {
    previousWallpaper = appearance.wallpaper;
    try { localStorage.setItem(wallpaperMemoryKey, JSON.stringify({wallpaper: previousWallpaper})); } catch {}
    appearance.wallpaper = '';
  }
  state.appearance = appearance;
  applyAppearance(state); save();
}, 'wallpaper-toggle-button');
window.addEventListener('orbit-wallpaper-state', event => {
  const disabled = (event as CustomEvent<boolean>).detail;
  wallpaperToggle.textContent = disabled ? 'Wallpaper: off' : 'Wallpaper: on';
  wallpaperToggle.setAttribute('aria-pressed', String(!disabled));
});
function showGlobalTransparency() {
  const before = new Map(state.monitors.map(m => [m.id, m.opacity ?? 1]));
  const dialog = document.createElement('dialog');
  dialog.className = 'hermes-tools-dialog';
  dialog.setAttribute('aria-label', 'Global transparency');
  const values = [...before.values()];
  const mixed = new Set(values).size > 1;
  const status = el('p', '', mixed ? 'Windows currently have different opacity settings.' : `Current opacity: ${Math.round((values[0] ?? 1) * 100)}%`);
  status.role = 'status';
  const apply = (value?: number) => {
    for (const m of state.monitors) {
      const opacity = value === undefined ? before.get(m.id) : value / 100;
      if (opacity === undefined) continue;
      m.opacity = opacity;
      const outer = monitors.get(m.id);
      if (outer) {
        outer.style.opacity = String(opacity);
        outer.querySelector('[aria-label^="Toggle transparency"]')?.setAttribute('aria-pressed', String(opacity < 1));
      }
    }
    renderInspector(); save();
    status.textContent = value === undefined ? 'Restored the individual settings from when this dialog opened.' : `All current windows: ${value}% opacity`;
  };
  const slider = range('All windows opacity', Math.round((values[0] ?? 1) * 100), 20, 100, 1, '%', apply);
  dialog.append(el('h2', '', 'Global transparency'),
    el('p', '', 'Adjust all current windows together, including minimized windows. Text and app content fade too. New windows keep their default opacity; individual controls remain available.'),
    status, slider,
    button('Fully opaque', 'Make all windows fully opaque', () => {
      const input = slider.querySelector('input')!;
      input.value = '100'; input.dispatchEvent(new Event('input'));
    }),
    button('Undo changes', 'Restore previous individual opacity settings', () => { apply(); dialog.close(); }),
    button('Done', 'Close global transparency', () => dialog.close()));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog); dialog.showModal();
}
applyAppearance(state);
const viewportToggle = installViewport(app, state.appearance?.fullViewport, value => { state.appearance = {...state.appearance, fullViewport:value}; save(); }).button;
// Hermes runtime tools surfaced from the orbit menu instead of the chat pane only.
const menuSession = `orbit-${workspaceId}`;
function menuAgentApi(payload: Record<string, unknown>): Promise<any> {
  if (!sessionToken) return Promise.reject(Error('Connect host first: use the host button in the top bar.'));
  return fetch('/api/agent', {
    method: 'POST',
    headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, session_id: menuSession, workspace_id: workspaceId }),
  }).then(async response => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(data.error || 'Hermes request failed');
    return data;
  });
}
const hermesIcons: Record<string, string> = { 'shared-browser': '🖥', 'build-queue': '🛠', jev: '⚡', plugins: '🧩', checkpoints: '⛁', catalog: '✦', outputs: '🗂', jobs: '⏱' };
setOrbitSettingsNavigation({
    appearance: [
      { title: 'Themes', detail: 'Workspace colors and appearance', run: () => commands.execute('themes') },
      { title: 'Global transparency', detail: 'Opacity across current windows', run: () => commands.execute('transparency') },
      { title: 'Toggle wallpaper', detail: 'Show or hide the desktop wallpaper', run: () => commands.execute('wallpaper') },
      { title: 'Toggle full viewport', detail: 'Use all available browser space', run: () => commands.execute('viewport') },
    ],
    layout: [
      { title: 'Arrange workspace', detail: 'Arrange existing windows', run: () => commands.execute('arrange') },
      { title: 'Saved workspace layouts', detail: 'Save and preview reusable window arrangements', run: () => commands.execute('saved-layouts') },
      { title: 'Selected window settings', detail: 'Name, text size and opacity', run: () => commands.execute('window-settings') },
      { title: 'Display and layout controls', detail: 'Shape, scale, position and layout presets', run: () => commands.execute('display-controls') },
    ],
});
function openSettings() { showOrbitSettings(); }
async function openWorkspaceArrange() {
  const { showWorkspaceArrange } = await import('./workspace-arrange');
  showWorkspaceArrange(() => sessionToken, measureArrangementViewport);
}
async function openSavedWorkspaceLayouts() {
  const { showSavedWorkspaceLayouts } = await import('./saved-workspace-layouts');
  showSavedWorkspaceLayouts(() => sessionToken, measureArrangementViewport);
}
function measureArrangementViewport() {
  const root = docking ? desktopHost.querySelector<HTMLElement>('.docking-root') : null;
  const target = root ?? desktopHost;
  if (target.clientWidth && target.clientHeight) return { width: target.clientWidth, height: target.clientHeight };
  // A shallow, invisible measurement host resolves the same CSS insets against
  // the actual workspace. No live pane moves, view/focus changes or saves occur.
  const measurement = desktopHost.cloneNode(false) as HTMLElement;
  measurement.removeAttribute('id');
  measurement.removeAttribute('hidden');
  measurement.setAttribute('aria-hidden', 'true');
  measurement.style.setProperty('display', 'block', 'important');
  measurement.style.setProperty('visibility', 'hidden', 'important');
  measurement.style.setProperty('pointer-events', 'none', 'important');
  const measured = root ? root.cloneNode(false) as HTMLElement : measurement;
  if (measured !== measurement) {
    measured.removeAttribute('id'); measured.removeAttribute('hidden');
    measured.style.setProperty('display', 'block', 'important');
    measurement.append(measured);
  }
  work.append(measurement);
  try { return { width: measured.clientWidth, height: measured.clientHeight }; }
  finally { measurement.remove(); }
}
let technologyConfiguration={browser_copilot:false,mcp_apps:false};
async function refreshTechnologyConfiguration(){
  if(!sessionToken){technologyConfiguration={browser_copilot:false,mcp_apps:false};return;}
  try{
    const response=await fetch('/api/technology-capabilities',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${sessionToken}`},body:JSON.stringify({action:'capabilities'})});
    if(!response.ok)return;
    const result=await response.json();
    technologyConfiguration={browser_copilot:result.browser_copilot===true,mcp_apps:result.mcp_apps===true};
  }catch{/* Optional configuration remains unavailable until a successful owner read. */}
}
window.addEventListener('orbit-host-connected',()=>{void refreshTechnologyConfiguration();});
if(sessionToken)void refreshTechnologyConfiguration();
function revealSurface(id: string) {
  const inFocus = !!focused;
  if (focused) unfocus();
  state.selected = id;
  renderAll();
  if (inFocus) focus(id);
  else { choose(id); if (state.view === 'spatial') scene.frameWindow(id); }
  save();
}
function openHostSurface(id: HostSurfaceId) {
  const url = HOST_SURFACE_URLS[id];
  let target = state.monitors.find(m => leaves(m.layout).some(p => p.kind === 'browser' && p.url === url));
  if (!target) {
    if (state.monitors.length >= 100) { notify('Close a window before opening another surface.'); return; }
    target = monitor(state.monitors.length + 1, 'browser');
    target.name = HOST_SURFACE_LABELS[id];
    leaves(target.layout)[0].url = url;
    state.monitors.push(target);
  }
  revealSurface(target.id);
}
window.addEventListener('orbit-open-host-surface', event => {
  const id = (event as CustomEvent<{ id?: string }>).detail?.id;
  if (typeof id==='string' && Object.hasOwn(HOST_SURFACE_URLS,id)) openHostSurface(id as HostSurfaceId);
});
window.addEventListener('orbit-review-document-result',event=>{
  const detail=(event as CustomEvent).detail;
  if(!detail||typeof detail.title!=='string'||typeof detail.respond!=='function'||detail.workspaceId!==workspaceId)return;
  event.preventDefault();
  void import('./document-library').then(module=>detail.workspaceId===workspaceId?module.reviewCreateDocument(()=>sessionToken,detail.title,detail.data):{status:'rejected' as const,reason:'Workspace changed before document review.'}).then(detail.respond).catch(()=>detail.respond({status:'rejected',reason:'Document result could not be reviewed.'}));
});
window.addEventListener('orbit-open-document',event=>{
  const detail=(event as CustomEvent<{id?:unknown;name?:unknown;paneId?:unknown}>).detail;
  if(typeof detail?.id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(detail.id))return;
  const url=`orbit://document/${detail.id}`;
  const recoveryPane=typeof detail.paneId==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(detail.paneId)?detail.paneId:undefined;
  if(recoveryPane&&state.monitors.some(m=>leaves(m.layout).some(p=>p.id===recoveryPane&&(p.kind!=='browser'||p.url!==url)))){notify('Original pane identity is now used by another surface. Draft remains in the library.');return;}
  let target=state.monitors.find(m=>leaves(m.layout).some(p=>p.kind==='browser'&&p.url===url&&(!recoveryPane||p.id===recoveryPane)));
  if(!target){
    if(state.monitors.length>=100){notify('Close a window before opening another document.');return;}
    target=monitor(state.monitors.length+1,'browser');
    target.name=typeof detail.name==='string'&&detail.name.trim()?detail.name.trim().slice(0,60):'Document';
    leaves(target.layout)[0].url=url;
    if(recoveryPane)leaves(target.layout)[0].id=recoveryPane;
    state.monitors.push(target);
  }
  revealSurface(target.id);
});
// Keep an explicit parent-document selection while menu/palette focus changes.
// Generated frames and terminal buffers are never queried. The transfer dialog
// shows the exact captured text and requires a recipient and insertion click.
let selectedWorkspaceText = '';
document.addEventListener('selectionchange', () => {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed) return;
  const element = (node: Node | null) => node instanceof Element ? node : node?.parentElement;
  if ([selection.anchorNode, selection.focusNode].some(node => element(node)?.closest('dialog, input, textarea, [contenteditable], .xterm'))) return;
  const text = selection.toString();
  if (text.trim()) selectedWorkspaceText = text.length <= 20000 ? text : '';
});
window.addEventListener('pagehide', () => { selectedWorkspaceText = ''; });
async function sendSelectedContext() {
  const text = selectedWorkspaceText;
  if (!text) throw Error('Select up to 20,000 characters of workspace text first.');
  const { requestConversationContext } = await import('./conversation-transfer');
  await requestConversationContext({ text, title: 'Selected workspace text' });
}
const onboardingActions = {connected:()=>!!sessionToken,run:(id:string)=>{void commands.execute(id);}};
const commands = createWorkspaceCommands((): WorkspaceCommand[] => [
  ...Object.entries(TECHNOLOGY_SURFACES).map(([id,entry])=>({id:`technology-${id}`,title:entry.title,detail:entry.detail,group:'Tools',hidden:id==='copilot'&&!technologyConfiguration.browser_copilot||id==='mcp-apps'&&!technologyConfiguration.mcp_apps,disabledReason:entry.auth&&!sessionToken?'Connect host first to use this tool.':undefined,run:()=>openHostSurface(id as HostSurfaceId)})),
  { id: 'getting-started', title: 'Getting started', detail: 'Choose a task, check readiness or tour Orbit', group: 'Help', run: () => showOnboarding(onboardingActions) },
  { id: 'settings', title: 'Orbit settings', detail: 'Appearance, layout and browser-local experiments', group: 'Settings', run: openSettings },
  { id: 'connect-host', title: 'Connect host', detail: 'Unlock this browser session with a host token', group: 'Settings', run: connectHost },
  { id: 'connection-passwords', title: 'Connection passwords', detail: 'View host connection details', group: 'Settings', disabledReason: !sessionToken ? 'Connect host first to view connection details.' : undefined, run: () => showConnectionPasswords(() => sessionToken) },
  { id: 'export-layout', title: 'Export workspace layout', detail: 'Download the current workspace layout', group: 'Layout', run: exportLayout },
  { id: 'import-layout', title: 'Import workspace layout', detail: 'Choose a layout file and review replacement confirmation', group: 'Layout', run: () => importInput.click() },
  { id: 'saved-layouts', title: 'Saved workspace layouts', detail: 'Save and preview reusable window arrangements', group: 'Layout', disabledReason: !sessionToken ? 'Connect host first to use saved workspace layouts.' : undefined, run: openSavedWorkspaceLayouts },
  { id: 'browser-layouts', title: 'Browser layout snapshots', detail: 'Browser-local snapshots — active snapshot auto-updates here', group: 'Layout', run: () => navigation.querySelector<HTMLButtonElement>('[aria-label="Choose browser snapshot"]')?.click() },
  ...state.monitors.map(m => ({ id: `window:${m.id}`, title: m.name, detail: 'Open or restore window', group: 'Windows', run: () => { if (focused) focus(m.id); else choose(m.id); } })),
  { id: 'new-agent', title: 'New agent chat', detail: 'Talk to Hermes', group: 'Create', run: () => addMonitor('agent') },
  { id: 'new-workbench', title: 'New Workbench window', detail: 'Separate Workbench beside Hermes', group: 'Create', hidden: !experimentalEnabled('workbench'), run: () => openWorkbenchWindow() },
  { id: 'new-terminal', title: 'New terminal', detail: 'Open a host terminal pane', group: 'Create', run: () => addMonitor('terminal') },
  { id: 'new-browser', title: 'New browser', detail: 'Open an app or website', group: 'Create', run: () => addMonitor('browser') },
  { id: 'windows', title: 'Windows view', detail: 'Movable desktop windows', group: 'Layout', run: () => windowsButton.click() },
  { id: 'spatial', title: 'Spatial view', detail: 'Explore your 3D workspace', group: 'Layout', run: () => sceneButton.click() },
  { id: 'focus', title: 'Focus selected window', detail: 'Expand the selected display', group: 'Layout', run: () => flatButton.click() },
  { id: 'arrange', title: 'Arrange workspace', detail: 'Arrange existing windows', group: 'Layout', disabledReason: !sessionToken ? 'Connect host first to arrange workspace.' : undefined, run: openWorkspaceArrange },
  { id: 'panel', title: 'Toggle side panel', detail: 'Workspace layout and settings', group: 'Layout', run: () => sidebarToggle.click() },
  { id: 'display-controls', title: 'Display and layout controls', detail: 'Shape, scale, position and layout presets', group: 'Settings', run: () => { state.sidebarHidden = false; applySidebar(); save(); inspector.querySelector<HTMLElement>('input, button, select')?.focus(); } },
  { id: 'themes', title: 'Themes', detail: 'Choose workspace theme', group: 'Appearance', run: () => themesButton.click() },
  { id: 'viewport', title: 'Toggle full viewport', detail: 'Use all available browser space', group: 'Appearance', run: () => viewportToggle.click() },
  { id: 'wallpaper', title: 'Toggle wallpaper', detail: 'Show or hide wallpaper', group: 'Appearance', run: () => wallpaperToggle.click() },
  { id: 'transparency', title: 'Global transparency', detail: 'Adjust current windows opacity', group: 'Appearance', run: showGlobalTransparency },
  { id: 'window-settings', title: 'Selected window settings', detail: 'Name, text size and opacity', group: 'Windows', run: () => openWindowOptions(state.selected) },
  { id: 'hermes-tools', title: 'Tools & conversations', detail: 'Tools for selected Hermes chat', group: 'Hermes', run: openHermesTools },
  { id: 'conversation-library', title: 'Conversation library', detail: 'Find, pin and resume Hermes conversations', group: 'Hermes', disabledReason: !sessionToken ? 'Connect host first to browse conversations.' : undefined, run: openConversationLibrary },
  { id: 'send-selection', title: 'Send selected text to conversation', detail: 'Review recently selected workspace text and choose a draft; never sends automatically', group: 'Hermes', disabledReason: !selectedWorkspaceText ? 'Select up to 20,000 characters of workspace text first.' : undefined, run: sendSelectedContext },
  { id: 'activity', title: 'Live activity', detail: 'Open host activity window', group: 'Hermes', run: () => openHostSurface('activity') },
  ...workspaceExtensions.map(extension => ({
    id: `hermes-${extension.id}`, title: extension.title, detail: extension.label, group: 'Hermes',
    hidden: extension.id === 'project-workbench' && !experimentalEnabled('workbench'),
    disabledReason: !sessionToken && extension.id !== 'outputs' ? 'Connect host first to use this tool.' : undefined,
    run: () => extension.id === 'outputs' ? openHostSurface('outputs') : extension.activate({ token: () => sessionToken, api: menuAgentApi }),
  })),
], notify);
installStart(navigation, commands);
const commandPalette = installCommandPalette(commands);
const hermesMenuItems: OrbitMenuItem[] = workspaceExtensions.map(extension => ({
  id: `hermes-${extension.id}`,
  label: extension.title,
  icon: hermesIcons[extension.id] || '✦',
  button: button(extension.title, extension.title, () => { void commands.execute(`hermes-${extension.id}`); }),
}));
// Experimental Project Workbench surfaces stay hidden until the owner enables
// them in Orbit settings. The settings entry point itself is always available.
const workbenchWindowMenuButton = button('New Workbench window', 'New Workbench window', () => { void commands.execute('new-workbench'); });
const orbitSettingsMenuButton = button('Orbit settings', 'Orbit settings', () => { void commands.execute('settings'); });
const projectWorkbenchMenuButton = hermesMenuItems.find(item => item.id === 'hermes-project-workbench')?.button;
function syncExperimentalMenuItems() {
  const on = experimentalEnabled('workbench');
  for (const node of [workbenchWindowMenuButton, projectWorkbenchMenuButton]) {
    if (!node) continue;
    node.hidden = !on;
    node.closest<HTMLElement>('.orbit-menu-item-slot')?.toggleAttribute('hidden', !on);
  }
}
function openHermesTools() {
  const target = state.monitors.find(m => m.id === (focused ?? state.selected));
  const agent = target ? leaves(target.layout).find(p => p.kind === 'agent') : undefined;
  if (!target || !agent) { notify('Open a Hermes chat window to see its tools and conversations.'); addMonitor('agent'); return; }
  if (focused !== target.id) focus(target.id);
  window.dispatchEvent(new CustomEvent('orbit-open-hermes-tools', { detail: { paneId: agent.id } }));
}
async function openConversationLibrary() {
  let target = state.monitors.find(m => m.id === (focused ?? state.selected) && leaves(m.layout).some(p => p.kind === 'agent'))
    ?? state.monitors.find(m => leaves(m.layout).some(p => p.kind === 'agent'));
  if (!target) {
    addMonitor('agent');
    target = state.monitors.find(m => m.id === state.selected);
  }
  const pane = target && leaves(target.layout).find(p => p.kind === 'agent');
  if (!target || !pane) throw Error('Conversation pane unavailable.');
  await ensureWorkspaceSynced();
  if (!paneExists(pane.id)) throw Error('Conversation pane closed before the library opened.');
  window.dispatchEvent(new CustomEvent('orbit-open-conversation-library', { detail: { paneId: pane.id } }));
}
let openingConversation = false;
window.addEventListener('orbit-open-conversation', event => {
  const detail = (event as CustomEvent<import('./conversation-selection').ConversationSelection>).detail;
  if (!detail || typeof detail.profileId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(detail.profileId) ||
      typeof detail.sessionId !== 'string' || !/^[A-Za-z0-9_:-]{1,128}$/.test(detail.sessionId)) return;
  const {profileId, sessionId} = detail;
  if(detail.signal?.aborted)return;
  const fail=(message:string)=>{notify(message);detail.report?.('failed',message);};
  if (openingConversation) { fail('A conversation window is already opening.'); return; }
  if (!sessionToken) { fail('Connect host first to open a saved conversation.'); return; }
  if (state.monitors.length >= 100) { fail('Close a window before opening another conversation.'); return; }
  openingConversation = true;
  void (async () => {
    if (focused) unfocus();
    addMonitor('agent');
    const target = state.monitors.find(m => m.id === state.selected);
    const pane = target && leaves(target.layout).find(p => p.kind === 'agent');
    if (!pane) throw Error('New conversation pane unavailable.');
    await ensureWorkspaceSynced();
    if(detail.signal?.aborted)return;
    if (!paneExists(pane.id)) throw Error('Conversation pane closed before it could link.');
    window.dispatchEvent(new CustomEvent('orbit-select-conversation', {
      detail: {...detail, paneId: pane.id, profileId, sessionId},
    }));
  })().catch(error => fail(`Conversation window could not open: ${String(error)}`))
    .finally(() => { openingConversation = false; });
});
function orbitMenuSections(): OrbitMenuSection[] {
  return [
    { id: 'view', title: 'Workspace view', detail: 'Choose how your windows are arranged.', items: [
      { id: 'windows', label: 'Windows', icon: '▤', button: windowsButton },
      { id: 'spatial', label: 'Spatial', icon: '◈', button: sceneButton },
      { id: 'focus', label: 'Focus', icon: '▣', button: flatButton },
      { id: 'arrange', label: 'Arrange workspace', icon: '▦', button: button('Arrange workspace', 'Arrange workspace', () => { void commands.execute('arrange'); }) },
      { id: 'saved-layouts', label: 'Saved workspace layouts', icon: '▦', button: button('Saved workspace layouts', 'Saved workspace layouts', () => { void commands.execute('saved-layouts'); }) },
    ] },
    { id: 'appearance', title: 'Panels & appearance', detail: 'Panel, themes, full viewport, wallpaper and transparency.', items: [
      { id: 'themes', label: 'Themes', icon: '✦', button: themesButton },
      { id: 'panel', label: 'Panel', icon: '▥', button: sidebarToggle },
      { id: 'viewport', label: 'Full viewport', icon: '⛶', button: viewportToggle },
      { id: 'wallpaper', label: 'Wallpaper', icon: '▧', button: wallpaperToggle },
      { id: 'transparency', label: 'Transparency', icon: '◐', button: globalTransparency },
    ] },
    { id: 'hermes', title: 'Hermes', detail: 'Hermes runtime tools and conversations, reachable without opening a chat pane.', items: [
      { id: 'hermes-chat', label: 'New Hermes chat', icon: '✧', button: button('New Hermes chat', 'New Hermes chat', () => { void commands.execute('new-agent'); }) },
      { id: 'hermes-workbench-window', label: 'New Workbench window', icon: '◧', button: workbenchWindowMenuButton },
      { id: 'hermes-tools', label: 'Tools & conversations', icon: '⋯', button: button('Tools & conversations', 'Tools & conversations', () => { void commands.execute('hermes-tools'); }) },
      { id: 'conversation-library', label: 'Conversation library', icon: '☷', button: button('Conversation library', 'Conversation library', () => { void commands.execute('conversation-library'); }) },
      { id: 'send-selection', label: 'Send selected text to conversation', icon: '↗', button: button('Send selected text to conversation', 'Send selected text to conversation', () => { void commands.execute('send-selection'); }) },
      { id: 'activity', label: 'Live activity', icon: '↻', button: button('Live activity', 'Live activity', () => { void commands.execute('activity'); }) },
      ...hermesMenuItems,
    ] },
    { id: 'settings', title: 'Settings', detail: 'Preferences saved in this browser.', items: [
      { id: 'commands', label: 'Commands', icon: '⌘', button: button('Commands', 'Open workspace commands (Ctrl or Cmd K)', commandPalette.open) },
      { id: 'settings-orbit', label: 'Orbit settings', icon: '⚙', button: orbitSettingsMenuButton },
    ] },
  ];
}
const orbitMenu = installOrbitMenu({ toolbar: orbitToolbar, drawerHost: app, logo: logoButton, sections: orbitMenuSections });
// Place menu items first, then apply and subscribe the experimental gates.
syncExperimentalMenuItems();
subscribeExperimental(syncExperimentalMenuItems);
const scene = new DesktopScene(stage);
scene.configureCamera(state.spatialCamera, pose => { state.spatialCamera = pose; save(); });
installSpatialControls(stage, scene, () => state, () => { updateScene(); renderInspector(); save(); });
if (stage.classList.contains("no-webgl"))
  footer.querySelector(".footer-status")!.textContent =
    "CSS3D mode · WebGL unavailable";
const toast = el("div", "toast");
toast.role = "status";
app.append(toast);
let toastTimer: ReturnType<typeof setTimeout>;
function notify(s: string) {
  toast.textContent = s;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3500);
}
function save() {
  if (!applyingRemote) workspaceBridge?.changed();
  clearTimeout(saveTimer);
  saved.textContent = "Saving…";
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem("orbit.workspace.v1", JSON.stringify(state));
      layoutSwitcher?.remember();
      saved.textContent = "Saved locally";
    } catch {
      saved.textContent = "Storage unavailable";
    }
  }, 200);
}
function current(): Monitor {
  return state.monitors.find((m) => m.id === state.selected)!;
}
function choose(id: string) {
  minimizer.restore(id, monitors.get(id));
  state.selected = id;
  const chosen = state.monitors.find(m => m.id === id);
  if (chosen?.frame && state.view === 'windows') chosen.frame.z = Math.min(99999, Math.max(...state.monitors.map(m => m.frame?.z || 0)) + 1);
  renderInspector();
  updateScene();
  renderTabs();
  save();
}
function updateScene() {
  if (state.monitors.some((m) => !monitors.has(m.id))) return;
  scene.retainWindows(state.monitors);
  if (docking) {
    reconcilingDocking = true;
    try { docking.retainWindows(state.monitors, state.selected); }
    finally { reconcilingDocking = false; }
  }
  for (const m of state.monitors) {
    const meta = monitors.get(m.id)?.querySelector(".monitor-meta");
    if (meta) meta.textContent = `${m.diagonal}″ / ${m.aspect}`;
  }
  if (state.view === 'windows') {
    // Docking placement is an opt-in overlay: it reuses the same live monitor
    // elements and PaneViews and only changes where they are positioned. A
    // layout-only change must not dispose or reload any pane runtime.
    state.monitors.forEach((m, i) => {
      const element = monitors.get(m.id)!;
      element.classList.toggle('selected', m.id === state.selected);
      if (focused !== m.id) {
        if (docking) {
          if (element.parentElement !== docking.surfaces) moveConnected(element, docking.surfaces);
          element.classList.add('desktop-window');
        } else {
          if (element.parentElement !== desktopHost) moveConnected(element, desktopHost);
          element.classList.add('desktop-window');
          placeWindow(element, m, desktopHost, i);
        }
      }
    });
    if (docking) docking.placeWindows(monitors, state.monitors, state.selected, focused);
  } else {
    // An inactive docking tab may have hidden its application-owned surface.
    // Spatial placement shows every non-minimized monitor, not just active tabs.
    if (docking) monitors.forEach(element => element.style.removeProperty('visibility'));
    scene.update(state.monitors, monitors, state.selected, state.arc);
  }
  views.forEach((v) => v.resize());
}
function renderTabs() {
  desktopIcons();
  minimizer.render(state.monitors, id => { if (focused) unfocus(); choose(id); monitors.get(id)?.querySelector<HTMLButtonElement>('.window-minimize')?.focus(); });
  navDisplays.replaceChildren();
  state.monitors.forEach((m, i) => {
    const b = button(
      `${minimizer.ids().includes(m.id) ? '↗' : String(i + 1).padStart(2, "0")}  ${m.name}`,
      `${minimizer.ids().includes(m.id) ? 'Restore' : 'Select'} ${m.name}`,
      () => {
        if (focused) focus(m.id);
        else choose(m.id);
      },
      m.id === state.selected ? "selected" : "",
    );
    b.classList.toggle('minimized', minimizer.ids().includes(m.id));
    navDisplays.append(b);
  });
}
function focus(id: string) {
  if (focused) unfocus();
  choose(id);
  focused = id;
  const element = monitors.get(id)!;
  element.classList.remove('desktop-window');
  for (const key of ['left', 'top', 'width', 'height', 'z-index']) element.style.removeProperty(key);
  moveConnected(element, focusHost);
  focusHost.classList.add("visible");
  work.classList.add("is-focused");
  sceneButton.classList.remove("active");
  flatButton.classList.add("active");
  element.classList.add("flat-monitor");
  element.style.transform = "none";
  views.forEach((v) => v.resize());
}
function unfocus() {
  if (!focused) return;
  const element = monitors.get(focused);
  element?.classList.remove("flat-monitor");
  if (element) {
    if (state.view === 'windows') moveConnected(element, desktopHost);
    else { const anchor = stage.querySelector<HTMLElement>(`[data-anchor-id="${focused}"]`); if (anchor) moveConnected(element, anchor); }
  }
  focused = null;
  focusHost.classList.remove("visible");
  work.classList.remove("is-focused");
  sceneButton.classList.add("active");
  flatButton.classList.remove("active");
  updateScene();
}
function applySidebar() {
  shell.classList.toggle('sidebar-hidden', !!state.sidebarHidden);
  sidebarToggle.textContent = state.sidebarHidden ? 'Show panel' : 'Hide panel';
  sidebarToggle.setAttribute('aria-expanded', String(!state.sidebarHidden));
  requestAnimationFrame(() => { scene.resize(); updateScene(); });
}
function setView(view: 'windows' | 'spatial') {
  scene.setNavigation(false);
  unfocus(); state.view = view;
  work.classList.toggle('windows-mode', view === 'windows');
  windowsButton.classList.toggle('active', view === 'windows');
  sceneButton.classList.toggle('active', view === 'spatial');
  if (view === 'spatial') {
    monitors.forEach((element, id) => {
      element.classList.remove('desktop-window');
      for (const key of ['left', 'top', 'width', 'height', 'z-index']) element.style.removeProperty(key);
      const anchor = stage.querySelector<HTMLElement>(`[data-anchor-id="${id}"]`);
      if (anchor) moveConnected(element, anchor);
    });
    scene.update(state.monitors, monitors, state.selected, state.arc);
  }
  state.monitors.forEach(m => leaves(m.layout).forEach(p => views.get(p.id)?.setFont(textSize(m))));
  renderInspector();
  updateScene(); save();
}
function confirmChange(text: string, action: () => void) {
  const d = el("dialog", "dialog");
  d.append(el("h2", "", "Change workspace?"), el("p", "", text));
  const row = el("div", "dialog-actions");
  row.append(
    button("Cancel", "Cancel change", () => d.close()),
    button(
      "Continue",
      "Confirm change",
      () => {
        d.close();
        action();
      },
      "primary",
    ),
  );
  d.append(row);
  d.onclose = () => d.remove();
  app.append(d);
  d.showModal();
}
function moveTerminal(id: string, popout: boolean) {
  const source = state.monitors.find(m => leaves(m.layout).some(p => p.id === id));
  if (!source) return;
  const eligible = (m: Monitor) => !state.plugins?.some(p => p.window?.id === m.id);
  if (!eligible(source)) { notify('Move terminals from ordinary windows, not managed app windows.'); return; }
  const commit = (target?: Monitor, axis: 'row' | 'column' = 'row') => {
    const p = leaves(source.layout).find(p => p.id === id);
    if (!p || !state.monitors.includes(source)) return;
    if (target && (!state.monitors.includes(target) || leaves(target.layout).length >= 8)) { notify('Destination unavailable or full'); return; }
    if (!target && leaves(source.layout).length === 1) { choose(source.id); notify('This terminal already has its own window'); return; }
    unfocus();
    const destination = target ?? monitor(state.monitors.length + 1, 'terminal');
    if (!target) {
      destination.name = `${source.name} · Terminal`;
      destination.fontSize = source.fontSize;
      destination.layout = { type: 'pane', pane: p };
      state.monitors.push(destination);
    } else destination.layout = { type: 'split', axis, ratio: 0.5, first: destination.layout, second: { type: 'pane', pane: p } };
    const remaining = remove(source.layout, id);
    if (remaining) source.layout = remaining;
    else {
      state.monitors = state.monitors.filter(m => m !== source);
      // renderAll relocates the retained pane before removing its old monitor.
    }
    state.selected = destination.id;
    // Reuse the PaneView, xterm instance and WebSocket: no shell reconnect.
    renderAll();
    choose(destination.id);
  };
  if (popout) { commit(); return; }
  const targets = state.monitors.filter(m => m !== source && eligible(m) && leaves(m.layout).length < 8);
  if (!targets.length) { notify('No other window with room for a terminal'); return; }
  const d = el('dialog', 'dialog');
  d.setAttribute('aria-label', 'Attach terminal');
  const target = select(targets.map(m => [m.id, m.name]), targets[0].id, () => {});
  target.setAttribute('aria-label', 'Destination window');
  const placement = select([['row', 'Beside existing panes'], ['column', 'Below existing panes']], 'row', () => {});
  placement.setAttribute('aria-label', 'Terminal placement');
  d.append(el('h2', '', 'Attach terminal'), target, placement,
    button('Cancel', 'Cancel attach', () => d.close()),
    button('Attach', 'Attach terminal to selected window', () => {
      const destination = state.monitors.find(m => m.id === target.value);
      if (!destination) { d.close(); return; }
      commit(destination, placement.value as 'row' | 'column'); d.close();
    }));
  d.addEventListener('keydown', e => e.stopPropagation());
  d.onclose = () => d.remove();
  app.append(d); d.showModal();
}
function paneSignature(p: { kind: PaneKind; url?: string }) {
  return `${p.kind}\u0000${p.kind === 'browser' ? p.url ?? '' : ''}`;
}
function livePaneMonitor(id: string): Monitor | undefined {
  return state.monitors.find(m => leaves(m.layout).some(p => p.id === id));
}
function paneView(p: ReturnType<typeof leaves>[number], m: Monitor): PaneView {
  const signature = paneSignature(p);
  let v = views.get(p.id);
  if (v && paneSignatures.get(p.id) !== signature) {
    v.dispose(); views.delete(p.id); paneSignatures.delete(p.id); v = undefined;
  }
  if (!v) {
      v = createPane(p, textSize(m), {
        move: moveTerminal,
        kind: (id, kind) => {
          confirmChange(
            "Switching this pane replaces its current view and unsaved content. Persistent terminal shells may continue detached.",
            async () => {
              if(!await (await import('./document-drafts')).requestDocumentClose([id]))return;
              const m = livePaneMonitor(id);
              if (!m) return;
              views.get(id)?.dispose();
              views.delete(id);
              paneSignatures.delete(id);
              m.layout = replace(m.layout, id, (p) => ({
                type: "pane",
                pane: { ...p, kind },
              }));
              renderMonitor(m);
              save();
            },
          );
        },
        split: (id, axis) => {
          const m = livePaneMonitor(id);
          if (!m) return;
          if (leaves(m.layout).length >= 8) {
            notify("Maximum 8 panes per display");
            return;
          }
          m.layout = replace(m.layout, id, (p) => ({
            type: "split",
            axis,
            ratio: 0.5,
            first: { type: "pane", pane: p },
            second: pane("terminal"),
          }));
          renderMonitor(m);
          save();
        },
        close: (id) => {
          const m = livePaneMonitor(id);
          if (!m) return;
          if (leaves(m.layout).length === 1) {
            notify("Keep at least one pane on each display");
            return;
          }
          confirmChange(
            "Closing this pane discards its unsaved view content and disconnects it. Persistent terminal shells may continue detached.",
            () => {
              const m = livePaneMonitor(id);
              if (!m) return;
              if (leaves(m.layout).length <= 1) {
                notify('Pane placement changed; keep at least one pane on each display.');
                return;
              }
              m.layout = remove(m.layout, id)!;
              views.get(id)?.dispose();
              views.delete(id);
              paneSignatures.delete(id);
              renderMonitor(m);
              save();
            },
          );
        },
        url: (id, url) => {
          const m = livePaneMonitor(id);
          if (!m) return;
          const p = leaves(m.layout).find((p) => p.id === id);
          if (p) {
            p.url = url;
            paneSignatures.set(id, paneSignature(p));
            save();
          }
        },
      });
      views.set(p.id, v);
      paneSignatures.set(p.id, paneSignature(p));
  }
  return v;
}
function renderLayout(layout: Layout): HTMLElement {
  if (layout.type === "pane") {
    const slot = el('div', 'pane-slot');
    slot.dataset.paneSlot = layout.pane.id;
    Object.assign(slot.style, { display: 'flex', flex: '1', minWidth: '0', minHeight: '0' });
    return slot;
  }
  const split = el("div", `split ${layout.axis}`);
  const first = el("div", "split-child"),
    second = el("div", "split-child");
  first.style.flex = `${layout.ratio} 1 0`;
  second.style.flex = `${1 - layout.ratio} 1 0`;
  first.append(renderLayout(layout.first));
  second.append(renderLayout(layout.second));
  const divider = el("div", "split-divider");
  divider.tabIndex = 0;
  divider.role = "separator";
  divider.setAttribute("aria-label", "Resize split");
  divider.setAttribute(
    "aria-orientation",
    layout.axis === "row" ? "vertical" : "horizontal",
  );
  const set = (ratio: number) => {
    layout.ratio = Math.max(0.15, Math.min(0.85, ratio));
    first.style.flex = `${layout.ratio} 1 0`;
    second.style.flex = `${1 - layout.ratio} 1 0`;
    divider.setAttribute(
      "aria-valuenow",
      String(Math.round(layout.ratio * 100)),
    );
    save();
  };
  let dragging = false;
  divider.onpointerdown = (e) => {
    dragging = true;
    divider.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  divider.onpointermove = (e) => {
    if (!dragging) return;
    const r = split.getBoundingClientRect();
    set(
      layout.axis === "row"
        ? (e.clientX - r.left) / r.width
        : (e.clientY - r.top) / r.height,
    );
  };
  divider.onpointerup = () => (dragging = false);
  divider.onpointercancel = () => (dragging = false);
  divider.onkeydown = (e) => {
    if (["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"].includes(e.key)) {
      e.preventDefault();
      set(
        layout.ratio +
          (["ArrowLeft", "ArrowUp"].includes(e.key) ? -0.05 : 0.05),
      );
    }
  };
  split.append(first, divider, second);
  return split;
}
function renderMonitor(m: Monitor) {
  let outer = monitors.get(m.id);
  if (!outer) {
    outer = el("article", "monitor");
    outer.dataset.monitorId = m.id;
    outer.addEventListener("pointerdown", () => {
      if (state.selected !== m.id) choose(m.id);
    }, true);
    monitors.set(m.id, outer);
    // Mount fresh windows in their final connected host before creating panes.
    // Moving an unlaid-out subtree into Docking with moveBefore can leave new
    // Review/tool bodies without layout boxes in Chromium. Existing windows
    // still use connected moves to retain their live documents.
    (docking?.surfaces ?? desktopHost).append(outer);
  }
  const bar = el("div", "monitor-bar");
  outer.style.opacity = String(m.opacity ?? 1);
  const transparency = button('◐', `Toggle transparency for ${m.name}`, () => {
    const dialog = document.createElement('dialog');
    dialog.className = 'hermes-tools-dialog';
    dialog.setAttribute('aria-label', 'Window transparency');
    const applyOpacity = (value: number) => {
      const live = state.monitors.find(window => window.id === m.id);
      if (!live) return;
      live.opacity = value / 100;
      outer!.style.opacity = String(live.opacity);
      transparency.setAttribute('aria-pressed', String(live.opacity < 1));
      transparency.title = `Window opacity: ${value}%`;
      renderInspector(); save();
    };
    dialog.append(el('h2', '', `Transparency · ${m.name}`),
      el('p', '', 'Lower opacity reveals the desktop behind this window. Text and app content fade too.'),
      range('Window opacity', Math.round((state.monitors.find(window => window.id === m.id)?.opacity ?? 1) * 100), 20, 100, 1, '%', applyOpacity),
      button('Fully opaque', 'Make window fully opaque', () => { applyOpacity(100); dialog.close(); }),
      button('Done', 'Close transparency settings', () => dialog.close()));
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog); dialog.showModal();
  });
  transparency.setAttribute('aria-pressed', String((m.opacity ?? 1) < 1));
  bar.append(
    el("span", "monitor-indicator"),
    el("strong", "", m.name),
    el("span", "monitor-meta", `${m.diagonal}″ / ${m.aspect}`),
    el("span", "pane-spacer"),
    button("A−", `Decrease text size on ${m.name}`, () => font(m, -1)),
    button("A+", `Increase text size on ${m.name}`, () => font(m, 1)),
    transparency,
    button("⚙", `Settings for ${m.name}`, () => openWindowOptions(m.id)),
    button("⛶", `Focus ${m.name}`, () => focus(m.id)),
    button('−', `Minimize ${m.name}`, () => {
      if (focused === m.id) unfocus();
      minimizer.hide(m.id, outer!);
      updateScene(); renderTabs(); layoutSwitcher?.remember(); minimizer.focusRestore();
    }, 'window-minimize'),
    button('×', `Close ${m.name}`, () => { choose(m.id); deleteMonitor(); }, 'window-close'),
  );
  minimizer.attach(m.id, outer);
  const content = el("div", "monitor-content");
  content.append(renderLayout(m.layout));
  const resizeHandle = el('div', 'window-resize', '◢');
  const oldChildren = Array.from(outer.children);
  outer.append(bar, content, resizeHandle);
  for (const p of leaves(m.layout)) {
    const slot = Array.from(content.querySelectorAll<HTMLElement>('[data-pane-slot]')).find(x => x.dataset.paneSlot === p.id)!;
    const v = paneView(p, m);
    if (v.element.parentElement !== slot) moveConnected(v.element, slot);
    v.setFont(textSize(m));
  }
  for (const [id, v] of views) {
    if (outer.contains(v.element) && !leaves(m.layout).some(p => p.id === id) && livePaneMonitor(id)) {
      moveConnected(v.element, paneParking);
    }
  }
  oldChildren.forEach(child => child.remove());
  scene.wireSpatial(bar, resizeHandle, m, () => state.view === 'spatial' && !focused, () => { updateScene(); save(); }, () => { renderInspector(); save(); });
  wireWindow(outer, bar, resizeHandle, m, desktopHost, () => state.view === 'windows' && !focused && !docking, () => { renderInspector(); views.forEach(v => v.resize()); save(); });
  updateScene();
  if (focused === m.id) {
    if (outer.parentElement !== focusHost) moveConnected(outer, focusHost);
    outer.classList.add("flat-monitor");
    outer.style.transform = "none";
  }
}
function openWindowOptions(id: string) {
  choose(id);
  const dialog = document.createElement('dialog');
  dialog.className = 'hermes-tools-dialog';
  dialog.setAttribute('aria-label', 'Window options');
  const live = () => state.monitors.find(window => window.id === id);
  const m = live();
  if (!m) return;
  const heading = el('h2', '', `Window options · ${m.name}`);
  const name = el('input', 'name-input');
  name.value = m.name;
  name.maxLength = 60;
  name.setAttribute('aria-label', 'Window name');
  const status = el('p', '', 'Opacity and text size save immediately. Window names are separate from conversation names.');
  status.setAttribute('role', 'status');
  const rename = () => {
    const window = live();
    if (!window) return dialog.close();
    const value = name.value.trim();
    if (!value) { status.textContent = 'Enter a window name.'; name.focus(); return; }
    const oldName = window.name;
    window.name = value;
    const bar = monitors.get(id)?.querySelector('.monitor-bar');
    const title = bar?.querySelector('strong');
    if (title) title.textContent = value;
    bar?.querySelectorAll('button').forEach(button => {
      const label = button.getAttribute('aria-label');
      if (label) button.setAttribute('aria-label', label.replace(oldName, value));
    });
    heading.textContent = `Window options · ${value}`;
    renderInspector(); renderTabs(); save();
    status.textContent = 'Window name saved.';
  };
  name.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); rename(); } };
  const opacity = range('Window opacity', Math.round((m.opacity ?? 1) * 100), 20, 100, 1, '%', value => {
    const window = live();
    if (!window) return dialog.close();
    window.opacity = value / 100;
    const outer = monitors.get(id);
    if (outer) {
      outer.style.opacity = String(window.opacity);
      outer.querySelector('[aria-label^="Toggle transparency"]')?.setAttribute('aria-pressed', String(value < 100));
    }
    renderInspector(); save();
  });
  dialog.append(heading, name, button('Save name', 'Save window name', rename), opacity,
    el('p', '', 'Lower opacity fades the entire window, including its text and apps.'),
    button('Fully opaque', 'Reset window opacity', () => {
      const input = opacity.querySelector('input')!;
      input.value = '100'; input.dispatchEvent(new Event('input'));
    }),
    range(textSizeLabel(), textSize(m), 6, state.view === 'spatial' ? 96 : 32, 1, ' px', value => {
      const window = live();
      if (window) font(window, value - textSize(window));
    }), status, button('Done', 'Close window options', () => dialog.close()));
  const trigger = document.activeElement as HTMLElement | null;
  dialog.addEventListener('close', () => { dialog.remove(); trigger?.focus(); });
  document.body.append(dialog);
  dialog.showModal();
}
function textSize(m: Monitor) {
  return state.view === 'spatial' ? (m.spatialFontSize ?? m.fontSize) : m.fontSize;
}
function textSizeLabel() { return state.view === 'spatial' ? '3D text size' : 'Desktop text size'; }
function font(m: Monitor, delta: number, refreshInspector = true) {
  const value = Math.max(6, Math.min(state.view === 'spatial' ? 96 : 32, textSize(m) + delta));
  // Freeze the legacy size before either view is edited, so desktop changes
  // cannot silently change an as-yet unedited spatial setting.
  m.spatialFontSize ??= m.fontSize;
  if (state.view === 'spatial') m.spatialFontSize = value;
  else m.fontSize = value;
  leaves(m.layout).forEach((p) => views.get(p.id)?.setFont(value));
  if (refreshInspector) renderInspector();
  save();
}
function range(
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  unit: string,
  on: (v: number) => void,
) {
  const wrap = el("label", "field");
  const line = el("div", "field-line"),
    output = el("output", "", `${value}${unit}`);
  line.append(el("span", "", label), output);
  const input = el("input");
  input.type = label === 'Diagonal' ? 'number' : 'range';
  input.min = String(min);
  if (label !== 'Diagonal') input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.setAttribute("aria-label", label);
  input.oninput = () => {
    if (!input.validity.valid || !input.value || !Number.isFinite(Number(input.value))) return;
    output.value = `${input.value}${unit}`;
    on(Number(input.value));
    save();
  };
  wrap.append(line, input);
  return wrap;
}
function renderInspector() {
  const m = current();
  inspector.replaceChildren();
  const head = el("div", "inspector-head");
  head.append(
    el("div", "eyebrow", "DISPLAY CONFIGURATION"),
    el("h2", "", m.name),
  );
  const name = el("input", "name-input");
  name.value = m.name;
  name.maxLength = 60;
  name.setAttribute("aria-label", "Display name");
  name.onchange = () => {
    m.name = name.value.trim() || "Display";
    renderMonitor(m);
    renderInspector();
    renderTabs();
    save();
  };
  head.append(name);
  inspector.append(head);
  const preset = el("div", "settings-section");
  preset.append(el("h3", "", "WORKSPACE"));
  const count = el("div", "count-control");
  count.append(
    button("−", "Remove selected monitor", () => deleteMonitor()),
    el("span", "", `${state.monitors.length} displays`),
    button("+", "Add monitor", () => addMonitor()),
  );
  preset.append(count);
  const presets = select(
    [
      ["custom", "Layout presets…"],
      ["single", "Single / deep focus"],
      ["dual", "Dual / side by side"],
      ["triple", "Triple / command center"],
    ],
    "custom",
    (v) => {
      if (v === "custom") return;
      confirmChange(
        "Applying a preset replaces workspace views and discards unsaved view content. Persistent terminal shells may continue detached.",
        () => {
          unfocus();
           views.forEach((v) => v.dispose());
           views.clear();
           paneSignatures.clear();
          monitors.forEach(element=>element.remove());
          monitors.clear();
          const n = v === "single" ? 1 : v === "dual" ? 2 : 3;
          state.monitors = Array.from({ length: n }, (_, i) =>
            monitor(i + 1, (["terminal", "browser", "agent"] as PaneKind[])[i]),
          );
          state.selected = state.monitors[0].id;
          renderAll();
        },
      );
    },
  );
  presets.setAttribute("aria-label", "Layout preset");
  preset.append(
    presets,
    range("Wrap angle", state.arc, 0, 30, 1, "°", (v) => {
      state.arc = v;
      updateScene();
    }),
  );
  inspector.append(preset);
  const display = el("div", "settings-section");
  display.append(el("h3", "", "SHAPE & SCALE"));
  const ratioLabel = el("label", "field");
  ratioLabel.append(el("span", "", "Aspect ratio"));
  const ratios = select(
    ["16:9", "16:10", "21:9", "32:9", "4:3", "9:16", "1:1"].map((v) => [v, v]),
    m.aspect,
    (v) => {
      m.aspect = v;
      renderMonitor(m);
      save();
    },
  );
  ratios.setAttribute("aria-label", "Aspect ratio");
  ratioLabel.append(ratios);
  display.append(
    ratioLabel,
    range("Diagonal", m.diagonal, 20, Infinity, 1, "″", (v) => {
      m.diagonal = v;
      updateScene();
    }),
    range(textSizeLabel(), textSize(m), 6, state.view === 'spatial' ? 96 : 32, 1, " px", (v) => {
      font(m, v - textSize(m), false);
    }),
  );
  inspector.append(display);
  const transparencySettings = el('div', 'settings-section');
  transparencySettings.append(el('h3', '', 'TRANSPARENCY'),
    range('Window opacity', Math.round((m.opacity ?? 1) * 100), 20, 100, 1, '%', (v) => {
      m.opacity = v / 100;
      const outer = monitors.get(m.id);
      if (outer) {
        outer.style.opacity = String(m.opacity);
        outer.querySelector('[aria-label^="Toggle transparency"]')?.setAttribute('aria-pressed', String(m.opacity < 1));
      }
    }),
    el('p', '', '100% is opaque. Lower values fade the entire window, including text and apps.'));
  inspector.append(transparencySettings);
  const position = el("div", "settings-section");
  position.append(el("h3", "", "POSITION"));
  for (const [label, key, min, max, step, unit] of [
    ["Height", "height", -2, 3, 0.1, " u"],
    ["Distance", "distance", -2, 4, 0.1, " u"],
    ["Pitch", "pitch", -35, 35, 1, "°"],
    ["Yaw", "yaw", -45, 45, 1, "°"],
    ["Horizontal offset", "offset", -3, 3, 0.1, " u"],
  ] as const) {
    position.append(
      range(label, m[key], min, max, step, unit, (v) => {
        m[key] = v;
        updateScene();
      }),
    );
  }
  inspector.append(position);
  if (m.spatial) {
    ratios.disabled = true;
    display.querySelector<HTMLInputElement>('[aria-label="Diagonal"]')!.disabled = true;
    position.replaceChildren(el('h3', '', 'FREE 3D PLACEMENT'), el('p', '', 'This window uses independent 3D dimensions and coordinates. Use Arrange / edit in Spatial view to change size, position, rotation and resolution.'),
      button('Edit 3D placement', 'Edit selected 3D placement', () => { if (state.view !== 'spatial') setView('spatial'); stage.querySelector<HTMLButtonElement>('[aria-label="3D layout and window settings"]')?.click(); }));
  }
  if (state.monitors.every(window => window.spatial)) preset.querySelector<HTMLInputElement>('[aria-label="Wrap angle"]')!.disabled = true;
  const actions = el("div", "settings-section settings-actions");
  actions.append(
    button("↧  Export layout", "Export workspace layout", exportLayout),
    button("↥  Import layout", "Import workspace layout", () =>
      importInput.click(),
    ),
  );
  const note = el(
    "p",
    "inspector-note",
    "Layouts save in this browser. Shell sessions end when their pane closes.",
  );
  actions.append(note);
  inspector.append(actions);
}
window.addEventListener('orbit-open-shared-browser', () => {
  let m=state.monitors.find(m=>leaves(m.layout).some(p=>p.kind==='browser'&&p.url==='orbit://shared-browser'));
  if(!m){

    m=monitor(state.monitors.length+1,'browser');m.name='Shared Chromium';
    leaves(m.layout)[0].url='orbit://shared-browser';
    m.frame={x:60,y:50,width:1000,height:700,z:state.monitors.length+1};
    state.monitors.push(m);
  }
  if(focused)unfocus();
  state.selected=m.id;renderAll();choose(m.id);save();
});
let desktopLaunchBusy = false;
async function launchDesktopPlugin(plugin:PluginInstance) {
  if (!sessionToken) { connectHost(); return; }
  if (desktopLaunchBusy) return;
  desktopLaunchBusy = true;
  try {
    await ensureWorkspaceSynced();
    const api = async (body:Record<string,unknown>) => {
       const response = await workspaceFetch(sessionToken,{workspace_id:workspaceId,...body});
      const data = await response.json(); if(!response.ok)throw Error(data.error || 'App launch failed'); return data;
    };
    const current = await api({action:'read'});
     await api({action:'plugins_apply',base_revision:current.revision,operations:[{action:'plugin_enable',...pluginSelector(plugin)}],intent:`Enable desktop plugin ${plugin.manifest.id}`});
    notify('App enabled; workspace is synchronizing.');
  } catch(e) { notify(String(e)); } finally { desktopLaunchBusy = false; }
}
function addMonitor(kind: PaneKind = 'terminal') {

  const m = monitor(state.monitors.length + 1, kind);
  state.monitors.push(m);
  state.selected = m.id;
  renderMonitor(m);
  renderInspector();
  renderTabs();
  save();
}
function paneExists(paneId: string): boolean {
  return state.monitors.some(m => leaves(m.layout).some(p => p.id === paneId && p.kind === 'agent'));
}
function focusPane(paneId: string): boolean {
  const target = state.monitors.find(m => leaves(m.layout).some(p => p.id === paneId));
  if (!target) return false;
  if (focused) unfocus();
  choose(target.id);
  return true;
}
// Opens (or re-focuses) a dedicated Workbench agent pane beside the Normal one.
// The new pane's mode is persisted before its first render and it starts its own
// fresh conversation; no chat, draft, context, grant or candidate is copied.
// The surface is experimental and off until enabled in Orbit settings.
function openWorkbenchWindow(normalPaneId?: string) {
  if (!experimentalEnabled('workbench')) {
    notify('Project Workbench is experimental and off. Enable it in Orbit settings.');
    openSettings();
    return;
  }
  if (normalPaneId && !paneExists(normalPaneId)) return;
  if (normalPaneId) {
    const paired = readPanePrefs(workspaceId, normalPaneId).pairedPaneId;
    if (paired && paneExists(paired)) { focusPane(paired); return; }
  }
  const m = monitor(state.monitors.length + 1, 'agent');
  m.name = 'Workbench';
  const workbenchPane = leaves(m.layout)[0];
  writePanePrefs(workspaceId, workbenchPane.id, { mode: 'workbench', pairedPaneId: normalPaneId ?? null });
  if (normalPaneId) writePanePrefs(workspaceId, normalPaneId, { pairedPaneId: workbenchPane.id });
  if (focused) unfocus();
  state.monitors.push(m);
  state.selected = m.id;
  renderMonitor(m);
  renderInspector();
  renderTabs();
  save();
}
// Opens (or re-focuses) the Normal chat paired with a Workbench pane. It never
// silently replaces the original; the opaque pair id is used.
function openNormalWindow(workbenchPaneId?: string) {
  if (workbenchPaneId && !paneExists(workbenchPaneId)) return;
  if (workbenchPaneId) {
    const paired = readPanePrefs(workspaceId, workbenchPaneId).pairedPaneId;
    if (paired && paneExists(paired)) { focusPane(paired); return; }
  }
  const m = monitor(state.monitors.length + 1, 'agent');
  m.name = 'Normal chat';
  const normalPane = leaves(m.layout)[0];
  if (workbenchPaneId) {
    writePanePrefs(workspaceId, normalPane.id, { pairedPaneId: workbenchPaneId });
    writePanePrefs(workspaceId, workbenchPaneId, { pairedPaneId: normalPane.id });
  }
  if (focused) unfocus();
  state.monitors.push(m);
  state.selected = m.id;
  renderMonitor(m);
  renderInspector();
  renderTabs();
  save();
}
function deleteMonitor() {
  if (state.monitors.length === 1) {
    notify("Keep at least one display");
    return;
  }
  const m = current();
  confirmChange(`Remove ${m.name} and close all its panes?`, async () => {
    const closingPaneIds=leaves(m.layout).map(p=>p.id);
    if(!await (await import('./document-drafts')).requestDocumentClose(closingPaneIds))return;
    if(!state.monitors.includes(m)||JSON.stringify(leaves(m.layout).map(p=>p.id))!==JSON.stringify(closingPaneIds)){notify('Window placement changed during close review. Please close it again.');return;}
    unfocus();
    leaves(m.layout).forEach((p) => {
      views.get(p.id)?.dispose();
      views.delete(p.id);
      paneSignatures.delete(p.id);
    });
    monitors.delete(m.id);
    state.monitors = state.monitors.filter((x) => x.id !== m.id);
    state.selected = state.monitors[0].id;
    renderAll();
  });
}
function renderAll() {
  for (const [id, v] of views) if (!livePaneMonitor(id)) {
    v.dispose(); views.delete(id); paneSignatures.delete(id);
  }
  // A removed CSS3DObject removes its anchor immediately; park surviving views
  // before any renderMonitor/updateScene call can prune that old anchor.
  for (const [id, element] of monitors) if (!state.monitors.some(m => m.id === id)) {
    for (const [paneId, v] of views) if (element.contains(v.element) && livePaneMonitor(paneId)) moveConnected(v.element, paneParking);
  }
  state.monitors.forEach(renderMonitor);
  for (const [id, element] of monitors) if (!state.monitors.some(m => m.id === id)) { element.remove(); monitors.delete(id); }
  desktopHost.querySelectorAll<HTMLElement>('[data-monitor-id]').forEach(element => { if (!state.monitors.some(m => m.id === element.dataset.monitorId)) element.remove(); });
  renderInspector();
  renderTabs();
  updateScene();
  applySidebar();
  save();
}
function exportLayout() {
  const blob = new Blob([JSON.stringify(state, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob),
    a = el("a");
  a.href = url;
  a.download = "orbit-workspace.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify("Workspace exported. Credentials and terminal data are excluded.");
}
const importInput = el("input");
importInput.type = "file";
importInput.accept = ".json,application/json";
importInput.hidden = true;
app.append(importInput);
importInput.onchange = async () => {
  const f = importInput.files?.[0];
  if (!f) return;
  try {
    if (f.size > 100000) throw Error("Layout file is too large");
    const next = validate(JSON.parse(await f.text()));
    confirmChange(
      "Importing replaces layout and pane views, discarding unsaved view content. Persistent terminal shells may continue detached.",
      () => {
        unfocus();
        views.forEach((v) => v.dispose());
        views.clear();
        paneSignatures.clear();
        monitors.forEach(element=>element.remove());
        monitors.clear();
        state = next;
        state.view ||= 'windows';
        scene.configureCamera(state.spatialCamera,pose=>{state.spatialCamera=pose;save();});
        applyAppearance(state);
        renderAll();
        setView(state.view);
        choose(state.selected);
      },
    );
  } catch (e) {
    notify(e instanceof Error ? e.message : "Invalid layout");
  }
  importInput.value = "";
};
function connectHost() {
  const d = el("dialog", "dialog");
  d.append(
    el("div", "eyebrow", "PRIVATE WORKSPACE"),
    el("h2", "", "Unlock terminals and Hermes"),
    el(
      "p",
      "",
      "Paste your Orbit session token. This unlocks terminal access and the connected Hermes agent, which can use tools in its own host environment.",
    ),
  );
  const code = el("p", "muted", "Keep this token private. It stays in browser memory and must be entered again after a reload.");
  const input = el("input");
  input.type = "password";
  input.autocomplete = "off";
  input.placeholder = "Session token";
  input.setAttribute("aria-label", "Host session token");
  const msg = el("p", "connection-message");
  const row = el("div", "dialog-actions");
  const unlock = button(
    "Unlock host",
    "Unlock local host",
    async () => {
      unlock.disabled = true;
      try {
        const r = await fetch("/api/auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: input.value }),
        });
        if (!r.ok)
          throw Error(
            r.status === 401
              ? "That token was not accepted."
              : "Orbit server unavailable. Check your connection and try again.",
          );
        setToken(input.value);
        input.value = "";
        hostStatus.textContent = "●  Host unlocked";
        d.close();
        notify("Unlocked. Chat with Hermes or select Connect shell.");
      } catch (e) {
        msg.textContent =
          e instanceof Error ? e.message : "Unable to reach local server";
      } finally {
        unlock.disabled = false;
      }
    },
    "primary",
  );
  row.append(
    button("Cancel", "Close host dialog", () => d.close()),
    unlock,
  );
  d.append(code, input, msg, row);
  d.onclose = () => d.remove();
  app.append(d);
  d.showModal();
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && focused) unfocus();
});
new ResizeObserver(() => updateScene()).observe(stage);
window.addEventListener("beforeunload", () => {
  try {
    localStorage.setItem("orbit.workspace.v1", JSON.stringify(state));
  } catch {}
  docking?.dispose();
  dockingSync?.dispose();
  views.forEach((v) => v.dispose());
  scene.dispose();
});
workspaceBridge = connectWorkspace(() => state, next => {
  cancelDockingPlacementGesture();
  applyingRemote = true;
  try {
    const valid = validate(next);
    // Camera/geometry synchronization must not detach live iframes or terminals.
    const geometryOnly = valid.view === state.view && valid.monitors.length === state.monitors.length && valid.monitors.every((m, i) => {
      const old = state.monitors[i];
      return old.id === m.id && old.name === m.name && old.opacity === m.opacity && JSON.stringify(old.layout) === JSON.stringify(m.layout);
    });
    if (geometryOnly) {
      valid.monitors = valid.monitors.map((m, i) => { const old = state.monitors[i]; if (!m.spatial) delete old.spatial; if (m.spatialFontSize === undefined) delete old.spatialFontSize; return Object.assign(old, m, {layout: old.layout}); });
      state = valid;
      state.monitors.forEach(m => leaves(m.layout).forEach(p => views.get(p.id)?.setFont(textSize(m))));
      scene.configureCamera(state.spatialCamera, pose => { state.spatialCamera = pose; save(); });
      renderInspector(); renderTabs(); updateScene(); applySidebar(); save();
      return;
    }
    const previousFocus = focused;
    if (focused) unfocus();
    const nextPanes = new Map(valid.monitors.flatMap(m => leaves(m.layout).map(p => [p.id, { p, monitorId: m.id }] as const)));
    for (const m of state.monitors) for (const p of leaves(m.layout)) {
      const match = nextPanes.get(p.id);
      if (!match || paneSignature(match.p) !== paneSignature(p)) { views.get(p.id)?.dispose(); views.delete(p.id); paneSignatures.delete(p.id); }
    }
    valid.monitors = valid.monitors.map(m => { const old = state.monitors.find(x => x.id === m.id); if (old && !m.spatial) delete old.spatial; if (old && m.spatialFontSize === undefined) delete old.spatialFontSize; return old ? Object.assign(old, m) : m; });
    state = valid; state.view ||= 'windows';
    scene.configureCamera(state.spatialCamera, pose => { state.spatialCamera = pose; save(); });
    renderAll(); setView(state.view); choose(state.selected);
    if (previousFocus && state.monitors.some(m => m.id === previousFocus) && state.selected === previousFocus) focus(previousFocus);
  } finally { applyingRemote = false; }
}, () => sessionToken, message => { saved.textContent = message; }, {
  onRemote: (placement, revision) => {
    if (dockingSync) dockingSync.remote(placement, revision);
    else firstDockingSnapshot = { placement, revision };
  },
});
renderAll();
setView(state.view || 'windows');
// Opt-in docking placement only when the local URL explicitly asks for it. The
// library/styles are dynamically imported (Dockview stays out of the main bundle) and
// refuses explicitly, leaving this default renderer in place, when the browser
// cannot preserve connected pane documents.
if (dockingRequested(location.search)) {
  const beginPlacementGesture = (event: Event) => {
    const target = event.target;
    if (!event.isTrusted || applyingRemote || !(target instanceof Element) ||
        !target.closest('.docking-root, .docking-toolbar') || target.closest('.docking-surfaces')) return;
    dockingPlacementGesture++;
    dockingPlacementAllowed = true;
  };
  const endPlacementGesture = () => {
    const generation = dockingPlacementGesture;
    // Include Dockview's pointer-release rAF snapshot, then close the gate. It
    // stays closed indefinitely, including layout events after its own 2-rAF
    // suppression expires. A remote apply invalidates even an ongoing gesture.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (generation === dockingPlacementGesture) dockingPlacementAllowed = false;
    }));
  };
  for (const host of [desktopHost, dockingToolbarHost]) {
    host.addEventListener('pointerdown', beginPlacementGesture, true);
    for (const type of ['click', 'keydown']) host.addEventListener(type, event => {
      beginPlacementGesture(event);
      endPlacementGesture();
    }, true);
  }
  window.addEventListener('pointerup', endPlacementGesture, true);
  window.addEventListener('pointercancel', cancelDockingPlacementGesture, true);
  window.addEventListener('blur', cancelDockingPlacementGesture);
  installDockingRenderer({
    host: desktopHost,
    toolbarHost: dockingToolbarHost,
    getState: () => state,
    onSelect: choose,
    onError: message => notify(`Docking renderer: ${message}`),
    onPlacementChange: placement => {
      if (dockingPlacementAllowed && !applyingRemote && !reconcilingDocking) dockingSync?.local(placement);
    },
  })
    .then(controller => {
      if (!controller) return;
      docking = controller;
      renderAll();
      dockingSync = createDockingSync({
        applyPlacement: placement => {
          cancelDockingPlacementGesture();
          docking!.applyPlacement(placement);
        },
        savePlacement: placement => workspaceBridge!.savePlacement(placement),
        reload: () => workspaceBridge!.sync(),
        status: notify,
      });
      if (firstDockingSnapshot) dockingSync.hydrate(firstDockingSnapshot.placement, firstDockingSnapshot.revision);
      firstDockingSnapshot = null;
    })
    .catch(error => notify(`Docking renderer failed: ${String(error)}`));
}
layoutSwitcher = installLayoutSwitcher(navigation, `orbit.layouts.${workspaceId}`, () => state,
  () => minimizer.ids(), (next, hidden) => {
    if (focused) unfocus();
    next.monitors = next.monitors.map(m => {
      const old = state.monitors.find(w => w.id === m.id)!;
      for (const key of ['frame', 'spatial', 'spatialFontSize'] as const) if (m[key] === undefined) delete old[key];
      return Object.assign(old, m);
    });
    state = next;
    scene.configureCamera(state.spatialCamera, pose => { state.spatialCamera = pose; save(); });
    for (const m of state.monitors) {
      const element = monitors.get(m.id)!;
      if (hidden.includes(m.id)) minimizer.hide(m.id, element); else minimizer.restore(m.id, element);
    }
    setView(state.view || 'windows'); renderTabs();
  }, notify, () => {void commands.execute('saved-layouts');});
// Optional, page-scoped WebMCP: no terminal input or credentials are exposed.
const modelContext = (
  document as Document & {
    modelContext?: {
      registerTool: (
        tool: unknown,
        options: { signal: AbortSignal },
      ) => void | Promise<void>;
    };
  }
).modelContext;
if (modelContext?.registerTool) {
  const lifecycle = new AbortController();
  const register = (tool: unknown) => {
    try {
      Promise.resolve(
        modelContext.registerTool(tool, { signal: lifecycle.signal }),
      ).catch(() => {});
    } catch {}
  };
  register({
    name: "read_display_layout",
    description:
      "Read monitor geometry and pane types. Does not include chat or terminal content.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute: () => ({
      selected: state.selected,
      monitors: state.monitors.map((m) => ({
        id: m.id,
        name: m.name,
        aspect: m.aspect,
        diagonal: m.diagonal,
        height: m.height,
        distance: m.distance,
        pitch: m.pitch,
        panes: leaves(m.layout).map((p) => p.kind),
      })),
    }),
  });
  register({
    name: "focus_display",
    description: "Show one existing monitor in the flat focus view.",
    inputSchema: {
      type: "object",
      properties: { monitorId: { type: "string" } },
      required: ["monitorId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    execute: (input: unknown) => {
      const x = input as { monitorId?: string };
      if (!x || !state.monitors.some((m) => m.id === x.monitorId))
        throw Error("Unknown monitor");
      focus(x.monitorId!);
      return { focused: x.monitorId };
    },
  });
  window.addEventListener("pagehide", () => lifecycle.abort(), { once: true });
}
