#!/usr/bin/env python3
"""Satellite check: NASA MODIS Terra 16-day NDVI (via NASA GIBS WMS) for Story County, Iowa, 2000-2025,
compared with USDA NASS yields and with the simulator's own per-season yields.

  python3 tools/satellite_check.py            # download (cached in raw/gibs/), decode, write data/satellite_check.json + public SVG
Needs numpy, Pillow, requests, node (for tools/satellite_model.js). TLS verification stays ON.
Outputs: data/satellite_check.json, ../public/images/satellite-check.svg, hashes appended to raw/HASHES.txt.
"""
import datetime as dt, hashlib, json, re, subprocess, sys, time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import numpy as np
import requests
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / 'raw' / 'gibs'
OUT_JSON = ROOT / 'data' / 'satellite_check.json'
OUT_SVG = ROOT.parent / 'public' / 'images' / 'satellite-check.svg'
HASHES = ROOT / 'raw' / 'HASHES.txt'
LAYER = 'MODIS_Terra_L3_NDVI_16Day'
WMS = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi'
CMAP_URL = 'https://gibs.earthdata.nasa.gov/colormaps/v1.3/MODIS_L3_NDVI.xml'
BBOX = (41.86, -93.70, 42.21, -93.23)          # minlat, minlon, maxlat, maxlon (WMS 1.3.0 EPSG:4326 axis order)
W, H = 209, 156                                  # about 0.00225 deg = 250 m per pixel
YEARS = list(range(2000, 2025 + 1))


def composite_dates(y):
    """16-day grid from 1 Jan of each year (the layer's own time grid), April to October."""
    d = dt.date(y, 1, 1)
    while d < dt.date(y, 4, 1):
        d += dt.timedelta(days=16)
    out = []
    while d <= dt.date(y, 10, 31):
        out.append(d)
        d += dt.timedelta(days=16)
    return out


def get(url, params=None, tries=4):
    for i in range(tries):
        try:
            r = requests.get(url, params=params, timeout=60)
            if r.status_code == 200:
                return r.content
            err = 'HTTP %d' % r.status_code
        except requests.RequestException as e:
            err = str(e)
        time.sleep(2 * (i + 1))
    raise RuntimeError('download failed: %s %s' % (url, err))


def fetch_tile(d):
    f = RAW / ('%s_%s.png' % (LAYER, d.isoformat()))
    if not f.exists():
        b = get(WMS, dict(SERVICE='WMS', REQUEST='GetMap', VERSION='1.3.0', LAYERS=LAYER, STYLES='', CRS='EPSG:4326',
                          BBOX=','.join(map(str, BBOX)), WIDTH=W, HEIGHT=H, FORMAT='image/png', TRANSPARENT='TRUE',
                          TIME=d.isoformat()))
        f.write_bytes(b)
    return f


def load_colormap():
    f = RAW / 'MODIS_L3_NDVI_colormap_v1.3.xml'
    if not f.exists():
        f.write_bytes(get(CMAP_URL))
    rgb, val = [], []
    for e in ET.parse(f).getroot().iter('ColorMapEntry'):
        if e.get('transparent') == 'true' or e.get('nodata') == 'true':
            continue
        lo, hi = re.match(r'[\[\(]([-\d.]+),([-\d.]+)[\)\]]', e.get('value')).groups()
        rgb.append(tuple(int(x) for x in e.get('rgb').split(',')))
        val.append((float(lo) + float(hi)) / 2)
    return np.array(rgb, float), np.array(val), f


def decode(png, rgb, val):
    """RGBA PNG -> NDVI array (nan where transparent = no data). Each colour maps to the nearest colormap entry (centre of its 0.005 bin)."""
    a = np.array(Image.open(png).convert('RGBA'))
    px = a[..., :3].reshape(-1, 3).astype(float)
    uniq, inv = np.unique(px, axis=0, return_inverse=True)
    dist = ((uniq[:, None, :] - rgb[None]) ** 2).sum(-1)
    nd = val[dist.argmin(1)]
    err = np.sqrt(dist.min(1))[inv].reshape(a.shape[:2])[a[..., 3] >= 128]
    err = err if err.size else np.zeros(1)
    ndvi = nd[inv].reshape(a.shape[:2])
    ndvi[a[..., 3] < 128] = np.nan
    return ndvi, float(err.max())


def corr(x, y):
    x, y = np.asarray(x, float), np.asarray(y, float)
    m = ~(np.isnan(x) | np.isnan(y))
    x, y = x[m], y[m]
    r = float(np.corrcoef(x, y)[0, 1])
    # Spearman with average ranks for ties
    def avg_rank(v):
        o = np.argsort(v, kind='mergesort'); rk = np.empty(len(v)); rk[o] = np.arange(len(v))
        for u in np.unique(v):
            i = v == u; rk[i] = rk[i].mean()
        return rk
    s = float(np.corrcoef(avg_rank(x), avg_rank(y))[0, 1])
    return {'n': int(len(x)), 'pearson': round(r, 3), 'spearman': round(s, 3)}


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    rgb, val, cmf = load_colormap()
    dates = [d for y in YEARS for d in composite_dates(y)]
    new = [d for d in dates if not (RAW / ('%s_%s.png' % (LAYER, d.isoformat()))).exists()]
    with ThreadPoolExecutor(6) as ex:
        files = list(ex.map(fetch_tile, dates))
    dl_s = time.time() - t0
    print('composites: %d (%d downloaded now, %.0f s)' % (len(dates), len(new), dl_s))

    # hashes for every raw file, appended once
    have = set(l.split(None, 1)[1].strip() for l in HASHES.read_text().splitlines() if l.strip())
    lines = []
    for f in [cmf] + files:
        rel = f.relative_to(ROOT / 'raw').as_posix()
        if rel not in have:
            lines.append('%s  %s' % (hashlib.sha256(f.read_bytes()).hexdigest(), rel))
    if lines:
        with HASHES.open('a') as h:
            h.write('\n'.join(lines) + '\n')

    cube, maxerr = {}, 0.0
    for d, f in zip(dates, files):
        cube[d], e = decode(f, rgb, val)
        maxerr = max(maxerr, e)

    # cropland mask: pixels that are bare-ish in spring and very green in summer in the MEDIAN year (no per-year selection).
    peak_by_year = {y: np.nanmean([cube[d] for d in composite_dates(y) if d.month in (7, 8)], axis=0) for y in YEARS}
    spring_by_year = {y: np.nanmean([cube[d] for d in composite_dates(y) if (d.month == 4 and d.day >= 16) or (d.month == 5 and d.day <= 20)], axis=0) for y in YEARS}
    med_peak = np.nanmedian(np.stack(list(peak_by_year.values())), 0)
    med_spring = np.nanmedian(np.stack(list(spring_by_year.values())), 0)
    mask = (med_peak >= 0.70) & (med_spring <= 0.50)
    allpx = ~np.isnan(med_peak)
    print('mask pixels: %d of %d (%.0f%%)' % (mask.sum(), allpx.sum(), 100 * mask.mean()))

    def region_mean(arr, m):
        v = arr[m]
        return float(np.nanmean(v)) if np.isfinite(v).any() else float('nan')

    rows = {}
    for y in YEARS:
        ds = composite_dates(y)
        series = [(d, region_mean(cube[d], mask)) for d in ds]
        peak = [v for d, v in series if d.month in (7, 8)]
        best = max(series, key=lambda t: (-1 if np.isnan(t[1]) else t[1]))
        rows[y] = {
            'ndviPeak': round(float(np.nanmean(peak)), 4),
            'ndviPeakAllPixels': round(float(np.nanmean([region_mean(cube[d], allpx) for d in ds if d.month in (7, 8)])), 4),
            'ndviMaxComposite': round(best[1], 4),
            'peakDate': best[0].isoformat(),
            'peakDoy': best[0].timetuple().tm_yday,
            'julAugComposites': [d.isoformat() for d in ds if d.month in (7, 8)],
            'seriesAprOct': {d.isoformat(): round(v, 4) for d, v in series},
            'noDataShareInBox': round(float(np.mean([np.isnan(cube[d]).mean() for d in ds if d.month in (7, 8)])), 4),
        }
    pk = np.array([rows[y]['ndviPeak'] for y in YEARS])
    sat_pct = pk / pk.mean() * 100
    for y, s in zip(YEARS, sat_pct):
        rows[y]['satellitePctOfMean'] = round(float(s), 1)

    # NASS: use what data/iowa_yields.json holds. Anomaly = % of 2000-2025 linear trend.
    Y = json.loads((ROOT / 'data' / 'iowa_yields.json').read_text())['series']
    nass = {}
    for k, ser in Y.items():
        v = np.array([ser['values'][str(y)] for y in YEARS], float)
        x = np.array(YEARS, float)
        b, a = np.polyfit(x, v, 1)
        pct = v / (a + b * x) * 100
        nass[k] = {'yield': dict(zip(YEARS, v.tolist())), 'pctOfTrend': dict(zip(YEARS, np.round(pct, 1).tolist())),
                   'trendBuPerYear': round(float(b), 2)}
        for y, p in zip(YEARS, pct):
            rows[y]['nassPctOfTrend_' + k] = round(float(p), 1)

    mod = json.loads(subprocess.run(['node', str(ROOT / 'tools' / 'satellite_model.js')], check=True, capture_output=True, text=True).stdout)
    for crop in ('corn', 'soybean'):
        m = dict(zip(mod[crop]['years'], mod[crop]['pct']))
        for y in YEARS:
            rows[y]['modelPct_' + crop] = m[y]

    def col(name):
        return np.array([rows[y][name] for y in YEARS], float)

    def excl(arr, drop):
        return np.array([np.nan if y in drop else a for y, a in zip(YEARS, arr)])

    sat = col('satellitePctOfMean')
    pairs = {
        'satellite_vs_nass_story_corn': (sat, col('nassPctOfTrend_story_corn')),
        'satellite_vs_nass_story_soybean': (sat, col('nassPctOfTrend_story_soybean')),
        'satellite_vs_nass_iowa_corn': (sat, col('nassPctOfTrend_state_corn')),
        'satellite_vs_nass_iowa_soybean': (sat, col('nassPctOfTrend_state_soybean')),
        'satellite_vs_model_corn': (sat, col('modelPct_corn')),
        'satellite_vs_model_soybean': (sat, col('modelPct_soybean')),
        'model_corn_vs_nass_story_corn': (col('modelPct_corn'), col('nassPctOfTrend_story_corn')),
        'model_corn_vs_nass_iowa_corn': (col('modelPct_corn'), col('nassPctOfTrend_state_corn')),
        'model_soybean_vs_nass_story_soybean': (col('modelPct_soybean'), col('nassPctOfTrend_story_soybean')),
    }
    stats = {}
    for k, (a, b) in pairs.items():
        stats[k] = {'all_years': corr(a, b), 'without_2012': corr(excl(a, {2012}), b)}
    stats['satellite_allpixels_vs_nass_story_corn'] = {'all_years': corr(col('ndviPeakAllPixels'), col('nassPctOfTrend_story_corn')),
                                                        'without_2012': corr(excl(col('ndviPeakAllPixels'), {2012}), col('nassPctOfTrend_story_corn'))}

    # biggest model/satellite disagreements (z-scores of each series over 2000-2025)
    z = lambda v: (v - v.mean()) / v.std()
    dz = z(col('modelPct_corn')) - z(sat)
    dis = sorted(zip(YEARS, dz), key=lambda t: -abs(t[1]))[:6]
    disagree = [{'year': y, 'modelCornPct': rows[y]['modelPct_corn'], 'satellitePctOfMean': rows[y]['satellitePctOfMean'],
                 'nassStoryCornPctOfTrend': rows[y]['nassPctOfTrend_story_corn'], 'zModelMinusZSatellite': round(float(d), 2)} for y, d in dis]

    res = {
        'source': 'NASA MODIS Terra 16-day NDVI composites (MOD13Q1-based, 250 m) rendered by NASA GIBS WMS, layer ' + LAYER,
        'request': WMS + '?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=' + LAYER + '&CRS=EPSG:4326&BBOX=%s&WIDTH=%d&HEIGHT=%d&FORMAT=image/png&TRANSPARENT=TRUE&TIME=YYYY-MM-DD' % (','.join(map(str, BBOX)), W, H),
        'colormap': CMAP_URL, 'bbox_minlat_minlon_maxlat_maxlon': BBOX, 'years': [YEARS[0], YEARS[-1]],
        'composites': len(dates), 'colorDecodeMaxRgbDistance': round(maxerr, 2),
        'cropland': {'method': 'median-year mask: July-August NDVI >= 0.70 and 16 Apr-20 May NDVI <= 0.50 (green in summer, bare in spring); no CropScape (its server fails TLS here)',
                     'pixels': int(mask.sum()), 'boxPixels': int(allpx.sum())},
        'peakSeason': 'mean of the July and August composites (16-day grid from 1 Jan)',
        'anomalies': 'satellite: % of own 2000-2025 mean; NASS: % of own 2000-2025 linear trend; model: % of normal (median season = 100), no trend',
        'model': 'FS.engine.seasons, current plans, initial controls; corn = field west, soybean = field north (tools/satellite_model.js)',
        'stats': stats, 'largestModelSatelliteDisagreementsCorn': disagree,
        'year2012': {k: rows[2012][k] for k in ('satellitePctOfMean', 'ndviPeak', 'modelPct_corn', 'modelPct_soybean',
                                                'nassPctOfTrend_story_corn', 'nassPctOfTrend_state_corn', 'peakDate')},
        'nass': nass, 'rows': {str(y): rows[y] for y in YEARS},
        'downloadSeconds': round(dl_s, 1),
    }
    OUT_JSON.write_text(json.dumps(res, indent=1))
    write_svg(rows)
    print(json.dumps(stats, indent=1)); print(json.dumps(res['year2012'])); print(disagree)
    print('max colour distance to colormap entry: %.2f' % maxerr)
    for y in (2000, 2005, 2012, 2013, 2020):
        print(y, rows[y]['ndviPeak'], rows[y]['peakDate'])


def write_svg(rows):
    W_, H_ = 960, 360
    L, R, T, B = 56, 20, 36, 62
    pw, ph = W_ - L - R, H_ - T - B
    lo, hi = 60, 120
    X = lambda y: L + (y - 2000) / 25 * pw
    Yf = lambda v: T + (hi - v) / (hi - lo) * ph
    def line(name, color, dash=''):
        pts = [(X(y), Yf(rows[y][name])) for y in YEARS if rows[y].get(name) is not None]
        d = ' '.join('%s%.1f,%.1f' % ('M' if i == 0 else 'L', *p) for i, p in enumerate(pts))
        dots = ''.join('<circle cx="%.1f" cy="%.1f" r="2.6" fill="%s"/>' % (x, y, color) for x, y in pts)
        return '<path d="%s" fill="none" stroke="%s" stroke-width="2"%s/>%s' % (d, color, dash, dots)
    s = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" role="img" aria-labelledby="t d" font-family="\'Plus Jakarta Sans\', system-ui, sans-serif" font-size="12">' % (W_, H_),
         '<title id="t">MODIS satellite greenness against the model and USDA yields, Story County, Iowa, 2000-2025</title>',
         '<desc id="d">Lines by year: NASA MODIS peak-season (July-August) NDVI as a percent of its 2000-2025 average; the simulator\'s corn yield as a percent of a normal season; and USDA NASS Story County corn yield as a percent of its trend. 2012 is marked: all three fall, the satellite least. Outside 2012 the three lines agree only weakly.</desc>']
    for v in range(lo, hi + 1, 10):
        s.append('<line x1="%d" x2="%d" y1="%.1f" y2="%.1f" stroke="#3d3d3d" stroke-width="%s"%s/>' % (L, L + pw, Yf(v), Yf(v), 1 if v in (lo, 100) else 0.5, '' if v in (lo, 100) else ' opacity="0.6"'))
        s.append('<text x="%d" y="%.1f" fill="#b4b2ac" text-anchor="end">%d</text>' % (L - 8, Yf(v) + 4, v))
    for y in range(2000, 2026, 5):
        s.append('<line x1="%.1f" x2="%.1f" y1="%d" y2="%d" stroke="#3d3d3d"/><text x="%.1f" y="%d" fill="#b4b2ac" text-anchor="middle">%d</text>' % (X(y), X(y), T + ph, T + ph + 5, X(y), T + ph + 20, y))
    s.append('<rect x="%.1f" y="%d" width="%.1f" height="%d" fill="#b4b2ac" opacity="0.12"/>' % (X(2012) - 9, T, 18, ph))
    s.append('<text x="%.1f" y="%d" fill="#b4b2ac" text-anchor="middle" font-weight="600">2012 drought</text>' % (X(2012), T - 8))
    s.append(line('nassPctOfTrend_story_corn', '#807e78', ' stroke-dasharray="5 4"'))
    s.append(line('modelPct_corn', '#9E6438'))
    s.append(line('satellitePctOfMean', '#D3AF7C'))
    s.append('<text x="%d" y="%d" fill="#b4b2ac" transform="rotate(-90 14 %d)" text-anchor="middle">percent of normal</text>' % (14, T + ph // 2, T + ph // 2))
    lx = L + 8; ly = H_ - 14
    for name, col_, dash, lab, w in (('sat', '#D3AF7C', '', 'MODIS peak greenness (% of 2000-2025 mean)', 290), ('mod', '#9E6438', '', 'Model corn yield (% of normal)', 200), ('nass', '#807e78', ' stroke-dasharray="5 4"', 'NASS Story corn (% of trend)', 200)):
        s.append('<line x1="%d" x2="%d" y1="%d" y2="%d" stroke="%s" stroke-width="2"%s/><text x="%d" y="%d" fill="#b4b2ac">%s</text>' % (lx, lx + 22, ly - 4, ly - 4, col_, dash, lx + 28, ly, lab))
        lx += w + 20
    s.append('</svg>')
    OUT_SVG.parent.mkdir(parents=True, exist_ok=True)
    OUT_SVG.write_text('\n'.join(s))


if __name__ == '__main__':
    main()
