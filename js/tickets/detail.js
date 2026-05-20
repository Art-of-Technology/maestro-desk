// ─── Ticket Detail ────────────────────────────────────────────────────────────
// The per-ticket detail view: header banners (snooze / merged), full sidebar
// (timing, SLA gauge, custom fields, mentions, attachments, linked tickets,
// macros, AI summary, KB suggestions), the activity log, and the compose
// pane with its AI / send / translate / mention controls. Also the New
// Ticket modal entry point (the only "create" flow surfaced from this
// page).
//
// External reaches (interim, via window): escAttr, escHtml, fmtMinutes,
// isAdmin, renderPage, updateNavBadges, navTo — all still in app.js.
//
// TICKETS, CUSTOMERS, AGENTS, TICKET_TEMPLATES come from data.js via the
// global lexical env; SESSION, CURRENT_TICKET, COMPOSE_TAB, AI_THINKING,
// AI_MESSAGES come from core/state.js the same way.

import { summarizeTicket, clearTicketSummary } from '../ai/summarize.js';
import {
  AGENT_PREFERRED_LANG, TRANSLATOR_LANGS,
  translateText, translateMessage, hideMessageTranslation,
  toggleThreadTranslate, toggleAutoTranslateReplies,
  setCustomerLanguage,
} from '../ai/translate.js';
import { aiAction } from '../ai/reply.js';
import { AI_API_KEY } from '../ai/client.js';
import {
  ticketTotalMinutes, ticketBillableMinutes,
  removeTimeEntry, showLogTimeModal,
} from './time-tracking.js';
import {
  formatSnoozeUntil, unsnoozeTicket, showSnoozeModal,
} from './snooze.js';
import {
  BUSINESS_HOURS, isWithinBusinessHours,
  computeTicketSLA, refreshTicketSLA, fmtSLAMinutes,
} from './sla.js';
import {
  unlinkTicket, unmergeTicket,
  showLinkTicketModal, showMergeTicketModal,
} from './linked.js';
import {
  parseMentions, renderTextWithMentions,
  updateMentionDropdown, hideMentionDropdown,
  mentionDropdownKey,
} from './mentions.js';
import { loadDraft, saveDraft, clearDraft } from './drafts.js';
import { logTicketEvent, getTicketEvents } from '../core/activity-log.js';
import { showApplyMacroModal } from './macros.js';
import { showAttachPanel } from './attachments.js';
import { fireWebhook, ticketPayload } from '../webhooks/index.js';
import {
  KB_INTEGRATION, KB_TICKET_CACHE,
  refreshTicketKbSuggestions,
} from '../kb-integration/index.js';
import { showModal, closeModal } from '../core/modal.js';
import { isFieldVisible, isFieldRequired } from '../layouts/index.js';
import { ticketCSATBlock } from './csat.js';
import { runAssignmentRulesOnTicket } from './assignment-rules.js';
import { registerActions, registerChangeActions } from '../core/event-delegation.js';

export function openTicket(id) {
  CURRENT_TICKET = id;
  const t = TICKETS.find(x => x.id === id);
  // Bad ticket IDs can reach here from stale notifications, deep-links
  // pasted from chat, or external modules calling window.openTicket after
  // a delete/merge. Fall back to the list so the page doesn't blank out.
  if (!t) { CURRENT_TICKET = null; return window.renderPage('tickets'); }
  const cust = CUSTOMERS.find(c => c.id === t.customerId);
  const otherTickets = TICKETS.filter(x => x.customerId === t.customerId && x.id !== id && !x.mergedInto);
  const snoozeBanner = (t.snoozedUntil && new Date(t.snoozedUntil).getTime() > Date.now()) ? `
    <div style="margin:0 0 10px;padding:8px 12px;background:var(--off2);border:1px solid var(--rule2);border-radius:var(--r);font-size:11px;color:var(--ink2);display:flex;align-items:center;gap:8px">
      <span style="font-size:14px">💤</span>
      <span style="font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--ink3)">Snoozed</span>
      <span style="color:var(--ink2)">${window.escHtml(formatSnoozeUntil(t.snoozedUntil))}</span>
      ${t.snoozeReason ? `<span style="color:var(--ink3);font-style:italic">· ${window.escHtml(t.snoozeReason)}</span>` : ''}
      <button class="btn btn-sm" style="margin-left:auto" data-action="td.unsnooze" data-ticket-id="${window.escAttr(t.id)}">Wake up</button>
    </div>` : '';
  const mergedFromIds = (t.mergedFrom || []);
  const mergedBanner = t.mergedInto ? `
    <div style="margin:0 0 10px;padding:8px 12px;background:var(--purple-lt);border:1px solid var(--purple);border-radius:var(--r);font-size:11px;color:var(--purple);display:flex;align-items:center;gap:8px">
      <span style="font-weight:600;text-transform:uppercase;letter-spacing:.06em">Merged duplicate</span>
      <span style="color:var(--ink2)">→</span>
      <span class="link" data-action="td.openTicket" data-ticket-id="${window.escAttr(t.mergedInto)}" style="color:var(--purple);font-weight:500">${window.escHtml(t.mergedInto)}</span>
      <span style="color:var(--ink3);font-family:'DM Mono',monospace;font-size:10px">on ${window.escHtml(t.mergedAt || '—')}</span>
      <button class="btn btn-sm" style="margin-left:auto" data-action="td.unmerge" data-ticket-id="${window.escAttr(t.id)}">Un-merge</button>
    </div>` : '';
  const mergedFromBlock = mergedFromIds.length ? `
    <div class="ts-section">
      <div class="ts-heading">Merged duplicates (${mergedFromIds.length})</div>
      ${mergedFromIds.map(mid => {
        const m = TICKETS.find(x => x.id === mid);
        if (!m) return '';
        return `
          <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;padding:6px 0;border-bottom:1px solid var(--rule)">
            <div style="flex:1;min-width:0;cursor:pointer" data-action="td.openTicket" data-ticket-id="${window.escAttr(mid)}">
              <div style="font-size:11.5px;color:var(--ink2);line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${window.escHtml(m.subject)}</div>
              <div style="display:flex;gap:6px;align-items:center;margin-top:4px">
                <span class="tag" style="font-size:9px;background:var(--purple-lt);color:var(--purple);border:1px solid var(--purple)">merged</span>
                <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${window.escHtml(mid)} · ${window.escHtml(m.mergedAt || '—')}</span>
              </div>
            </div>
          </div>`;
      }).join('')}
    </div>` : '';
  const csatScore = cust ? TICKETS.filter(x=>x.customerId===cust.id&&x.csat).reduce((a,x)=>a+x.csat,0) / (TICKETS.filter(x=>x.customerId===cust.id&&x.csat).length||1) : 0;
  const csatColor = csatScore >= 4 ? '#007744' : csatScore >= 3 ? '#0044cc' : '#cc2200';
  const csatPct = Math.round((csatScore/5)*100);
  const circumference = 2*Math.PI*18;
  const dash = (csatPct/100)*circumference;

  const pendingAITags = t.aiTags.filter(x => !x.accepted);
  const aiTagsHtml = pendingAITags.length ? `
    <div class="ts-section">
      <div class="ts-heading">AI Tag Suggestions</div>
      <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px">
        ${pendingAITags.map(at=>`<span class="ai-tag-chip" data-action="td.acceptAITag" data-ticket-id="${window.escAttr(id)}" data-tag="${window.escAttr(at.tag)}">${at.tag} <span class="conf">${at.conf}%</span></span>`).join('')}
      </div>
      <button class="btn btn-sm" data-action="td.acceptAllAITags" data-ticket-id="${window.escAttr(id)}">Accept all</button>
    </div>` : '';

  const times = getTicketTimes(t);
  const timeBlock = `
    <div class="ts-section">
      <div class="ts-heading">Timing</div>
      <div class="ts-row"><span class="ts-key">Created</span><span class="ts-val">${times.created}</span></div>
      <div class="ts-row"><span class="ts-key">Age</span><span class="ts-val">${times.age}</span></div>
      <div class="ts-row"><span class="ts-key">First response</span><span class="ts-val">${times.firstResp}</span></div>
      <div class="ts-row"><span class="ts-key">Last update</span><span class="ts-val">${times.lastUpdate}</span></div>
      ${t.attachments && t.attachments.length ? `<div class="ts-row"><span class="ts-key">Attachments</span><span class="ts-val"><span class="link" data-action="td.showAttach" data-ticket-id="${window.escAttr(id)}">${t.attachments.length}</span></span></div>` : ''}
    </div>`;

  // SLA evaluation block — computed live from policies + ticket timing.
  const sla = computeTicketSLA(t);
  const slaColor = s => s === 'breach' ? 'var(--red)' : s === 'warn' ? 'var(--amber)' : s === 'snoozed' ? 'var(--ink3)' : 'var(--green)';
  const slaBar = (used, total, status) => {
    const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
    return `<div style="height:5px;background:var(--off2);border-radius:3px;overflow:hidden;margin-top:4px"><div style="height:100%;background:${slaColor(status)};width:${pct}%;transition:width .25s"></div></div>`;
  };
  const bhActive = BUSINESS_HOURS.enabled;
  const bhPaused = bhActive && !isWithinBusinessHours(new Date());
  const slaBlock = `
    <div class="ts-section">
      <div class="ts-heading">SLA${bhPaused ? ' <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--ink3);font-size:10px;font-style:italic;margin-left:4px">· paused (outside hours)</span>' : ''}</div>
      ${sla.policy ? `
        <div class="ts-row"><span class="ts-key">Policy</span><span class="ts-val"><span class="link" data-action="td.navTo" data-target="sla">${window.escHtml(sla.policy.name)}</span></span></div>
        ${bhActive ? `<div class="ts-row"><span class="ts-key">Hours</span><span class="ts-val"><span class="link" data-action="td.navTo" data-target="business-hours">Business hours</span></span></div>` : ''}
        <div style="margin-top:10px">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--ink2)">
            <span>First response</span>
            <span style="color:${slaColor(sla.firstResponseStatus)};font-weight:500;text-transform:uppercase;font-size:10px;letter-spacing:.06em">${window.escHtml(sla.firstResponseStatus)}</span>
          </div>
          <div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);margin-top:2px">${fmtSLAMinutes(sla.firstRespMin != null ? sla.firstRespMin : sla.elapsedMin)} ${sla.firstRespMin != null ? 'taken' : 'so far'} · target ${fmtSLAMinutes(sla.policy.firstResponseMin)}</div>
          ${slaBar(sla.firstRespMin != null ? sla.firstRespMin : sla.elapsedMin, sla.policy.firstResponseMin, sla.firstResponseStatus)}
        </div>
        <div style="margin-top:10px">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--ink2)">
            <span>Resolution</span>
            <span style="color:${slaColor(sla.resolutionStatus)};font-weight:500;text-transform:uppercase;font-size:10px;letter-spacing:.06em">${sla.isResolved ? 'resolved' : window.escHtml(sla.resolutionStatus)}</span>
          </div>
          <div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);margin-top:2px">${fmtSLAMinutes(sla.elapsedMin)} elapsed · target ${fmtSLAMinutes(sla.policy.resolutionMin)}</div>
          ${slaBar(sla.elapsedMin, sla.policy.resolutionMin, sla.isResolved ? 'ok' : sla.resolutionStatus)}
        </div>
      ` : `<div style="font-size:11px;color:var(--ink3);font-style:italic">No active policy matches this ticket. Configure one in <span class="link" data-action="td.navTo" data-target="sla">SLA Policies</span>.</div>`}
    </div>`;

  const summarizing = t.aiSummary && t.aiSummary.summarizing;
  const summary = t.aiSummary && !t.aiSummary.summarizing ? t.aiSummary : null;
  const summaryStale = summary && summary.coveredMsgCount !== undefined && summary.coveredMsgCount !== null && (t.msgs || []).length > summary.coveredMsgCount;
  const aiSummaryBlock = summarizing ? `
    <div class="ts-section">
      <div class="ts-heading">AI Summary <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--purple);font-size:10px;font-style:italic;margin-left:4px">generating…</span></div>
      <div style="font-size:11px;color:var(--ink3);font-style:italic">Talking to Claude…</div>
    </div>` : (summary ? `
    <div class="ts-section">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div class="ts-heading" style="margin:0">AI Summary${summaryStale ? '<span class="ts-stale-badge">stale</span>' : ''}</div>
        <span style="display:flex;gap:10px">
          <span class="link" data-action="td.summarize" data-ticket-id="${window.escAttr(id)}" style="font-size:11px">Refresh</span>
          <span class="link" data-action="td.clearSummary" data-ticket-id="${window.escAttr(id)}" style="font-size:11px;color:var(--ink3)">×</span>
        </span>
      </div>
      ${summary.error ? `<div style="font-size:11px;color:var(--red);font-style:italic">${window.escHtml(summary.error)}</div>` : `
        <div style="font-size:12px;color:var(--ink);line-height:1.5;margin-bottom:8px">${window.escHtml(summary.tldr || '')}</div>
        ${summary.issue ? `<div style="font-size:11px;color:var(--ink2);line-height:1.5;margin-bottom:4px"><strong style="color:var(--purple);text-transform:uppercase;font-size:10px;letter-spacing:.06em">Issue · </strong>${window.escHtml(summary.issue)}</div>` : ''}
        ${summary.done ? `<div style="font-size:11px;color:var(--ink2);line-height:1.5;margin-bottom:4px"><strong style="color:var(--green);text-transform:uppercase;font-size:10px;letter-spacing:.06em">Done · </strong>${window.escHtml(summary.done)}</div>` : ''}
        ${summary.next ? `<div style="font-size:11px;color:var(--ink2);line-height:1.5;margin-bottom:4px"><strong style="color:var(--amber);text-transform:uppercase;font-size:10px;letter-spacing:.06em">Next · </strong>${window.escHtml(summary.next)}</div>` : ''}
        <div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);margin-top:6px">covered ${summary.coveredMsgCount || 0} msg${summary.coveredMsgCount === 1 ? '' : 's'} · ${window.escHtml((summary.generatedAt || '').slice(0, 16).replace('T', ' '))}</div>
      `}
    </div>` : '');

  const followers = t.followers || [];
  const watching = SESSION ? followers.includes(SESSION.name) : false;
  const followerAvatars = followers.map(name => {
    const ag = AGENTS.find(a => a.name === name);
    const initials = ag ? ag.initials : (name.split(/\s+/).map(w => w[0]).join('').slice(0,2).toUpperCase());
    return `<div title="${name}" style="width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,var(--purple),#22d3ee);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:600;color:#fff;flex-shrink:0;margin-left:-6px;border:2px solid var(--off)">${initials}</div>`;
  }).join('');
  const followersBlock = `
    <div class="ts-section">
      <div class="ts-heading">Followers (${followers.length})</div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <div style="display:flex;padding-left:6px">${followerAvatars || '<span style="font-size:11px;color:var(--ink3)">No followers yet</span>'}</div>
        <button class="btn btn-sm" data-action="td.toggleWatch" data-ticket-id="${window.escAttr(id)}">${watching ? 'Unfollow' : 'Follow'}</button>
      </div>
    </div>`;

  const kbSuggestions = getSuggestedKB(t);
  const kbBlock = kbSuggestions.length ? `
    <div class="ts-section">
      <div class="ts-heading">Suggested KB</div>
      ${kbSuggestions.map(a => `
        <div data-action="td.openKB" data-kb-id="${window.escAttr(a.id)}" style="padding:8px 10px;border:1px solid var(--rule);border-radius:var(--r);cursor:pointer;margin-bottom:5px;background:var(--off2);transition:all .15s" onmouseover="this.style.borderColor='var(--purple)'" onmouseout="this.style.borderColor='var(--rule)'">
          <div style="font-size:10px;color:var(--purple);text-transform:uppercase;letter-spacing:.04em;font-weight:600;margin-bottom:2px">${a.category}</div>
          <div style="font-size:12px;color:var(--ink);font-weight:500;line-height:1.3">${a.title}</div>
        </div>`).join('')}
    </div>` : '';

  // External-KB suggestions are fetched lazily and cached by ticket id. The
  // sidebar shows a loading shimmer first paint, then the results on the
  // re-render. If the integration is disabled the whole block stays hidden.
  let extKbBlock = '';
  if (KB_INTEGRATION.enabled) {
    const cache = KB_TICKET_CACHE.get(t.id);
    if (cache === undefined) setTimeout(() => refreshTicketKbSuggestions(t.id), 0);
    const head = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div class="ts-heading" style="margin:0">External KB</div>
        <span class="link" data-action="td.refreshKB" data-ticket-id="${window.escAttr(t.id)}" style="font-size:11px">Refresh</span>
      </div>`;
    let body = '';
    if (!cache || cache.loading) body = '<div style="font-size:11px;color:var(--ink3);font-style:italic">Searching your KB…</div>';
    else if (cache.error)        body = `<div style="font-size:11px;color:var(--red);font-style:italic">${window.escHtml(cache.error)}</div>`;
    else if (!cache.articles.length) body = '<div style="font-size:11px;color:var(--ink3);font-style:italic">No matching articles.</div>';
    else body = cache.articles.map(a => {
      // External URL goes into an href, so escape with escHtml (handles ", &,
      // <, >). Also restrict to http(s) so a malicious KB can't ship a
      // javascript: link that runs on click.
      const safeUrl = (typeof a.url === 'string' && /^https?:\/\//i.test(a.url.trim())) ? a.url.trim() : '';
      return `
      <div style="padding:8px 10px;border:1px solid var(--rule);border-radius:var(--r);margin-bottom:5px;background:var(--off2)">
        ${safeUrl ? `<a href="${window.escHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" style="font-size:12px;color:var(--ink);font-weight:500;text-decoration:none;line-height:1.3">${window.escHtml(a.title)} ↗</a>` : `<div style="font-size:12px;color:var(--ink);font-weight:500;line-height:1.3">${window.escHtml(a.title)}</div>`}
        ${a.body ? `<div style="font-size:11px;color:var(--ink3);margin-top:4px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${window.escHtml(String(a.body).slice(0, 200))}</div>` : ''}
      </div>`;
    }).join('');
    extKbBlock = `<div class="ts-section">${head}${body}</div>`;
  }

  const totalTimeMin    = ticketTotalMinutes(t);
  const billableTimeMin = ticketBillableMinutes(t);
  const recentTime      = (t.timeEntries || []).slice(0, 4);
  const timeLogBlock = `
    <div class="ts-section">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div class="ts-heading" style="margin:0">Time logged${totalTimeMin ? ` · ${window.fmtMinutes(totalTimeMin)}` : ''}</div>
        <span class="link" data-action="td.logTime" data-ticket-id="${window.escAttr(id)}" style="font-size:11px">+ Log time</span>
      </div>
      ${totalTimeMin ? `
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--ink2);margin-bottom:8px">
          <span>Total <strong style="color:var(--ink)">${window.fmtMinutes(totalTimeMin)}</strong></span>
          <span>Billable <strong style="color:${billableTimeMin === totalTimeMin ? 'var(--ink)' : 'var(--amber)'}">${window.fmtMinutes(billableTimeMin)}</strong></span>
        </div>
        ${recentTime.map(e => `
          <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;padding:6px 0;border-bottom:1px solid var(--rule)">
            <div style="flex:1;min-width:0">
              <div style="font-size:11.5px;color:var(--ink);font-weight:500">${window.fmtMinutes(e.minutes)}${e.billable === false ? ' <span style="color:var(--ink3);font-weight:400;font-size:10px">· non-billable</span>' : ''}</div>
              ${e.note ? `<div style="font-size:11px;color:var(--ink2);font-style:italic;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">"${window.escHtml(e.note)}"</div>` : ''}
              <div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);margin-top:2px">${window.escHtml(e.agent)} · ${window.escHtml(e.ts)}</div>
            </div>
            <button data-action="td.removeTime" data-ticket-id="${window.escAttr(id)}" data-entry-id="${window.escAttr(e.id)}" style="background:transparent;border:none;color:var(--ink3);cursor:pointer;font-size:14px;padding:4px 6px;line-height:1" onmouseover="this.style.color='var(--red)'" onmouseout="this.style.color='var(--ink3)'" title="Remove entry">×</button>
          </div>`).join('')}
      ` : `<div style="font-size:11px;color:var(--ink3);text-align:center;padding:8px 0">No time logged yet</div>`}
    </div>`;

  const linkedIds = t.linked || [];
  const linkedBlock = `
    <div class="ts-section">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div class="ts-heading" style="margin:0">Linked tickets (${linkedIds.length})</div>
        <span style="display:flex;gap:10px">
          <span class="link" data-action="td.linkTicket" data-ticket-id="${window.escAttr(id)}" style="font-size:11px">+ Link</span>
          ${t.mergedInto ? '' : `<span class="link" data-action="td.mergeTicket" data-ticket-id="${window.escAttr(id)}" style="font-size:11px">↩ Merge</span>`}
        </span>
      </div>
      ${linkedIds.length ? linkedIds.map(linkedId => {
        const lt = TICKETS.find(x => x.id === linkedId);
        if (!lt) return '';
        return `
          <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;padding:7px 0;border-bottom:1px solid var(--rule)">
            <div style="flex:1;min-width:0;cursor:pointer" data-action="td.openTicket" data-ticket-id="${window.escAttr(linkedId)}">
              <div style="font-size:11.5px;color:var(--ink2);line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${lt.subject}</div>
              <div style="display:flex;gap:6px;align-items:center;margin-top:4px">
                <span class="tag tag-${lt.status}" style="font-size:9px">${lt.status}</span>
                <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${window.escHtml(linkedId)}</span>
              </div>
            </div>
            <button data-action="td.unlink" data-ticket-id="${window.escAttr(id)}" data-linked-id="${window.escAttr(linkedId)}" style="background:transparent;border:none;color:var(--ink3);cursor:pointer;font-size:14px;padding:4px 6px;flex-shrink:0;line-height:1" onmouseover="this.style.color='var(--red)'" onmouseout="this.style.color='var(--ink3)'" title="Unlink">×</button>
          </div>`;
      }).join('') : '<div style="font-size:11px;color:var(--ink3);text-align:center;padding:8px 0">No linked tickets</div>'}
    </div>`;

  const eventColors = { status:'var(--cyan)', priority:'var(--amber)', agent:'var(--purple)', tag:'var(--green)', system:'var(--ink3)' };
  const events = getTicketEvents(t);
  const activityBlock = events.length ? `
    <div class="ts-section">
      <div class="ts-heading">Activity (${events.length})</div>
      <div style="max-height:240px;overflow-y:auto;margin-right:-4px;padding-right:4px">
        ${events.slice(0, 12).map(e => `
          <div style="display:flex;gap:8px;padding:6px 0;border-bottom:1px solid var(--rule)">
            <div style="width:6px;height:6px;border-radius:50%;background:${eventColors[e.type] || 'var(--ink4)'};margin-top:5px;flex-shrink:0"></div>
            <div style="flex:1;min-width:0">
              <div style="font-size:11px;color:var(--ink2);line-height:1.4;word-break:break-word">${e.details}</div>
              <div style="font-size:10px;color:var(--ink3);font-family:'DM Mono',monospace;margin-top:2px">${e.author === 'System' ? '' : e.author + ' · '}${e.ts}</div>
            </div>
          </div>`).join('')}
      </div>
    </div>` : '';

  const threadOn = !!t.translateThread;
  const msgsHtml = t.msgs.map((m, i) => {
    let translateBlock = '';
    let bodyText = m.t;
    let bodyNote = '';

    if (m.r === 'customer') {
      // Thread translation: show translation as the primary body when available
      if (threadOn && m.translatedFor === AGENT_PREFERRED_LANG && m.translation) {
        bodyText = m.translation;
        bodyNote = `<div style="margin-top:6px;font-size:10px;color:var(--ink3);font-style:italic">Translated from ${window.escHtml(t.detectedCustomerLang || 'auto')} → ${window.escHtml(AGENT_PREFERRED_LANG)} · <span class="link" data-action="td.hideTranslation" data-ticket-id="${window.escAttr(id)}" data-msg-idx="${i}">show original</span></div>`;
      } else if (m.translating) {
        translateBlock = '<div style="margin-top:8px;padding-top:8px;border-top:1px dashed var(--rule);font-size:11px;color:var(--purple);font-style:italic">Translating…</div>';
      } else if (m.translation) {
        translateBlock = `<div style="margin-top:8px;padding-top:8px;border-top:1px dashed var(--rule)">
          <div style="font-size:10px;color:var(--ink3);text-transform:uppercase;letter-spacing:.06em;font-weight:500;margin-bottom:4px">Translation</div>
          <div style="font-size:13px;color:var(--ink2);font-style:italic;line-height:1.55">${window.escHtml(m.translation)}</div>
          <div style="margin-top:6px"><span class="link" style="font-size:11px" data-action="td.hideTranslation" data-ticket-id="${window.escAttr(id)}" data-msg-idx="${i}">Hide translation</span></div>
        </div>`;
      } else {
        translateBlock = `<div style="margin-top:6px"><span class="link" style="font-size:11px" data-action="td.translateMsg" data-ticket-id="${window.escAttr(id)}" data-msg-idx="${i}">Translate</span></div>`;
      }
    } else if ((m.r === 'agent' || m.r === 'note') && m.tOriginal) {
      // Agent reply that was auto-translated for the customer — show what the agent typed
      bodyText = m.tOriginal;
      bodyNote = `<div style="margin-top:6px;font-size:10px;color:var(--ink3);font-style:italic">→ Sent to customer in ${window.escHtml(m.translatedTo || 'their language')} · <span class="link" data-action="td.showSentText" data-ticket-id="${window.escAttr(id)}" data-msg-idx="${i}">view sent text</span></div>`;
    }

    const bodyHtml = m.r === 'note'
      ? renderTextWithMentions(bodyText)
      : window.escHtml(bodyText).replace(/\n/g, '<br>');
    return `
    <div class="msg msg-${m.r}">
      <div class="msg-from">${window.escHtml(m.from)} ${m.r==='ai'?'<span class="ai-mark">AI</span>':''} ${m.r==='note'?'<span class="note-mark">Note</span>':''}<span style="margin-left:auto;font-family:'Inter',sans-serif;font-size:11px;color:var(--ink3)">${window.escHtml(m.ts)}</span></div>
      ${bodyHtml}
      ${bodyNote}
      ${translateBlock}
    </div>`;
  }).join('');

  // Thread translation toolbar — sits above the message thread
  const customerLangLabel = t.detectedCustomerLang
    ? `<span style="color:var(--ink2)">Customer language: <strong style="color:var(--ink)">${window.escHtml(t.detectedCustomerLang)}</strong></span>`
    : `<span style="color:var(--ink3);font-style:italic">Customer language: not yet detected</span>`;
  const langOptions = TRANSLATOR_LANGS.map(l => `<option value="${l}" ${t.detectedCustomerLang===l?'selected':''}>${l}</option>`).join('');
  const threadBarHtml = `
    <div style="padding:8px 14px;border-bottom:1px solid var(--rule);background:var(--off2);display:flex;align-items:center;gap:14px;flex-wrap:wrap;font-size:12px">
      <label class="auth-check" style="margin:0">
        <input type="checkbox" ${threadOn?'checked':''} data-change-action="td.toggleThreadTranslate" data-ticket-id="${window.escAttr(id)}">
        <span>Translate thread to <strong style="color:var(--ink)">${window.escHtml(AGENT_PREFERRED_LANG)}</strong></span>
      </label>
      <span style="color:var(--rule2)">·</span>
      ${customerLangLabel}
      ${(threadOn || t.autoTranslateReplies) ? `<select class="filter-select" data-change-action="td.setCustomerLang" data-ticket-id="${window.escAttr(id)}" style="font-size:11px;padding:3px 8px"><option value="">— override —</option>${langOptions}</select>` : ''}
      <span style="color:var(--rule2)">·</span>
      <label class="auth-check" style="margin:0">
        <input type="checkbox" ${t.autoTranslateReplies?'checked':''} data-change-action="td.toggleAutoTranslate" data-ticket-id="${window.escAttr(id)}">
        <span>Send replies in customer language</span>
      </label>
      ${!AI_API_KEY ? '<span style="margin-left:auto;color:var(--amber);font-family:\'DM Mono\',monospace;font-size:10px">Add API key in Settings → AI</span>' : ''}
    </div>`;

  const main = document.getElementById('main-area');
  main.innerHTML = `
    <div class="page">
      <div class="topbar">
        <div class="tb-breadcrumb">
          <span data-action="td.openTicketsList">Tickets</span>
          <span class="tb-sep">/</span>
          <span style="color:var(--ink);font-weight:500">${t.id}</span>
          <span style="margin-left:auto;display:flex;gap:6px;align-items:center">
            <button class="btn btn-sm" data-action="td.prev">← Prev</button>
            <button class="btn btn-sm" data-action="td.next">Next →</button>
            <span style="width:1px;background:var(--rule);align-self:stretch;margin:0 4px"></span>
            ${t.mergedInto ? '' : `<button class="btn btn-sm" data-action="td.summarize" data-ticket-id="${window.escAttr(id)}" title="Generate an AI summary of this ticket"${summarizing ? ' disabled' : ''}>${summarizing ? '⏳' : '📝'} Summarize</button>`}
            ${t.mergedInto ? '' : `<button class="btn btn-sm" data-action="td.macroModal" data-ticket-id="${window.escAttr(id)}" title="Apply a macro">⚡ Macro</button>`}
            ${t.mergedInto ? '' : `<button class="btn btn-sm" data-action="td.runRules" data-ticket-id="${window.escAttr(id)}" title="Auto-assign by rules">⇄ Run rules</button>`}
            ${t.status !== 'escalated' && t.status !== 'resolved' ? `<button class="btn btn-sm" data-action="td.quickStatus" data-ticket-id="${window.escAttr(id)}" data-status="escalated">Escalate</button>` : ''}
            ${t.status !== 'resolved' ? (t.snoozedUntil
              ? `<button class="btn btn-sm" data-action="td.unsnooze" data-ticket-id="${window.escAttr(id)}" title="Wake the ticket up now">💤 Wake up</button>`
              : `<button class="btn btn-sm" data-action="td.snooze" data-ticket-id="${window.escAttr(id)}" title="Pause SLA until a chosen time">💤 Snooze</button>`) : ''}
            ${t.status !== 'resolved'
              ? `<button class="btn btn-sm btn-solid" data-action="td.quickStatus" data-ticket-id="${window.escAttr(id)}" data-status="resolved">Resolve</button>`
              : `<button class="btn btn-sm" data-action="td.quickStatus" data-ticket-id="${window.escAttr(id)}" data-status="open">Reopen</button>`}
          </span>
        </div>
      </div>
      <div style="padding:14px 20px 10px;border-bottom:1px solid var(--rule);flex-shrink:0">
        ${mergedBanner}
        ${snoozeBanner}
        <div style="font-family:\'Syne\',sans-serif;font-size:17px;font-weight:700;color:var(--ink);letter-spacing:-.02em;margin-bottom:7px">${t.subject}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          <span class="tag tag-${t.status}">${t.status}</span>
          <span class="tag tag-${t.priority}">${t.priority}</span>
          <span class="tag tag-neutral">${t.category}</span>
          ${t.tags.map(tg=>`<span class="tag tag-neutral" style="display:inline-flex;align-items:center;gap:4px">${tg}<span style="cursor:pointer;color:var(--ink3);font-weight:400" data-action="td.removeTag" data-ticket-id="${window.escAttr(id)}" data-tag="${window.escAttr(tg)}" title="Remove tag">×</span></span>`).join('')}
          <input id="tag-add-${id}" data-tag-add-id="${window.escAttr(id)}" placeholder="+ tag" style="background:transparent;border:1px dashed var(--rule2);border-radius:3px;padding:2px 8px;font-size:10px;color:var(--ink2);width:90px;outline:none;font-family:'Inter',sans-serif;letter-spacing:.03em;text-transform:uppercase"/>
          <span style="font-family:'Inter',sans-serif;font-size:11px;color:var(--ink3);margin-left:auto">SLA: <span class="sla-${t.sla}">${t.sla.toUpperCase()}</span></span>
        </div>
      </div>
      <div class="ticket-layout">
        <div class="ticket-main">
          ${threadBarHtml}
          <div class="thread" id="thread-${id}">${msgsHtml}</div>
          <div class="composer">
            <div class="composer-tabs">
              <div class="ctab ${COMPOSE_TAB==='reply'?'active':''}" onclick="setComposeTab('reply','${id}')">Reply</div>
              <div class="ctab ${COMPOSE_TAB==='note'?'active':''}" onclick="setComposeTab('note','${id}')">Internal note</div>
              <div style="margin-left:auto;display:flex;gap:4px;align-items:center;padding:0 12px">
                <span style="font-size:10px;color:var(--ink3);text-transform:uppercase;letter-spacing:.06em;font-weight:500;margin-right:4px">Insert</span>
                <button class="comp-var-btn" onclick="insertVar('${id}','{name}')" title="Customer first name">{name}</button>
                <button class="comp-var-btn" onclick="insertVar('${id}','{ticket}')" title="Ticket ID">{ticket}</button>
                <button class="comp-var-btn" onclick="insertVar('${id}','{brand}')" title="Customer brand">{brand}</button>
                <button class="comp-var-btn" onclick="insertVar('${id}','{agent}')" title="Assigned agent">{agent}</button>
              </div>
            </div>
            <div class="composer-body">
              <textarea class="compose-area" id="compose-${id}" placeholder="${COMPOSE_TAB==='reply'?'Write a reply or use AI…':'Add an internal note… type @ to mention an agent'}" oninput="onComposeInput('${id}')" onkeydown="if(mentionDropdownKey(event,'${id}'))return;" onblur="setTimeout(hideMentionDropdown,150)">${window.escHtml(loadDraft(id))}</textarea>
              <div class="comp-meta">
                <span id="draft-status-${id}">${loadDraft(id) ? 'Draft restored' : ''}</span>
                <span id="char-count-${id}">${loadDraft(id).length} chars</span>
              </div>
              <div class="composer-foot">
                <div class="composer-actions">
                  <select class="filter-select" id="status-sel-${id}" onchange="changeTicketStatus('${id}',this.value)">
                    <option value="open" ${t.status==='open'?'selected':''}>Open</option>
                    <option value="pending" ${t.status==='pending'?'selected':''}>Pending</option>
                    <option value="escalated" ${t.status==='escalated'?'selected':''}>Escalated</option>
                    <option value="resolved" ${t.status==='resolved'?'selected':''}>Resolved</option>
                  </select>
                  <button class="btn btn-sm" onclick="showMacroPanel('${id}')">Macros</button>
                  <button class="btn btn-sm" onclick="showAttachPanel('${id}')">Attach${t.attachments&&t.attachments.length?' · '+t.attachments.length:''}</button>
                  <button class="btn btn-sm btn-danger" onclick="showGDPRModal('${id}')">GDPR</button>
                  <div class="thinking" id="thinking-${id}"><span class="dot">·</span><span class="dot">·</span><span class="dot">·</span>&nbsp;working</div>
                </div>
                <div style="display:flex;gap:6px;align-items:center">
                  ${COMPOSE_TAB==='reply' ? `
                  <div style="position:relative;display:inline-block">
                    <button class="btn btn-sm" onclick="toggleAIMenu('${id}')">AI ▾</button>
                    <div id="ai-menu-${id}" class="comp-menu">
                      <div class="comp-menu-item" onclick="aiAction('${id}','draft')">Draft reply</div>
                      ${KB_INTEGRATION.enabled ? `<div class="comp-menu-item" onclick="aiAction('${id}','kb-reply')" title="Draft a reply grounded in your external KB">Draft reply with KB</div>` : ''}
                      <div class="comp-menu-item" onclick="aiAction('${id}','improve')">Improve writing</div>
                      <div class="comp-menu-item" onclick="aiAction('${id}','shorten')">Shorten</div>
                      <div class="comp-menu-item" onclick="aiAction('${id}','lengthen')">Add detail</div>
                      <div class="comp-menu-item" onclick="aiAction('${id}','friendly')">Friendlier tone</div>
                      <div class="comp-menu-item" onclick="aiAction('${id}','formal')">More formal</div>
                      <div class="comp-menu-item" onclick="aiAction('${id}','translate')">Translate to English</div>
                    </div>
                  </div>` : ''}
                  <div style="position:relative;display:inline-flex">
                    <button class="btn btn-sm btn-solid" style="border-radius:var(--r) 0 0 var(--r);border-right:1px solid rgba(255,255,255,0.25)" onclick="sendCompose('${id}')">${COMPOSE_TAB==='reply'?'Send':'Add note'}</button>
                    <button class="btn btn-sm btn-solid" style="border-radius:0 var(--r) var(--r) 0;padding:5px 8px" onclick="toggleSendMenu('${id}')" title="More send options">▾</button>
                    <div id="send-menu-${id}" class="comp-menu">
                      <div class="comp-menu-item" onclick="sendComposeAnd('${id}','resolved')">${COMPOSE_TAB==='reply'?'Send':'Add note'} and resolve</div>
                      <div class="comp-menu-item" onclick="sendComposeAnd('${id}','pending')">${COMPOSE_TAB==='reply'?'Send':'Add note'} and set pending</div>
                      <div class="comp-menu-item" onclick="sendComposeAnd('${id}','escalated')">${COMPOSE_TAB==='reply'?'Send':'Add note'} and escalate</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="ticket-sidebar">
          ${cust?`
          <div class="ts-section" style="cursor:pointer" data-action="td.openCustomer" data-cust-id="${window.escAttr(cust.id)}">
            <div class="ts-heading">Customer</div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
              <div style="width:32px;height:32px;border-radius:50%;background:var(--ink);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;color:var(--w);flex-shrink:0">${cust.first[0]}${cust.last[0]}</div>
              <div><div style="font-size:12px;font-weight:500;color:var(--ink)">${cust.first} ${cust.last}</div><div style="font-family:'Inter',sans-serif;font-size:11px;color:var(--ink3)">${cust.id}</div></div>
            </div>
            <div class="ts-row"><span class="ts-key">Brand</span><span class="ts-val">${cust.brand}</span></div>
            <div class="ts-row"><span class="ts-key">VIP</span><span class="vip-badge vip-${cust.vip.toLowerCase()}">${cust.vip}</span></div>
            <div class="ts-row"><span class="ts-key">Jurisdiction</span><span class="ts-val">${cust.jurisdiction}</span></div>
          </div>`:``}
          <div class="ts-section">
            <div class="ts-heading">CSAT</div>
            <div class="csat-ring-wrap">
              <div class="csat-ring">
                <svg width="44" height="44" viewBox="0 0 44 44"><circle cx="22" cy="22" r="18" fill="none" stroke="var(--rule)" stroke-width="4"/><circle cx="22" cy="22" r="18" fill="none" stroke="${csatColor}" stroke-width="4" stroke-dasharray="${dash} ${circumference-dash}" stroke-linecap="round"/></svg>
                <div class="csat-inner" style="color:${csatColor};font-size:10px">${csatScore>0?csatScore.toFixed(1):'—'}</div>
              </div>
              <div style="font-size:11px;color:var(--ink2)">Avg score<br/><span style="color:var(--ink3);font-family:'Inter',sans-serif;font-size:11px">${TICKETS.filter(x=>x.customerId===t.customerId&&x.csat).length} rated tickets</span></div>
            </div>
          </div>
          ${aiSummaryBlock}
          ${ticketCSATBlock(t)}
          ${timeBlock}
          ${slaBlock}
          ${aiTagsHtml}
          ${followersBlock}
          ${kbBlock}
          ${extKbBlock}
          ${timeLogBlock}
          <div class="ts-section">
            <div class="ts-heading">Properties</div>
            <select class="ts-select" data-change-action="td.setStatus" data-ticket-id="${window.escAttr(id)}">
              <option value="open" ${t.status==='open'?'selected':''}>Open</option>
              <option value="pending" ${t.status==='pending'?'selected':''}>Pending</option>
              <option value="escalated" ${t.status==='escalated'?'selected':''}>Escalated</option>
              <option value="gdpr" ${t.status==='gdpr'?'selected':''}>GDPR</option>
              <option value="resolved" ${t.status==='resolved'?'selected':''}>Resolved</option>
            </select>
            <select class="ts-select" data-change-action="td.setPriority" data-ticket-id="${window.escAttr(id)}">
              <option value="urgent" ${t.priority==='urgent'?'selected':''}>Urgent</option>
              <option value="high" ${t.priority==='high'?'selected':''}>High</option>
              <option value="normal" ${t.priority==='normal'?'selected':''}>Normal</option>
              <option value="low" ${t.priority==='low'?'selected':''}>Low</option>
            </select>
            <select class="ts-select" data-change-action="td.setAgent" data-ticket-id="${window.escAttr(id)}">
              ${AGENTS.map(a=>`<option value="${window.escAttr(a.name)}" ${t.agent===a.name?'selected':''}>${window.escHtml(a.name)}${isAgentOOO(a.name) ? ' (OOO)' : ''}</option>`).join('')}
            </select>
          </div>
          ${t.status==='gdpr'||t.category==='GDPR'?`
          <div class="ts-section">
            <div class="ts-heading">GDPR Actions</div>
            <button class="btn btn-sm btn-danger" style="width:100%;margin-bottom:5px;justify-content:center" data-action="td.gdprErasure">Request Erasure</button>
            <button class="btn btn-sm" style="width:100%;margin-bottom:5px;justify-content:center" data-action="td.gdprRedact">Redact Data</button>
            <button class="btn btn-sm" style="width:100%;justify-content:center" data-action="td.gdprExport">SAR Export</button>
          </div>`:''}
          ${mergedFromBlock}
          ${linkedBlock}
          ${otherTickets.length?`
          <div class="ts-section">
            <div class="ts-heading">Other tickets (${otherTickets.length})</div>
            ${otherTickets.map(ot=>`
              <div class="other-ticket" data-action="td.openTicket" data-ticket-id="${window.escAttr(ot.id)}">
                <div class="other-ticket-subj">${ot.subject}</div>
                <span class="tag tag-${ot.status}">${ot.status}</span>
              </div>`).join('')}
          </div>`:''}
          ${activityBlock}
        </div>
      </div>
    </div>`;
}

export function setComposeTab(tab, id) { COMPOSE_TAB = tab; openTicket(id); }

function getTicketTimes(t) {
  const msgs = t.msgs || [];
  const customerMsgs = msgs.filter(m => m.r === 'customer');
  const agentMsgs = msgs.filter(m => m.r === 'agent' || m.r === 'ai');

  let firstResp = '—';
  if (customerMsgs.length && agentMsgs.length) {
    const cust = customerMsgs[0];
    const agentAfter = agentMsgs.find(a => msgs.indexOf(a) > msgs.indexOf(cust));
    if (agentAfter && /^\d+:\d+/.test(cust.ts) && /^\d+:\d+/.test(agentAfter.ts)) {
      const [ch, cm] = cust.ts.split(':').map(Number);
      const [ah, am] = agentAfter.ts.split(':').map(Number);
      const diff = Math.max(0, (ah - ch) * 60 + (am - cm));
      firstResp = diff === 0 ? '< 1m' : diff < 60 ? `${diff}m` : `${Math.floor(diff/60)}h ${diff%60}m`;
    }
  }

  let age = '—';
  if (t.created) {
    const created = new Date(t.created);
    const today = new Date('2025-04-16');
    const days = Math.max(0, Math.floor((today - created) / 86400000));
    age = days === 0 ? 'today' : days === 1 ? '1 day' : `${days} days`;
  }

  return { firstResp, age, created: t.created || '—', lastUpdate: t.updated || '—' };
}

function getSuggestedKB(t) {
  const tokens = (t.subject || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3);
  const cat = (t.category || '').toLowerCase();
  const scored = KB_ARTICLES.map(a => {
    let score = 0;
    if (a.category.toLowerCase() === cat) score += 3;
    const text = (a.title + ' ' + a.body).toLowerCase();
    tokens.forEach(tok => { if (text.includes(tok)) score += 1; });
    return { a, score };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
  return scored.map(s => s.a);
}

export function toggleWatch(id) {
  const t = TICKETS.find(x => x.id === id);
  if (!t || !SESSION) return;
  if (!t.followers) t.followers = [];
  const idx = t.followers.indexOf(SESSION.name);
  if (idx >= 0) t.followers.splice(idx, 1);
  else t.followers.push(SESSION.name);
  openTicket(id);
}

export function insertMacro(ticketId, idx) {
  const r = CANNED_RESPONSES[idx];
  if (!r) return;
  const t = TICKETS.find(x => x.id === ticketId);
  const cust = t ? CUSTOMERS.find(c => c.id === t.customerId) : null;
  const text = r.text.replace('{name}', cust ? cust.first : 'there');
  const el = document.getElementById('compose-' + ticketId);
  if (el) {
    el.value = el.value ? `${el.value}\n\n${text}` : text;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }
  closeModal();
}

export function changeTicketStatus(id, val) {
  const t = TICKETS.find(x => x.id === id);
  if (!t || t.status === val) return;
  const prevSla = t.sla;
  logTicketEvent(id, 'status', `Status: ${t.status} → ${val}`);
  t.status = val;
  refreshTicketSLA(t);
  if (val === 'resolved' && !t.csatRequestedAt && !t.csat) {
    t.csatRequestedAt = new Date().toISOString().slice(0, 10);
    logTicketEvent(id, 'system', 'CSAT survey sent to customer');
  }
  window.updateNavBadges();
  if (CURRENT_TICKET === id) openTicket(id);
  if (val === 'resolved')   fireWebhook('ticket.resolved',  ticketPayload(t));
  if (val === 'escalated')  fireWebhook('ticket.escalated', ticketPayload(t));
  if (prevSla !== 'breach' && t.sla === 'breach') fireWebhook('sla.breach', ticketPayload(t));
}
export function quickStatus(id, val) { changeTicketStatus(id, val); }
export function addTicketTag(id, raw) {
  const tag = String(raw || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  if (!tag) return;
  const t = TICKETS.find(x => x.id === id); if (!t) return;
  if (!t.tags) t.tags = [];
  if (!t.tags.includes(tag)) {
    t.tags.push(tag);
    logTicketEvent(id, 'tag', `Tagged: ${tag}`);
    const lib = TAG_LIBRARY.find(x => x.tag === tag);
    if (lib) lib.count++;
    else TAG_LIBRARY.push({ tag, count: 1, type: 'manual', conf: null });
  }
  openTicket(id);
}
export function removeTicketTag(id, tag) {
  const t = TICKETS.find(x => x.id === id); if (!t) return;
  if ((t.tags || []).includes(tag)) {
    logTicketEvent(id, 'tag', `Tag removed: ${tag}`);
  }
  t.tags = (t.tags || []).filter(x => x !== tag);
  const lib = TAG_LIBRARY.find(x => x.tag === tag);
  if (lib && lib.count > 0) lib.count--;
  openTicket(id);
}
export function changeTicketPriority(id, val) {
  const t = TICKETS.find(x => x.id === id);
  if (!t || t.priority === val) return;
  logTicketEvent(id, 'priority', `Priority: ${t.priority} → ${val}`);
  t.priority = val;
  refreshTicketSLA(t);
  if (CURRENT_TICKET === id) openTicket(id);
}
export function changeTicketAgent(id, val) {
  const t = TICKETS.find(x => x.id === id);
  if (!t) return;
  const old = t.agent || 'Unassigned';
  if (old === val) return;
  logTicketEvent(id, 'agent', `Reassigned: ${old} → ${val}`);
  t.agent = val;
  if (CURRENT_TICKET === id) openTicket(id);
  fireWebhook('ticket.assigned', { ...ticketPayload(t), previousAgent: old });
}

export function acceptAITag(ticketId, tagName) {
  const t = TICKETS.find(x=>x.id===ticketId);
  const at = t.aiTags.find(x=>x.tag===tagName);
  if(at) { at.accepted=true; t.tags.push(tagName); }
  openTicket(ticketId);
}
export function acceptAllAITags(ticketId) {
  const t = TICKETS.find(x=>x.id===ticketId);
  t.aiTags.forEach(at => { if(!at.accepted){ at.accepted=true; t.tags.push(at.tag); } });
  openTicket(ticketId);
}
export function prevNextTicket(dir) {
  const idx = TICKETS.findIndex(t => t.id === CURRENT_TICKET);
  const next = TICKETS[idx + dir];
  if (next) openTicket(next.id);
}


export function onComposeInput(id) {
  const el = document.getElementById('compose-' + id);
  if (!el) return;
  saveDraft(id, el.value);
  const cc = document.getElementById('char-count-' + id);
  if (cc) cc.textContent = `${el.value.length} chars`;
  const ds = document.getElementById('draft-status-' + id);
  if (ds) ds.textContent = el.value.length ? 'Draft saved' : '';
  if (COMPOSE_TAB === 'note') updateMentionDropdown(id, el);
  else hideMentionDropdown();
}


export function insertVar(id, token) {
  const t = TICKETS.find(x => x.id === id);
  const cust = t ? CUSTOMERS.find(c => c.id === t.customerId) : null;
  let val = token;
  if (token === '{name}'   && cust) val = cust.first;
  else if (token === '{ticket}')    val = id;
  else if (token === '{brand}' && cust) val = cust.brand;
  else if (token === '{agent}' && t) val = t.agent || '';
  const el = document.getElementById('compose-' + id);
  if (!el) return;
  el.focus();
  const start = el.selectionStart || 0;
  const end   = el.selectionEnd   || 0;
  el.value = el.value.slice(0, start) + val + el.value.slice(end);
  const pos = start + val.length;
  el.setSelectionRange(pos, pos);
  onComposeInput(id);
}

export function toggleAIMenu(id) {
  const m = document.getElementById('ai-menu-' + id);
  if (!m) return;
  document.getElementById('send-menu-' + id)?.style.setProperty('display', 'none');
  m.style.display = m.style.display === 'block' ? 'none' : 'block';
}
export function hideAIMenu(id)  { const m = document.getElementById('ai-menu-'   + id); if (m) m.style.display = 'none'; }
export function toggleSendMenu(id) {
  const m = document.getElementById('send-menu-' + id);
  if (!m) return;
  document.getElementById('ai-menu-' + id)?.style.setProperty('display', 'none');
  m.style.display = m.style.display === 'block' ? 'none' : 'block';
}
export function hideSendMenu(id) { const m = document.getElementById('send-menu-' + id); if (m) m.style.display = 'none'; }

export function sendComposeAnd(id, status) {
  hideSendMenu(id);
  sendCompose(id);
  changeTicketStatus(id, status);
  if (CURRENT_TICKET === id) openTicket(id);
}

export function showSentTextModal(ticketId, msgIdx) {
  const t = TICKETS.find(x => x.id === ticketId);
  const m = t && t.msgs && t.msgs[msgIdx];
  if (!m) return;
  showModal(`Sent to customer · ${m.translatedTo || 'translated'}`,
    `<div style="font-size:13px;color:var(--ink);line-height:1.6;white-space:pre-wrap;word-wrap:break-word">${window.escHtml(m.t || '')}</div>`,
    null, null);
}

export async function sendCompose(id) {
  const el = document.getElementById(`compose-${id}`);
  const txt = el.value.trim(); if (!txt) return;
  const t = TICKETS.find(x => x.id === id);
  if (!t) return;

  // Auto-translate outgoing replies (not internal notes) when toggle is on and we know the customer's language
  let outgoing = txt;
  let original = null;
  let translatedTo = null;
  const shouldAutoTranslate = COMPOSE_TAB !== 'note'
    && t.autoTranslateReplies
    && t.detectedCustomerLang
    && t.detectedCustomerLang.toLowerCase() !== AGENT_PREFERRED_LANG.toLowerCase()
    && AI_API_KEY;
  if (shouldAutoTranslate) {
    AI_THINKING = true;
    try {
      if (CURRENT_TICKET === id) openTicket(id);
      const res = await translateText(txt, t.detectedCustomerLang);
      if (res.translation) {
        outgoing = res.translation;
        original = txt;
        translatedTo = t.detectedCustomerLang;
      }
    } finally {
      AI_THINKING = false;
    }
  }

  const isNote = COMPOSE_TAB === 'note';
  const mentions = isNote ? parseMentions(outgoing) : null;
  t.msgs.push({
    from: SESSION.name,
    r: isNote ? 'note' : 'agent',
    t: outgoing,
    tOriginal: original,
    translatedTo,
    mentions,
    ts: new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}),
  });
  el.value = '';
  clearDraft(id);
  onComposeInput(id);
  if (CURRENT_TICKET === id) openTicket(id);
}

export function showNewTicketModal(templateId) {
  const cats = [...new Set([...TICKETS.map(t=>t.category), ...TICKET_TEMPLATES.map(t=>t.category)])];
  const tpl = templateId ? TICKET_TEMPLATES.find(t => t.id === templateId) : null;
  const esc = s => String(s||'').replace(/"/g,'&quot;');
  const tplOptions = TICKET_TEMPLATES.map(t => `<option value="${window.escAttr(t.id)}" ${tpl?.id===t.id?'selected':''}>${window.escHtml(t.name)}</option>`).join('');
  const req = key => isFieldRequired('ticket', key) ? ' <span style="color:var(--red);font-weight:500" title="Required">*</span>' : '';
  const visible = key => isFieldVisible('ticket', key);
  const customerRow = visible('customerId')
    ? `<div class="form-row"><label class="form-label">Customer ID${req('customerId')}</label><input class="form-input" id="nt-cust" placeholder="M001"/></div>`
    : '';
  const categoryRow = visible('category')
    ? `<div class="form-row"><label class="form-label">Category${req('category')}</label>
        <select class="form-input" id="nt-cat">${cats.map(c=>`<option ${tpl?.category===c?'selected':''}>${c}</option>`).join('')}</select>
      </div>`
    : '';
  const priorityRow = visible('priority')
    ? `<div class="form-row"><label class="form-label">Priority${req('priority')}</label>
        <select class="form-input" id="nt-pri">${['normal','high','urgent','low'].map(p => `<option ${tpl?.priority===p?'selected':''}>${p}</option>`).join('')}</select>
      </div>`
    : '';
  const agentRow = visible('agent')
    ? `<div class="form-row"><label class="form-label">Assign to${req('agent')}</label>
        <select class="form-input" id="nt-agent">
          <option value="__auto__">Auto (apply rules)</option>
          ${AGENTS.map(a=>`<option value="${window.escAttr(a.name)}">${window.escHtml(a.name)}${isAgentOOO(a.name) ? ' (OOO)' : ''}</option>`).join('')}
        </select>
      </div>`
    : '';
  const messageRow = visible('message')
    ? `<div class="form-row"><label class="form-label">Message${req('message')}</label><textarea class="form-input" id="nt-msg" placeholder="First message…">${window.escHtml(tpl?.body || '')}</textarea></div>`
    : '';
  showModal('New Ticket', `
    ${TICKET_TEMPLATES.length ? `
    <div class="form-row">
      <label class="form-label">Start from template (optional)</label>
      <select class="form-input" id="nt-template" onchange="ntApplyTemplate(this.value)">
        <option value="">— Blank ticket —</option>
        ${tplOptions}
      </select>
    </div>` : ''}
    ${customerRow || categoryRow ? `<div class="form-grid">${customerRow}${categoryRow}</div>` : ''}
    ${visible('subject') ? `<div class="form-row"><label class="form-label">Subject${req('subject')}</label><input class="form-input" id="nt-subj" value="${esc(tpl?.subject)}" placeholder="Describe the issue…"/></div>` : ''}
    ${priorityRow || agentRow ? `<div class="form-grid">${priorityRow}${agentRow}</div>` : ''}
    ${messageRow}
  `, () => {
    const subj = document.getElementById('nt-subj')?.value.trim() || '';
    if (visible('subject') && isFieldRequired('ticket', 'subject') && !subj) { alert('Subject is required.'); return; }
    const custInput = document.getElementById('nt-cust');
    const custId = custInput ? (custInput.value.trim() || 'M001') : 'M001';
    if (visible('customerId') && isFieldRequired('ticket', 'customerId') && !custInput?.value.trim()) {
      alert('Customer is required.'); return;
    }
    const msgEl = document.getElementById('nt-msg');
    const msg = msgEl ? msgEl.value.trim() : '';
    if (visible('message') && isFieldRequired('ticket', 'message') && !msg) {
      alert('First message is required.'); return;
    }
    if (visible('category') && isFieldRequired('ticket', 'category') && !document.getElementById('nt-cat')?.value) {
      alert('Category is required.'); return;
    }
    if (visible('priority') && isFieldRequired('ticket', 'priority') && !document.getElementById('nt-pri')?.value) {
      alert('Priority is required.'); return;
    }
    if (visible('agent') && isFieldRequired('ticket', 'agent')) {
      const v = document.getElementById('nt-agent')?.value;
      if (!v || v === '__auto__') { alert('Assignee is required (Auto does not satisfy a required assignment).'); return; }
    }
    // parseInt on non-numeric IDs returns NaN; filter them out so a stray
    // ticket like "TK-foo" can't poison Math.max into NaN.
    const ticketNums = TICKETS.map(t => parseInt((t.id||'').split('-')[1] || '0', 10)).filter(n => Number.isFinite(n));
    const newId = 'TK-' + String(Math.max(0, ...ticketNums) + 1).padStart(3,'0');
    const agentPick = document.getElementById('nt-agent')?.value || '__auto__';
    TICKETS.unshift({
      id:newId, subject:subj, customerId:custId,
      status:'open',
      priority: document.getElementById('nt-pri')?.value || 'normal',
      category: document.getElementById('nt-cat')?.value || 'Technical',
      agent:agentPick === '__auto__' ? '' : agentPick,
      created:new Date().toISOString().slice(0,10), updated:'just now',
      sla:'ok', tags:[], aiTags:[], csat:null,
      msgs: msg ? [{from:SESSION.name,r:'agent',t:msg,ts:new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}] : [],
    });
    if (agentPick === '__auto__') applyAssignmentRules(TICKETS[0]);
    refreshTicketSLA(TICKETS[0]);
    fireWebhook('ticket.created', ticketPayload(TICKETS[0]));
    closeModal(); window.renderPage('tickets');
  }, 'Create Ticket');
}

export function ntApplyTemplate(id) {
  const t = id ? TICKET_TEMPLATES.find(x => x.id === id) : null;
  const subj = document.getElementById('nt-subj');
  const cat  = document.getElementById('nt-cat');
  const pri  = document.getElementById('nt-pri');
  const msg  = document.getElementById('nt-msg');
  if (!t) {
    if (subj) subj.value = '';
    if (msg) msg.value = '';
    return;
  }
  if (subj) subj.value = t.subject || '';
  if (msg) msg.value = t.body || '';
  if (cat && t.category) {
    [...cat.options].forEach(o => { if (o.value === t.category) cat.value = t.category; });
  }
  if (pri && t.priority) pri.value = t.priority;
}

// ─── data-action registrations (sidebar) ─────────────────────────────────────
// First slice of the detail.js event-delegation migration. Sidebar
// handlers only — toolbar, tags row, message thread, and compose area
// still use inline strings (follow-up PRs). Bridge namespace can't
// retire until all three slices land.
//
// `td.*` action prefix avoids collisions with other modules. Most
// handlers call locally-imported fns directly. `navTo` and the
// customers/modals `openCustomerModal` go through `window` to avoid
// adding new import edges in this PR; will move to direct imports in
// the follow-up cleanup pass.

registerActions({
  // Snooze + merge banners
  'td.unsnooze':       (ds) => unsnoozeTicket(ds.ticketId),
  'td.snooze':         (ds) => showSnoozeModal(ds.ticketId),
  'td.unmerge':        (ds) => unmergeTicket(ds.ticketId),
  'td.openTicket':     (ds) => openTicket(ds.ticketId),
  // AI tags
  'td.acceptAITag':    (ds) => acceptAITag(ds.ticketId, ds.tag),
  'td.acceptAllAITags':(ds) => acceptAllAITags(ds.ticketId),
  // Sidebar info rows / SLA / KB
  'td.showAttach':     (ds) => showAttachPanel(ds.ticketId),
  'td.navTo':          (ds) => window.navTo(ds.target),
  'td.summarize':      (ds) => summarizeTicket(ds.ticketId),
  'td.clearSummary':   (ds) => clearTicketSummary(ds.ticketId),
  'td.toggleWatch':    (ds) => toggleWatch(ds.ticketId),
  'td.openKB':         (ds) => { KB_SELECTED = ds.kbId; window.navTo('kb'); },
  'td.refreshKB':      (ds) => refreshTicketKbSuggestions(ds.ticketId),
  // Time tracking
  'td.logTime':        (ds) => showLogTimeModal(ds.ticketId),
  'td.removeTime':     (ds) => removeTimeEntry(ds.ticketId, ds.entryId),
  // Linked tickets
  'td.linkTicket':     (ds) => showLinkTicketModal(ds.ticketId),
  'td.mergeTicket':    (ds) => showMergeTicketModal(ds.ticketId),
  'td.unlink':         (ds) => unlinkTicket(ds.ticketId, ds.linkedId),
  // Customer panel
  'td.openCustomer':   (ds) => window.openCustomerModal(ds.custId),
  // Per-ticket GDPR sidebar (stubs — same as the inline alerts they replace)
  'td.gdprErasure':    () => alert('Erasure request initiated'),
  'td.gdprRedact':     () => alert('Data redacted'),
  'td.gdprExport':     () => alert('SAR export started'),
  // Toolbar
  'td.openTicketsList':() => window.renderPage('tickets'),
  'td.prev':           () => prevNextTicket(-1),
  'td.next':           () => prevNextTicket(1),
  'td.macroModal':     (ds) => showApplyMacroModal(ds.ticketId),
  'td.runRules':       (ds) => runAssignmentRulesOnTicket(ds.ticketId),
  'td.quickStatus':    (ds) => quickStatus(ds.ticketId, ds.status),
  // Tags row
  'td.removeTag':      (ds) => removeTicketTag(ds.ticketId, ds.tag),
  // Message thread
  'td.hideTranslation':(ds) => hideMessageTranslation(ds.ticketId, parseInt(ds.msgIdx, 10)),
  'td.translateMsg':   (ds) => translateMessage(ds.ticketId, parseInt(ds.msgIdx, 10)),
  'td.showSentText':   (ds) => showSentTextModal(ds.ticketId, parseInt(ds.msgIdx, 10)),
});

registerChangeActions({
  'td.setStatus':            (ds, el) => changeTicketStatus(ds.ticketId, el.value),
  'td.setPriority':          (ds, el) => changeTicketPriority(ds.ticketId, el.value),
  'td.setAgent':             (ds, el) => changeTicketAgent(ds.ticketId, el.value),
  'td.toggleThreadTranslate':(ds, el) => toggleThreadTranslate(ds.ticketId, el.checked),
  'td.setCustomerLang':      (ds, el) => setCustomerLanguage(ds.ticketId, el.value),
  'td.toggleAutoTranslate':  (ds, el) => toggleAutoTranslateReplies(ds.ticketId, el.checked),
});

// ─── Tag-add Enter-key handler ───────────────────────────────────────────────
// One module-internal document-level keydown listener for the tag-add inputs.
// Keydown delegation isn't worth a fifth dispatcher event type for this one
// callsite (and one more in the compose textarea, handled separately).
// Inputs that should respond carry `data-tag-add-id="<ticketId>"`; on Enter
// the listener pulls the value + ticket id and adds the tag.
document.addEventListener('keydown', e => {
  const el = e.target;
  if (!(el instanceof HTMLInputElement) || !el.dataset.tagAddId) return;
  if (e.key !== 'Enter') return;
  e.preventDefault();
  addTicketTag(el.dataset.tagAddId, el.value);
});
