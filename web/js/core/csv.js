// ─── CSV download helper ─────────────────────────────────────────────────────
// One place for the serialize-and-download dance the exporters need. Folds in
// the fixes the older per-page copies collected piecemeal:
//   - UTF-8 BOM so Excel decodes accented names (from tickets/list.js),
//   - revokeObjectURL in finally so a click exception can't leak the URL,
//   - formula-injection guard: cells starting with = + - @ get an apostrophe
//     prefix so customer-controlled text (ticket subjects!) can't execute as
//     a spreadsheet formula when the export is opened in Excel/Sheets.
// Older exporters (tickets, customers) still carry local copies — migrate
// them here as they're next touched.

function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function downloadCSV(headers, rows, filename) {
  const csv = [headers, ...rows].map(r => r.map(csvCell).join(',')).join('\n');
  const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
