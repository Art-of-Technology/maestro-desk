// ─── Customer modals ─────────────────────────────────────────────────────────
// Four modal stubs that were physically wedged in app.js next to other
// inline-onclick stubs, but all touch customer data:
//   - showGDPRModal       (triggered from ticket detail's customer-info panel)
//   - openCustomerModal   (compact customer card, opened from search results)
//   - showCSVModal        (CSV import affordance on the customers list)
//   - showNewCustomerModal (creates a new CUSTOMERS row + refreshes the table)

import { CUSTOMERS } from '../core/data.js';
import { showModal, closeModal } from '../core/modal.js';
import { refreshCustTable } from './index.js';

export function showGDPRModal(id) {
  showModal('GDPR actions', `
    <div class="gdpr-action"><div class="gdpr-action-title">Request erasure</div><div class="gdpr-action-desc">Permanently delete this customer's personal data under Article 17.</div><button class="btn btn-sm btn-danger" data-action="modal.close">Request erasure</button></div>
    <div class="gdpr-action"><div class="gdpr-action-title">Redact in-thread data</div><div class="gdpr-action-desc">Mask PII in this ticket's messages.</div><button class="btn btn-sm" data-action="modal.close">Redact</button></div>
    <div class="gdpr-action"><div class="gdpr-action-title">SAR export</div><div class="gdpr-action-desc">Export all data held about this customer.</div><button class="btn btn-sm" data-action="modal.close">Export</button></div>
  `, null, null);
}

export function openCustomerModal(custId) {
  const c = CUSTOMERS.find(x => x.id === custId); if (!c) return;
  const esc = window.escHtml;
  const vipRaw = c.vip || '';
  showModal(`${esc(c.first + ' ' + c.last)}`, `
    <div class="ts-row"><span class="ts-key">Customer ID</span><span class="ts-val">${esc(c.id)}</span></div>
    <div class="ts-row"><span class="ts-key">Email</span><span class="ts-val">${esc(c.email || '')}</span></div>
    <div class="ts-row"><span class="ts-key">Mobile</span><span class="ts-val">${esc(c.mobile || '')}</span></div>
    <div class="ts-row"><span class="ts-key">Brand</span><span class="ts-val">${esc(c.brand || '')}</span></div>
    <div class="ts-row"><span class="ts-key">VIP</span><span class="vip-badge vip-${esc(vipRaw.toLowerCase())}">${esc(vipRaw)}</span></div>
    <div class="ts-row"><span class="ts-key">Jurisdiction</span><span class="ts-val">${esc(c.jurisdiction || '')}</span></div>
    <div class="ts-row"><span class="ts-key">KYC</span><span class="ts-val">${esc(c.kyc || '')}</span></div>
    <div class="ts-row"><span class="ts-key">Customer since</span><span class="ts-val">${esc(c.since || '')}</span></div>
  `, null, null);
}

export function showCSVModal() {
  showModal('CSV import', `<div class="attach-zone">Drop a CSV file or click to upload</div><div style="font-size:11px;color:var(--ink3);margin-top:10px">Expected columns: id, first, last, email, brand, vip, jurisdiction</div>`, () => closeModal(), 'Import');
}

// Allocate the next M-prefixed customer id by scanning the max numeric
// suffix among existing CUSTOMERS rows. Using CUSTOMERS.length collides
// once any customer has been deleted, which the table supports.
function nextCustomerId() {
  const maxN = CUSTOMERS.reduce((m, c) => {
    const n = parseInt(String(c.id || '').replace(/^M/, ''), 10);
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  return 'M' + String(maxN + 1).padStart(3, '0');
}

export function showNewCustomerModal() {
  showModal('New customer', `
    <div class="form-grid">
      <div class="form-row"><label class="form-label">First name</label><input class="form-input" id="nc-first"/></div>
      <div class="form-row"><label class="form-label">Last name</label><input class="form-input" id="nc-last"/></div>
    </div>
    <div class="form-row"><label class="form-label">Email</label><input class="form-input" id="nc-email" type="email"/></div>
    <div class="form-grid">
      <div class="form-row"><label class="form-label">Brand</label><input class="form-input" id="nc-brand"/></div>
      <div class="form-row"><label class="form-label">Jurisdiction</label><input class="form-input" id="nc-jurisdiction" placeholder="UK"/></div>
    </div>
  `, () => {
    const first = document.getElementById('nc-first').value.trim();
    const last  = document.getElementById('nc-last').value.trim();
    if (!first || !last) return;
    const id = nextCustomerId();
    const jurisdiction = document.getElementById('nc-jurisdiction').value.trim() || 'UK';
    CUSTOMERS.push({id,first,last,username:(first[0]+last).toLowerCase(),email:document.getElementById('nc-email').value,mobile:'',brand:document.getElementById('nc-brand').value,vip:'Bronze',jurisdiction,consent:true,kyc:'Pending',since:new Date().toISOString().slice(0,10),bo:'',custom:{}});
    closeModal(); refreshCustTable(CUSTOMERS);
  }, 'Create');
}
