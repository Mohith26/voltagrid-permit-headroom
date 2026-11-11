// Seeded synthetic site: a behind-the-meter plant of 30 J620-class gas engines serving a
// data center whose IT load ramps hall by hall. The permit structure (shared rolling
// 12-month NOx/CO caps for the engines plus the host data center's emergency engines,
// SCR + oxidation catalyst on every engine) mirrors public synthetic-minor permits;
// all operating data is synthetic. The "truth" emission physics deliberately includes
// effects the fitted model does not (ambient-temperature SCR slip, nonlinear catalyst
// aging, a load-squared term) so the calibration step has something real to catch.
import { writeFileSync } from 'node:fs';
import { rng, randn, poisson, SITE, tempMean, pue, itLoad, unitsNeeded, dayOf, monthKey } from '../core/headroom.js';

export function generate(seed = 20261110) {
  const r = rng(seed); const U = SITE.units, P = SITE.pmax;
  const days = dayOf(2026, 10, 1); // history: 2025-01-01 .. 2026-10-31
  const halls = [
    { name: 'Hall A', mw: 18, day: dayOf(2024, 11, 1), ramp: 1 },
    { name: 'Hall B', mw: 10, day: dayOf(2025, 3, 15), ramp: 30 },
    { name: 'Hall C', mw: 9, day: dayOf(2025, 8, 1), ramp: 30 },
    { name: 'Hall D', mw: 8, day: dayOf(2026, 1, 1), ramp: 30 },
    { name: 'Hall E', mw: 6, day: dayOf(2026, 6, 15), ramp: 30 },
    // contracted future energizations (dates can slip)
    { name: 'Hall F', mw: 6, day: dayOf(2027, 0, 15), ramp: 30, future: true },
    { name: 'Hall G', mw: 5, day: dayOf(2027, 3, 1), ramp: 30, future: true },
    { name: 'Hall H', mw: 4, day: dayOf(2027, 6, 1), ramp: 30, future: true },
  ];
  // per-engine truth parameters
  const units = [];
  for (let u = 0; u < U; u++) {
    units.push({
      id: 'NLC-CoryellTX-' + String(u + 1).padStart(3, '0'),
      a0: 0.226 * Math.exp(0.12 * randn(r)),           // lb/MWh, fresh catalyst
      g: Math.max(0.04, 0.13 + 0.05 * randn(r)),       // aging severity
      c: 0.05 + 0.02 * r(),                            // lb/h load-independent slip
      co: 0.155 * Math.exp(0.1 * randn(r)),            // lb/MWh CO after oxidation catalyst
      age0: Math.floor(r() * 17000),                   // catalyst hours on 2025-01-01
    });
  }
  const startNox = 16, startCo = 22; // lb per cold start (SCR below light-off)
  const h = new Float32Array(days * U), l = new Float32Array(days * U), age = new Float32Array(days * U), st = new Float32Array(days * U);
  const nox = new Float32Array(days * U), co = new Float32Array(days * U);
  const site = { load: new Float32Array(days), temp: new Float32Array(days) };
  const ageNow = units.map(x => x.age0); const cum = units.map(() => Math.floor(r() * 4000));
  let on = new Set([...Array(U).keys()].sort((x, y) => cum[x] - cum[y]).slice(0, unitsNeeded(itLoad(0, halls) * 1.15)));
  const replacements = [];
  let ar = 0;
  for (let d = 0; d < days; d++) {
    const T = tempMean(d) + 2.5 * randn(r);
    ar = 0.7 * ar + 0.012 * randn(r);
    const L = itLoad(d, halls) * pue(T) * (1 + ar);
    site.load[d] = L; site.temp[d] = T;
    const n = unitsNeeded(L);
    const arr = [...on]; const off = [...Array(U).keys()].filter(u => !on.has(u));
    arr.sort((x, y) => cum[x] - cum[y]); off.sort((x, y) => cum[x] - cum[y]);
    while (arr.length > n) arr.pop();
    while (arr.length < n && off.length) arr.push(off.shift());
    if (d % 7 === 0 && off.length) { arr.sort((x, y) => cum[x] - cum[y]); arr.pop(); arr.push(off.shift()); }
    const next = new Set(arr);
    const share = Math.min(1, Math.max(SITE.lmin, L / (n * P)));
    for (let u = 0; u < U; u++) {
      const i = d * U + u;
      if (ageNow[u] >= SITE.catalystLifeH) { replacements.push({ unit: u, day: d }); ageNow[u] = 0; }
      age[i] = ageNow[u];
      if (!next.has(u)) continue;
      const trips = poisson(r, 0.015); const cold = on.has(u) ? 0 : 1; const starts = cold + trips;
      const lu = Math.min(1, Math.max(SITE.lmin, share * (1 + 0.02 * randn(r))));
      const hrs = 24 - 1.5 * trips - 2 * cold;
      const x = units[u];
      const agingMult = 1 + x.g * Math.pow(ageNow[u] / 8000, 1.45);
      const heatMult = 1 + 0.03 * Math.max(0, T - 27);                   // SCR slip in heat
      const ratePerH = P * lu * x.a0 * agingMult * heatMult + 0.012 * P * lu * lu + x.c;
      const noise = Math.exp(0.07 * randn(r));
      h[i] = hrs; l[i] = lu; st[i] = starts;
      nox[i] = hrs * ratePerH * noise + starts * startNox * Math.exp(0.2 * randn(r));
      co[i] = hrs * (P * lu * x.co * (1 + 0.25 * (1 - lu)) + 0.06) * Math.exp(0.06 * randn(r)) + starts * startCo * Math.exp(0.2 * randn(r));
      ageNow[u] += hrs; cum[u] += hrs;
    }
    on = next;
  }
  // host data center: 48 diesel emergency gensets, monthly readiness tests + annual load-bank in March
  const hostMonthly = [];
  for (let d = 0; d < days; d++) {
    const mk = monthKey(d);
    if (!hostMonthly.length || hostMonthly[hostMonthly.length - 1].mk !== mk) {
      const march = mk % 12 === 2;
      hostMonthly.push({ mk, nox: +(0.42 * Math.exp(0.15 * randn(r)) + (march ? 1.6 : 0)).toFixed(3), co: +(0.09 * Math.exp(0.15 * randn(r)) + (march ? 0.35 : 0)).toFixed(3) });
    }
  }
  const lastOnline = [...on];
  const round = (arr, k) => Array.from(arr, v => +v.toFixed(k));
  return {
    meta: { seed, generated: 'scripts/generate.mjs', note: 'Synthetic data. Permit structure modeled on public synthetic-minor EGU permits; not any real site.' },
    customer: 'Northline Compute', siteName: 'NLC-CoryellTX', county: 'Coryell County, TX',
    site: { units: U, pmax: P, ids: units.map(x => x.id) },
    permit: { nox: { cap: 99.0, label: 'NOx (NO2)', basis: 'rolling 12-month, engines + host emergency engines' }, co: { cap: 99.0, label: 'CO', basis: 'rolling 12-month, engines + host emergency engines' } },
    halls: halls.map(x => ({ ...x })),
    history: {
      days, h: round(h, 2), l: round(l, 4), age: round(age, 0), st: round(st, 0), nox: round(nox, 3), co: round(co, 3),
      load: round(site.load, 3), temp: round(site.temp, 2),
      lastAge: ageNow.map(v => Math.round(v)), lastOnline, cumHours: cum.map(v => Math.round(v)),
    },
    replacements,
    hostMonthly,
    plan: { swapOffsetDays: 30 },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const data = generate();
  writeFileSync(new URL('../data/site.json', import.meta.url), JSON.stringify(data));
  console.log('wrote data/site.json', data.history.days, 'days x', data.site.units, 'engines');
}
