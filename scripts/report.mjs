// Prints every headline number the page shows, using the same core code, data, seeds and
// scenario counts as app.js (S=200 seed 7 for the planner, 400 fresh scenarios seed 99 for the check).
import { readFileSync } from 'node:fs';
import { fitAll, weeklyResiduals, residSampler, calibration, simulate, optimize, BASELINE, historyMonthly, monthLabel } from '../core/headroom.js';

const data = JSON.parse(readFileSync(new URL('../data/site.json', import.meta.url)));
const S = 200, SEED = 7;
for (const pol of ['nox', 'co']) {
  const models = fitAll(data, pol);
  const resid = residSampler(weeklyResiduals(data, models, pol, 0, data.history.days));
  const cal = calibration(data, pol);
  const hm = historyMonthly(data, pol); const mks = [...hm.keys()].sort((a, b) => a - b);
  const last12 = mks.slice(-12).reduce((a, k) => a + hm.get(k), 0);
  const base = simulate(data, models, BASELINE, { S, seed: SEED, resid, modelErr: cal.errs, pollutant: pol });
  const nTest = cal.backtest.length - cal.split;
  console.log(`\n== ${pol.toUpperCase()} (cap ${data.permit[pol].cap} t) ==`);
  console.log(`rolling 12-mo through ${monthLabel(mks[mks.length - 1])}: ${last12.toFixed(1)} t`);
  console.log(`backtest: ${cal.backtest.length} origins, noise-only 90% coverage ${(cal.rawCoverage * 100).toFixed(0)}%, conformal q(all) ±${(cal.q * 100).toFixed(1)}%, q(first ${cal.split}) ±${(cal.qCal * 100).toFixed(1)}% -> held-out ${Math.round(cal.testCoverage * nTest)}/${nTest}, mean err ${(cal.bias * 100).toFixed(2)}%`);
  console.log(`current rotation: P(breach) ${(base.pBreach * 100).toFixed(1)}%, first at-risk ${base.firstRisk ? monthLabel(base.firstRisk) : 'none'}, median peak ${base.peakP50.toFixed(1)} t, fuel $${Math.round(base.fuelCost).toLocaleString()}`);
  for (const target of [0.01, 0.05, 0.1]) {
    const o = optimize(data, models, { target, S, seed: SEED, resid, modelErr: cal.errs, pollutant: pol });
    const plan = { commit: 'merit', lambda: o.best.lambda, swaps: o.best.swaps };
    const check = simulate(data, models, plan, { S: 400, seed: 99, resid, modelErr: cal.errs, pollutant: pol });
    console.log(`target ${target * 100}%: merit-only ${(o.meritOnly.pBreach * 100).toFixed(1)}% | best k=${o.best.k} swaps=[${o.best.swaps.map(u => data.site.ids[u].slice(-3))}] lambda=${Math.round(o.best.lambda)} $/lb -> P ${(o.best.pBreach * 100).toFixed(1)}%, median peak ${o.best.result.peakP50.toFixed(1)} t, cost $${Math.round(o.best.cost).toLocaleString()} (fuel ${Math.round(o.best.fuelDelta).toLocaleString()}) | check(400 fresh) ${(check.pBreach * 100).toFixed(1)}%`);
    console.log('   tried: ' + o.tried.map(t => `k=${t.k} lam=${Math.round(t.lambda)} P=${(t.pBreach * 100).toFixed(1)}% ${t.feasible ? '$' + Math.round(t.cost).toLocaleString() : 'infeasible'}`).join(' ; '));
  }
}
