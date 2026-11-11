# Permit Headroom: a concept feature for the VoltaGrid client portal

**Live demo:** https://mohith26.github.io/voltagrid-permit-headroom/

Unofficial concept demo by Mohith Gajjela. Not affiliated with VoltaGrid. Synthetic data.

## What it is

Behind-the-meter gas plants that serve data centers usually run under a synthetic-minor air
permit: a rolling 12-month cap on NOx and CO (for example 99 tons) that is often shared with
the host data center's own emergency engines. The VoltaGrid portal already shows measured
emissions per fleet. Permit Headroom answers the next question a customer or an operations
lead asks: **with the load ramp we have contracted, what is the chance we cross the cap in the
next 12 months, in which month, and what is the cheapest change to the run plan that keeps the
risk under a target?**

The page lives under Reports, next to Emissions and Invoices, in the portal's dark theme.

## How it works

All numbers on the page are computed in the browser from `data/site.json` by `core/headroom.js`.

1. **Per-engine emission models from measured data.** For each of the 30 engines, a
   ridge-stabilised least-squares fit of daily measured mass:
   `lb = h·P·l·(a + s·age + q·age² + t·max(0, T−27°C)) + h·c + starts·k`
   (load fraction `l`, SCR catalyst hours `age`, ambient temperature `T`, cold starts).
2. **Projection.** 200 Monte Carlo scenarios over the next 12 months at weekly steps:
   hall energization dates slip (0-60 days, 15% chance of 90 more), weather drives cooling load,
   engines trip and restart, N+2 commitment is applied every week, and the rolling 12-month
   total (engines + host emergency engines) is computed at each month end.
3. **Uncertainty that is checked, not assumed.** Weekly residuals are block-bootstrapped, and
   each scenario also draws one out-of-sample model error from a rolling-origin backtest
   (31 weekly origins, refit on data before each origin, 13-week horizon). The backtest shows the
   noise-only 90% bands cover only 32% of realised quarters; a split-conformal band (fit on the
   first 18 origins) covers 13 of the 13 later, held-out quarters.
4. **Planner.** Finds the cheapest plan with P(breach) at or below the target (1%, 5%, 10%):
   - commit the engines with the lowest fitted rate first (no engine more than 1,500 run hours
     ahead of the fleet median, so overhaul intervals stay aligned);
   - share load by equalising marginal cost of fuel plus an emission price λ ($/lb), solved exactly
     per week by bisection on the common marginal cost (the cost is convex quadratic per engine);
   - optionally pull forward SCR catalyst replacements on the engines whose fitted aging terms
     make them the dirtiest (each priced at $92k, an assumption).
   λ is found by bisection on common random numbers; the N+2 reserve is never relaxed.
   The chosen plan is re-checked on 400 fresh scenarios with a different seed.

### Headline results on the synthetic site (from `node scripts/report.mjs`)

| | NOx |
|---|---|
| Rolling 12-month total, Oct 2026 | 80.7 t of a 99.0 t cap |
| Current wear-levelling rotation | P(breach) 100%, first at-risk month Jul 2027, median peak 105.1 t |
| Cleanest engines first only | 63.5% |
| Headroom plan, 5% target | λ = 19 $/lb, no catalyst swaps: 5.0% (4.0% on 400 fresh scenarios), +$24,925/yr fuel on a $15.5M gas bill |
| Headroom plan, 1% target | 1 early catalyst swap (engine 021) + λ = 11: 1.0%, $108,698/yr |

CO stays far below its cap (P(breach) 0%). Its model is weaker (held-out coverage 9/13), and the
page shows that honestly in the coverage gauge.

## Run it

```
node scripts/generate.mjs      # regenerates data/site.json (seeded)
node --test test/              # 11 tests
node scripts/report.mjs        # prints every headline number
python3 -m http.server         # then open http://localhost:8000
```

Tests cover: generator determinism against the committed data; exact coefficient recovery on
noise-free rows; dispatch serves the load, respects bounds and orders load by marginal emission
rate; N+2 reserve; the conformal order statistic and its coverage on exchangeable draws; backtest
coverage; rolling-sum bookkeeping for both pollutants; seeded determinism; monotone risk in λ;
and that the planner returns the cheapest feasible plan it tried.

## Honest limitations

- **Synthetic data.** The permit structure (shared rolling 12-month caps, SCR + oxidation catalyst
  on every engine, synthetic-minor limits around 99 tpy) is modeled on public permit documents;
  the site, customer, engines and every measurement are synthetic. The generator includes effects
  the fitted model only approximates (nonlinear catalyst aging, a load-squared term).
- **Weekly resolution.** Dispatch uses weekly mean load. Real load following, start-up sequencing
  and minute-level SCR behaviour are not modeled.
- **Model error horizon.** The backtest calibrates a 13-week horizon; the projection holds one draw
  of that error for the whole year, which is conservative for persistence but may understate drift
  past 13 weeks. Backtest origins overlap, so they are not independent.
- **Costs are placeholders.** Gas at $3.40/MMBtu, an OEM-style part-load fuel curve, $92k per
  early catalyst replacement. Pulling a catalyst forward also forfeits its remaining life, which is
  not credited.
- **Compliance.** This is a planning estimate, not a compliance calculation; the permit's own
  recordkeeping method governs.
- **UI.** Rebuilt from public screenshots of the client portal (voltagrid.com). Fonts, spacing and
  some components are approximations.

## Novelty note

VoltaGrid's portal pages describe measured-emissions tracking, carbon intensity, cost projection
for the billing cycle and invoices; I found no permit-limit forecasting or emission-aware dispatch
in its public product pages or news (checked Nov 2026). General EHS suites do track rolling
12-month totals against permit limits and alert on approaching limits (VelocityEHS, Intelex,
AirComply), and some advertise forecasting or what-if scenarios (Intelex, Benchmark Gensuite).
What I did not find anywhere is the combination here: a breach probability whose band is checked
by a rolling-origin backtest, plus an engine-level plan (commitment order, emission-priced load
sharing, catalyst timing) solved for the cheapest way under a risk target, inside the power
provider's own portal. If VoltaGrid already does this internally, this is a second take.
