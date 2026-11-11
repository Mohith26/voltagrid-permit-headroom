// Permit Headroom core: fit per-engine emission models from measured (CEMS) data,
// project the rolling 12-month permit total with Monte Carlo, calibrate the band with a
// split-conformal backtest, and search for the cheapest run plan that keeps the
// probability of breaching the cap under a target.
// Pure ES module: runs in the browser and under `node --test`.

export const DAY0 = Date.UTC(2025, 0, 1); // day index 0 = 2025-01-01
export const DAY_MS = 86400000;

export const SITE = {
  units: 30,
  pmax: 3.3,            // MW per Jenbacher J620-class engine
  lmin: 0.4,            // minimum stable load fraction
  maxShare: 0.92,       // planning load per online engine before another is committed
  reserve: 2,           // N+2 spinning reserve, never relaxed by the optimizer
  fuel: { F0: 0.9, F1: 6.5, F2: 0.2 }, // MMBtu/h per MW of capacity: F0 + F1 l + F2 l^2
  gas: 3.4,             // $/MMBtu
  catalystLifeH: 24000, // scheduled SCR catalyst replacement interval (operating hours)
  catalystCost: 92000,  // $ per early catalyst replacement (assumption, see README)
  wearBandH: 1500,      // max run-hour lead over the fleet median before an engine is rested
};

// ---------- random numbers ----------
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function randn(r) {
  let u = 0; while (u === 0) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}
export function poisson(r, lam) {
  const L = Math.exp(-lam); let k = 0, p = 1;
  do { k++; p *= r(); } while (p > L);
  return k - 1;
}

// ---------- calendar ----------
export function dayDate(d) { return new Date(DAY0 + d * DAY_MS); }
export function monthKey(d) { const x = dayDate(d); return x.getUTCFullYear() * 12 + x.getUTCMonth(); }
export function monthLabel(mk) {
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return names[mk % 12] + ' ' + Math.floor(mk / 12);
}
export function daysBetween(a, b) { return Math.round((Date.UTC(b[0], b[1], b[2]) - Date.UTC(a[0], a[1], a[2])) / DAY_MS); }
export function dayOf(y, m, d) { return Math.round((Date.UTC(y, m, d) - DAY0) / DAY_MS); }

// seasonal ambient temperature (deg C), central Texas
export function tempMean(d) { return 19.5 + 10.5 * Math.sin(2 * Math.PI * (d - 105) / 365.25); }
// site load per MW of IT load (cooling rises with heat)
export function pue(T) { return 1.12 + 0.0075 * Math.max(0, T - 16); }

// IT load ramp: sum of energized halls, each ramping linearly over `ramp` days
export function itLoad(d, halls) {
  let mw = 0;
  for (const h of halls) {
    const t = d - h.day;
    if (t >= h.ramp) mw += h.mw; else if (t > 0) mw += h.mw * t / h.ramp;
  }
  return mw;
}

export function unitsNeeded(L) {
  return Math.min(SITE.units, Math.ceil(L / (SITE.maxShare * SITE.pmax)) + SITE.reserve);
}

export function fuelPerHour(l) { // MMBtu/h for one engine at load fraction l
  const f = SITE.fuel; return SITE.pmax * (f.F0 + f.F1 * l + f.F2 * l * l);
}

// ---------- linear algebra ----------
export function solve(A, b) { // Gaussian elimination with partial pivoting; A is n x n
  const n = b.length; const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const piv = M[c][c]; if (Math.abs(piv) < 1e-12) throw new Error('singular');
    for (let r = 0; r < n; r++) if (r !== c) {
      const f = M[r][c] / piv; if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// ---------- model fitting ----------
// Per-engine model of daily measured pollutant mass (lb):
//   y = h*P*l*(a + s*ageK + q*ageK^2 + t*heat) + h*c + starts*k,   heat = max(0, T - 27 C)
// features: [h*P*l, h*P*l*ageK, h*P*l*ageK^2, h*P*l*heat, h, starts]; ridge-stabilised least squares.
export const HEAT_C = 27;
export const FEATURES = ['load', 'load x catalyst age', 'load x catalyst age^2', 'load x heat', 'hours', 'starts'];
export function heat(T) { return Math.max(0, T - HEAT_C); }
export function features(h, l, age, starts, T) {
  const P = SITE.pmax, ak = age / 1000; return [h * P * l, h * P * l * ak, h * P * l * ak * ak / 10, h * P * l * heat(T), h, starts];
}

export function fitUnit(rows, pollutant, ridge = 1e-3) {
  const k = 6; const A = Array.from({ length: k }, () => new Array(k).fill(0)); const b = new Array(k).fill(0);
  let n = 0;
  for (const r of rows) {
    if (r.h <= 0) continue;
    const x = features(r.h, r.l, r.age, r.st, r.T); const y = r[pollutant];
    for (let i = 0; i < k; i++) { b[i] += x[i] * y; for (let j = 0; j < k; j++) A[i][j] += x[i] * x[j]; }
    n++;
  }
  for (let i = 0; i < k; i++) A[i][i] += ridge * (A[i][i] || 1);
  const th = solve(A, b);
  return { a: th[0], s: th[1], q: th[2], t: Math.max(0, th[3]), c: th[4], k: Math.max(0, th[5]), n };
}

// catalyst-aging part of the per-MWh rate (lb/MWh) at a given age
export function agingRate(m, age) { const ak = age / 1000; return m.a + m.s * ak + m.q * ak * ak / 10; }
export function predictUnit(m, h, l, age, starts, T) {
  return h * SITE.pmax * l * (agingRate(m, age) + m.t * heat(T)) + h * m.c + starts * m.k;
}
// fitted lb/MWh at a given load, catalyst age and temperature (excludes starts)
export function rateLbMWh(m, l, age, T = 20) { return (SITE.pmax * l * (agingRate(m, age) + m.t * heat(T)) + m.c) / (SITE.pmax * l); }

// rows of the history for one unit, optionally truncated at day `upto` (exclusive)
export function unitRows(data, u, upto = Infinity) {
  const out = []; const H = data.history;
  const n = Math.min(H.days, upto);
  for (let d = 0; d < n; d++) {
    const i = d * data.site.units + u;
    out.push({ d, h: H.h[i], l: H.l[i], age: H.age[i], st: H.st[i], nox: H.nox[i], co: H.co[i], T: H.temp[d] });
  }
  return out;
}

export function fitAll(data, pollutant = 'nox', upto = Infinity) {
  const models = [];
  for (let u = 0; u < data.site.units; u++) models.push(fitUnit(unitRows(data, u, upto), pollutant));
  return models;
}

// weekly site-level relative residuals (actual/predicted - 1) over days [from, to)
export function weeklyResiduals(data, models, pollutant, from, to) {
  const H = data.history, U = data.site.units; const res = [];
  for (let w0 = from; w0 + 7 <= to; w0 += 7) {
    let act = 0, pred = 0;
    for (let d = w0; d < w0 + 7; d++) for (let u = 0; u < U; u++) {
      const i = d * U + u; if (H.h[i] <= 0) continue;
      act += H[pollutant][i]; pred += predictUnit(models[u], H.h[i], H.l[i], H.age[i], H.st[i], H.temp[d]);
    }
    if (pred > 0) res.push({ w0, r: act / pred - 1 });
  }
  return res;
}

// Moving-block bootstrap of weekly site-level residuals: each scenario starts at a random
// historical week and walks forward, so persistent stretches of error stay together.
export function residSampler(res) {
  const v = res.map(x => x.r);
  return {
    n: v.length,
    scenario(r) { return { i: Math.floor(r() * v.length) }; },
    draw(sc) { return v.length ? v[(sc.i++) % v.length] : 0; },
  };
}

// ---------- dispatch ----------
// Emission-weighted economic dispatch over the committed engines:
// minimise sum fuel$(l_u) + lambda * pollutant(l_u) s.t. sum P l_u = L, lmin <= l_u <= 1.
// Each engine's cost is convex quadratic in l, so the optimum equalises marginal cost (mu).
export function dispatch(L, online, models, ages, lambda, T = 20) {
  const P = SITE.pmax, f = SITE.fuel, g = SITE.gas; const n = online.length;
  const loads = new Float64Array(n);
  const share = L / (n * P);
  if (lambda <= 0 || share >= 1 || share <= SITE.lmin) {
    loads.fill(Math.min(1, Math.max(SITE.lmin, share))); return loads;
  }
  // marginal cost per MW at load l: alpha_u + 2 beta l
  const alpha = new Float64Array(n), beta = g * f.F2;
  for (let j = 0; j < n; j++) { const m = models[online[j]]; alpha[j] = g * f.F1 + lambda * (agingRate(m, ages[online[j]]) + m.t * heat(T)); }
  let lo = Infinity, hi = -Infinity;
  for (let j = 0; j < n; j++) { lo = Math.min(lo, alpha[j] + 2 * beta * SITE.lmin); hi = Math.max(hi, alpha[j] + 2 * beta); }
  const target = L / P;
  for (let it = 0; it < 40; it++) {
    const mu = 0.5 * (lo + hi); let sum = 0;
    for (let j = 0; j < n; j++) { let l = (mu - alpha[j]) / (2 * beta); l = l < SITE.lmin ? SITE.lmin : l > 1 ? 1 : l; sum += l; }
    if (sum > target) hi = mu; else lo = mu;
  }
  const mu = 0.5 * (lo + hi); let sum = 0;
  for (let j = 0; j < n; j++) { let l = (mu - alpha[j]) / (2 * beta); l = l < SITE.lmin ? SITE.lmin : l > 1 ? 1 : l; loads[j] = l; sum += l; }
  // tiny correction so the engines serve the load exactly
  const corr = (target - sum) / n; for (let j = 0; j < n; j++) loads[j] = Math.min(1, Math.max(SITE.lmin, loads[j] + corr));
  return loads;
}

// ---------- projection ----------
// plan = { name, commit: 'rotation'|'merit', lambda, swaps: [unit indices replaced at swapDay] }
export const BASELINE = { name: 'Current plan', commit: 'rotation', lambda: 0, swaps: [] };

export function monthsOfProjection(data) {
  const out = []; const start = data.history.days; const end = start + 365;
  for (let d = start; d < end; d++) { const mk = monthKey(d); if (!out.length || out[out.length - 1] !== mk) out.push(mk); }
  return out;
}

export function historyMonthly(data, pollutant) {
  const H = data.history, U = data.site.units; const m = new Map();
  for (let d = 0; d < H.days; d++) {
    let s = 0; for (let u = 0; u < U; u++) s += H[pollutant][d * U + u];
    const mk = monthKey(d); m.set(mk, (m.get(mk) || 0) + s / 2000);
  }
  for (const r of data.hostMonthly) m.set(r.mk, (m.get(r.mk) || 0) + r[pollutant]);
  return m; // tons per month, engines + host data-center emergency engines
}

export function simulate(data, models, plan, opts = {}) {
  const S = opts.S ?? 300, seed = opts.seed ?? 7, pollutant = opts.pollutant ?? 'nox';
  const modelErr = opts.modelErr; // signed out-of-sample log errors from the backtest
  const resid = opts.resid; // residSampler over in-sample weekly residuals
  const U = data.site.units, P = SITE.pmax, start = data.history.days;
  const months = monthsOfProjection(data); const M = months.length;
  const histM = historyMonthly(data, pollutant);
  const cap = data.permit[pollutant].cap;
  const r = rng(seed);
  const monthly = new Float64Array(S * M); const rolling = new Float64Array(S * M);
  const unitTons = new Float64Array(U); let fuelCost = 0, startsTotal = 0, swapsDone = 0;
  const lastAge = data.history.lastAge, lastOn = data.history.lastOnline, lastHours = data.history.cumHours;
  const swapDay = start + (data.plan?.swapOffsetDays ?? 30);
  const hostByMonth = new Map(); for (const r0 of data.hostMonthly) { const mm = r0.mk % 12; if (!hostByMonth.has(mm)) hostByMonth.set(mm, []); hostByMonth.get(mm).push(r0[pollutant]); }
  const steps = []; for (let d = start; d < start + 365; d += 7) steps.push([d, Math.min(7, start + 365 - d)]);
  const monthIdx = new Map(months.map((mk, i) => [mk, i]));
  for (let s = 0; s < S; s++) {
    // per-scenario load uncertainty: each future hall slips 0-60 days (15% chance of 90 more)
    const halls = data.halls.map(h => h.future ? { ...h, day: h.day + Math.floor(r() * 61) + (r() < 0.15 ? 90 : 0) } : h);
    const age = Float64Array.from(lastAge); const hours = Float64Array.from(lastHours);
    let on = new Set(lastOn); let ar = 0;
    const swapped = new Set();
    const sc = resid ? resid.scenario(r) : null;
    // one out-of-sample model error per scenario, held for the whole year (conservative)
    const mErr = modelErr && modelErr.length ? Math.exp(modelErr[Math.floor(r() * modelErr.length)]) : 1;
    for (const [d0, len] of steps) {
      const dm = d0 + len / 2;
      const T = tempMean(dm) + 1.2 * randn(r);
      ar = 0.6 * ar + 0.015 * randn(r);
      const L = itLoad(dm, halls) * pue(T) * (1 + ar);
      // planned early catalyst replacements
      if (plan.swaps.length && d0 >= swapDay && swapped.size < plan.swaps.length) for (const u of plan.swaps) if (!swapped.has(u)) { age[u] = 0; swapped.add(u); }
      // scheduled replacement at end of catalyst life (both plans)
      for (let u = 0; u < U; u++) if (age[u] >= SITE.catalystLifeH) age[u] = 0;
      const n = unitsNeeded(L);
      let starts = new Float64Array(U);
      let next;
      if (plan.commit === 'merit') {
        // merit order by fitted aging rate, but an engine more than wearBandH run hours ahead of
        // the fleet median is rested (keeps overhaul intervals aligned, like the rotation does)
        const med = [...hours].sort((x, y) => x - y)[U >> 1];
        const key = u => agingRate(models[u], age[u]) + (hours[u] > med + SITE.wearBandH ? 1e6 : 0);
        const order = [...Array(U).keys()].sort((x, y) => key(x) - key(y));
        next = new Set(order.slice(0, n));
      } else {
        // wear-levelling rotation: keep running units, add lowest-hour engines, drop highest-hour,
        // and once a week swap the highest-hour running engine for the lowest-hour standby engine
        const arr = [...on]; const off = [...Array(U).keys()].filter(u => !on.has(u));
        arr.sort((x, y) => hours[x] - hours[y]); off.sort((x, y) => hours[x] - hours[y]);
        while (arr.length > n) arr.pop();
        while (arr.length < n && off.length) arr.push(off.shift());
        if (off.length && arr.length) { arr.sort((x, y) => hours[x] - hours[y]); arr.pop(); arr.push(off.shift()); }
        next = new Set(arr);
      }
      for (const u of next) if (!on.has(u)) starts[u] += 1;
      on = next;
      const online = [...on];
      const loads = dispatch(L, online, models, age, plan.lambda, T);
      const hrs = len * 24;
      let tot = 0;
      for (let j = 0; j < online.length; j++) {
        const u = online[j];
        const trips = poisson(r, 0.015 * len); starts[u] += trips;
        const y = predictUnit(models[u], hrs, loads[j], age[u] + hrs / 2, starts[u], T);
        tot += y; unitTons[u] += y / 2000 / S;
        fuelCost += fuelPerHour(loads[j]) * hrs * SITE.gas / S;
        age[u] += hrs; hours[u] += hrs; startsTotal += starts[u] / S;
      }
      // week-to-week noise (block-bootstrapped residual) and the scenario's model error
      const e = sc ? resid.draw(sc) : 0;
      tot = Math.max(0, tot * (1 + e) * mErr);
      // spread the step over the months it covers
      for (let d = d0; d < d0 + len; d++) monthly[s * M + monthIdx.get(monthKey(d))] += tot / len / 2000;
    }
    // host data-center emergency engines: bootstrap same calendar month from history
    for (let i = 0; i < M; i++) { const pool = hostByMonth.get(months[i] % 12) || [0]; monthly[s * M + i] += pool[Math.floor(r() * pool.length)] * (0.85 + 0.3 * r()); }
    // rolling 12-month totals at each projected month end
    for (let i = 0; i < M; i++) {
      let sum = 0;
      for (let k = 0; k < 12; k++) {
        const mk = months[i] - k; const j = monthIdx.get(mk);
        sum += j !== undefined ? monthly[s * M + j] : (histM.get(mk) || 0);
      }
      rolling[s * M + i] = sum;
    }
  }
  void swapsDone;
  return summarize({ months, monthly, rolling, S, M, cap, unitTons, fuelCost, startsTotal, plan });
}

export function summarize(sim) {
  const { months, rolling, S, M, cap } = sim;
  const bands = []; let breach = 0; const pMonth = new Array(M).fill(0); const peak = [];
  for (let s = 0; s < S; s++) {
    let any = false, pk = 0;
    for (let i = 0; i < M; i++) { const v = rolling[s * M + i]; if (v > cap) { any = true; pMonth[i]++; } if (v > pk) pk = v; }
    if (any) breach++; peak.push(pk);
  }
  for (let i = 0; i < M; i++) {
    const col = []; for (let s = 0; s < S; s++) col.push(rolling[s * M + i]); col.sort((a, b) => a - b);
    bands.push({ mk: months[i], p05: quantile(col, 0.05), p50: quantile(col, 0.5), p95: quantile(col, 0.95), pBreach: pMonth[i] / S });
  }
  peak.sort((a, b) => a - b);
  const firstRisk = bands.find(b => b.pBreach >= 0.05);
  return { ...sim, bands, pBreach: breach / S, peakP50: quantile(peak, 0.5), peakP95: quantile(peak, 0.95), firstRisk: firstRisk ? firstRisk.mk : null };
}

// ---------- calibration (split-conformal backtest) ----------
// At each weekly origin (after a full year of data), refit on data before the origin and
// predict the next `horizon` days of measured mass from the realised operations. The
// noise-only Monte Carlo band is compared with the realised total, and the out-of-sample
// log error err = ln(actual / median) is recorded. Conformal: the ceil((n+1)(1-alpha))-th
// smallest |err| on calibration origins gives a band with finite-sample coverage under
// exchangeability; we check it on later, held-out origins.
export function backtest(data, pollutant = 'nox', opts = {}) {
  const horizon = opts.horizon ?? 91, step = opts.step ?? 7, firstOrigin = opts.firstOrigin ?? 365, B = opts.B ?? 300;
  const H = data.history, U = data.site.units; const r = rng(opts.seed ?? 11);
  const out = [];
  for (let o = firstOrigin; o + horizon <= H.days; o += step) {
    const models = fitAll(data, pollutant, o);
    const samp = residSampler(weeklyResiduals(data, models, pollutant, 0, o));
    const wk = [];
    for (let w0 = o; w0 + 7 <= o + horizon; w0 += 7) {
      let act = 0, pred = 0;
      for (let d = w0; d < w0 + 7; d++) for (let u = 0; u < U; u++) {
        const i = d * U + u; if (H.h[i] <= 0) continue;
        act += H[pollutant][i]; pred += predictUnit(models[u], H.h[i], H.l[i], H.age[i], H.st[i], H.temp[d]);
      }
      wk.push({ act, pred, mid: w0 + 3 });
    }
    const actual = wk.reduce((a, w) => a + w.act, 0) / 2000;
    const sims = [];
    for (let b = 0; b < B; b++) {
      const sc = samp.scenario(r); let t = 0;
      for (const w of wk) t += w.pred * (1 + samp.draw(sc)); sims.push(t / 2000);
    }
    sims.sort((a, b) => a - b);
    const med = quantile(sims, 0.5), lo = quantile(sims, 0.05), hi = quantile(sims, 0.95);
    out.push({ origin: o, actual, med, lo, hi, err: Math.log(actual / med) });
  }
  return out;
}

export function conformalQuantile(scores, alpha = 0.1) {
  const s = [...scores].sort((a, b) => a - b); const n = s.length;
  const k = Math.ceil((n + 1) * (1 - alpha));
  return k > n ? Infinity : s[k - 1];
}

export function calibration(data, pollutant = 'nox', opts = {}) {
  const bt = backtest(data, pollutant, opts);
  const split = Math.floor(bt.length * 0.6);
  const cal = bt.slice(0, split), test = bt.slice(split);
  const inRaw = x => x.actual >= x.lo && x.actual <= x.hi;
  const qCal = conformalQuantile(cal.map(x => Math.abs(x.err)));
  const errs = bt.map(x => x.err);
  return {
    backtest: bt, split, errs,
    rawCoverage: bt.filter(inRaw).length / bt.length,
    qCal, testCoverage: test.filter(x => Math.abs(x.err) <= qCal).length / test.length,
    q: conformalQuantile(bt.map(x => Math.abs(x.err))),
    bias: errs.reduce((a, b) => a + b, 0) / errs.length,
  };
}

// ---------- optimiser ----------
// Cheapest plan with P(breach) <= target. Levers: merit-order commitment of the cleanest engines,
// an emission price lambda in the load sharing, and pulling forward k catalyst replacements on the
// engines whose fitted aging slope makes them the dirtiest. Reserve (N+2) is never relaxed.
export function optimize(data, models, ctx) {
  const { target = 0.05, S = 200, seed = 7, modelErr, resid, maxSwaps = 6, lambdaMax = 400, iters = 8, minK = 1, pollutant = 'nox' } = ctx;
  const base = simulate(data, models, BASELINE, { S, seed, modelErr, resid, pollutant });
  const ages = data.history.lastAge;
  const cands = [...Array(data.site.units).keys()]
    .sort((x, y) => (agingRate(models[y], Math.min(ages[y] + 6000, SITE.catalystLifeH)) - agingRate(models[y], 0)) - (agingRate(models[x], Math.min(ages[x] + 6000, SITE.catalystLifeH)) - agingRate(models[x], 0)))
    .slice(0, maxSwaps);
  const tried = []; let best = null;
  for (let k = 0; k <= maxSwaps; k++) {
    // catalyst spend alone already exceeds the best plan found: larger k cannot win
    // (minK: always evaluate the first swap option so the trade-off can be shown)
    if (best && k > minK && k * SITE.catalystCost >= best.cost) break;
    const swaps = cands.slice(0, k);
    const ev = (lambda) => simulate(data, models, { name: 'Headroom plan', commit: 'merit', lambda, swaps }, { S, seed, modelErr, resid, pollutant });
    let res = ev(0), lam = 0;
    if (res.pBreach > target) {
      const top = ev(lambdaMax);
      if (top.pBreach > target) { tried.push({ k, lambda: lambdaMax, pBreach: top.pBreach, feasible: false }); continue; }
      let lo = 0, hi = lambdaMax; res = top; lam = lambdaMax;
      for (let it = 0; it < iters; it++) {
        const mid = 0.5 * (lo + hi); const m = ev(mid);
        if (m.pBreach <= target) { hi = mid; res = m; lam = mid; } else lo = mid;
      }
    }
    const cost = (res.fuelCost - base.fuelCost) + k * SITE.catalystCost;
    const rec = { k, swaps, lambda: lam, pBreach: res.pBreach, fuelDelta: res.fuelCost - base.fuelCost, cost, feasible: true };
    tried.push(rec);
    if (!best || cost < best.cost) best = { ...rec, result: res };
  }
  const meritOnly = simulate(data, models, { name: 'Merit commitment', commit: 'merit', lambda: 0, swaps: [] }, { S, seed, modelErr, resid, pollutant });
  return { base, best, tried, cands, meritOnly: { pBreach: meritOnly.pBreach, fuelDelta: meritOnly.fuelCost - base.fuelCost } };
}
