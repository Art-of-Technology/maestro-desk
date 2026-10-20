import { showModal, closeModal } from '../core/modal.js';

export function statusReasonField(choice, id, selected = '') {
  if (!choice?.reasons?.some(r => r.is_active)) return '';
  return `<div class="form-row"><label class="form-label" for="${id}">Reason (${choice.reason_required ? 'required' : 'optional'})</label>
    <select class="form-input" id="${id}" ${choice.reason_required ? 'required' : ''}><option value="">${choice.reason_required ? 'Choose a reason' : 'No reason'}</option>
    ${choice.reasons.filter(r => r.is_active).map(r => `<option value="${window.escAttr(r.key)}" ${r.key === selected ? 'selected' : ''}>${window.escHtml(r.label)}</option>`).join('')}</select></div>`;
}

// Closing or replacing the singleton dialog resolves cancellation for every caller.
export function chooseStatusReason(choice) {
  if (!choice.reasons.some(r => r.is_active)) return Promise.resolve(null);
  return new Promise(resolve => {
    const trigger = document.activeElement;
    showModal(`Set ${choice.label}`, statusReasonField(choice, 'status-change-reason') + '<p id="status-reason-error" role="alert"></p>', () => {
      const value = document.getElementById('status-change-reason').value;
      if (!value && choice.reason_required) { document.getElementById('status-reason-error').textContent = 'Choose a reason.'; return; }
      resolve(value || null); closeModal();
    }, 'Set status');
    const modal = document.getElementById('status-change-reason').closest('.modal');
    modal.classList.add('ticket-status-modal');
    modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-label', `Set ${choice.label}`);
    modal.querySelector('.modal-close').outerHTML = '<button type="button" class="modal-close" data-action="modal.close" aria-label="Close dialog">×</button>';
    modal.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); closeModal(); }
      if (event.key !== 'Tab') return;
      const controls = [...modal.querySelectorAll('button:not(:disabled), select')], first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    const observer = new MutationObserver(() => {
      if (!modal.isConnected) { observer.disconnect(); resolve(undefined); if (trigger?.isConnected) trigger.focus(); }
    });
    observer.observe(document.getElementById('modal-container'), { childList: true });
    document.getElementById('status-change-reason').focus();
  });
}
