import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SITE, rng, randn, fitUnit, predictUnit, dispatch, conformalQuantile, simulate, BASELINE, fitAll,
  weeklyResiduals, residSampler, calibration, optimize, historyMonthly, monthsOfProjection, unitsNeeded, agingRate, heat,
} from '../core/headroom.js';
import { generate } from '../scripts/generate.mjs';

const data = JSON.parse(readFileSync(new URL('../data/site.json', import.meta.url)));
const models = fitAll(data, 'nox');
const resid = residSampler(weeklyResiduals(data, models, 'nox', 0, data.history.days));
const cal = calibration(data, 'nox');

test('committed data is reproduced by the seeded generator', () => {
  const g = JSON.parse(JSON.stringify(generate()));
  assert.equal(g.history.days, data.history.days);
  assert.deepEqual(g.history.nox.slice(0, 500), data.history.nox.slice(0, 500));
  assert.deepEqual(g.history.lastAge, data.history.lastAge);
  assert.deepEqual(g.hostMonthly, data.hostMonthly);
});

test('fitUnit recovers known coefficients from noise-free rows', () => {
  const truth = { a: 0.21, s: 0.004, q: 0.002, t: 0.006, c: 0.07, k: 15 };
  const r = rng(3); const rows = [];
  for (let i = 0; i < 600; i++) {
    const l = 0.5 + 0.5 * r(), age = 20000 * r(), st = r() < 0.1 ? 1 : 0, T = 10 + 25 * r(), h = 24 - 2 * st;
    rows.push({ h, l, age, st, T, nox: predictUnit(truth, h, l, age, st, T) });
  }
  const m = fitUnit(rows, 'nox', 1e-9);
  for (const key of ['a', 's', 'q', 't', 'c', 'k']) assert.ok(Math.abs(m[key] - truth[key]) < 1e-4 * Math.max(1, Math.abs(truth[key]) * 100), key + ' ' + m[key]);
});

test('dispatch serves the load, respects bounds, and shifts load to cleaner engines', () => {
  const online = [...Array(20).keys()]; const ages = data.history.lastAge;
  const L = 20 * SITE.pmax * 0.8;
  const eq = dispatch(L, online, models, ages, 0);
  assert.ok(eq.every(v => Math.abs(v - 0.8) < 1e-12));
  const w = dispatch(L, online, models, ages, 60, 30);
  const served = [...w].reduce((a, b) => a + b, 0) * SITE.pmax;
  assert.ok(Math.abs(served - L) < 1e-6 * L);
  assert.ok([...w].every(v => v >= SITE.lmin - 1e-12 && v <= 1 + 1e-12));
  const rate = j => agingRate(models[online[j]], ages[online[j]]) + models[online[j]].t * heat(30);
  for (let i = 0; i < 20; i++) for (let j = 0; j < 20; j++) if (rate(i) < rate(j) - 1e-9) assert.ok(w[i] >= w[j] - 1e-9);
});

test('N+2 reserve is always kept', () => {
  for (const L of [10, 40, 63.7, 80]) assert.equal(unitsNeeded(L), Math.min(SITE.units, Math.ceil(L / (SITE.maxShare * SITE.pmax)) + 2));
});

test('conformal quantile is the right order statistic and covers exchangeable draws', () => {
  assert.equal(conformalQuantile([5, 1, 4, 2, 3, 9, 8, 7, 6], 0.1), 9); // ceil(10*0.9)=9th
  assert.equal(conformalQuantile([...Array(19).keys()].map(i => i + 1), 0.1), 18);
  const r = rng(5); let covered = 0, trials = 2000;
  for (let t = 0; t < trials; t++) {
    const cal = Array.from({ length: 20 }, () => Math.abs(randn(r)));
    const q = conformalQuantile(cal, 0.1); if (Math.abs(randn(r)) <= q) covered++;
  }
  assert.ok(covered / trials >= 0.88, 'coverage ' + covered / trials);
});

test('backtest: noise-only bands undercover, conformal band holds on held-out origins', () => {
  assert.ok(cal.backtest.length >= 25);
  assert.ok(cal.rawCoverage < 0.6);
  assert.ok(cal.testCoverage >= 0.85, 'test coverage ' + cal.testCoverage);
});

for (const pol of ['nox', 'co']) test(`rolling ${pol} totals are 12-month sums of projected and historical months`, () => {
  const ms = fitAll(data, pol);
  const sim = simulate(data, ms, BASELINE, { S: 20, pollutant: pol, resid: residSampler(weeklyResiduals(data, ms, pol, 0, data.history.days)) });
  const months = monthsOfProjection(data); const hm = historyMonthly(data, pol);
  // the first projected month continues the measured series (no level jump)
  const mks = [...hm.keys()].sort((a, b) => a - b); const lastHist = hm.get(mks[mks.length - 1]);
  assert.ok(Math.abs(sim.monthly[0] / lastHist - 1) < 0.25, pol + ' ' + sim.monthly[0] + ' vs ' + lastHist);
  assert.equal(months.length, 12);
  for (let s = 0; s < 3; s++) {
    let exp = sim.monthly[s * 12 + 0];
    for (let k = 1; k < 12; k++) exp += hm.get(months[0] - k);
    assert.ok(Math.abs(exp - sim.rolling[s * 12]) < 1e-9);
    let all = 0; for (let i = 0; i < 12; i++) all += sim.monthly[s * 12 + i];
    assert.ok(Math.abs(all - sim.rolling[s * 12 + 11]) < 1e-9);
  }
});

test('simulation is deterministic under a seed (common random numbers)', () => {
  const a = simulate(data, models, BASELINE, { S: 30, seed: 4, resid, modelErr: cal.errs });
  const b = simulate(data, models, BASELINE, { S: 30, seed: 4, resid, modelErr: cal.errs });
  assert.deepEqual([...a.rolling], [...b.rolling]);
});

test('emission-aware levers lower breach risk monotonically on common random numbers', () => {
  const opt = { S: 120, resid, modelErr: cal.errs };
  const base = simulate(data, models, BASELINE, opt);
  const p = [0, 10, 40, 160].map(lambda => simulate(data, models, { commit: 'merit', lambda, swaps: [] }, opt).pBreach);
  assert.ok(p[0] < base.pBreach);
  for (let i = 1; i < p.length; i++) assert.ok(p[i] <= p[i - 1] + 0.02, p.join(','));
});

test('optimizer returns the cheapest tried plan that meets the target', () => {
  const o = optimize(data, models, { target: 0.05, S: 120, resid, modelErr: cal.errs });
  assert.ok(o.best.pBreach <= 0.05);
  for (const t of o.tried) if (t.feasible) assert.ok(o.best.cost <= t.cost + 1e-6);
  assert.ok(o.base.pBreach > 0.5);
});
