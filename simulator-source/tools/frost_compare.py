#!/usr/bin/env python3
"""Median first-fall and last-spring frost dates, NASA POWER vs ERA5 (Open-Meteo), 1982-2025, for several Tmin thresholds.
Writes data/frost_compare.json. Also compares both against three NOAA GHCN-Daily stations around Ames (raw/ghcn/, fetched from
https://noaa-ghcn-pds.s3.amazonaws.com/csv/by_station/<ID>.csv; hashes in raw/HASHES.txt): station data decide which grid
dataset is right on cold nights (POWER is close; ERA5 runs warm). See VALIDATION.md, Round 3.
    python3 tools/frost_compare.py
"""
import json, pathlib, datetime as dt
import numpy as np
ROOT = pathlib.Path(__file__).resolve().parent.parent
om = json.loads((ROOT / 'raw' / 'openmeteo.json').read_text())['daily']
P = json.loads((ROOT / 'raw' / 'power.json').read_text())['properties']['parameter']['T2M_MIN']
E = {t: v for t, v in zip(om['time'], om['temperature_2m_min'])}
Pw = {f'{k[:4]}-{k[4:6]}-{k[6:]}': v for k, v in P.items() if v > -900}
YEARS = range(1982, 2026)
def doy_fall(d):   # days since 1 Jul
    return (d - dt.date(d.year, 7, 1)).days
def first_fall(series, y, th):
    d = dt.date(y, 7, 1)
    while d.year == y:
        v = series.get(d.isoformat())
        if v is not None and v <= th: return d
        d += dt.timedelta(1)
def last_spring(series, y, th):
    out = None; d = dt.date(y, 3, 1)
    while d < dt.date(y, 7, 1):
        v = series.get(d.isoformat())
        if v is not None and v <= th: out = d
        d += dt.timedelta(1)
    return out
def med_date(ds, ref_month):
    ds = [d for d in ds if d]
    base = dt.date(2001, 1, 1)
    n = int(np.median([(dt.date(2001, d.month, d.day) - base).days for d in ds]))
    return (base + dt.timedelta(n)).strftime('%d %b'), len(ds)
out = {'note': 'median dates over 1982-2025; n = seasons with such a night'}
for name, fn in (('fall', first_fall), ('spring', last_spring)):
    out[name] = {}
    for src, S in (('ERA5', E), ('POWER', Pw)):
        out[name][src] = {str(th): med_date([fn(S, y, th) for y in YEARS], 0) for th in (0.0, -1.7, -2.0, -2.8, -3.3)}
import csv
def station(st):
    d = {}
    for r in csv.DictReader(open(ROOT / 'raw' / 'ghcn' / (st + '.csv'))):
        if r['ELEMENT'] == 'TMIN' and not r['Q_FLAG']:
            k = r['DATE']; d[f'{k[:4]}-{k[4:6]}-{k[6:]}'] = int(r['DATA_VALUE']) / 10
    return d
def full(S, y):
    d = dt.date(y, 3, 1); n = t = 0
    while d < dt.date(y, 12, 1):
        t += 1; n += d.isoformat() in S; d += dt.timedelta(1)
    return n / t > 0.95
out['stations'] = {}
for st, nm in (('USC00130200', 'AMES 8 WSW'), ('USW00094989', 'AMES MUNI AP'), ('USC00131710', 'COLO')):
    S = station(st); yrs = [y for y in YEARS if full(S, y)]
    bias = {}
    for src, G in (('POWER', Pw), ('ERA5', E)):
        diffs = [G[k] - S[k] for y in yrs for k in S if k[:4] == str(y) and k[5:7] in ('09', '10', '11') and G.get(k) is not None]
        bias[src] = round(float(np.mean(diffs)), 2)
    out['stations'][st] = {'name': nm, 'years': len(yrs),
        'fall_-2C': {'station': med_date([first_fall(S, y, -2.0) for y in yrs], 0), 'POWER': med_date([first_fall(Pw, y, -2.0) for y in yrs], 0), 'ERA5': med_date([first_fall(E, y, -2.0) for y in yrs], 0)},
        'spring_0C': {'station': med_date([last_spring(S, y, 0.0) for y in yrs], 0), 'POWER': med_date([last_spring(Pw, y, 0.0) for y in yrs], 0), 'ERA5': med_date([last_spring(E, y, 0.0) for y in yrs], 0)},
        'SepNov_Tmin_bias_vs_station_C': bias, 'Tmin_1992-10-18': {'station': S.get('1992-10-18'), 'POWER': Pw.get('1992-10-18'), 'ERA5': E.get('1992-10-18')}}
(ROOT / 'data' / 'frost_compare.json').write_text(json.dumps(out, indent=1))
print(json.dumps(out, indent=1))
