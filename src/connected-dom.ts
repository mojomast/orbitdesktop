let fallbackWarningShown = false;

/** Whether this browser exposes the state-preserving connected move operation. */
export function supportsConnectedMove(): boolean {
  return typeof Element !== "undefined" &&
    typeof (Element.prototype as Element & { moveBefore?: unknown }).moveBefore ===
      "function";
}

/**
 * Move an element without disconnecting it when both parents are connected and
 * the browser supports Element.moveBefore. The insertBefore fallback does not
 * promise to preserve iframe state.
 */
export function moveConnected(
  element: HTMLElement,
  parent: HTMLElement,
  before: Node | null = null,
): void {
  if (element.parentNode === parent &&
      (before === element ||
        (before === null && element.nextSibling === null) ||
        element.nextSibling === before)) {
    return;
  }

  const connected = element.isConnected && parent.isConnected;
  if (connected && element.ownerDocument === parent.ownerDocument && supportsConnectedMove()) {
    const moveBefore = (parent as HTMLElement & {
      moveBefore: (node: Node, child: Node | null) => void;
    }).moveBefore;
    moveBefore.call(parent, element, before);
    return;
  }

  // A new disconnected view has no live document state to preserve.
  if (element.isConnected && !fallbackWarningShown) {
    fallbackWarningShown = true;
    console.warn(
      "State-preserving DOM move unavailable (or source/destination disconnected); falling back to insertBefore/appendChild, which does not promise to preserve iframe state.",
    );
  }

  if (before === null) parent.appendChild(element);
  else parent.insertBefore(element, before);
}
