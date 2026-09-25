import { el, button } from './dom';
import './onboarding.css';

const key = 'orbit.onboarding.v1';
const steps = [
  {title: 'Welcome to Orbit', text: ['A workspace you can shape with Hermes. Keep chats, terminals, websites and custom apps together—in a desktop or a navigable 3D scene.', 'This short tour only explains the controls. It will not rearrange windows, run commands or send messages. Reopen it anytime from Start → Getting started.']},
  {title: 'Your everyday controls', text: ['Start opens chats, terminals, browsers and searchable actions. The bottom taskbar switches windows and restores minimized ones. Drag window title bars to move them and their resize handles to change their size.', 'Use the upper-left view switcher for Windows or Spatial. Controls shows or hides workspace controls; Ctrl+Alt+F is another way back. The side panel contains settings for your selected window.']},
  {title: 'Move into 3D', text: ['In Spatial, drag a title bar to move a window; Shift-drag changes depth and Ctrl/Command-drag rotates it. The bottom-right handle resizes it. Arrange / edit provides grid, row and curved-wall tiling.', 'Navigate enables WASD or arrow-key travel and Q/E vertical movement. Drag the background to orbit, Shift-drag to pan, and scroll to zoom. Escape returns to interacting with apps. Fit all recovers your view; Approach brings a window closer.', 'Desktop text size and 3D text size are independent. Higher surface resolution fits more content; increase 3D text size or move closer for readability. Remote desktop streams have their own resolution limits.']},
  {title: 'Keep layouts for different tasks', text: ['Open the layout switcher at the bottom right. Enter a name and choose New from current. Rearrange your windows; changes to that layout are saved automatically.', 'Keep a 2D coding desk and a 3D research wall, then switch between them. Apps are shared—not separate sessions or simultaneous 2D/3D compositing.', 'The named layout collection is local to this browser. Clearing browser storage removes it; it is not synced across devices or included in server checkpoints.']},
  {title: 'Ask Hermes to make it yours', text: ['Open Start → Chat and describe the result you want in plain language. Specify which windows to change, what to preserve, and how you want the result checked.', 'Hermes can use workspace controls for layout, appearance and plugin settings. New core features may need source changes, a build and a reload. Layout context is not access to your screen pixels, terminal buffers or every embedded app.'], prompt: 'Make this a focused coding workspace: put my terminal on the left and chat on the right, use a dark background, and preserve my existing panes and running sessions. Save a checkpoint before changing the layout and verify the result.'},
  {title: 'Build apps inside your workspace', text: ['Describe the app, its controls, data source and how you will use it. Ask Hermes to build, publish and test it—not just provide a mockup. Then iterate by asking for specific changes.', 'Generated app plugins run in sandboxed browser panes, without a privileged host bridge. Host integrations need a separately authorized service. Never paste API keys into chat or store secrets in app code or plugin config.'], prompt: 'Build a focus timer app in this workspace with start, pause, reset and adjustable work/break durations. Keep it self-contained, publish it as a sandboxed plugin, test the controls, and add it without replacing my other windows.'},
  {title: 'Explore with a safety net', text: ['Ask for a preview and checkpoint before a big workspace redesign. Workspace checkpoints restore supported layout, appearance and plugin settings—not files, shell commands, messages, documents or running processes.', 'Review tool approvals and ask before destructive or external actions. Core code and browser-local named layouts need their own backups.', 'You’re ready. Open Start → Chat when you want help, or reopen Getting started anytime. Example prompts in this tour are copied only when you choose; nothing is sent automatically.']},
];
let active: HTMLDialogElement | undefined;

export function showOnboarding() {
  if (active?.open) return;
  const previous = document.activeElement as HTMLElement | null;
  const dialog = document.createElement('dialog');
  dialog.className = 'orbit-onboarding'; active = dialog;
  dialog.setAttribute('aria-labelledby', 'orbit-tour-title');
  const top = el('div', 'tour-top');
  const progress = el('span', 'tour-progress');
  const heading = el('h1'); heading.id = 'orbit-tour-title'; heading.tabIndex = -1;
  const content = el('div', 'tour-content');
  const status = el('p', 'tour-status'); status.setAttribute('role', 'status');
  const footer = el('div', 'tour-footer');
  let index = 0;
  function finish() {
    try { localStorage.setItem(key, 'done'); } catch { /* Tour still works without persistence. */ }
    dialog.close();
  }
  const back = button('Back', 'Previous tour step', () => { index--; render(); });
  const next = button('Next', 'Next tour step', () => { if (index === steps.length - 1) finish(); else { index++; render(); } });
  top.append(el('strong', '', '◉ ORBIT / GETTING STARTED'), button('Skip tour', 'Skip tour', finish));
  footer.append(back, progress, next);
  function render() {
    const step = steps[index];
    heading.textContent = step.title;
    progress.textContent = `${index + 1} of ${steps.length}`;
    back.disabled = index === 0;
    next.textContent = index === steps.length - 1 ? 'Start exploring' : 'Next';
    next.setAttribute('aria-label', index === steps.length - 1 ? 'Finish tour' : 'Next tour step');
    content.replaceChildren(...step.text.map(text => el('p', '', text)));
    status.textContent = '';
    if (step.prompt) {
      const prompt = el('textarea', 'tour-prompt') as HTMLTextAreaElement;
      prompt.readOnly = true; prompt.value = step.prompt; prompt.setAttribute('aria-label', 'Example prompt');
      const copy = button('Copy example prompt', 'Copy example prompt', async () => {
        try { await navigator.clipboard.writeText(step.prompt!); status.textContent = 'Copied. Paste into an agent chat and review before sending.'; }
        catch { prompt.focus(); prompt.select(); status.textContent = 'Copy unavailable. The prompt is selected; use your usual copy shortcut.'; }
      });
      content.append(prompt, copy);
    }
    heading.focus(); content.scrollTop = 0;
  }
  dialog.addEventListener('cancel', event => { event.preventDefault(); finish(); });
  dialog.addEventListener('close', () => { dialog.remove(); active = undefined; if (previous?.isConnected) previous.focus(); });
  dialog.append(top, heading, content, status, footer);
  document.body.append(dialog); dialog.showModal(); render();
}

export function offerOnboarding() {
  let seen = false;
  try { seen = localStorage.getItem(key) === 'done'; } catch { /* Nonpersistent first run. */ }
  if (!seen) showOnboarding();
}
