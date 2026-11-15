#!/usr/bin/env python3
"""Build src/sites.js: the fourteen Corn Belt locations (API_V4 section 1).

   python3 tools/build_sites.py            (standard library only; downloads are cached in raw/sites/<id>/)

Story County reuses the existing climate (climate: null) and the soils in src/data.js. The other seven sites get
NASA POWER daily 1981-2025 (same parameters/community as build_data.py), Open-Meteo ERA5 (for heatMatch), seasons built
with build_data.py's own functions, NRCS Soil Data Access soils at four points, and NASS county yields 2020-2024.
"""
import csv, hashlib, io, json, math, os, re, sys, time, urllib.parse, urllib.request
import datetime as dt
from statistics import median
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_data as bd

ROOT, RAW, SRC = bd.ROOT, os.path.join(bd.ROOT, 'raw', 'sites'), bd.SRC
ACCESSED = dt.date.today().isoformat()
POWER_PARAMS = 'T2M_MAX,T2M_MIN,T2M,T2MDEW,RH2M,WS2M,ALLSKY_SFC_SW_DWN,PRECTOTCORR,PS,GWETROOT'
# Soil points: offsets from the county point, the same pattern as Story's four fields (1-3 km apart).
OFFSETS = {'north': (-0.01, 0.01), 'creek': (0.0, 0.0), 'west': (-0.03, 0.02), 'south': (0.01, -0.01)}
SITES = [  # id, name, short, state, NASS state, NASS county, lat, lon, where the point is
    ('obrien-ia', "O'Brien County, Iowa", "O'Brien Co., IA", 'IA', 'IOWA', "O BRIEN", 43.09, -95.63, 'farmland about 2 km south-west of Primghar (county seat, near the county centre)'),
    ('champaign-il', 'Champaign County, Illinois', 'Champaign Co., IL', 'IL', 'ILLINOIS', 'CHAMPAIGN', 40.10, -88.20, 'farmland south of Champaign-Urbana, central county'),
    ('tippecanoe-in', 'Tippecanoe County, Indiana', 'Tippecanoe Co., IN', 'IN', 'INDIANA', 'TIPPECANOE', 40.36, -86.88, 'farmland south-east of Lafayette, central county'),
    ('blueearth-mn', 'Blue Earth County, Minnesota', 'Blue Earth Co., MN', 'MN', 'MINNESOTA', 'BLUE EARTH', 44.06, -94.05, 'farmland near Garden City, central county'),
    ('saunders-ne', 'Saunders County, Nebraska', 'Saunders Co., NE', 'NE', 'NEBRASKA', 'SAUNDERS', 41.22, -96.65, 'farmland near Wahoo (county seat), central county'),
    ('brookings-sd', 'Brookings County, South Dakota', 'Brookings Co., SD', 'SD', 'SOUTH DAKOTA', 'BROOKINGS', 44.35, -96.85, 'farmland west of Brookings, central county'),
    ('wood-oh', 'Wood County, Ohio', 'Wood Co., OH', 'OH', 'OHIO', 'WOOD', 41.35, -83.68, 'farmland south-west of Bowling Green, central county'),
    ('cass-nd', 'Cass County, North Dakota', 'Cass Co., ND', 'ND', 'NORTH DAKOTA', 'CASS', 46.90, -97.25, 'farmland near Casselton, west of Fargo'),
    ('dane-wi', 'Dane County, Wisconsin', 'Dane Co., WI', 'WI', 'WISCONSIN', 'DANE', 43.17, -89.20, 'farmland east of Sun Prairie, north-east county'),
    ('lenawee-mi', 'Lenawee County, Michigan', 'Lenawee Co., MI', 'MI', 'MICHIGAN', 'LENAWEE', 41.85, -84.10, 'farmland north-east of Adrian (county seat), central county'),
    ('saline-mo', 'Saline County, Missouri', 'Saline Co., MO', 'MO', 'MISSOURI', 'SALINE', 39.12, -93.20, 'farmland near Marshall (county seat), central county'),
    ('nemaha-ks', 'Nemaha County, Kansas', 'Nemaha Co., KS', 'KS', 'KANSAS', 'NEMAHA', 39.82, -96.05, 'farmland near Seneca (county seat), central county'),
    ('christian-ky', 'Christian County, Kentucky', 'Christian Co., KY', 'KY', 'KENTUCKY', 'CHRISTIAN', 36.80, -87.55, 'farmland south of Hopkinsville (county seat)'),
]
HASHES = []


def fetch(url, data=None, tries=4, wait=5):
    for k in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers={'User-Agent': 'field-shift-sim data builder'})
            with urllib.request.urlopen(req, timeout=240) as r:
                return r.read()
        except Exception as e:
            print('   retry', k, url[:80], e)
            time.sleep(wait * (k + 1))
    raise RuntimeError('fetch failed ' + url)


def cached(path, producer):
    if not os.path.exists(path):
        data = producer()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        open(path, 'wb').write(data)
    b = open(path, 'rb').read()
    HASHES.append((hashlib.sha256(b).hexdigest(), os.path.relpath(path, os.path.join(ROOT, 'raw'))))
    return b


def sda(sql):
    body = urllib.parse.urlencode({'query': sql, 'format': 'JSON+COLUMNNAME'}).encode()
    return fetch('https://sdmdataaccess.sc.egov.usda.gov/Tabular/post.rest', body)


def soil_query(lon, lat):
    return ("SELECT mu.mukey, mu.muname, ma.aws0100wta, ma.aws0150wta, ma.drclassdcd, ma.hydgrpdcd, ma.slopegraddcp "
            "FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('POINT(%.5f %.5f)') k "
            "JOIN mapunit mu ON mu.mukey = k.mukey JOIN muaggatt ma ON ma.mukey = mu.mukey" % (lon, lat))


def get_soils(sid, lat, lon):
    """Four field soils; if a point has no usable map unit (water, urban, no data) nudge it 0.004 deg at a time."""
    out, log = {}, {}
    for fid, (dlon, dlat) in OFFSETS.items():
        nudges = [(0, 0), (0.004, 0), (0, 0.004), (-0.004, 0), (0, -0.004), (0.008, 0.008), (-0.008, -0.008), (0.008, -0.008)]
        for n, (a, b) in enumerate(nudges):
            plon, plat = round(lon + dlon + a, 5), round(lat + dlat + b, 5)
            raw = cached(os.path.join(RAW, sid, 'nrcs_%s_%d.json' % (fid, n)), lambda: sda(soil_query(plon, plat)))
            t = json.loads(raw).get('Table') or []
            if len(t) > 1:
                r = dict(zip(t[0], t[1]))
                if r.get('aws0150wta') not in (None, '') and r.get('drclassdcd') not in (None, ''):
                    out[fid] = {'name': r['muname'], 'awcMmPerM': int(round(float(r['aws0150wta']) * 10 / 1.5)),
                                'aws150cm': float(r['aws0150wta']), 'drainage': r['drclassdcd'], 'hydgrp': r['hydgrpdcd'] or '',
                                'slopePct': int(round(float(r['slopegraddcp'] or 0))), 'point': [plon, plat]}
                    log[fid] = n
                    break
        else:
            raise RuntimeError('no soil for %s %s' % (sid, fid))
    return out, log


def nass(state, county, key):
    form = {'source_desc': 'SURVEY', 'short_desc': key, 'agg_level_desc': 'COUNTY', 'state_name': state, 'county_name': county,
            'freq_desc': 'ANNUAL', 'reference_period_desc': 'YEAR'}
    base = 'https://quickstats.nass.usda.gov'
    uid = fetch(base + '/uuid/encode', urllib.parse.urlencode(form).encode()).decode().strip().strip('"')
    raw = fetch(base + '/data/spreadsheet/' + uid + '.csv')
    vals = {}
    for r in csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))):
        if r['Period'] != 'YEAR' or r.get('Domain', 'TOTAL') != 'TOTAL':
            continue
        try:
            vals[int(r['Year'])] = float(r['Value'].replace(',', ''))
        except ValueError:
            pass
    return raw, vals, uid


def county_yields(sid, state, county):
    res, note = {}, []
    for crop, key in (('corn', 'CORN, GRAIN - YIELD, MEASURED IN BU / ACRE'), ('soybean', 'SOYBEANS - YIELD, MEASURED IN BU / ACRE')):
        path = os.path.join(RAW, sid, 'nass_%s.csv' % crop)
        holder = {}
        def prod():
            raw, vals, uid = nass(state, county, key)
            holder['uid'] = uid
            return raw
        raw = cached(path, prod)
        vals = {}
        for r in csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))):
            if r['Period'] == 'YEAR':
                try:
                    vals[int(r['Year'])] = float(r['Value'].replace(',', ''))
                except ValueError:
                    pass
        yrs = [y for y in range(2020, 2025) if y in vals]
        if not yrs:
            raise RuntimeError('no NASS yields %s %s' % (sid, crop))
        res[crop] = {'mean': round(sum(vals[y] for y in yrs) / len(yrs), 1), 'years': yrs, 'values': {y: vals[y] for y in yrs}}
        if len(yrs) < 5:
            note.append('%s: only %s available' % (crop, ','.join(map(str, yrs))))
    return res, note


def STORY_HEAT():
    t = open(os.path.join(SRC, 'climate.js')).read()
    return json.loads(re.search(r'"heatMatch":(\{[^}]*\})', t).group(1))


def build_climate(sid, lat, lon):
    bd.LAT = lat                                     # et0_day reads the module-level latitude
    pw = cached(os.path.join(RAW, sid, 'power.json'), lambda: fetch(
        'https://power.larc.nasa.gov/api/temporal/daily/point?parameters=%s&community=AG&longitude=%s&latitude=%s'
        '&start=19810101&end=20251231&format=JSON' % (POWER_PARAMS, lon, lat)))
    tz = 'America/New_York' if lon > -87.5 else 'America/Chicago'
    omp = os.path.join(RAW, sid, 'openmeteo.json')
    era5 = True
    try:
        cached(omp, lambda: fetch(
            'https://archive-api.open-meteo.com/v1/archive?latitude=%s&longitude=%s&start_date=1981-01-01&end_date=2025-12-31'
            '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,et0_fao_evapotranspiration&timezone=%s' % (lat, lon, tz),
            tries=3, wait=20))
    except RuntimeError:
        era5 = False
    old = bd.RAW
    bd.RAW = os.path.join(RAW, sid)
    try:
        days, S, elev = bd.load_power()
        if era5:
            edays, E = bd.load_openmeteo()
    finally:
        bd.RAW = old
    index = {d: i for i, d in enumerate(days)}
    et0 = []
    for i, d in enumerate(days):
        doy = d.timetuple().tm_yday if not (d.year % 4 == 0 and d.month > 2) else d.timetuple().tm_yday - 1
        et0.append(bd.et0_day(doy, S['T2M_MAX'][i], S['T2M_MIN'][i], S['T2MDEW'][i], S['WS2M'][i], S['ALLSKY_SFC_SW_DWN'][i], elev))
    years = list(range(1982, 2026))
    seasons, missing = bd.build_seasons(index, S, et0, years)
    jja_rain = {y: sum(bd.jja(days, S['PRECTOTCORR'], y)) for y in range(1981, 2026)}
    med = median(jja_rain[y] for y in years)
    typical = min(years, key=lambda y: abs(jja_rain[y] - med))
    if era5:
        hm = bd.heat_match(days, S['T2M_MAX'], edays, E['temperature_2m_max'], set(range(1981, 2026)))
        hm = {k: v for k, v in hm.items() if not k.startswith('_')}
        hfrom = 'this site (POWER vs Open-Meteo ERA5)'
        et0check = {}
        for y in (2012, 2019, 2023):
            ours, theirs = sum(bd.jja(days, et0, y)), sum(bd.jja(edays, E['et0_fao_evapotranspiration'], y))
            et0check[str(y)] = {'power': round(ours, 1), 'era5': round(theirs, 1)}
    else:
        hm = STORY_HEAT()
        hfrom = "Story County's heatMatch reused (Open-Meteo ERA5 not fetched for this site)"
        et0check = None
    meta = {'source': 'NASA POWER daily (MERRA-2 based), community AG', 'lat': lat, 'lon': lon, 'elevation_m': round(elev),
            'seasonStart': '11-16', 'days': 365, 'years': years, 'typicalYear': typical, 'scale': bd.SCALE,
            'heatMatch': hm, 'heatMatchFrom': hfrom,
            'et0Check': et0check, 'accessed': ACCESSED}
    return {'meta': meta, 'seasons': seasons}, missing


def story_site():
    s = open(os.path.join(SRC, 'data.js')).read()
    soils = {}
    for fid in OFFSETS:
        m = re.search(r"\{ id: '%s',[^\n]*?soil: (\{[^\n]*?\}),(?=[ \t]*\n[ \t]*poly)" % fid, s)
        o = m.group(1)
        soils[fid] = {'name': re.search(r"name: '([^']*)'", o).group(1), 'awcMmPerM': int(re.search(r'awcMmPerM: (\d+)', o).group(1)),
                      'aws150cm': float(re.search(r'aws150cm: ([\d.]+)', o).group(1)), 'drainage': re.search(r"drainage: '([^']*)'", o).group(1),
                      'hydgrp': re.search(r"hydgrp: '([^']*)'", o).group(1), 'slopePct': int(re.search(r'slopePct: (\d+)', o).group(1)),
                      'point': [float(x) for x in re.search(r'point: \[([^\]]*)\]', o).group(1).split(',')]}
    return {'id': 'story-ia', 'name': 'Story County, Iowa', 'short': 'Story Co., IA', 'state': 'IA', 'lat': bd.LAT, 'lon': bd.LON,
            'validated': True, 'climate': None, 'soils': soils, 'normalYield': {'corn': 211, 'soybean': 61},
            'source': {'power': 'NASA POWER daily 1981-2025, point 42.03 N 93.47 W (the page climate)',
                       'nrcs': 'NRCS Soil Data Access, map unit at four points (src/data.js)',
                       'nass': 'ISU 2026 crop budgets (A1-20): 211 bu corn, 61 bu soybean; Story County yields were checked against USDA NASS 1975-2025'}}


def main():
    sites = [story_site()]
    report = []
    for sid, name, short, st, nst, nco, lat, lon, where in SITES:
        print('==', sid)
        clim, missing = build_climate(sid, lat, lon)
        soils, slog = get_soils(sid, lat, lon)
        ny, note = county_yields(sid, nst, nco)
        print('   missing', missing, 'soil nudges', slog, 'yields', {c: (v['mean'], v['years']) for c, v in ny.items()}, note)
        sites.append({'id': sid, 'name': name, 'short': short, 'state': st, 'lat': lat, 'lon': lon, 'validated': False,
                      'climate': clim, 'soils': soils,
                      'normalYield': {'corn': round(ny['corn']['mean']), 'soybean': round(ny['soybean']['mean'])},
                      'normalYieldDetail': {c: {'years': v['years'], 'values': {str(k): x for k, x in v['values'].items()}, 'mean': v['mean']} for c, v in ny.items()},
                      'source': {'power': 'NASA POWER daily 1981-2025 (community AG), point %.2f N %.2f W: %s' % (lat, -lon, where),
                                 'nrcs': 'NRCS Soil Data Access, map unit at four points 1-3 km from the county point',
                                 'nass': 'USDA NASS Quick Stats county average yield, mean of %s%s' % (
                                     '2020-2024' if not note else 'the available years among 2020-2024', ('; ' + '; '.join(note)) if note else '')}})
    body = json.dumps(sites, separators=(',', ':'))
    assert '</script' not in body.lower()
    text = ("/* GENERATED by tools/build_sites.py from NASA POWER, Open-Meteo, NRCS Soil Data Access and USDA NASS. Do not hand-edit. */\n"
            "window.FS = window.FS || {};\nFS.data = FS.data || {};\nFS.data.sites = " + body + ";\n")
    open(os.path.join(SRC, 'sites.js'), 'w').write(text)
    print('sites.js %.1f KB' % (len(text) / 1024))
    hp = os.path.join(ROOT, 'raw', 'HASHES.txt')
    have = open(hp).read()
    with open(hp, 'a') as f:
        for h, p in sorted(set(HASHES), key=lambda x: x[1]):
            if p not in have:
                f.write('%s  %s\n' % (h, p))


if __name__ == '__main__':
    main()
