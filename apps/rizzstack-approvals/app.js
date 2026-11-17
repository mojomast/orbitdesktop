// Rizzstack Approvals — owner surface for pending job approvals.
// Lists every tracked request with its preview and binding digest, then posts
// Approve or Decline decisions back to the approvals route. This page holds
// no credentials: signing happens server-side and the signing secret never
// reaches the browser.
'use strict';
(function () {
  const BASE = '/api/approvals';
  const listElement = document.getElementById('approval-list');
  const statusElement = document.getElementById('status');
  const refreshButton = document.getElementById('refresh');

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function formatWhen(value) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toLocaleString() : String(value == null ? '' : value);
  }

  async function fetchJson(url, options) {
    const response = await fetch(url, options);
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    return { ok: response.ok, status: response.status, data };
  }

  function card(item) {
    const decided = item.state !== 'pending';
    const locked = decided || item.expired;
    const controls = decided
      ? ''
      : '<button class="approve" type="button"' + (locked ? ' disabled' : '') + '>Approve</button>' +
        '<button class="decline" type="button"' + (locked ? ' disabled' : '') + '>Decline</button>' +
        '<input class="note" type="text" maxlength="2000" placeholder="Optional note">';
    const badges = '<span class="badge ' + escapeHtml(item.state) + '">' + escapeHtml(item.state) + '</span>' +
      (item.expired ? '<span class="badge expired">expired</span>' : '');
    return '<article class="approval" data-id="' + escapeHtml(item.id) + '" data-state="' + escapeHtml(item.state) + '"' +
      ' data-binding="' + escapeHtml(item.binding) + '">' +
      '<div class="approval-head"><span class="preview">' + escapeHtml(item.preview) + '</span>' + badges + '</div>' +
      '<div class="binding">binding <code>' + escapeHtml(item.binding) + '</code></div>' +
      '<div class="when">created ' + escapeHtml(formatWhen(item.created_at)) +
      ' · expires ' + escapeHtml(formatWhen(item.expires_at)) + '</div>' +
      '<div class="actions">' + controls + '</div>' +
      '<div class="result" hidden></div></article>';
  }

  async function decide(article, decision) {
    const id = article.getAttribute('data-id');
    const binding = article.getAttribute('data-binding');
    const noteField = article.querySelector('.note');
    const note = noteField ? noteField.value.trim() : '';
    const result = article.querySelector('.result');
    for (const button of article.querySelectorAll('button')) button.disabled = true;
    if (result) result.hidden = true;
    const outcome = await fetchJson([BASE, encodeURIComponent(id), 'decision'].join('/'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision, binding, ...(note ? { note } : {}) }),
    });
    let message;
    if (outcome.ok && outcome.data && outcome.data.ok) {
      message = decision === 'approve' ? 'Approved — signed receipt recorded.' : 'Declined.';
    } else {
      const code = outcome.data && outcome.data.error ? outcome.data.error : ['request failed', String(outcome.status)].join(' ');
      message = ['Refused:', code].join(' ');
      if (result) {
        result.textContent = message;
        result.className = 'result error';
        result.hidden = false;
      }
    }
    await load();
    statusElement.textContent = [statusElement.textContent, message].filter(Boolean).join(' · ');
  }

  async function load() {
    statusElement.textContent = 'Loading pending approvals…';
    let outcome;
    try {
      outcome = await fetchJson(BASE);
    } catch (error) {
      statusElement.textContent = ['Load failed:', error instanceof Error ? error.message : 'unknown'].join(' ');
      return;
    }
    if (!outcome.ok || !outcome.data || !Array.isArray(outcome.data.approvals)) {
      statusElement.textContent = ['Load failed', String(outcome.status)].join(' ');
      return;
    }
    const items = outcome.data.approvals;
    listElement.innerHTML = items.length ? items.map(card).join('') : '<p class="empty">No pending approvals.</p>';
    const pending = items.filter((item) => item.state === 'pending').length;
    statusElement.textContent = `${pending} pending · ${items.length} tracked`;
    for (const article of listElement.querySelectorAll('.approval')) {
      for (const button of article.querySelectorAll('button.approve, button.decline')) {
        button.addEventListener('click', () => decide(article, button.classList.contains('approve') ? 'approve' : 'decline'));
      }
    }
  }

  refreshButton.addEventListener('click', () => { load(); });
  load();
})();
