// touch-controls.js — small on-screen buttons for phones/tablets. They drive the
// game through the same keydown/keyup path as the keyboard, so no gameplay code,
// combat state or input semantics have to be duplicated.
export function createTouchControls({ W = 740, H = 510 } = {}) {
  if (typeof window === 'undefined' || !('ontouchstart' in window) || !(navigator && navigator.maxTouchPoints)) return false;

  const root = document.createElement('div');
  root.id = 'ppTouch';
  root.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:' + W + 'px;height:' + H + 'px;pointer-events:none;z-index:40;';

  const controls = [
    ['Left', 'ArrowLeft', 'left', 42, 74], ['Right', 'ArrowRight', 'right', 42, 74],
    ['Up', 'ArrowUp', 'up', 42, 16], ['Down', 'ArrowDown', 'down', 42, 126],
    ['Punch', 'KeyJ', 'J', null, null], ['Kick', 'KeyK', 'K', null, null],
    ['Jump', 'KeyL', 'L', null, null], ['Pizza', 'Space', 'P', null, null],
    ['Dash', 'ShiftLeft', 'DASH', null, null], ['Pause', 'Escape', 'II', null, null]
  ];

  const hold = new Set();
  function send(code, state, e) {
    try {
      if (e) e.preventDefault();
      const ev = new KeyboardEvent(state ? 'keydown' : 'keyup', { code, key: code, bubbles: true, cancelable: true });
      window.dispatchEvent(ev);
    } catch (_) {
      // Older engines lacking synthetic keyboard events silently fall back.
    }
  }

  function makeButton(label, code, left, top) {
    const b = document.createElement('div');
    b.className = 'ppTouchBtn';
    b.textContent = label;
    b.style.left = left + 'px';
    b.style.top = top + 'px';
    let down = false;
    const begin = (e) => { if (down) return; down = true; b.classList.add('down'); send(code, true, e); };
    const end = (e) => { if (!down) return; down = false; b.classList.remove('down'); send(code, false, e); };
    b.style.pointerEvents = 'auto';
    b.addEventListener('touchstart', begin, { passive: false });
    b.addEventListener('touchend', end, { passive: false });
    b.addEventListener('touchcancel', end, { passive: false });
    root.appendChild(b);
    return b;
  }

  const places = {
    Punch: [W - 118, H - 84], Kick: [W - 76, H - 46], Jump: [W - 158, H - 46],
    Pizza: [W - 76, H - 120], Dash: [W - 158, H - 120], Pause: [W - 56, 16]
  };
  const [lx, ly] = [30, H - 164];
  for (const [label, code, shorthand, x, y] of controls) {
    if (label === 'Left') makeButton('◀', code, lx, ly + 48);
    else if (label === 'Right') makeButton('▶', code, lx + 92, ly + 48);
    else if (label === 'Up') makeButton('▲', code, lx + 46, ly);
    else if (label === 'Down') makeButton('▼', code, lx + 46, ly + 96);
    else makeButton(shorthand, code, places[label][0], places[label][1]);
  }

  const style = document.createElement('style');
  style.textContent = `#ppTouch .ppTouchBtn{position:absolute;touch-action:none;user-select:none;-webkit-user-select:none;display:flex;align-items:center;justify-content:center;border:1px solid rgba(100,240,150,.45);background:rgba(6,18,15,.55);color:#bdf8c7;font:bold 16px monospace;border-radius:999px;min-width:46px;height:46px;opacity:.82}
#ppTouch .ppTouchBtn.down{background:rgba(100,240,150,.85);color:#000}
@media (pointer: fine){ #ppTouch .ppTouchBtn { opacity:.35 } }`;
  document.head.appendChild(style);
  document.body.appendChild(root);

  const adjust = () => {
    const k = Math.min(window.innerWidth / W, window.innerHeight / H);
    root.style.transform = 'translate(-50%,-50%) scale(' + k + ')';
  };
  window.addEventListener('resize', adjust);
  adjust();
  return true;
}
