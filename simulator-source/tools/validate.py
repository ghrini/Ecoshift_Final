#!/usr/bin/env python3
"""Leave-one-year-out check of the Field Shift crop model against USDA NASS Iowa yields, plus the
"process model vs statistics" comparison the challenge brief asks for.

    python3 tools/validate.py            # fit, test, write data/validation.json and the tables in VALIDATION.md
    python3 tools/validate.py --write    # ... and write the fitted parameters and the headline numbers into src/engine.js

Inputs
  data/iowa_yields.json      NASS Quick Stats yields (tools/validate_fetch_nass.py)
  node tools/validate_model.js   the engine's own per-season components for the reference rotation (county soil),
                                 for every structural setting in its grid, plus season weather features

Method (the same folds for every model)
  For each held-out season Y (44 folds, 1982-2025):
  1. Fit a robust straight-line trend (Tukey bisquare) to the NASS yields of the other 43 seasons; the observed
     "yield ratio" of every season is yield / trend. The held-out season's ratio uses that trend, so it never
     sees its own yield.
  2. Process model: on the 43 training seasons, choose the structural setting (rooting depth, season start) and fit
     gamma (compression of the weather-stress part), b (heat slope) and eDur (grain-fill exponent) by least squares
     on the ratios, then predict the held-out season.
  3. Ridge regression and gradient boosting on season weather features from the same POWER grid cell, fitted on the
     43 training seasons (ridge penalty chosen by leave-one-out inside the training seasons), predict the held-out one.
  4. Trend-only: predict ratio 1 (the trend itself).
  Metrics on the 44 out-of-sample predictions: Pearson r, Spearman r, RMSE in points of the trend (pp), skill =
  1 - RMSE / RMSE(trend-only). Also excluding 1993 (flood) and 2020 (derecho) and excluding 2012.
Requires numpy, scipy, scikit-learn.
"""
import argparse, json, math, pathlib, re, subprocess, sys
import numpy as np
from scipy.optimize import minimize
from scipy.stats import pearsonr, spearmanr
from sklearn.linear_model import RidgeCV
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline

ROOT = pathlib.Path(__file__).resolve().parent.parent
BOUNDS = [(0.05, 1.0), (0.0, 0.01), (0.0, 1.5)]          # gamma, b (per degree-day), eDur
STARTS = [(0.25, 0.001, 0.3), (0.5, 0.003, 0.8), (0.15, 0.0005, 0.0), (0.8, 0.006, 0.5)]
DROUGHTS = [1988, 2012]                                  # the two big Iowa droughts in the record
NON_WEATHER = [1993, 2020]                               # 1993 Midwest flood, 2020 derecho (Story County is in the corridor)
FEATURES = ['rainJJA', 'rainJJA2', 'hddJA', 'gddMS', 'rainAJ', 'gwrJA']


def robust_trend(x, y, iters=30, c=4.685):
    """Straight line by iteratively reweighted least squares with Tukey bisquare weights."""
    X = np.c_[np.ones_like(x), x - 2000.0]
    w = np.ones_like(y)
    beta = np.linalg.lstsq(X, y, rcond=None)[0]
    for _ in range(iters):
        W = np.sqrt(w)
        beta = np.linalg.lstsq(X * W[:, None], y * W, rcond=None)[0]
        r = y - X @ beta
        s = np.median(np.abs(r - np.median(r))) / 0.6745 or 1e-9
        u = r / (c * s)
        w = np.where(np.abs(u) < 1, (1 - u ** 2) ** 2, 0.0)
    return lambda xx: beta[0] + beta[1] * (np.asarray(xx, float) - 2000.0)


def comp_arrays(rows):
    g = lambda k: np.array([np.nan if r[k] is None else r[k] for r in rows], float)
    return {'Yw': g('Yw'), 'Yww': g('Yww'), 'hdd': g('hdd'), 'PD': g('PD'), 'Yf': g('Yf'), 'fill': g('fill')}


def process_pred(A, p):
    gamma, b, e = p
    sw = A['Yw'] * A['Yww'] * np.exp(-b * A['hdd'])
    w = (sw / np.median(sw)) ** gamma
    fv = A['fill']
    ok = np.isfinite(fv)
    fr = np.ones_like(sw)
    if ok.any():
        fr[ok] = (fv[ok] / np.median(fv[ok])) ** e
    raw = w * fr * A['PD'] * A['Yf']
    return np.minimum(raw / np.median(raw), 1.25)


def fit_process(A, obs, mask):
    best = None
    for s0 in STARTS:
        f = lambda p: float(np.sum((process_pred(A, p)[mask] - obs[mask]) ** 2))
        r = minimize(f, s0, method='L-BFGS-B', bounds=BOUNDS)
        if best is None or r.fun < best.fun:
            best = r
    return best.x, best.fun


def metrics(pred, obs, sel=None):
    pred, obs = np.asarray(pred), np.asarray(obs)
    if sel is not None:
        pred, obs = pred[sel], obs[sel]
    rmse = float(np.sqrt(np.mean((pred - obs) ** 2))) * 100
    rmse_t = float(np.sqrt(np.mean((1.0 - obs) ** 2))) * 100
    return {'n': int(len(obs)), 'r': round(float(pearsonr(pred, obs)[0]), 3), 'rho': round(float(spearmanr(pred, obs)[0]), 3),
            'rmsePct': round(rmse, 2), 'rmseTrendPct': round(rmse_t, 2), 'skill': round(1 - rmse / rmse_t, 3),
            'maePct': round(float(np.mean(np.abs(pred - obs))) * 100, 2)}


def feature_matrix(feat, years):
    rows = []
    for y in years:
        f = feat[str(y)]
        rows.append([f['rainJJA'], f['rainJJA'] ** 2, f['hddJA'], f['gddMS'], f['rainAJ'], f['gwrJA']])
    return np.array(rows, float)


def loyo(years, yields, grid, feat, crop):
    years = np.array(years)
    yv = np.array([yields[str(y)] for y in years], float)
    n = len(years)
    combos = [((g['zMaxCorn'], g['startMode'], g.get('crMax', 0)), comp_arrays(g[crop])) for g in grid]
    X = feature_matrix(feat, years)
    out = {k: np.zeros(n) for k in ('obs', 'process', 'ridge', 'gbm', 'hybrid')}
    chosen = []
    # hybrid: ridge on the process model's own stress indices (structural setting fixed to the shipped one)
    ship = combos[-1][1]                              # last grid entry: deepest roots, largest water-table term
    H = np.c_[np.log(ship['Yw']), ship['hdd'], np.log(ship['Yww']), np.log(np.where(np.isfinite(ship['fill']), ship['fill'], np.nanmedian(ship['fill'])) / np.nanmedian(ship['fill'])), np.log(ship['PD'] * ship['Yf'])]
    for i in range(n):
        tr = np.arange(n) != i
        trend = robust_trend(years[tr].astype(float), yv[tr])
        ratio = yv / trend(years)
        out['obs'][i] = ratio[i]
        best = None
        for st, A in combos:
            p, sse = fit_process(A, ratio, tr)
            if best is None or sse < best[0]:
                best = (sse, st, p, A)
        out['process'][i] = process_pred(best[3], best[2])[i]
        chosen.append({'year': int(years[i]), 'zMaxCorn': best[1][0], 'startMode': best[1][1], 'crMax': best[1][2], 'gamma': round(best[2][0], 3), 'b': round(best[2][1], 5), 'eDur': round(best[2][2], 3)})
        rg = make_pipeline(StandardScaler(), RidgeCV(alphas=np.logspace(-2, 3, 40)))
        rg.fit(X[tr], ratio[tr] - 1)
        out['ridge'][i] = 1 + rg.predict(X[i:i + 1])[0]
        gb = GradientBoostingRegressor(n_estimators=200, max_depth=2, learning_rate=0.05, subsample=0.7, min_samples_leaf=4, random_state=0)
        gb.fit(X[tr], ratio[tr] - 1)
        out['gbm'][i] = 1 + gb.predict(X[i:i + 1])[0]
        hy = make_pipeline(StandardScaler(), RidgeCV(alphas=np.logspace(-2, 3, 40)))
        hy.fit(H[tr], ratio[tr] - 1)
        out['hybrid'][i] = 1 + hy.predict(H[i:i + 1])[0]
    return out, chosen


def full_fit(years, yields, grid, crop):
    years = np.array(years)
    yv = np.array([yields[str(y)] for y in years], float)
    trend = robust_trend(years.astype(float), yv)
    ratio = yv / trend(years)
    mask = np.ones(len(years), bool)
    best = None
    table = []
    for g in grid:
        A = comp_arrays(g[crop])
        p, sse = fit_process(A, ratio, mask)
        rmse = math.sqrt(sse / len(years)) * 100
        table.append({'zMaxCorn': g['zMaxCorn'], 'startMode': g['startMode'], 'crMax': g.get('crMax', 0), 'gamma': round(p[0], 3), 'b': round(p[1], 5), 'eDur': round(p[2], 3), 'rmseInSamplePct': round(rmse, 2)})
        if best is None or sse < best[0]:
            best = (sse, g, p, A)
    pred = process_pred(best[3], best[2])
    return {'zMaxCorn': best[1]['zMaxCorn'], 'startMode': best[1]['startMode'], 'crMax': best[1].get('crMax', 0), 'gamma': float(best[2][0]), 'b': float(best[2][1]), 'eDur': float(best[2][2]),
            'ratio': ratio.tolist(), 'pred': pred.tolist(), 'trend': [float(trend(2000)), float(trend(2001) - trend(2000))], 'grid': table}


def summarise(years, res):
    years = np.array(years)
    allm = {}
    sel_nw = ~np.isin(years, NON_WEATHER)
    sel_12 = years != 2012
    sel_dr = ~np.isin(years, DROUGHTS)                   # ordinary years: without the two droughts
    sel_dr2 = ~np.isin(years, DROUGHTS + NON_WEATHER)    # ... and without the flood and derecho years
    for k in ('process', 'ridge', 'gbm', 'hybrid'):
        allm[k] = {'all': metrics(res[k], res['obs']), 'exclFloodDerecho': metrics(res[k], res['obs'], sel_nw), 'excl2012': metrics(res[k], res['obs'], sel_12),
                   'exclDroughts': metrics(res[k], res['obs'], sel_dr), 'exclDroughtsFloodDerecho': metrics(res[k], res['obs'], sel_dr2)}
    allm['trend'] = {'all': {'rmsePct': round(float(np.sqrt(np.mean((1 - res['obs']) ** 2))) * 100, 2)}}
    return allm


def bootstrap_r(pred, obs, n=5000, seed=1):
    """95% percentile interval of Pearson r over the seasons (resampling seasons with replacement)."""
    rng = np.random.default_rng(seed)
    pred, obs = np.asarray(pred), np.asarray(obs)
    k = len(obs)
    rs = []
    for _ in range(n):
        i = rng.integers(0, k, k)
        if np.std(pred[i]) > 0 and np.std(obs[i]) > 0:
            rs.append(np.corrcoef(pred[i], obs[i])[0, 1])
    return [round(float(np.percentile(rs, 2.5)), 2), round(float(np.percentile(rs, 97.5)), 2)]


def risk_spread(res, n_worst=5):
    """How much narrower the model's season-to-season spread is than the observed one (out-of-sample predictions).
    k = sd(observed ratio) / sd(predicted ratio) is what the simulator uses to widen weather deviations when it ranks bad years."""
    o, p = np.asarray(res['obs']), np.asarray(res['process'])
    sd_o, sd_p = float(np.std(o, ddof=1)), float(np.std(p, ddof=1))
    return {'sdObs': round(sd_o, 4), 'sdPred': round(sd_p, 4), 'k': round(sd_o / sd_p, 3),
            'worst5Obs': round(float(np.mean(np.sort(o)[:n_worst])), 3), 'worst5Pred': round(float(np.mean(np.sort(p)[:n_worst])), 3)}


def rank_low(v, years, y):
    order = np.argsort(v)
    return int(np.where(np.array(years)[order] == y)[0][0]) + 1


def md_tables(report):
    L = []
    for crop in ('corn', 'soybean'):
        R = report[crop]
        L.append(f"### {crop.capitalize()}: Iowa state yields (NASS), leave-one-year-out, {R['n']} seasons {R['years'][0]}-{R['years'][-1]}\n")
        L.append('| Model | Pearson r | Spearman r | RMSE (points of trend) | Skill vs trend-only | RMSE excl. 1993, 2020 | RMSE excl. 2012 |')
        L.append('|---|---|---|---|---|---|---|')
        names = {'process': 'Process model (this simulator; 3 fitted numbers + rooting depth/start chosen in each fold)', 'ridge': 'Ridge regression on 6 POWER season features',
                 'gbm': 'Gradient boosting (depth-2 trees) on the same features', 'hybrid': 'Ridge on the process model\'s stress indices'}
        for k in ('process', 'ridge', 'gbm', 'hybrid'):
            m = R['metrics'][k]
            L.append(f"| {names[k]} | {m['all']['r']:.2f} | {m['all']['rho']:.2f} | {m['all']['rmsePct']:.1f} | {m['all']['skill']:.2f} | {m['exclFloodDerecho']['rmsePct']:.1f} (skill {m['exclFloodDerecho']['skill']:.2f}) | {m['excl2012']['rmsePct']:.1f} (skill {m['excl2012']['skill']:.2f}) |")
        t = R['metrics']['process']
        L.append(f"| Trend only (predicts the trend) | - | - | {R['metrics']['trend']['all']['rmsePct']:.1f} | 0 | {t['exclFloodDerecho']['rmseTrendPct']:.1f} | {t['excl2012']['rmseTrendPct']:.1f} |")
        if R.get('bootstrapR'):
            P = R['metrics']['process']
            L.append(f"\nOrdinary years (1988 and 2012 left out): process r {P['exclDroughts']['r']:.2f}, RMSE {P['exclDroughts']['rmsePct']:.1f} vs {P['exclDroughts']['rmseTrendPct']:.1f} for trend-only (skill {P['exclDroughts']['skill']:.2f}); also without 1993 and 2020: r {P['exclDroughtsFloodDerecho']['r']:.2f}, RMSE {P['exclDroughtsFloodDerecho']['rmsePct']:.1f} vs {P['exclDroughtsFloodDerecho']['rmseTrendPct']:.1f} (skill {P['exclDroughtsFloodDerecho']['skill']:.2f}). Bootstrap 95% interval for the all-years r: [{R['bootstrapR'][0]:.2f}, {R['bootstrapR'][1]:.2f}]. Spread: observed sd {R['risk']['sdObs']*100:.1f} points, predicted {R['risk']['sdPred']*100:.1f} (ratio k = {R['risk']['k']:.2f}); mean of the 5 worst seasons observed {R['risk']['worst5Obs']:.2f}, predicted {R['risk']['worst5Pred']:.2f}.")
        if R.get('story'):
            s = R['story']
            L.append(f"\nSecondary check, Story County NASS yields (the county the POWER grid cell sits in), process model refitted the same way: Pearson r {s['all']['r']:.2f}, Spearman r {s['all']['rho']:.2f}, RMSE {s['all']['rmsePct']:.1f} points vs {s['all']['rmseTrendPct']:.1f} for trend-only (skill {s['all']['skill']:.2f}); excluding 1993 and 2020: r {s['exclFloodDerecho']['r']:.2f}, skill {s['exclFloodDerecho']['skill']:.2f}.")
        f = R['fit']
        L.append(f"\nShipped parameters (fitted on all {R['n']} seasons): rooting depth {f['zMaxCorn']} m, season start '{f['startMode']}', water-table ceiling crMax {f['crMax']} mm/day, gamma {f['gamma']:.3f}, heat slope b {f['b']:.5f} per degree-day, grain-fill exponent eDur {f['eDur']:.3f}. Settings chosen inside the folds: " +
                 ', '.join(f"{k} x{v}" for k, v in R['choiceCounts'].items()) + '.\n')
        L.append('| Season | NASS yield (bu/acre) | Observed ratio | Process (LOYO) | Ridge (LOYO) | Note |')
        L.append('|---|---|---|---|---|---|')
        for row in R['table']:
            L.append(f"| {row['year']} | {row['yield']:g} | {row['obs']:.2f} | {row['process']:.2f} | {row['ridge']:.2f} | {row.get('note', '')} |")
        L.append('')
    return '\n'.join(L)


def scenario_checks(feat, years):
    """Years behind the named scenarios, recomputed from the same POWER features (see data.js weatherScenarios)."""
    F = {y: feat[str(y)] for y in years}
    jja = np.array([F[y]['rainJJA'] for y in years]); gdd = np.array([F[y]['gddMS'] for y in years]); aj = np.array([F[y]['rainAJ'] for y in years])
    ok = np.array([y >= 1984 for y in years])           # 1982-83 have no radiation (Hargreaves ET0)
    dist = np.hypot((jja - np.median(jja)) / jja.std(ddof=1), (gdd - np.median(gdd)) / gdd.std(ddof=1))
    dist[~ok] = np.inf
    order = np.argsort(dist)
    y88 = years.index(1988)
    return {'typical': int(years[order[0]]), 'typicalRunnersUp': [int(years[i]) for i in order[1:4]],
            'typicalByRainOnly': int(years[int(np.argmin(np.abs(jja - np.median(jja))))]),
            'gddRank1984Coolest': int(np.argsort(np.argsort(gdd))[years.index(1984)] + 1),
            'wettestAprJun': int(years[int(np.argmax(aj))]), 'wettestAprJunMm': round(float(aj.max()), 1),
            'rank1988DriestAprJun': int(np.argsort(np.argsort(aj))[y88] + 1), 'rank1988DriestJJA': int(np.argsort(np.argsort(jja))[y88] + 1)}


def frost_match():
    """POWER Tmin thresholds as frequent as ERA5's 0 C and -2 C nights (reported only; the engine keeps POWER's own -2 C)."""
    om = json.loads((ROOT / 'raw' / 'openmeteo.json').read_text())['daily']
    P = json.loads((ROOT / 'raw' / 'power.json').read_text())['properties']['parameter']['T2M_MIN']
    out = {}
    for name, months in (('fall', ('09', '10', '11')), ('spring', ('03', '04', '05', '06'))):
        e, p = [], []
        for t_, v in zip(om['time'], om['temperature_2m_min']):
            k = t_.replace('-', '')
            if t_[5:7] in months and v is not None and k in P and P[k] > -900:
                e.append(v); p.append(P[k])
        e, p = np.array(e), np.array(p)
        grid = np.arange(-6, 2.01, 0.1)
        out[name] = {str(th): round(float(grid[np.argmin([abs((p <= g).mean() - (e <= th).mean()) for g in grid])]), 1) for th in (0.0, -2.0)}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--write', action='store_true', help='write fitted parameters and headline numbers into src/engine.js')
    args = ap.parse_args()
    Y = json.loads((ROOT / 'data' / 'iowa_yields.json').read_text())
    comp = json.loads(subprocess.run(['node', str(ROOT / 'tools' / 'validate_model.js')], capture_output=True, text=True, check=True).stdout)
    years = comp['years']
    report = {'source': Y['source'], 'accessed': Y['accessed'], 'nass': {k: v['results_url'] for k, v in Y['series'].items()},
              'scenarios': scenario_checks(comp['features'], years), 'frostMatch': frost_match()}
    print('scenario checks', report['scenarios'], '| POWER thresholds matching ERA5 0/-2 C', report['frostMatch'])
    notes = {1988: 'drought', 1993: 'flood (not a weather-model year)', 2012: 'drought and heat', 2017: 'record yield, dry July-August in POWER', 2019: 'late planting',
             2020: 'derecho (not in weather data)', 2021: 'record yield, dry summer in POWER', 2023: 'dry, near-record yield'}
    grid = comp['grid']
    for crop, key, skey in (('corn', 'state_corn', 'story_corn'), ('soybean', 'state_soybean', 'story_soybean')):
        yields = Y['series'][key]['values']
        if crop == 'soybean':
            # the engine has one rooting depth / season start / water-table setting: soybean uses the one corn chose
            fc = report['corn']['fit']
            grid = [g for g in comp['grid'] if (g['zMaxCorn'], g['startMode'], g.get('crMax', 0)) == (fc['zMaxCorn'], fc['startMode'], fc['crMax'])]
        res, chosen = loyo(years, yields, grid, comp['features'], crop)
        M = summarise(years, res)
        fit = full_fit(years, yields, grid, crop)
        sres, _ = loyo(years, Y['series'][skey]['values'], grid, comp['features'], crop)
        story = {'all': metrics(sres['process'], sres['obs']), 'exclFloodDerecho': metrics(sres['process'], sres['obs'], ~np.isin(np.array(years), NON_WEATHER))}
        counts = {}
        for c in chosen:
            k = f"{c['zMaxCorn']} m/{c['startMode']}/cr {c['crMax']}"
            counts[k] = counts.get(k, 0) + 1
        table = [{'year': y, 'yield': yields[str(y)], 'obs': float(res['obs'][i]), 'process': float(res['process'][i]), 'ridge': float(res['ridge'][i]), 'gbm': float(res['gbm'][i]), 'note': notes.get(y, '')}
                 for i, y in enumerate(years)]
        ranks = {str(y): {'observed': rank_low(res['obs'], years, y), 'process': rank_low(res['process'], years, y)} for y in (1988, 1993, 2012, 2017, 2021, 2023)}
        report[crop] = {'n': len(years), 'years': [years[0], years[-1]], 'metrics': M, 'fit': fit, 'folds': chosen, 'choiceCounts': counts, 'table': table, 'ranksLowest': ranks, 'story': story,
                        'bootstrapR': bootstrap_r(res['process'], res['obs']), 'risk': risk_spread(res)}
        m = M['process']['all']
        print(f"{crop}: process r={m['r']} rho={m['rho']} rmse={m['rmsePct']} trend={M['trend']['all']['rmsePct']} skill={m['skill']} | ridge r={M['ridge']['all']['r']} rmse={M['ridge']['all']['rmsePct']} skill={M['ridge']['all']['skill']} | gbm rmse={M['gbm']['all']['rmsePct']} skill={M['gbm']['all']['skill']} | hybrid rmse={M['hybrid']['all']['rmsePct']} skill={M['hybrid']['all']['skill']}")
        print(f"   excl 1993/2020: process r={M['process']['exclFloodDerecho']['r']} skill={M['process']['exclFloodDerecho']['skill']} | excl 2012 skill={M['process']['excl2012']['skill']} | story r={story['all']['r']} skill={story['all']['skill']}")
        print(f"   full fit: z={fit['zMaxCorn']} start={fit['startMode']} cr={fit['crMax']} gamma={fit['gamma']:.3f} b={fit['b']:.5f} eDur={fit['eDur']:.3f}; folds {counts}; ranks {ranks}")
    c, s = report['corn']['metrics']['process']['all'], report['soybean']['metrics']['process']['all']
    rm = max(round(c['rmsePct']), round(s['rmsePct']))
    for crop_ in ('corn', 'soybean'):
        o = report[crop_]['metrics']['process']['exclDroughts']
        print(f"   {crop_}: ordinary years (without 1988, 2012) skill vs trend {o['skill']}; bootstrap r {report[crop_]['bootstrapR']}; risk {report[crop_]['risk']}")
        if o['skill'] > 0.05:
            print(f"WARNING: {crop_} has skill {o['skill']} in ordinary years; the sentence 'no better than the trend' in the validation text is no longer true, reword it")
    report['text'] = (f"Checked against USDA NASS Iowa yields {years[0]}-{years[-1]}: the model catches the big droughts (1988, 2012), but in ordinary years it does no better than "
                      f"the long-term yield trend, and in any one season it has a typical error of {rm} points of a normal crop. Small differences between plans are not reliable.")
    (ROOT / 'data' / 'validation.json').write_text(json.dumps(report, indent=1))
    print('wrote data/validation.json')
    md = ROOT / 'VALIDATION.md'
    if md.exists():
        t = md.read_text()
        t = re.sub(r'(<!-- auto:start -->).*?(<!-- auto:end -->)', lambda m_: m_.group(1) + '\n' + md_tables(report) + '\n' + m_.group(2), t, flags=re.S)
        md.write_text(t)
        print('updated tables in VALIDATION.md')
    if args.write:
        eng = ROOT / 'src' / 'engine.js'
        t = eng.read_text()
        fc, fs = report['corn']['fit'], report['soybean']['fit']
        fit_js = ("var FIT = {\n"
                  f"    corn: {{ gamma: {fc['gamma']:.3f}, heatB: {fc['b']:.5f}, eDur: {fc['eDur']:.3f} }},\n"
                  f"    soybean: {{ gamma: {fs['gamma']:.3f}, heatB: {fs['b']:.5f}, eDur: {fs['eDur']:.3f} }},\n"
                  f"    zMaxCorn: {fc['zMaxCorn']}, startMode: '{fc['startMode']}', crMax: {fc['crMax']}\n  }};")
        def vblock(crop):
            M = report[crop]['metrics']
            return {k: {kk: M[k]['all'][kk] for kk in ('r', 'rho', 'rmsePct', 'rmseTrendPct', 'skill')} for k in ('process', 'ridge', 'gbm')}
        val = {'source': 'USDA NASS Quick Stats, Iowa state yields', 'years': [years[0], years[-1]], 'corn': vblock('corn'), 'soybean': vblock('soybean'),
               'riskK': {'corn': report['corn']['risk']['k'], 'soybean': report['soybean']['risk']['k']}, 'text': report['text']}
        t = re.sub(r'(// <fit:auto>\n).*?(\n\s*// </fit:auto>)', lambda m_: m_.group(1) + '  ' + fit_js + m_.group(2), t, flags=re.S)
        t = re.sub(r'(// <validation:auto>\n).*?(\n\s*// </validation:auto>)', lambda m_: m_.group(1) + '  var VALIDATION = ' + json.dumps(val) + ';' + m_.group(2), t, flags=re.S)
        eng.write_text(t)
        print('wrote FIT and VALIDATION into src/engine.js (fit on corn; soybean uses its own gamma, b, eDur and the corn structural setting)')


if __name__ == '__main__':
    main()
