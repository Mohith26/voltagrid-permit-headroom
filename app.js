import {
  SITE, fitAll, weeklyResiduals, residSampler, calibration, simulate, optimize, BASELINE,
  historyMonthly, monthLabel, monthKey, rateLbMWh, dayDate,
} from './core/headroom.js';

const $ = id => document.getElementById(id);
const fmt = (v, d = 1) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = v => (v * 100 < 1 && v > 0 ? '<1' : Math.round(v * 100)) + '%';
const usd = v => '$' + Math.round(v).toLocaleString('en-US');
const S = 200, SEED = 7, CHECK_S = 400, CHECK_SEED = 99;

const state = { pol: 'nox', target: 0.05, plan: 'opt', showAll: false };
const cache = { pol: {}, opt: {} };
let data, rollChart, btChart;

const sleep = () => new Promise(r => setTimeout(r, 0));

async function polCtx(pol) {
  if (cache.pol[pol]) return cache.pol[pol];
  const models = fitAll(data, pol);
  const resid = residSampler(weeklyResiduals(data, models, pol, 0, data.history.days));
  await sleep();
  const cal = calibration(data, pol);
  await sleep();
  const base = simulate(data, models, BASELINE, { S, seed: SEED, resid, modelErr: cal.errs, pollutant: pol });
  const hm = historyMonthly(data, pol);
  return (cache.pol[pol] = { models, resid, cal, base, hm });
}

async function optCtx(pol, target) {
  const key = pol + '|' + target;
  if (cache.opt[key]) return cache.opt[key];
  const c = await polCtx(pol);
  await sleep();
  const o = optimize(data, c.models, { target, S, seed: SEED, resid: c.resid, modelErr: c.cal.errs, pollutant: pol });
  const plan = { name: 'Headroom plan', commit: 'merit', lambda: o.best.lambda, swaps: o.best.swaps };
  await sleep();
  const check = simulate(data, c.models, plan, { S: CHECK_S, seed: CHECK_SEED, resid: c.resid, modelErr: c.cal.errs, pollutant: pol });
  return (cache.opt[key] = { o, plan, res: o.best.result, check });
}

function fleetList() {
  const on = new Set(data.history.lastOnline); const ids = data.site.ids; const blocks = [];
  for (let b = 0; b < 3; b++) {
    const units = [...Array(10).keys()].map(i => b * 10 + i); const running = units.filter(u => on.has(u)).length;
    blocks.push({ name: `${data.siteName} Block ${'ABC'[b]}`, sub: `${ids[units[0]].slice(-3)}-${ids[units[9]].slice(-3)} · ${running} of 10 running`, cls: running === 10 ? 'on' : running ? 'on' : 'off' });
  }
  blocks.push({ name: 'NLC-CoryellTX BESS-01', sub: 'Online (Standby)', cls: 'sb' });
  $('fleetList').innerHTML = blocks.map((b, i) => `<div class="fleet${i === 0 ? '' : ''}"><span class="dot ${b.cls}"></span><div><div class="nm">${b.name}</div><div class="st">${b.sub}</div></div></div>`).join('');
}

function gauge(el, frac, val, sub, max, color) {
  const f = Math.max(0, Math.min(1, frac)); const R = 62, cx = 80, cy = 74, w = 20;
  const arc = (a0, a1) => {
    const p = a => [cx + R * Math.cos(Math.PI * (1 - a)), cy - R * Math.sin(Math.PI * (1 - a))];
    const [x0, y0] = p(a0), [x1, y1] = p(a1); return `M${x0},${y0} A${R},${R} 0 0 1 ${x1},${y1}`;
  };
  const id = 'gr' + el.id;
  el.innerHTML = `<svg width="160" height="84" viewBox="0 0 160 84">
    <defs><linearGradient id="${id}" x1="0" x2="1"><stop offset="0" stop-color="${color[0]}"/><stop offset="1" stop-color="${color[1]}"/></linearGradient></defs>
    <path d="${arc(0, 1)}" stroke="#0e1020" stroke-width="${w}" fill="none"/>
    ${f > 0.001 ? `<path d="${arc(0, f)}" stroke="url(#${id})" stroke-width="${w}" fill="none"/>` : ''}
  </svg><div class="g-val">${val}</div><div class="g-sub">${sub}</div><div class="g-max">${max}</div>`;
}
const GREEN = ['#2f9e61', '#93c13a'], AMBER = ['#c9932c', '#e2c04a'], RED = ['#c43f38', '#ef6b5e'];

function render(c, oc) {
  const pol = state.pol, cap = data.permit[pol].cap, label = pol === 'nox' ? 'NOx' : 'CO';
  document.querySelectorAll('.pol').forEach(e => (e.textContent = label));
  $('permitBasis').textContent = `${data.permit[pol].label} cap ${fmt(cap)} tons, ${data.permit[pol].basis}`;
  const mks = [...c.hm.keys()].sort((a, b) => a - b); const lastMk = mks[mks.length - 1];
  const last12 = mks.slice(-12).reduce((a, k) => a + c.hm.get(k), 0);
  $('kRolling').textContent = fmt(last12);
  $('kRollingSub').textContent = `tons through ${monthLabel(lastMk)} · ${fmt(cap - last12)} t headroom`;
  $('kBreach').textContent = pct(c.base.pBreach);
  $('kBreach').className = 'kpi-num' + (c.base.pBreach >= 0.2 ? ' red' : '');
  $('kBreachSub').textContent = `current rotation, ${S} scenarios to ${monthLabel(c.base.months[11])}`;
  $('kFirst').textContent = c.base.firstRisk ? monthLabel(c.base.firstRisk) : 'None';
  $('kFirstSub').innerHTML = `month-end P(breach) &ge; 5% · peak P50 ${fmt(c.base.peakP50)} t`;
  const b = oc.o.best;
  $('kPlan').textContent = pct(oc.res.pBreach);
  $('kPlan').className = 'kpi-num green';
  $('kPlanSub').textContent = `${b.cost > 0 ? '+' + usd(b.cost) + ' / yr' : 'no added cost'} · ${b.k} catalyst swap${b.k === 1 ? '' : 's'}`;
  $('asOf').textContent = `${dayDate(data.history.days - 1).toISOString().slice(0, 10).replace(/-/g, '/')} · ${data.customer} · ${data.county} · ${data.site.units} engines · ${S} load and emission scenarios`;

  // ----- rolling chart -----
  const histPts = []; for (const mk of mks) { if (mk < mks[0] + 11) continue; let s = 0; for (let k = 0; k < 12; k++) s += c.hm.get(mk - k) || 0; histPts.push({ mk, v: s }); }
  const labels = [...histPts.map(p => p.mk), ...c.base.months].map(monthLabel);
  const nH = histPts.length; const pad = Array(nH - 1).fill(null);
  const join = (arr, key) => [...pad, histPts[nH - 1].v, ...arr.map(x => x[key])];
  const sel = state.plan; const bA = sel === 'base' ? 1 : 0.35, oA = sel === 'opt' ? 1 : 0.35;
  const ds = [
    { label: 'Measured', data: [...histPts.map(p => p.v), ...Array(12).fill(null)], borderColor: '#e9eaee', borderWidth: 2, pointRadius: 2.5, pointBackgroundColor: '#e9eaee', tension: 0.25 },
    { label: 'cur95', data: join(c.base.bands, 'p95'), borderWidth: 0, pointRadius: 0, backgroundColor: `rgba(229,83,75,${0.22 * bA})`, fill: '+1', tension: 0.25 },
    { label: 'cur05', data: join(c.base.bands, 'p05'), borderWidth: 0, pointRadius: 0, fill: false, tension: 0.25 },
    { label: 'Current plan (P50)', data: join(c.base.bands, 'p50'), borderColor: `rgba(239,107,94,${bA})`, borderWidth: 2, borderDash: [5, 4], pointRadius: 0, tension: 0.25 },
    { label: 'opt95', data: join(oc.res.bands, 'p95'), borderWidth: 0, pointRadius: 0, backgroundColor: `rgba(71,175,114,${0.25 * oA})`, fill: '+1', tension: 0.25 },
    { label: 'opt05', data: join(oc.res.bands, 'p05'), borderWidth: 0, pointRadius: 0, fill: false, tension: 0.25 },
    { label: 'Headroom plan (P50)', data: join(oc.res.bands, 'p50'), borderColor: `rgba(147,193,58,${oA})`, borderWidth: 2.2, pointRadius: 0, tension: 0.25 },
    { label: 'Permit cap', data: labels.map(() => cap), borderColor: '#dcd66c', borderWidth: 1.5, borderDash: [2, 3], pointRadius: 0 },
  ];
  const lo = Math.floor(Math.min(...histPts.map(p => p.v), ...c.base.bands.map(x => x.p05), ...oc.res.bands.map(x => x.p05)) / 10) * 10;
  const hi = Math.ceil((Math.max(cap, ...c.base.bands.map(x => x.p95)) + 3) / 10) * 10;
  const opts = {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: false }, tooltip: { backgroundColor: '#0e1020', borderColor: '#2f3241', borderWidth: 1, titleColor: '#fff', bodyColor: '#c9cad2', filter: i => !/(95|05)$/.test(i.dataset.label), callbacks: { label: i => `${i.dataset.label}: ${fmt(i.parsed.y)} t` } } },
    scales: {
      x: { grid: { color: '#262938', drawTicks: false }, ticks: { color: '#8d8f9b', font: { family: 'Lato', size: 11 }, padding: 6, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 }, border: { color: '#2f3241' } },
      y: { min: lo, max: hi, grid: { color: '#262938', drawTicks: false }, ticks: { color: '#8d8f9b', font: { family: 'Lato', size: 11 }, padding: 8, callback: v => v + ' t' }, border: { display: false } },
    },
  };
  if (rollChart) { rollChart.data.labels = labels; rollChart.data.datasets = ds; rollChart.options = opts; rollChart.update(); }
  else rollChart = new Chart($('rollChart'), { type: 'line', data: { labels, datasets: ds }, options: opts });
  $('legend').innerHTML = `<span><i style="background:#e9eaee"></i>Measured</span><span><i style="background:#ef6b5e"></i>Current plan</span><span><i style="background:#93c13a"></i>Headroom plan</span><span><i style="background:#dcd66c"></i>Permit cap</span>`;
  $('chartNote').textContent = `Bands are 5th-95th percentiles over ${S} scenarios: hall energization slips (0-60 days, 15% chance of 90 more), weather-driven cooling load, trips, block-bootstrapped weekly residuals and one out-of-sample model error per scenario drawn from the backtest. Independent check of the headroom plan on ${CHECK_S} fresh scenarios: ${pct(oc.check.pBreach)} breach.`;

  // ----- plan options -----
  const rows = [`<tr><th>Plan</th><th>Catalyst swaps</th><th>&lambda; $/lb</th><th>P(breach)</th><th>Added cost / yr</th></tr>`,
    `<tr><td>Current rotation</td><td>0</td><td>-</td><td>${pct(c.base.pBreach)}</td><td>-</td></tr>`,
    `<tr><td>Cleanest engines first</td><td>0</td><td>0</td><td>${pct(oc.o.meritOnly.pBreach)}</td><td>${usd(Math.max(0, oc.o.meritOnly.fuelDelta))}</td></tr>`];
  for (const t of oc.o.tried) {
    const chosen = t.k === b.k && t.feasible;
    rows.push(`<tr class="${chosen ? 'chosen' : ''}${t.feasible ? '' : ' infeasible'}"><td>${chosen ? '&#9656; ' : ''}${t.k ? '+ load sharing, ' + t.k + ' swap' + (t.k > 1 ? 's' : '') : '+ emission-priced sharing'}</td><td>${t.k}</td><td>${t.feasible ? Math.round(t.lambda) : '&gt;' + Math.round(t.lambda)}</td><td>${pct(t.pBreach)}</td><td>${t.feasible ? usd(t.cost) : 'misses target'}</td></tr>`);
  }
  $('optTable').innerHTML = rows.join('');
  const swapNames = b.swaps.map(u => data.site.ids[u].slice(-3));
  $('optFoot').innerHTML = `Target ${pct(state.target)}. Commit the engines with the lowest fitted ${label} rate first (no engine more than ${SITE.wearBandH.toLocaleString()} run hours ahead of the fleet median), share load at an emission price of ${Math.round(b.lambda)} $/lb${b.k ? `, and pull forward the SCR catalyst on engine${b.k > 1 ? 's' : ''} ${swapNames.join(', ')} to ${monthLabel(monthKey(data.history.days + data.plan.swapOffsetDays))}` : ''}. N+2 spinning reserve is unchanged. Fuel ${b.fuelDelta >= 0 ? '+' : '-'}${usd(Math.abs(b.fuelDelta))}/yr on ${usd(c.base.fuelCost)} baseline gas.`;

  // ----- gauges -----
  const g1 = c.base.peakP50 / cap, g2 = oc.res.peakP50 / cap;
  gauge($('g1'), g1, fmt(c.base.peakP50) + ' t', `${Math.round(g1 * 100)}% of cap (median peak)`, `Max: ${fmt(cap)} t`, g1 > 1 ? RED : g1 > 0.95 ? AMBER : GREEN);
  gauge($('g2'), g2, fmt(oc.res.peakP50) + ' t', `${Math.round(g2 * 100)}% of cap (median peak)`, `Max: ${fmt(cap)} t`, g2 > 1 ? RED : g2 > 0.95 ? AMBER : GREEN);
  const q = c.cal.q; gauge($('g3'), q / 0.05, '±' + fmt(q * 100) + '%', `13-week ${label} total, all ${c.cal.backtest.length} origins`, 'Max: ±5.0%', GREEN);
  const nTest = c.cal.backtest.length - c.cal.split; const covered = Math.round(c.cal.testCoverage * nTest);
  gauge($('g4'), c.cal.testCoverage, `${covered} / ${nTest}`, `held-out quarters inside band`, `noise-only bands: ${pct(c.cal.rawCoverage)}`, c.cal.testCoverage >= 0.85 ? GREEN : AMBER);

  // ----- engine drivers -----
  const ids = data.site.ids; const ages = data.history.lastAge; const n = ids.length;
  const list = [...Array(n).keys()].map(u => ({
    u, id: ids[u], age: ages[u], rate: rateLbMWh(c.models[u], 0.85, ages[u]),
    cur: c.base.unitTons[u], opt: oc.res.unitTons[u], swap: b.swaps.includes(u),
  })).sort((x, y) => y.cur - x.cur);
  const action = r => r.swap ? `<span class="pill swap">Replace catalyst · ${monthLabel(monthKey(data.history.days + data.plan.swapOffsetDays))}</span>`
    : r.opt < 0.7 * r.cur ? '<span class="pill park">Standby first</span>' : r.opt > 1.1 * r.cur ? '<span class="pill base">Base load</span>' : '<span class="tip">Rotate</span>';
  const shown = state.showAll ? list : list.slice(0, 8);
  $('drvTable').innerHTML = `<tr><th>Engine</th><th>Catalyst hours</th><th>${label} lb/MWh @85%</th><th>Tons · current</th><th>Tons · plan</th><th>Action</th></tr>` +
    shown.map(r => `<tr><td>${r.id}</td><td>${r.age.toLocaleString('en-US')}</td><td>${fmt(r.rate, 3)}</td><td>${fmt(r.cur, 2)}</td><td>${fmt(r.opt, 2)}</td><td>${action(r)}</td></tr>`).join('');
  $('drvSub').textContent = `next 12 months, sorted by current-plan tons`;
  $('drvMore').textContent = state.showAll ? 'Show top 8' : `Show all ${n} engines`;

  // ----- backtest -----
  const bt = c.cal.backtest; const bl = bt.map(x => dayDate(x.origin).toISOString().slice(5, 10).replace('-', '/'));
  const q100 = c.cal.q * 100;
  const bds = [
    { label: 'Conformal +', data: bt.map(() => q100), borderWidth: 0, pointRadius: 0, backgroundColor: 'rgba(71,175,114,0.22)', fill: '+1' },
    { label: 'Conformal -', data: bt.map(() => -q100), borderWidth: 0, pointRadius: 0, fill: false },
    { label: 'Noise-only +', data: bt.map(x => 100 * Math.log(x.hi / x.med)), borderColor: 'rgba(220,214,108,.8)', borderWidth: 1.2, pointRadius: 0, borderDash: [3, 3] },
    { label: 'Noise-only -', data: bt.map(x => 100 * Math.log(x.lo / x.med)), borderColor: 'rgba(220,214,108,.8)', borderWidth: 1.2, pointRadius: 0, borderDash: [3, 3] },
    { label: 'Measured vs predicted', data: bt.map(x => 100 * x.err), borderColor: '#e9eaee', backgroundColor: bt.map((x, i) => i < c.cal.split ? '#8d8f9b' : '#e9eaee'), borderWidth: 1, pointRadius: 3, showLine: true },
  ];
  const bopts = {
    responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: false }, tooltip: { backgroundColor: '#0e1020', borderColor: '#2f3241', borderWidth: 1, callbacks: { title: i => 'Forecast made ' + i[0].label, label: i => `${i.dataset.label}: ${i.parsed.y >= 0 ? '+' : ''}${fmt(i.parsed.y, 2)}%` } } },
    scales: { x: { grid: { color: '#262938', drawTicks: false }, ticks: { color: '#8d8f9b', font: { family: 'Lato', size: 10 }, maxTicksLimit: 8, maxRotation: 0, padding: 6 } }, y: { grid: { color: '#262938', drawTicks: false }, ticks: { color: '#8d8f9b', font: { family: 'Lato', size: 10 }, padding: 6, callback: v => (v > 0 ? '+' : '') + v + '%' }, border: { display: false } } },
  };
  if (btChart) { btChart.data.labels = bl; btChart.data.datasets = bds; btChart.options = bopts; btChart.update(); }
  else btChart = new Chart($('btChart'), { type: 'line', data: { labels: bl, datasets: bds }, options: bopts });
  $('btStats').innerHTML = `<div><b>${pct(c.cal.rawCoverage)}</b><span>noise-only 90% bands covered the measured 13-week total</span></div>
    <div><b>±${fmt(c.cal.qCal * 100)}%</b><span>conformal band fit on first ${c.cal.split} origins</span></div>
    <div><b>${covered} / ${nTest}</b><span>later origins inside that band (${pct(c.cal.testCoverage)})</span></div>`;
}

async function update() {
  $('loading').classList.remove('hide');
  await sleep();
  const c = await polCtx(state.pol); const oc = await optCtx(state.pol, state.target);
  render(c, oc);
  $('loading').classList.add('hide');
  document.body.dataset.ready = '1';
}

function wire() {
  for (const [segId, key] of [['polSeg', 'pol'], ['planSeg', 'plan']]) {
    $(segId).addEventListener('click', e => {
      const v = e.target?.dataset?.v; if (!v) return;
      state[key] = v; [...$(segId).children].forEach(x => x.classList.toggle('on', x.dataset.v === v)); update();
    });
  }
  $('target').addEventListener('change', e => { state.target = +e.target.value; update(); });
  $('drvMore').addEventListener('click', e => { e.preventDefault(); state.showAll = !state.showAll; update(); });
  const p = new URLSearchParams(location.search);
  if (p.get('pol')) state.pol = p.get('pol');
  if (p.get('target')) state.target = +p.get('target');
  if (p.get('plan')) state.plan = p.get('plan');
  $('target').value = String(state.target);
  [...$('polSeg').children].forEach(x => x.classList.toggle('on', x.dataset.v === state.pol));
  [...$('planSeg').children].forEach(x => x.classList.toggle('on', x.dataset.v === state.plan));
}

(async function main() {
  data = await (await fetch('data/site.json')).json();
  Chart.defaults.font.family = 'Lato';
  fleetList(); wire(); await update();
})();
