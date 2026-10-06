// Shared, dependency-free charts. Every format consumes the same labelled rows.
const esc = value => window.escHtml(String(value ?? ''));
const count = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const palette = ['var(--purple)', 'var(--cyan)', 'var(--amber)', 'var(--green)', 'var(--red)'];

export function renderStatTable(headers, rows) {
  return `<div class="stat-table" tabindex="0" role="region" aria-label="${esc(headers.join(', '))}"><table class="tbl"><thead><tr>${headers.map(h => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr><th scope="row">${esc(row[0])}</th>${row.slice(1).map(v => `<td>${esc(v ?? 'Unavailable')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

export function renderDataChart(headers, rows, chart, { colorFor, formatValue = v => v, xValues } = {}) {
  if (!rows.length) return '<p class="report-note">No data in this period.</p>';
  const table = () => renderStatTable(headers, rows.map(row => [row[0], ...row.slice(1).map(formatValue)]));
  if (chart === 'table' || chart === 'list') return table();
  const color = (label, series) => colorFor ? colorFor(label, series) : palette[series % palette.length];
  const values = rows.flatMap(row => row.slice(1).map(count));
  const max = Math.max(1, ...values);
  if (chart === 'donut') {
    const total = rows.reduce((sum, row) => sum + count(row[1]), 0);
    if (!total) return `<p class="report-note">No data to plot.</p>${table()}`;
    const circumference = 2 * Math.PI * 36;
    let offset = 0;
    const arcs = rows.map(([label, value], i) => {
      const length = count(value) / total * circumference;
      const arc = `<circle cx="50" cy="50" r="36" fill="none" stroke="${esc(color(label, i))}" stroke-width="14" stroke-dasharray="${length} ${circumference - length}" stroke-dashoffset="${-offset}" transform="rotate(-90 50 50)"><title>${esc(label)}: ${esc(formatValue(value))}</title></circle>`;
      offset += length;
      return arc;
    }).join('');
    return `<div class="stat-donut"><svg width="120" height="120" viewBox="0 0 100 100" role="img" aria-label="${esc(headers[1])}: ${esc(formatValue(total))} total">${arcs}<text x="50" y="55" text-anchor="middle" fill="var(--ink)" font-size="14">${esc(formatValue(total))}</text></svg><div>${rows.map(([label, value], i) => `<div class="stat-legend-row"><span class="donut-dot" style="background:${esc(color(label, i))}"></span><span>${esc(label)}</span><strong>${esc(formatValue(value))}</strong></div>`).join('')}</div></div>`;
  }
  if (chart === 'line') {
    const timed = xValues?.length === rows.length && xValues.every(Number.isFinite) && xValues.at(-1) > xValues[0];
    const x = i => 48 + (rows.length === 1 ? 230 : timed ? (xValues[i] - xValues[0]) / (xValues.at(-1) - xValues[0]) * 460 : i * 460 / (rows.length - 1));
    const y = value => 170 - count(value) / max * 145;
    const lines = headers.slice(1).map((header, s) => `<polyline points="${rows.map((r, i) => `${x(i)},${y(r[s + 1])}`).join(' ')}" fill="none" stroke="${esc(color(header, s))}" stroke-width="2"/>${rows.map((r, i) => `<circle cx="${x(i)}" cy="${y(r[s + 1])}" r="3" fill="${esc(color(header, s))}"><title>${esc(r[0])} · ${esc(header)}: ${esc(formatValue(r[s + 1]))}</title></circle>`).join('')}`).join('');
    return `<div class="stat-line"><svg viewBox="0 0 540 210" role="img" aria-label="${esc(headers.slice(1).join(', '))} over time"><path d="M48 25V170H508" fill="none" stroke="var(--rule)"/><text x="42" y="29" text-anchor="end">${esc(formatValue(max))}</text><text x="42" y="174" text-anchor="end">0</text>${lines}<text x="48" y="198">${esc(rows[0][0])}</text>${rows.length > 1 ? `<text x="508" y="198" text-anchor="end">${esc(rows.at(-1)[0])}</text>` : ''}</svg><div class="stat-series">${headers.slice(1).map((h, i) => `<span><i style="background:${esc(color(h, i))}"></i>${esc(h)}</span>`).join('')}</div><div class="stat-sr-only">${table().replace(' tabindex="0"', '')}</div></div>`;
  }
  return `<div class="stat-bars">${rows.map(row => `<div class="stat-bar-group"><div class="stat-category">${esc(row[0])}</div>${row.slice(1).map((value, s) => `<div class="stat-bar-row">${headers.length > 2 ? `<span>${esc(headers[s + 1])}</span>` : ''}<div class="r-bar-track"><div class="r-bar-fill" style="background:${esc(color(row[0], s))};width:${count(value) / max * 100}%"></div></div><strong>${esc(formatValue(value))}</strong></div>`).join('')}</div>`).join('')}</div>`;
}
