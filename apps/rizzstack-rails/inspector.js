import { formatTimestamp, formatDuration } from './rails.js';

function setChildren(el, kids) {
  el.textContent = '';
  for (const kid of kids) el.appendChild(kid);
  return el;
}

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.classList.add(...className.split(' '));
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function row(doc, label, value) {
  const rowEl = el(doc, 'div', 'rails-inspector__row');
  const labelEl = el(doc, 'span', 'rails-inspector__label', label);
  const valueEl = el(doc, 'span', 'rails-inspector__value', value);
  rowEl.appendChild(labelEl);
  rowEl.appendChild(valueEl);
  return rowEl;
}

export function createInspector({ container, document = globalThis.document, onClose = () => {} } = {}) {
  if (!container) throw new Error('createInspector: container is required');
  if (!document) throw new Error('createInspector: document is required');

  container.classList.add('rails-inspector');
  container.setAttribute('aria-label', 'Mark inspector');
  container.setAttribute('role', 'complementary');

  let open = false;

  container.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });

  function buildBreadcrumbs(breadcrumbs) {
    const bar = el(document, 'div', 'rails-inspector__breadcrumbs');
    const crumbs = Array.isArray(breadcrumbs) ? breadcrumbs : [];
    for (const crumb of crumbs) {
      if (crumb && crumb.missing) {
        bar.appendChild(el(document, 'span', 'rails-crumb rails-crumb--orphan', `orphan:${crumb.lane_id}`));
      } else {
        const button = el(document, 'button', 'rails-crumb', crumb ? crumb.lane_id : '');
        button.setAttribute('type', 'button');
        bar.appendChild(button);
      }
    }
    return bar;
  }

  function build(ctx) {
    const lane = ctx && ctx.lane ? ctx.lane : {};
    const mark = ctx && ctx.mark ? ctx.mark : {};
    const parts = [];

    const head = el(document, 'div', 'rails-inspector__head');
    head.appendChild(el(document, 'div', 'rails-inspector__title', mark.event_id ?? 'unknown event'));
    const closeButton = el(document, 'button', 'rails-inspector__close', '×');
    closeButton.setAttribute('type', 'button');
    closeButton.setAttribute('aria-label', 'Close inspector');
    closeButton.addEventListener('click', () => close());
    head.appendChild(closeButton);
    parts.push(head);

    parts.push(buildBreadcrumbs(ctx && ctx.breadcrumbs));

    parts.push(row(document, 'Event', mark.event_id ?? 'unknown'));
    parts.push(row(document, 'Kind', mark.kind ?? 'unknown'));
    parts.push(row(document, 'Lane', lane.lane_id ?? 'unknown'));
    parts.push(row(document, 'Occurred at', formatTimestamp(mark.occurred_at)));
    parts.push(row(document, 'Duration', formatDuration(mark.duration_ms)));
    parts.push(row(document, 'Timing', mark.timing_quality ?? 'unknown'));
    parts.push(row(document, 'Outcome', mark.outcome ?? 'unknown'));
    parts.push(row(document, 'Ghost', mark.ghost ? 'yes' : 'no'));
    parts.push(row(document, 'Source', lane.source_status ?? 'unknown'));

    const refs = Array.isArray(mark.evidence_refs) ? mark.evidence_refs.slice(0, 20) : [];
    const evidenceSection = el(document, 'div', 'rails-inspector__evidence-section');
    evidenceSection.appendChild(el(document, 'div', 'rails-inspector__label rails-inspector__label--block', 'Evidence'));
    const evidenceList = el(document, 'ul', 'rails-inspector__evidence');
    for (const ref of refs) evidenceList.appendChild(el(document, 'li', 'rails-inspector__evidence-item', ref));
    evidenceSection.appendChild(evidenceList);
    parts.push(evidenceSection);

    return parts;
  }

  function show(ctx) {
    open = true;
    container.classList.add('rails-inspector--open');
    container.removeAttribute('hidden');
    setChildren(container, build(ctx));
    container.focus();
  }

  function close() {
    if (!open) return;
    open = false;
    container.classList.remove('rails-inspector--open');
    container.setAttribute('hidden', '');
    setChildren(container, []);
    onClose();
  }

  return {
    show,
    close,
    isOpen: () => open,
    el: container,
  };
}
