const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export function benchmarkHtml(reports, data) {
  reports = reports.map((r) => ({
    ...r,
    algorithm:
      {
        "cost-optimized": "Cost optimized",
        "evening-target": "Evening target",
      }[r.algorithm] ?? r.algorithm,
  }));
  const colors = ["#0891b2", "#d97706", "#9333ea", "#059669"];
  const date = new Intl.DateTimeFormat("en-GB", {
    timeZone: data.timeZone,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const first = data.slots[0].start;
  const last = data.slots.at(-1).end;
  const x = (t) => 60 + ((t - first) / (last - first)) * 1000;
  const legend = reports
    .map(
      (r, i) =>
        `<span style="--series:${colors[i % colors.length]}">${escapeHtml(r.algorithm)}</span>`,
    )
    .join("");
  const chart = (title, unit, series, maximum, stepped = true) => {
    const max = Math.max(1, maximum);
    const y = (v) => 230 - (v / max) * 200;
    const ticks = Array.from({ length: 5 }, (_, i) => {
      const value = (max * i) / 4;
      return `<line x1="60" x2="1060" y1="${y(value)}" y2="${y(value)}" stroke="var(--line)"/><text x="50" y="${y(value) + 4}" text-anchor="end">${Math.round(value)}</text>`;
    }).join("");
    const times = Array.from({ length: 5 }, (_, i) => {
      const t = first + ((last - first) * i) / 4;
      return `<text x="${x(t)}" y="258" text-anchor="${i === 0 ? "start" : i === 4 ? "end" : "middle"}">${escapeHtml(date.format(t))}</text>`;
    }).join("");
    const paths = series
      .map((s) => {
        const coordinates = s.points.flatMap((p) =>
          stepped
            ? [
                [p.start, p.value],
                [p.end, p.value],
              ]
            : [[p.end, p.value]],
        );
        const d = coordinates
          .map(([t, v], i) => `${i ? "L" : "M"}${x(t)},${y(v)}`)
          .join(" ");
        return `<path d="${d}" stroke="${s.color}" stroke-width="2.5" fill="none"/><g>${s.points.map((p) => `<circle cx="${x(p.end)}" cy="${y(p.value)}" r="4" fill="${s.color}" fill-opacity="0"><title>${escapeHtml(s.name)} · ${escapeHtml(date.format(p.start))}–${escapeHtml(date.format(p.end))}: ${p.value.toFixed(1)} ${unit}</title></circle>`).join("")}</g>`;
      })
      .join("");
    const hoverTargets = series[0].points
      .map((p, i) => {
        const time = stepped
          ? `${date.format(p.start)} – ${date.format(p.end)}`
          : `${date.format(p.end)} (end of interval)`;
        const label = `${time} · ${data.timeZone}\n${series.map((s) => `${s.name}: ${s.points[i].value.toFixed(1)} ${unit}`).join("\n")}`;
        return `<rect class="hover-target" x="${x(p.start)}" y="25" width="${x(p.end) - x(p.start)}" height="205" fill="transparent" tabindex="0" role="button" aria-label="${escapeHtml(label)}" data-label="${escapeHtml(label)}" data-guide="${x(stepped ? p.start : p.end)}"/>`;
      })
      .join("");
    const deadline = Date.parse(reports[0].settings.deadline);
    return `<section><h2>${title} <small>${unit}</small></h2><div class="plot"><svg viewBox="0 0 1100 275" role="img" aria-label="${title}">${ticks}${times}${paths}<line x1="${x(deadline)}" x2="${x(deadline)}" y1="25" y2="230" stroke="var(--muted)" stroke-dasharray="5 5"/><text x="${x(deadline) - 5}" y="18" text-anchor="end">Deadline</text><line class="hover-guide" y1="25" y2="230" stroke="var(--text)" stroke-dasharray="3 3" visibility="hidden" pointer-events="none"/>${hoverTargets}</svg></div></section>`;
  };
  const metricSeries = (field) =>
    reports.map((r, i) => ({
      name: r.algorithm,
      color: colors[i % colors.length],
      points: r.plan.points.map((p) => ({ ...p, value: p[field] })),
    }));
  const peak = (field) =>
    Math.max(...reports.flatMap((r) => r.plan.points.map((p) => p[field])));
  const summary = reports
    .flatMap((r) =>
      r.scenarios.map(
        (s) =>
          `<tr><td>${escapeHtml(r.algorithm)}</td><td>${s.solarHaircut * 100}% less solar</td><td>${s.energyCost.toFixed(4)}</td><td>${s.deadlineSoc.toFixed(2)}%</td><td>${s.targetShortfallKwh.toFixed(3)}</td><td>${s.switches}</td></tr>`,
      ),
    )
    .join("");
  const schedule = data.slots
    .map(
      (slot, i) =>
        `<tr><td>${escapeHtml(date.format(slot.start))}</td><td>${Math.round(slot.solarW)}</td><td>${Math.round(slot.loadW)}</td>${reports
          .map((r) => {
            const p = r.plan.points[i];
            return `<td>${p.limitW}</td><td>${Math.round(p.chargeW)}</td><td>${p.soc.toFixed(1)}%</td>`;
          })
          .join("")}</tr>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Battery planner benchmark</title><style>
:root{color-scheme:light dark;--bg:light-dark(#f4f6f8,#101820);--card:light-dark(#fff,#1d2934);--text:light-dark(#182b3a,#e4edf4);--muted:light-dark(#526575,#a7bacb);--line:light-dark(#dae1e7,#394958)}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px system-ui,sans-serif}main{max-width:1280px;margin:auto;padding:28px}h1{margin:0 0 8px}h2{font-size:18px;margin:0 0 16px}p{color:var(--muted);line-height:1.6}section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin:20px 0}small{color:var(--muted);font-weight:400}.legend{display:flex;gap:24px;flex-wrap:wrap}.legend span:before{content:"";display:inline-block;width:22px;height:4px;background:var(--series);margin:0 8px 4px 0}.plot,.table{overflow:auto}svg{width:100%;min-width:700px;display:block}svg text{fill:var(--muted);font:12px system-ui}table{width:100%;border-collapse:collapse;white-space:nowrap;text-align:right}th,td{padding:10px;border-bottom:1px solid var(--line)}th:first-child,td:first-child{text-align:left}thead{color:var(--muted)}summary{cursor:pointer;font-weight:600}code{overflow-wrap:anywhere}footer{color:var(--muted);font-size:12px;overflow-wrap:anywhere}
.chart-tooltip{position:fixed;z-index:10;pointer-events:none;white-space:pre-line;max-width:calc(100vw - 24px);padding:12px 16px;background:var(--card);color:var(--text);border:1px solid var(--muted);border-radius:8px;box-shadow:0 4px 18px #0003;font-size:14px;line-height:1.6}.hover-target:focus{outline:none;stroke:var(--muted);stroke-width:1}
</style><main><h1>Battery planner benchmark</h1><p>${escapeHtml(data.id)} · ${escapeHtml(data.timeZone)} · Generated ${escapeHtml(date.format(Date.parse(reports[0].generatedAt)))}<br>Target ${reports[0].settings.targetSoc}% by ${escapeHtml(date.format(Date.parse(reports[0].settings.deadline)))}. Rebuilt by <code>node gym/benchmark.mjs</code>; reload this page after running.</p><div class="legend">${legend}</div>
<section><h2>Cost and evening target</h2><div class="table"><table><thead><tr><th>Algorithm</th><th>Scenario</th><th>Energy cost (${escapeHtml(data.currency)})</th><th>Deadline SoC</th><th>Shortfall kWh</th><th>Ceiling changes</th></tr></thead><tbody>${summary}</tbody></table></div><p>Lower energy cost is better; negative values mean net export revenue. Costs exclude the switching penalty. Both scenarios use the same planned ceilings.</p></section>
${chart("Charge ceiling", "W", metricSeries("limitW"), peak("limitW"))}
${chart("Expected charging", "W", metricSeries("chargeW"), peak("chargeW"))}
${chart("Battery state of charge", "%", metricSeries("soc"), 100, false)}
${chart(
  "Input solar and household demand",
  "W",
  [
    {
      name: "Solar",
      color: colors[0],
      points: data.slots.map((p) => ({ ...p, value: p.solarW })),
    },
    {
      name: "Household demand",
      color: colors[1],
      points: data.slots.map((p) => ({ ...p, value: p.loadW })),
    },
  ],
  Math.max(...data.slots.map((p) => Math.max(p.solarW, p.loadW))),
)}
<p>Input chart: blue = solar; orange = household demand. Schedule charts show the nominal scenario. Hover anywhere inside a chart for local time and all series values. You can also focus intervals with Tab; Escape dismisses the tooltip.</p>
<section><details><summary>All intervals · local time · power in W</summary><div class="table"><table><thead><tr><th>Start</th><th>Solar</th><th>Demand</th>${reports.map((r) => `<th>${escapeHtml(r.algorithm)} ceiling</th><th>Charging</th><th>SoC</th>`).join("")}</tr></thead><tbody>${schedule}</tbody></table></div></details></section>
<p>Measured-hindsight benchmark, not achieved household savings. Reduced solar is an assumed stress scenario, not a calibrated forecast probability. The evening candidate uses local search and is not guaranteed globally optimal.</p><footer>Input SHA-256: ${escapeHtml(reports[0].datasetSha256)}</footer></main><div class="chart-tooltip" role="tooltip" hidden></div><script>
const tooltip = document.querySelector('.chart-tooltip');
let active;
function hideTooltip() {
  tooltip.hidden = true;
  document.querySelectorAll('.hover-guide').forEach(guide => guide.setAttribute('visibility', 'hidden'));
  active = null;
}
function showTooltip(target, clientX, clientY) {
  if (active !== target) hideTooltip();
  active = target;
  tooltip.textContent = target.dataset.label;
  tooltip.hidden = false;
  const guide = target.ownerSVGElement.querySelector('.hover-guide');
  guide.setAttribute('x1', target.dataset.guide);
  guide.setAttribute('x2', target.dataset.guide);
  guide.setAttribute('visibility', 'visible');
  const bounds = tooltip.getBoundingClientRect();
  tooltip.style.left = Math.max(12, Math.min(clientX + 16, innerWidth - bounds.width - 12)) + 'px';
  tooltip.style.top = Math.max(12, Math.min(clientY + 16, innerHeight - bounds.height - 12)) + 'px';
}
document.querySelectorAll('.plot').forEach(plot => {
  plot.addEventListener('pointermove', event => {
    if (event.target.matches('.hover-target')) showTooltip(event.target, event.clientX, event.clientY);
    else hideTooltip();
  });
  plot.addEventListener('pointerleave', hideTooltip);
  plot.addEventListener('focusin', event => {
    if (!event.target.matches('.hover-target')) return;
    const rect = event.target.getBoundingClientRect();
    showTooltip(event.target, rect.left, rect.top);
  });
  plot.addEventListener('focusout', hideTooltip);
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') hideTooltip(); });
window.addEventListener('scroll', hideTooltip, true);
window.addEventListener('resize', hideTooltip);
</script></html>`;
}
