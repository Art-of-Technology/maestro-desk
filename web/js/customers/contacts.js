// ─── Customer contacts (multiple emails / mobiles) ───────────────────────────
// GET /customers ships `emails` / `mobiles` arrays beside the primary mirror
// (c.email / c.mobile). Every SEARCH surface matches on all of them (list
// filter, global search, quick switcher, new-ticket typeahead, player lookup);
// display columns and the CSV export keep the primary. Demo rows may carry
// only the scalars — contactArrays() synthesises the arrays from them so the
// same predicates work against demo data. The add / remove / set-primary UI
// lives on the pinned details card (customers/details-card.js).

// Apply a server contacts object ({ email, mobile, emails, mobiles } — the
// shape every contact endpoint and the merge/unmerge responses return) onto a
// view-model row. PARTIAL by design: it touches only the address fields, so
// it's safe to call with a contact-endpoint response; a full GET /-shaped
// row goes through bootstrap.js applyCustomerRow instead.
export function applyContacts(row, srv) {
  if (!row || !srv || !Array.isArray(srv.emails)) return;
  row.email = srv.email || '';
  row.mobile = srv.mobile || '';
  row.emails = srv.emails;
  row.mobiles = Array.isArray(srv.mobiles) ? srv.mobiles : [];
}

export function contactArrays(c) {
  const emails  = Array.isArray(c?.emails)  && c.emails.length  ? c.emails
    : (c?.email  ? [{ id: null, value: c.email,  is_primary: true }] : []);
  const mobiles = Array.isArray(c?.mobiles) && c.mobiles.length ? c.mobiles
    : (c?.mobile ? [{ id: null, value: c.mobile, is_primary: true }] : []);
  return { emails, mobiles };
}

// Every address of the customer, lower-cased, for substring search.
export function contactValues(c) {
  const { emails, mobiles } = contactArrays(c);
  return [...emails, ...mobiles].map((x) => String(x?.value || '').toLowerCase());
}

// Substring match across all addresses (needle already lower-cased or not —
// we lower-case it here).
export function matchesContact(c, needle) {
  const n = String(needle || '').toLowerCase();
  return Boolean(n) && contactValues(c).some((v) => v.includes(n));
}

// Exact (case-insensitive) match on one kind — the player lookup's "is there
// a local record for this Maestro player" check.
export function hasContact(c, kind, value) {
  const v = String(value || '').toLowerCase();
  if (!v) return false;
  const list = contactArrays(c)[kind === 'mobile' ? 'mobiles' : 'emails'];
  return list.some((x) => String(x?.value || '').toLowerCase() === v);
}
