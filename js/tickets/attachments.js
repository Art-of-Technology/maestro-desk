// ─── Ticket attachments ──────────────────────────────────────────────────────
// Demo-only: addMockAttachment cycles through a fixed sample list; in a real
// build this would hook into a file picker / upload pipeline. The panel
// re-renders itself after each add/remove so the count stays in sync.
//
// External reaches (interim, via window): escAttr — still in app.js.
// showModal is a direct ES import.
//
// Inline on*= handlers were migrated to data-action delegation (see the
// registerActions block at the bottom). showAttachPanel stays exported —
// tickets/detail.js imports it directly (action td.showAttach). The add /
// remove mutators are now module-internal (dispatched via att.* actions).

import { TICKETS } from '../core/data.js';
import { registerActions } from '../core/event-delegation.js';
import { showModal } from '../core/modal.js';

function addMockAttachment(id) {
  const t = TICKETS.find(x => x.id === id);
  if (!t) return;
  if (!t.attachments) t.attachments = [];
  const samples = [
    { name: 'screenshot.png', size: '142 KB' },
    { name: 'error-log.txt',  size: '8 KB'   },
    { name: 'invoice.pdf',    size: '218 KB' },
    { name: 'export.csv',     size: '47 KB'  },
    { name: 'recording.mp4',  size: '2.4 MB' },
  ];
  t.attachments.push(samples[t.attachments.length % samples.length]);
  showAttachPanel(id);
}

function removeAttachment(id, idx) {
  const t = TICKETS.find(x => x.id === id);
  if (t && t.attachments) t.attachments.splice(idx, 1);
  showAttachPanel(id);
}

export function showAttachPanel(id) {
  const t = TICKETS.find(x => x.id === id);
  if (!t.attachments) t.attachments = [];
  const list = t.attachments.length
    ? t.attachments.map((a, i) => `
        <div style="display:flex;align-items:center;gap:10px;padding:9px 12px;border:1px solid var(--rule);border-radius:var(--r);margin-bottom:6px;background:var(--off2)">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 1.5h5l3 3v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M8 1.5v3h3" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
          <span style="flex:1;font-size:12px;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${a.name}</span>
          <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${a.size}</span>
          <button class="btn btn-sm btn-danger" data-action="att.remove" data-id="${window.escAttr(id)}" data-idx="${i}" style="padding:2px 8px;font-size:11px">Remove</button>
        </div>`).join('')
    : '<div style="font-size:12px;color:var(--ink3);text-align:center;padding:18px 0">No attachments yet</div>';
  showModal('Attachments', `
    <div class="attach-zone" data-action="att.add" data-id="${window.escAttr(id)}">Click to add a sample attachment</div>
    <div style="margin-top:14px;font-size:11px;color:var(--ink3);text-transform:uppercase;letter-spacing:.06em;font-weight:500;margin-bottom:8px">${t.attachments.length} file${t.attachments.length===1?'':'s'}</div>
    ${list}
  `, null, null);
}

registerActions({
  'att.add':    (ds) => addMockAttachment(ds.id),
  'att.remove': (ds) => removeAttachment(ds.id, parseInt(ds.idx, 10)),
});
