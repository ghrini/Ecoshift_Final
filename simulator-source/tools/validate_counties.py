#!/usr/bin/env python3
"""Multi-county validation of the Field Shift crop model against USDA NASS county yields (14 counties, corn and soybean).

    python3 tools/validate_counties.py          # writes data/validation_counties.json and prints the tables
    python3 tools/validate_counties.py --md     # also prints the markdown tables used in VALIDATION.md

This script never changes src/engine.js and does not touch tools/validate.py's outputs; it only imports its functions
(robust_trend, process_pred, fit_process, metrics' building blocks).

Inputs
  src/sites.js                     the 14 counties as built into the simulator (county NASA POWER weather, NRCS soil)
  raw/sites/<id>/nass_<crop>.csv   NASS Quick Stats county yields (Story County: data/nass/story_<crop>.csv)
  node tools/validate_counties_model.js   the engine's own per-season components for each county, with the SHIPPED settings

Two tests per county and crop, on the seasons that have both a NASS yield and weather (1982-2025)
  Target. Yield ratio = NASS county yield / robust trend (Tukey bisquare, the same method as tools/validate.py). In every
  fold the trend is refitted without the held-out season, so a season never sees its own yield. Same ratios for both tests.
  (a) TRANSFER. The shipped model exactly as fitted on Iowa state yields (gamma, heat slope, grain-fill exponent, rooting
      depth, season start, water-table term): nothing is refitted. The county's own weather and soil go in; the model's
      season ratio is normalised by the county's own median season (what the app does for every site).
  (b) REFIT. Leave-one-year-out: gamma, heat slope and grain-fill exponent are refitted on the county's other seasons
      in every fold (rooting depth, season start and water-table term stay at the shipped values: the structural
      grid search of validate.py is not repeated per county). Then the held-out season is predicted.
  Baseline. Trend-only: predicts ratio 1 (the county's own trend, refitted without the held-out season).
Metrics: Pearson r, RMSE in points of the trend (pp), skill = 1 - RMSE/RMSE(trend-only), mean absolute % error of the yield,
share of seasons within 10 points, overlap of the county's worst-5 real seasons with the model's own worst-5, and the
3 biggest misses.
Requires numpy, scipy, scikit-learn (the same as validate.py).
"""
import argparse, csv, json, math, pathlib, subprocess, sys
import numpy as np
from scipy.stats import pearsonr

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import validate as V                      # noqa: E402  (reuses robust_trend, comp_arrays, process_pred, fit_process)

ROOT = V.ROOT
CROPS = ('corn', 'soybean')
BAD_RATIO = 0.90                          # a "bad season": real yield 10 or more points under the trend
HOME = 'story-ia'

# Known weather and land context, used only to word the notes. It is NOT tested here; the notes say so.
CONTEXT = {
    'story-ia': 'home county: the model was fitted on Iowa state yields and the grid cell sits here',
    'obrien-ia': 'north-west Iowa, same state as the fit',
    'champaign-il': 'flat, tile-drained prairie soils; the 2012 drought and wet springs hit here',
    'tippecanoe-in': 'eroded sloping soil at the sample point, Indiana',
    'blueearth-mn': 'northern, shorter and cooler season than Iowa',
    'saunders-ne': 'part of the county is irrigated and NASS reports all practices together; model has no irrigation here',
    'brookings-sd': 'northern, short season; river flooding and late springs are common',
    'wood-oh': 'very poorly drained clay (Black Swamp) with low modelled water capacity; wet springs delay planting',
    'cass-nd': 'far north (46.9 N), short season; Red River spring flooding and late planting are common',
    'dane-wi': 'northern, eroded sloping soil at the sample point',
    'lenawee-mi': 'sandy loam at the sample point, low water capacity',
    'saline-mo': 'southern edge of the belt, hot summers, claypan soils',
    'nemaha-ks': 'drier and hotter western edge, heat and drought at flowering',
    'christian-ky': 'southern, hot and humid, double-crop soybean common; heat-match threshold borrowed from Story County',
}
EVENTS = {1983: 'drought year', 1988: 'drought', 1992: 'cool summer and an October freeze in the weather data', 1993: 'Midwest flood',
          2012: 'drought and heat', 2019: 'wet spring, late planting', 2020: 'derecho (Iowa and neighbours)'}


def load_site_nass(sid, crop):
    p = ROOT / 'data' / 'nass' / f'story_{crop}.csv' if sid == HOME else ROOT / 'raw' / 'sites' / sid / f'nass_{crop}.csv'
    out = {}
    with open(p, newline='') as f:
        for r in csv.DictReader(f):
            if r['Period'] != 'YEAR' or 'YIELD' not in r['Data Item']:
                continue
            try:
                out[int(r['Year'])] = float(r['Value'].replace(',', ''))
            except ValueError:
                pass
    return out, str(p.relative_to(ROOT))


def score(pred, obs, trend_vals):
    """pred and obs are ratios to trend (the trend of each held-out fold); trend_vals are those trends in bu/acre."""
    pred, obs, tv = map(np.asarray, (pred, obs, trend_vals))
    n = len(obs)
    err = pred - obs
    rmse, rmse_t = float(np.sqrt(np.mean(err ** 2))) * 100, float(np.sqrt(np.mean((1 - obs) ** 2))) * 100
    r = float(pearsonr(pred, obs)[0]) if np.std(pred) > 0 and np.std(obs) > 0 else float('nan')
    real = obs * tv
    mape = float(np.mean(np.abs(pred * tv - real) / real)) * 100
    mape_t = float(np.mean(np.abs(tv - real) / real)) * 100
    k = min(5, n)
    worst_obs = set(np.argsort(obs)[:k].tolist())
    worst_pred = set(np.argsort(pred)[:k].tolist())
    return {'n': int(n), 'r': round(r, 3), 'rmsePct': round(rmse, 2), 'rmseTrendPct': round(rmse_t, 2), 'skill': round(1 - rmse / rmse_t, 3),
            'maePct': round(mape, 2), 'maeTrendPct': round(mape_t, 2),
            'within10': round(float(np.mean(np.abs(err) <= 0.10)), 3), 'within10Trend': round(float(np.mean(np.abs(1 - obs) <= 0.10)), 3),
            'worst5Hits': int(len(worst_obs & worst_pred)), 'worst5Of': int(k), 'biasPct': round(float(np.mean(err)) * 100, 2)}


def skill_interval(pred, obs, reps=2000, seed=7):
    """95% bootstrap interval of the skill (resampling seasons with replacement)."""
    rng = np.random.default_rng(seed)
    pred, obs = np.asarray(pred), np.asarray(obs)
    n = len(obs)
    s = []
    for _ in range(reps):
        i = rng.integers(0, n, n)
        a, b = np.mean((pred[i] - obs[i]) ** 2), np.mean((1 - obs[i]) ** 2)
        if b > 0:
            s.append(1 - math.sqrt(a / b))
    return [round(float(np.percentile(s, 2.5)), 2), round(float(np.percentile(s, 97.5)), 2)]


def diagnostics(pred, obs, years, feats):
    pred, obs = np.asarray(pred), np.asarray(obs)
    bad = obs <= BAD_RATIO
    keep = np.ones(len(obs), bool)
    keep[np.argsort(obs)[:5]] = False
    d = {'sdObs': round(float(np.std(obs, ddof=1)) * 100, 1), 'sdPred': round(float(np.std(pred, ddof=1)) * 100, 1),
         'badSeasons': int(bad.sum()), 'badObsMean': round(float(obs[bad].mean()), 3) if bad.any() else None,
         'badPredMean': round(float(pred[bad].mean()), 3) if bad.any() else None,
         'badCaught': int((pred[bad] <= 0.97).sum()) if bad.any() else 0,
         'predBelow90': int((pred <= BAD_RATIO).sum()),
         'skillWithoutWorst5': round(1 - math.sqrt(np.mean((pred[keep] - obs[keep]) ** 2) / np.mean((1 - obs[keep]) ** 2)), 3) if keep.sum() > 3 else None}
    for fk, label in (('rainJJA', 'rainJJA'), ('hddJA', 'hotDays'), ('gddMS', 'gdd')):
        x = np.array([feats[str(y)][fk] for y in years])
        d['rObsVs_' + label] = round(float(np.corrcoef(x, obs)[0, 1]), 2)
        d['rPredVs_' + label] = round(float(np.corrcoef(x, pred)[0, 1]), 2) if np.std(pred) > 0 else None
    return d


def worst_misses(pred, obs, tv, years, k=3):
    pred, obs, tv = map(np.asarray, (pred, obs, tv))
    order = np.argsort(-np.abs(pred - obs))[:k]
    return [{'year': int(years[i]), 'real': round(float(obs[i] * tv[i]), 1), 'model': round(float(pred[i] * tv[i]), 1), 'realPct': round(float(obs[i]) * 100, 1),
             'modelPct': round(float(pred[i]) * 100, 1), 'errorPts': round(float(pred[i] - obs[i]) * 100, 1)} for i in order]


def note_for(sid, crop, tr, rf, dg, misses):
    """One plain line from the numbers. The context at the end is background knowledge, not something this test measured."""
    s, r = tr['skill'], tr['r']
    lo, hi = tr['skillCI95']
    if s >= 0.10 and r >= 0.3:
        word = 'Some skill'
    elif s > -0.05:
        word = 'No better than trend'
    elif s > -0.5:
        word = 'Worse than trend-only'
    else:
        word = 'Much worse than trend-only'
    parts = [f'{word} (skill {s:+.2f}, 95% interval {lo:+.2f} to {hi:+.2f}, r {r:.2f})']
    if dg['badSeasons']:
        parts.append(f"of {dg['badSeasons']} real seasons 10+ points under trend the model put {dg['badCaught']} below 0.97 (real mean {dg['badObsMean']:.2f}, model {dg['badPredMean']:.2f})")
    if tr['biasPct'] <= -3:
        parts.append(f"runs {abs(tr['biasPct']):.0f} points low on average")
    elif tr['biasPct'] >= 3:
        parts.append(f"runs {tr['biasPct']:.0f} points high on average")
    m = misses[0]
    ev = EVENTS.get(m['year'])
    parts.append(f"biggest miss {m['year']} (real {m['realPct']:.0f}% of trend, model {m['modelPct']:.0f}%" + (f"; {ev}" if ev else '') + ')')
    if dg['sdPred'] < 0.5 * dg['sdObs']:
        parts.append(f"model swings {dg['sdPred']:.1f} points a season against {dg['sdObs']:.1f} real" + (' (direction partly right, size far too small)' if r >= 0.5 else ''))
    w5 = dg['skillWithoutWorst5']
    if w5 is not None and s > 0 and w5 <= 0:
        parts.append(f"without the 5 worst real seasons skill is {w5:+.2f}")
    if rf['skill'] > s + 0.15:
        parts.append(f"refitting its three numbers here helps (skill {rf['skill']:+.2f})")
    elif rf['skill'] <= 0:
        parts.append(f"even refitted here it is no better than trend (skill {rf['skill']:+.2f})")
    return '; '.join(parts) + '. Context, not tested here: ' + CONTEXT[sid] + '.'


def write_chart(report):
    """public/images/validation-counties.svg: transfer-test skill vs trend-only per county, corn and soybean, sorted by corn skill.
    Bars are the skill; the thin line on each bar is its 95% bootstrap interval. Same look as public/images/validation-corn.svg."""
    rows = sorted(report['sites'], key=lambda e: -e['crops']['corn']['transfer']['skill'])
    X0, X1, LO, HI = 190.0, 800.0, -0.40, 0.50
    xs = lambda v: X0 + (v - LO) / (HI - LO) * (X1 - X0)
    top, rh = 70, 34
    H = top + rh * len(rows) + 70
    sm = report['summary']
    desc = (f"Horizontal grouped bars, one row per county, of model skill against a trend-only guess when the Iowa-fitted model is applied to that county with no refit. "
            f"Skill is 1 minus the model error divided by the trend-only error, so zero means no better than the trend and below zero means worse. "
            f"Corn skill is above zero in {sm['corn']['transferSkillPositive']} of 14 counties but 0.10 or more in only {sm['corn']['transferSkillAtLeast0_10']} (median {sm['corn']['transferSkillMedian']:+.2f}); "
            f"soybean is above zero in {sm['soybean']['transferSkillPositive']} and 0.10 or more in {sm['soybean']['transferSkillAtLeast0_10']} (median {sm['soybean']['transferSkillMedian']:+.2f}). "
            f"The thin line on each bar is the 95 percent interval; most intervals reach below zero.")
    o = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 %d" width="100%%" role="img" aria-labelledby="t d" font-family="\'Plus Jakarta Sans\', system-ui, -apple-system, \'Segoe UI\', Roboto, Helvetica, Arial, sans-serif" font-size="12">' % H,
         '<title id="t">Model skill against a trend-only guess in 14 counties, corn and soybean</title>',
         f'<desc id="d">{desc}</desc>']
    for v in (-0.4, -0.2, 0.0, 0.2, 0.4):
        zero = abs(v) < 1e-9
        o.append(f'<line x1="{xs(v):.1f}" x2="{xs(v):.1f}" y1="{top - 8}" y2="{top + rh * len(rows)}" stroke="#808080" stroke-opacity="{0.7 if zero else 0.18}" stroke-width="1"' + (' stroke-dasharray="5 4"' if zero else '') + '/>')
        o.append(f'<text x="{xs(v):.1f}" y="{top + rh * len(rows) + 16}" fill="#b4b2ac" text-anchor="middle">{v:+.1f}</text>' if not zero else f'<text x="{xs(v):.1f}" y="{top + rh * len(rows) + 16}" fill="#b4b2ac" text-anchor="middle">0</text>')
    o.append(f'<text x="{xs(0.0):.1f}" y="{top - 14}" fill="#b4b2ac" text-anchor="middle" font-size="11">No Better Than Trend</text>')
    o.append(f'<text x="{xs(-0.2):.1f}" y="{top - 14}" fill="#b4b2ac" text-anchor="middle" font-size="11">Worse</text>')
    o.append(f'<text x="{xs(0.3):.1f}" y="{top - 14}" fill="#b4b2ac" text-anchor="middle" font-size="11">Better</text>')
    # legend
    o.append('<rect x="190" y="18" width="12" height="10" fill="#D3AF7C"/><text x="208" y="27" fill="#e8e2d8">Corn</text>')
    o.append('<rect x="256" y="18" width="12" height="10" fill="#9E6438"/><text x="274" y="27" fill="#e8e2d8">Soybean</text>')
    o.append('<line x1="348" x2="372" y1="23" y2="23" stroke="#e8e2d8" stroke-opacity="0.8" stroke-width="1.4"/><text x="380" y="27" fill="#b4b2ac">95% Interval</text>')
    o.append(f'<text x="868" y="{top - 14}" fill="#b4b2ac" text-anchor="end" font-size="11">Corn</text><text x="940" y="{top - 14}" fill="#b4b2ac" text-anchor="end" font-size="11">Soybean</text>')
    for i, e in enumerate(rows):
        y = top + i * rh
        label = f"{e['name'].split(' County')[0]}, {e['state']}"
        o.append(f'<text x="{X0 - 12:.0f}" y="{y + 20}" fill="#e8e2d8" text-anchor="end">{label}</text>')
        for j, (crop, col) in enumerate((('corn', '#D3AF7C'), ('soybean', '#9E6438'))):
            t = e['crops'][crop]['transfer']
            by = y + 5 + j * 12
            x_a, x_b = sorted((xs(0), xs(t['skill'])))
            o.append(f'<rect x="{x_a:.1f}" y="{by}" width="{max(x_b - x_a, 1):.1f}" height="10" fill="{col}"/>')
            lo, hi = t['skillCI95']
            o.append(f'<line x1="{xs(lo):.1f}" x2="{xs(hi):.1f}" y1="{by + 5}" y2="{by + 5}" stroke="#e8e2d8" stroke-opacity="0.8" stroke-width="1.2"/>')
            o.append(f'<line x1="{xs(lo):.1f}" x2="{xs(lo):.1f}" y1="{by + 2}" y2="{by + 8}" stroke="#e8e2d8" stroke-opacity="0.8" stroke-width="1.2"/>')
            o.append(f'<line x1="{xs(hi):.1f}" x2="{xs(hi):.1f}" y1="{by + 2}" y2="{by + 8}" stroke="#e8e2d8" stroke-opacity="0.8" stroke-width="1.2"/>')
            o.append(f'<text x="{868 if crop == "corn" else 940}" y="{by + 9}" fill="#b4b2ac" text-anchor="end" font-size="11">{t["skill"]:+.2f}</text>')
    o.append(f'<text x="{(X0 + X1) / 2:.0f}" y="{H - 14}" fill="#b4b2ac" text-anchor="middle">Skill Vs Trend-Only (1 Minus Model Error / Trend-Only Error), Iowa-Fitted Model, No Refit</text>')
    o.append('</svg>')
    (ROOT.parent / 'public' / 'images' / 'validation-counties.svg').write_text('\n'.join(o) + '\n')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--md', action='store_true', help='print the markdown tables for VALIDATION.md')
    args = ap.parse_args()
    comp = json.loads(subprocess.run(['node', str(ROOT / 'tools' / 'validate_counties_model.js')], capture_output=True, text=True, check=True).stdout)
    shipped = comp['shipped']
    report = {'method': 'see tools/validate_counties.py', 'shippedSettings': shipped, 'badSeasonRatio': BAD_RATIO, 'sites': []}
    for sid, S in comp['sites'].items():
        years_all = np.array(S['years'])
        entry = {'id': sid, 'name': S['name'], 'short': S['short'], 'state': S['state'], 'lat': S['lat'], 'lon': S['lon'], 'weather': S['weather'],
                 'soil': {'countyAwcMmPerM': S['countyAwcMmPerM'], 'fields': S['soils'], 'source': 'NRCS Soil Data Access, map unit at four points near the county point (src/sites.js)'},
                 'context': CONTEXT[sid], 'crops': {}}
        for crop in CROPS:
            ny, src = load_site_nass(sid, crop)
            use = np.array([i for i, y in enumerate(years_all) if int(y) in ny])
            yrs = years_all[use]
            n = len(yrs)
            yv = np.array([ny[int(y)] for y in yrs], float)
            A = V.comp_arrays(S[crop])
            p_ship = shipped[crop]
            full_pred = V.process_pred(A, (p_ship['gamma'], p_ship['heatB'], p_ship['eDur']))   # normalised by this county's own 44 seasons
            tr_pred = full_pred[use]
            obs, tv = np.zeros(n), np.zeros(n)
            rf_pred = np.zeros(n)
            fits = []
            for i in range(n):
                tr = np.arange(n) != i
                trend = V.robust_trend(yrs[tr].astype(float), yv[tr])
                tv[i] = float(trend(yrs[i]))
                ratio = yv / trend(yrs)
                obs[i] = ratio[i]
                # refit: the process model is evaluated on all 44 seasons (own normalisation), fitted on the training seasons that have a yield
                mask_full = np.zeros(len(years_all), bool)
                mask_full[use[tr]] = True
                obs_full = np.full(len(years_all), np.nan)
                obs_full[use] = ratio
                p, _ = V.fit_process(A, np.where(np.isnan(obs_full), 1.0, obs_full), mask_full)
                fits.append([round(float(x), 4) for x in p])
                rf_pred[i] = V.process_pred(A, p)[use[i]]
            T, R = score(tr_pred, obs, tv), score(rf_pred, obs, tv)
            T['skillCI95'], R['skillCI95'] = skill_interval(tr_pred, obs), skill_interval(rf_pred, obs)
            feats = S['features']
            dgT, dgR = diagnostics(tr_pred, obs, yrs, feats), diagnostics(rf_pred, obs, yrs, feats)
            mT, mR = worst_misses(tr_pred, obs, tv, yrs), worst_misses(rf_pred, obs, tv, yrs)
            table = [{'year': int(yrs[i]), 'real': round(float(yv[i]), 1), 'trend': round(float(tv[i]), 1), 'realPct': round(float(obs[i]) * 100, 1),
                      'transferPct': round(float(tr_pred[i]) * 100, 1), 'transfer': round(float(tr_pred[i] * tv[i]), 1),
                      'refitPct': round(float(rf_pred[i]) * 100, 1), 'refit': round(float(rf_pred[i] * tv[i]), 1),
                      'transferErrorPts': round(float(tr_pred[i] - obs[i]) * 100, 1), 'refitErrorPts': round(float(rf_pred[i] - obs[i]) * 100, 1)} for i in range(n)]
            entry['crops'][crop] = {'nass': src, 'years': [int(yrs[0]), int(yrs[-1])], 'seasonsUsed': n, 'seasonsMissing': [int(y) for y in years_all if int(y) not in ny],
                                    'hybridGdd': S['hybrid'][crop], 'transfer': dict(T, diagnostics=dgT, biggestMisses=mT, note=note_for(sid, crop, T, R, dgT, mT)),
                                    'refit': dict(R, diagnostics=dgR, biggestMisses=mR, meanRefit=[round(float(x), 4) for x in np.mean(fits, axis=0)]), 'seasons': table}
            print(f"{sid:14s} {crop:8s} n={n:2d} | transfer r={T['r']:+.2f} rmse={T['rmsePct']:5.1f} trend={T['rmseTrendPct']:5.1f} skill={T['skill']:+.2f} "
                  f"in10={T['within10']:.2f} w5={T['worst5Hits']} | refit r={R['r']:+.2f} skill={R['skill']:+.2f}")
        report['sites'].append(entry)
    for crop in CROPS:
        sk = [e['crops'][crop]['transfer']['skill'] for e in report['sites']]
        rs = [e['crops'][crop]['refit']['skill'] for e in report['sites']]
        report.setdefault('summary', {})[crop] = {
            'transferSkillPositive': int(sum(s > 0 for s in sk)), 'transferSkillAtLeast0_10': int(sum(s >= 0.10 for s in sk)), 'counties': len(sk),
            'transferSkillMedian': round(float(np.median(sk)), 3), 'refitSkillPositive': int(sum(s > 0 for s in rs)), 'refitSkillAtLeast0_10': int(sum(s >= 0.10 for s in rs)), 'refitSkillMedian': round(float(np.median(rs)), 3)}
    (ROOT / 'data' / 'validation_counties.json').write_text(json.dumps(report, indent=1))
    print('wrote data/validation_counties.json', report['summary'])
    write_chart(report)
    print('wrote public/images/validation-counties.svg')
    if args.md:
        for crop in CROPS:
            for kind in ('transfer', 'refit'):
                print(f'\n### {crop} {kind}')
                print('| County | State | Seasons | r | Model RMSE | Trend RMSE | Skill | Within 10 (model / trend) | Worst-5 hits |')
                print('|---|---|---|---|---|---|---|---|---|')
                for e in sorted(report['sites'], key=lambda e: -e['crops'][crop][kind]['skill']):
                    c = e['crops'][crop]
                    m = c[kind]
                    print(f"| {e['name'].split(',')[0]} | {e['state']} | {c['seasonsUsed']} | {m['r']:.2f} | {m['rmsePct']:.1f} | {m['rmseTrendPct']:.1f} | {m['skill']:+.2f} | {m['within10']*100:.0f}% / {m['within10Trend']*100:.0f}% | {m['worst5Hits']} of {m['worst5Of']} |")


if __name__ == '__main__':
    main()
