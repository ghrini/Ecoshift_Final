#!/usr/bin/env python3
"""Build src/climate.js and update src/data.js from the raw pulls in raw/.

Run:  python3 tools/build_data.py        (standard library only)

Inputs (raw/):  power.json (NASA POWER daily), openmeteo.json (Open-Meteo archive),
                nrcs_sda.json (NRCS Soil Data Access, four field points).
Outputs:        src/climate.js (generated, do not hand-edit), src/data.js (soil, scenarios,
                economics, sources blocks are rewritten; everything else is left alone).
Format:         see CLIMATE_FORMAT.md.
"""
import json
import math
import os
import re
import datetime as dt
from statistics import median

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'raw')
SRC = os.path.join(ROOT, 'src')
LAT, LON = 42.03, -93.47
ACCESSED = '2026-11-14'
SCALE = {'tmax': 10, 'tmin': 10, 'rain': 10, 'et0': 10, 'rad': 10, 'rh': 1, 'wind': 10, 'gwr': 100}
SCENARIO_FALLBACK = {'lateFreeze': 1997, 'earlyFrost': 1991}   # only used for the printed comparison


# ---------------------------------------------------------------- loading
def load_power():
    d = json.load(open(os.path.join(RAW, 'power.json')))
    elev = d['geometry']['coordinates'][2]
    units = {k: v['units'] for k, v in d['parameters'].items()} if 'parameters' in d else \
        {k: v['units'] for k, v in d['properties']['parameters'].items()}
    assert units['ALLSKY_SFC_SW_DWN'] == 'MJ/m^2/day', units   # AG community: MJ, not kWh
    fill = d['header']['fill_value']
    par = d['properties']['parameter']
    dates = sorted(par['T2M'].keys())
    series = {}
    for k, v in par.items():
        series[k] = [None if v[x] == fill else v[x] for x in dates]
    days = [dt.date(int(x[:4]), int(x[4:6]), int(x[6:])) for x in dates]
    return days, series, elev


def load_openmeteo():
    d = json.load(open(os.path.join(RAW, 'openmeteo.json')))['daily']
    days = [dt.date.fromisoformat(x) for x in d['time']]
    return days, d


# ---------------------------------------------------------------- ET0
def e0(t):
    return 0.6108 * math.exp(17.27 * t / (t + 237.3))


def extraterrestrial(doy, lat_rad):
    dr = 1 + 0.033 * math.cos(2 * math.pi * doy / 365)
    delta = 0.409 * math.sin(2 * math.pi * doy / 365 - 1.39)
    ws = math.acos(max(-1.0, min(1.0, -math.tan(lat_rad) * math.tan(delta))))
    ra = (24 * 60 / math.pi) * 0.0820 * dr * (ws * math.sin(lat_rad) * math.sin(delta)
                                               + math.cos(lat_rad) * math.cos(delta) * math.sin(ws))
    return ra


def et0_day(doy, tmax, tmin, tdew, u2, rs, z):
    """FAO-56 Penman-Monteith (rs given) or Hargreaves (rs None). mm/day."""
    phi = math.radians(LAT)
    tmean = (tmax + tmin) / 2
    ra = extraterrestrial(doy, phi)
    if rs is None:
        return max(0.0, 0.0023 * (tmean + 17.8) * math.sqrt(max(tmax - tmin, 0)) * ra * 0.408)
    es = (e0(tmax) + e0(tmin)) / 2
    ea = e0(tdew)
    delta = 4098 * e0(tmean) / (tmean + 237.3) ** 2
    p = 101.3 * ((293 - 0.0065 * z) / 293) ** 5.26
    gamma = 0.000665 * p
    rso = (0.75 + 2e-5 * z) * ra
    rns = 0.77 * rs
    rnl = 4.903e-9 * (((tmax + 273.16) ** 4 + (tmin + 273.16) ** 4) / 2) * (0.34 - 0.14 * math.sqrt(ea)) \
        * (1.35 * min(rs / rso, 1.0) - 0.35)
    et = (0.408 * delta * (rns - rnl) + gamma * 900 / (tmean + 273) * u2 * (es - ea)) / (delta + gamma * (1 + 0.34 * u2))
    return max(0.0, et)


# ---------------------------------------------------------------- seasons
def season_days(y):
    """Dates of season year y: 16 Nov (y-1) .. 15 Nov y, without 29 Feb. 365 days."""
    out, d, end = [], dt.date(y - 1, 11, 16), dt.date(y, 11, 15)
    while d <= end:
        if not (d.month == 2 and d.day == 29):
            out.append(d)
        d += dt.timedelta(days=1)
    assert len(out) == 365
    return out


def build_seasons(index, S, et0, years):
    seasons, missing = {}, {k: 0 for k in ('tmax', 'tmin', 'rain', 'et0', 'rad', 'gwr')}
    def rnd(v, s):
        return int(round(v * s))
    for y in years:
        arr = {k: [] for k in missing}
        for d in season_days(y):
            i = index[d]
            for key, src in (('tmax', 'T2M_MAX'), ('tmin', 'T2M_MIN'), ('rain', 'PRECTOTCORR'), ('gwr', 'GWETROOT')):
                v = S[src][i]
                if v is None:
                    missing[key] += 1
                    v = 0
                arr[key].append(rnd(v, SCALE[key]))
            arr['et0'].append(rnd(et0[i], SCALE['et0']))
            rs = S['ALLSKY_SFC_SW_DWN'][i]
            if rs is None:
                missing['rad'] += 1
                arr['rad'].append(-1)
            else:
                arr['rad'].append(rnd(rs, SCALE['rad']))
        seasons[str(y)] = arr
    return seasons, missing


# ---------------------------------------------------------------- statistics
def jja(days, vals, y):
    return [v for d, v in zip(days, vals) if d.year == y and d.month in (6, 7, 8)]


def heat_match(p_days, p_tmax, e_days, e_tmax, years):
    pj = [v for d, v in zip(p_days, p_tmax) if d.month in (6, 7, 8) and d.year in years]
    ej = [v for d, v in zip(e_days, e_tmax) if d.month in (6, 7, 8) and d.year in years]
    out = {}
    for c in (29, 30, 35):
        target = sum(1 for v in ej if v > c)
        best, bestgap = None, None
        for k in range(250, 450):          # 25.0 .. 44.9 C on a 0.1 grid
            t = k / 10
            gap = abs(sum(1 for v in pj if v > t) - target)
            if bestgap is None or gap < bestgap:
                best, bestgap = t, gap
        out['c%d' % c] = best
        out['_n%d' % c] = target
    return out


def frost_years(days, tmin, years):
    spring, fall = {}, {}
    for d, v in zip(days, tmin):
        if v is None or d.year not in years or v > 0:
            continue
        if d.month in (3, 4, 5, 6):
            if d.year not in spring or d > spring[d.year]:
                spring[d.year] = d
        if d.month >= 7 and not (d.month == 12 and d.day >= 31):
            if d.year not in fall or d < fall[d.year]:
                fall[d.year] = d
    late = max(spring.items(), key=lambda kv: kv[1].replace(year=2000))
    early = min(fall.items(), key=lambda kv: kv[1].replace(year=2000))
    return late, early


# ---------------------------------------------------------------- soil
def load_soil():
    t = json.load(open(os.path.join(RAW, 'nrcs_sda.json')))['Table']
    head = t[0]
    rows = {r[0]: dict(zip(head, r)) for r in t[1:]}
    return rows


POINTS = {'north': (-93.48, 42.04), 'creek': (-93.47, 42.03), 'west': (-93.50, 42.05), 'south': (-93.46, 42.02)}


def soil_object(row, pt):
    aws150 = float(row['aws0150wta'])
    return {'name': row['muname'], 'awcMmPerM': int(round(aws150 * 10 / 1.5)), 'aws150cm': aws150,
            'drainage': row['drclassdcd'], 'hydgrp': row['hydgrpdcd'], 'slopePct': int(round(float(row['slopegraddcp']))),
            'point': list(pt)}


# ---------------------------------------------------------------- JS helpers
def js(v, indent=None):
    """Render a Python value as JS with single-quoted strings."""
    if isinstance(v, str):
        return "'" + v.replace('\\', '\\\\').replace("'", "\\'") + "'"
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if v is None:
        return 'null'
    if isinstance(v, (int, float)):
        return repr(v)
    if isinstance(v, (list, tuple)):
        return '[' + ', '.join(js(x) for x in v) + ']'
    if isinstance(v, dict):
        return '{ ' + ', '.join('%s: %s' % (k if re.match(r'^[A-Za-z_]\w*$', k) else js(k), js(x)) for k, x in v.items()) + ' }'
    raise TypeError(v)


def write_climate(meta, seasons):
    body = json.dumps({'meta': meta, 'seasons': seasons}, separators=(',', ':'))
    text = ("/* GENERATED by tools/build_data.py from NASA POWER daily data. Do not hand-edit. */\n"
            "window.FS = window.FS || {};\nFS.data = FS.data || {};\nFS.data.climate = " + body + ";\n")
    assert '</script' not in text.lower()
    path = os.path.join(SRC, 'climate.js')
    open(path, 'w').write(text)
    return os.path.getsize(path)


def update_data_js(soils, typical, late_year, early_year, late_date, early_date):
    path = os.path.join(SRC, 'data.js')
    s = open(path).read()
    # 1. field soil
    for fid, pt in POINTS.items():
        pat = re.compile(r"(\{ id: '%s',[^\n]*?)soil: (?:'[^']*'|\{[^\n]*?\}),(?=[ \t]*\n[ \t]*poly)" % fid)
        s, n = pat.subn(lambda m: m.group(1) + 'soil: ' + js(soils[fid]) + ',', s)
        assert n == 1, fid
    # 2. farm name/place stay; county reference AWC after view line
    if 'countyAwcMmPerM' in s:
        s = re.sub(r"countyAwcMmPerM: [\d.]+,", 'countyAwcMmPerM: 180,', s)
    else:
        s = s.replace("    view: { w: 1000, h: 640 },\n",
                      "    view: { w: 1000, h: 640 },\n"
                      "    countyAwcMmPerM: 180,   // county reference available water, mm per m (Story County soils, rounded)\n", 1)
    # 3. weather scenarios
    def mon(d):
        return d.strftime('%-d %B')
    scen = [
        ('typical', 'Typical year (%d weather)' % typical, typical, 'Median June-August rain of the 44 seasons 1982-2025'),
        ('drought2012', '2012 drought and heat', 2012, 'Iowa corn 137 bu/acre vs 172 in 2011'),
        ('wet2019', '2019 wet spring', 2019, 'Planting delayed; record unplanted acres nationally'),
        ('dry2023', '2023 dry summer', 2023, 'Drought, yet Iowa corn stayed near 201 bu/acre'),
        ('lateFreeze', 'Late spring frost (%d, the latest in 44 seasons)' % late_year, late_year,
         'Last 0 C night of spring: %s %d' % (mon(late_date), late_year)),
        ('earlyFrost', 'Early fall frost (%d, the earliest in 44 seasons)' % early_year, early_year,
         'First 0 C night of fall: %s %d' % (mon(early_date), early_year)),
    ]
    block = ("  weatherScenarios: [\n" + ',\n'.join(
        "    { id: %s, label: %s, year: %d, note: %s }" % (js(i), js(l), y, js(n)) for i, l, y, n in scen) + "\n  ],")
    s, n = re.subn(r"  weatherScenarios: \[.*?\n  \],", lambda m: block, s, flags=re.S)
    assert n == 1
    # 4. economics
    econ = """  // Prices and costs for the money model. Dollar figures are before insurance, at the dates below.
  economics: {
    price: { corn: 4.60, soybean: 12.10, oats: 3.50 },           // $/bu; corn and soybean = 2026/27 season-average farm price (Nov 2026 WASDE); oats price is a PLACEHOLDER
    normalYield: { corn: 211, soybean: 61, oats: 80 },             // bu/acre; corn and soybean from the ISU 2026 budgets; oats is a placeholder
    costPerAcre: { corn: 911.98, cornAfterCorn: 960.02, soybean: 680, oats: 420, rye: 37 }, // full cost incl. land; ISU 2026 A1-20 via secondary summaries; oats and rye are placeholders
    nitrogen: { lbPerAcreCornAfterSoy: 146, lbPerAcreCornAfterCorn: 190, dollarsPerLb: 0.57 },
    volatility: { corn: 0.15, soybean: 0.13 },                     // RMA 2026 price volatility factors
    costShareRye: 30,                                              // IDALS 2026 first-time cover crop cost-share, $/acre
    asOf: '2026-11-14',
    sources: {
      price: 'Corn $4.60 and soybean $12.10 per bushel: USDA WASDE November 2026, 2026/27 season-average farm price (reported by DTN, 10 Nov 2026). Oats $3.50 is a placeholder, not sourced.',
      costs: 'Corn $911.98, corn after corn $960.02 and the 211 bu/acre budget yield: Iowa State University Ag Decision Maker A1-20, January 2026, read through secondary summaries (Fencerow, Iowa Farm Bureau). Soybean about $680 at 61 bu/acre: Iowa Soybean Association summary of the same budgets, sources conflict. Oats $420 and 80 bu/acre are placeholders. Rye $37 is a placeholder.',
      nitrogen: '146 lb N/acre for corn after soybean: Iowa State MRTN 2022. 190 lb for corn after corn is a working figure. $0.57 per lb N from anhydrous at $938/ton (DTN, November 2026).',
      volatility: 'RMA 2026 volatility factors, via farmdoc daily (March 2026).',
      costShare: 'Iowa Department of Agriculture and Land Stewardship cover crop cost-share 2026: $30/acre first-time, 160-acre cap; not combinable with the crop insurance discount.'
    }
  },"""
    s, n = re.subn(r"  // Prices and costs for the money model[^\n]*\n  economics: \{.*?\n  \},", lambda m: econ, s, flags=re.S)
    assert n == 1
    # 5. sources
    src = {
        'power': ('NASA POWER', 'https://power.larc.nasa.gov/docs/services/api/temporal/'),
        'openmeteo': ('Open-Meteo archive (ERA5)', 'https://open-meteo.com/en/docs/historical-weather-api'),
        'nrcs': ('NRCS Soil Data Access', 'https://sdmdataaccess.sc.egov.usda.gov/WebServiceHelp.aspx'),
        'isu': ('Iowa State A1-20 crop budgets', 'https://www.extension.iastate.edu/agdm/crops/pdf/a1-20.pdf'),
        'wasde': ('USDA WASDE, November 2026', 'https://esmis.nal.usda.gov/sites/default/release-files/796142/wasde1126.pdf'),
        'rma': ('RMA prices and volatility (farmdoc)', 'https://farmdocdaily.illinois.edu/2026/03/projected-prices-and-volatility-factors-for-2026.html'),
        'idals': ('Iowa cover crop cost-share', 'https://iowaagriculture.gov/news/cover-crop-cost-share-program-2026'),
        'fao56': ('FAO Paper 56 (ET0)', 'https://www.fao.org/4/x0490e/x0490e0e.htm'),
        'fao33': ('FAO Paper 33 (Ky)', 'https://fao.org/4/i2800e/i2800e02.pdf'),
    }
    block = "  sources: {\n" + ',\n'.join("    %s: { label: %s, url: %s }" % (k, js(l), js(u)) for k, (l, u) in src.items()) + "\n  },"
    s, n = re.subn(r"^  sources: \{.*?\n  \},", lambda m: block, s, flags=re.S | re.M)
    assert n == 1
    open(path, 'w').write(s)


# ---------------------------------------------------------------- main
def main():
    days, S, elev = load_power()
    index = {d: i for i, d in enumerate(days)}
    edays, E = load_openmeteo()
    print('POWER days: %d (%s .. %s), elevation %.2f m' % (len(days), days[0], days[-1], elev))
    print('Open-Meteo days: %d, nulls: %s' % (len(edays), {k: sum(1 for x in v if x is None) for k, v in E.items() if k != 'time'}))
    print('POWER missing (-999) per variable:', {k: sum(1 for x in v if x is None) for k, v in S.items()})

    # ET0 on every day
    et0 = []
    for i, d in enumerate(days):
        et0.append(et0_day(d.timetuple().tm_yday if not (d.year % 4 == 0 and d.month > 2) else d.timetuple().tm_yday - 1,
                           S['T2M_MAX'][i], S['T2M_MIN'][i], S['T2MDEW'][i], S['WS2M'][i], S['ALLSKY_SFC_SW_DWN'][i], elev))
    # (doy above ignores 29 Feb so day-of-year is on the 365-day calendar)

    years = list(range(1982, 2026))
    seasons, missing = build_seasons(index, S, et0, years)
    print('Seasons: %d (%d..%d), days per season: %s' % (len(years), years[0], years[-1], {len(v['tmax']) for v in seasons.values()}))
    print('Missing in season arrays (filled 0, rad = -1):', missing)

    # typical year: June-August rain closest to the median over the seasons
    jja_rain = {y: sum(jja(days, S['PRECTOTCORR'], y)) for y in range(1981, 2026)}
    med = median(jja_rain[y] for y in years)
    typical = min(years, key=lambda y: abs(jja_rain[y] - med))
    print('JJA rain median (1982-2025): %.1f mm; typical year %d (%.1f mm)' % (med, typical, jja_rain[typical]))
    for y in (2012, 2019, 2023):
        print('  JJA rain %d: %.1f mm' % (y, jja_rain[y]))

    # heat thresholds
    allyears = set(range(1981, 2026))
    hm = heat_match(days, S['T2M_MAX'], edays, E['temperature_2m_max'], allyears)
    print('heatMatch (POWER Tmax thresholds, JJA 1981-2025):', {k: v for k, v in hm.items() if not k.startswith('_')},
          ' ERA5 exceedance counts:', {k: v for k, v in hm.items() if k.startswith('_')})
    for y in (2012, 2023):
        pj, ej = jja(days, S['T2M_MAX'], y), jja(edays, E['temperature_2m_max'], y)
        print('  %d: POWER days > %.1f: %d | ERA5 days > 30: %d | POWER days > 30: %d' % (
            y, hm['c30'], sum(v > hm['c30'] for v in pj), sum(v > 30 for v in ej), sum(v > 30 for v in pj)))
        print('  %d: POWER days > %.1f: %d | ERA5 days > 29: %d | POWER > %.1f (c35): %d | ERA5 > 35: %d' % (
            y, hm['c29'], sum(v > hm['c29'] for v in pj), sum(v > 29 for v in ej), hm['c35'], sum(v > hm['c35'] for v in pj), sum(v > 35 for v in ej)))

    # ET0 check
    et0check = {}
    for y in (2012, 2019, 2023):
        ours = sum(jja(days, et0, y))
        theirs = sum(jja(edays, E['et0_fao_evapotranspiration'], y))
        et0check[str(y)] = {'power': round(ours, 1), 'era5': round(theirs, 1)}
        print('  ET0 JJA %d: ours %.1f mm, Open-Meteo %.1f mm, gap %+.1f%%' % (y, ours, theirs, 100 * (ours - theirs) / theirs))

    # frost years (seasons 1982-2025)
    (ly, ld), (ey, ed) = frost_years(days, S['T2M_MIN'], set(years))
    print('Latest spring frost (Tmin<=0, Mar-Jun): %s; earliest fall frost (Jul-Dec): %s' % (ld, ed))
    print('  fallback expectations were', SCENARIO_FALLBACK)

    meta = {'source': 'NASA POWER daily (MERRA-2 based), community AG', 'lat': LAT, 'lon': LON,
            'elevation_m': round(elev), 'seasonStart': '11-16', 'days': 365, 'years': years,
            'typicalYear': typical, 'scale': SCALE,
            'heatMatch': {k: v for k, v in hm.items() if not k.startswith('_')},
            'et0Check': et0check, 'accessed': ACCESSED}
    size = write_climate(meta, seasons)
    print('climate.js size: %.1f KB' % (size / 1024))

    # soil
    rows = load_soil()
    soils = {}
    for fid, pt in POINTS.items():
        soils[fid] = soil_object(rows[fid], pt)
        s = soils[fid]
        print('  soil %-5s %s | aws150 %.2f cm | awc %d mm/m | %s | %s | slope %d%%' % (
            fid, s['name'], s['aws150cm'], s['awcMmPerM'], s['drainage'], s['hydgrp'], s['slopePct']))
    update_data_js(soils, typical, ly, ey, ld, ed)
    print('data.js updated')


if __name__ == '__main__':
    main()
