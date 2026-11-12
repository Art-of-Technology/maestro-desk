// ─── Customers table: column order + row sort ────────────────────────────────
// Pure helpers behind the customers list header (drag a header to reorder,
// click it to sort). No DOM and no imports, so scripts/customer-table-order
// .test.js exercises them directly.

// Move the column `srcId` to where `targetId` sits. Mutates `columns` in place
// (CUST_COLUMNS is shared state — importers hold the array) and reports
// whether anything moved. Dragging rightwards lands the column AFTER the
// target, leftwards BEFORE it — i.e. it always takes the target's slot.
//
// Deliberately blind to `fixed`: that flag means "can't be hidden" in the
// column manager. It used to veto reordering as well, which left Customer ID
// and Name showing a drag handle that did nothing.
export function moveColumn(columns, srcId, targetId) {
  if (srcId == null || targetId == null || srcId === targetId) return false;
  const si = columns.findIndex(c => c.id === srcId);
  const ti = columns.findIndex(c => c.id === targetId);
  if (si < 0 || ti < 0) return false;
  const [src] = columns.splice(si, 1);
  columns.splice(ti, 0, src);
  return true;
}

// Which edge of the hovered header the insertion line belongs on, given where
// the dragged column currently sits. Mirrors moveColumn's landing rule.
export function dropSide(columns, srcId, targetId) {
  const si = columns.findIndex(c => c.id === srcId);
  const ti = columns.findIndex(c => c.id === targetId);
  if (si < 0 || ti < 0 || si === ti) return null;
  return si < ti ? 'after' : 'before';
}

const VIP_RANK = { platinum: 0, gold: 1, silver: 2, bronze: 3 };

// The comparable value for one customer in one column. Strings compare as
// text, numbers numerically; '' / null means "blank" and always sorts last.
function sortKey(c, colId) {
  if (colId === 'name') return `${c.first || ''} ${c.last || ''}`.trim();
  if (colId === 'vip') {
    const rank = VIP_RANK[String(c.vip || '').toLowerCase()];
    return rank === undefined ? null : rank;
  }
  if (colId === 'consent') return c.consent ? 0 : 1;   // Yes before No when ascending
  if (colId.startsWith('cf_')) return String(c.custom?.[colId.slice(3)] ?? '').trim();
  return String(c[colId] ?? '').trim();
}

const isBlank = v => v === null || v === '';
// numeric:true so CUST-2 sorts before CUST-10. One shared collator — building
// one per comparison (localeCompare with options) is slow on a long list.
const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
// Plain numbers ("1.5", "-10") compare by value: digit-run collation alone
// would put 1.5 before 1.25 and -5 before -10.
const asNumber = v => (typeof v === 'number' ? v : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : null);
function textCompare(a, b) {
  const na = asNumber(a), nb = asNumber(b);
  if (na !== null && nb !== null) return na - nb;
  return COLLATOR.compare(String(a), String(b));
}

// Sorted COPY of `list` by column `colId`; `dir` is 1 (ascending) or -1.
// Blanks stay at the bottom in both directions, and ties fall back to the
// customer id so the order is stable across re-renders.
export function sortCustomers(list, colId, dir = 1) {
  if (!colId) return list;
  return list
    .map(c => ({ c, k: sortKey(c, colId) }))
    .sort((a, b) => {
      const ab = isBlank(a.k), bb = isBlank(b.k);
      if (ab !== bb) return ab ? 1 : -1;
      let d = 0;
      if (!ab) d = textCompare(a.k, b.k) * dir;
      return d || textCompare(a.c.id ?? '', b.c.id ?? '');
    })
    .map(x => x.c);
}

// Header click cycle: unsorted → ascending → descending → unsorted.
export function nextSort(current, colId) {
  if (current.col !== colId) return { col: colId, dir: 1 };
  if (current.dir === 1) return { col: colId, dir: -1 };
  return { col: null, dir: 1 };
}
