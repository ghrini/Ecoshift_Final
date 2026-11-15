#!/usr/bin/env python3
"""Fetch Iowa and Story County corn and soybean yields from USDA NASS Quick Stats and write data/iowa_yields.json.

   python3 tools/validate_fetch_nass.py

The Quick Stats API needs a key; the public web tool at https://quickstats.nass.usda.gov/ does not. This script
uses the same three calls the web tool makes when you press "Get Data" and then "Spreadsheet":
  POST /row_counts      (how many rows the selection returns)
  POST /uuid/encode     (saves the selection, returns its id)
  GET  /data/spreadsheet/<id>.csv
The raw CSV files are kept in data/nass/ with their sha256 in data/iowa_yields.json, so the numbers can be checked
against the NASS web tool by anyone (open https://quickstats.nass.usda.gov/results/<id>).
Standard library only.
"""
import csv, hashlib, io, json, pathlib, ssl, urllib.parse, urllib.request, datetime

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'data'
RAW = OUT / 'nass'
BASE = 'https://quickstats.nass.usda.gov'

QUERIES = {
    'state_corn': {'commodity': 'corn', 'level': 'state',
                   'form': {'source_desc': 'SURVEY', 'short_desc': 'CORN, GRAIN - YIELD, MEASURED IN BU / ACRE', 'agg_level_desc': 'STATE',
                            'state_name': 'IOWA', 'freq_desc': 'ANNUAL', 'reference_period_desc': 'YEAR'}},
    'state_soybean': {'commodity': 'soybean', 'level': 'state',
                      'form': {'source_desc': 'SURVEY', 'short_desc': 'SOYBEANS - YIELD, MEASURED IN BU / ACRE', 'agg_level_desc': 'STATE',
                               'state_name': 'IOWA', 'freq_desc': 'ANNUAL', 'reference_period_desc': 'YEAR'}},
    'story_corn': {'commodity': 'corn', 'level': 'county',
                   'form': {'source_desc': 'SURVEY', 'short_desc': 'CORN, GRAIN - YIELD, MEASURED IN BU / ACRE', 'agg_level_desc': 'COUNTY',
                            'state_name': 'IOWA', 'county_name': 'STORY', 'freq_desc': 'ANNUAL', 'reference_period_desc': 'YEAR'}},
    'story_soybean': {'commodity': 'soybean', 'level': 'county',
                      'form': {'source_desc': 'SURVEY', 'short_desc': 'SOYBEANS - YIELD, MEASURED IN BU / ACRE', 'agg_level_desc': 'COUNTY',
                               'state_name': 'IOWA', 'county_name': 'STORY', 'freq_desc': 'ANNUAL', 'reference_period_desc': 'YEAR'}},
}
FIRST, LAST = 1975, 2025     # 2026 is the in-season forecast at the time of the pull, not a final estimate: excluded


def post(path, form):
    data = urllib.parse.urlencode(form).encode()
    with urllib.request.urlopen(urllib.request.Request(BASE + path, data=data), timeout=120) as r:
        return r.read().decode()


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=180) as r:
        return r.read()


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    out = {'source': 'USDA NASS Quick Stats (survey, annual, final estimates)', 'tool': BASE + '/',
           'accessed': datetime.date.today().isoformat(), 'units': 'bu/acre',
           'note': 'Values are the NASS survey yield for each marketing year. The current year (in-season forecast) is excluded. '
                   'Each series can be reopened in the NASS web tool at results_url.',
           'series': {}}
    for key, q in QUERIES.items():
        rows = json.loads(post('/row_counts', q['form']))
        uid = post('/uuid/encode', q['form']).strip().strip('"')
        raw = get('/data/spreadsheet/' + uid + '.csv')
        (RAW / (key + '.csv')).write_bytes(raw)
        vals = {}
        for r in csv.DictReader(io.StringIO(raw.decode())):
            y = int(r['Year'])
            if FIRST <= y <= LAST and r['Period'] == 'YEAR':
                v = r['Value'].replace(',', '').strip()
                try: vals[str(y)] = float(v)
                except ValueError: pass       # (D) withheld etc.
        out['series'][key] = {'commodity': q['commodity'], 'level': q['level'], 'query': q['form'], 'rows': rows.get('rowcnt'),
                              'results_url': BASE + '/results/' + uid, 'csv_url': BASE + '/data/spreadsheet/' + uid + '.csv',
                              'csv_file': 'data/nass/' + key + '.csv', 'sha256': hashlib.sha256(raw).hexdigest(),
                              'values': dict(sorted(vals.items()))}
        print(key, len(vals), 'years', min(vals), '-', max(vals))
    (OUT / 'iowa_yields.json').write_text(json.dumps(out, indent=1), encoding='utf-8')
    print('wrote data/iowa_yields.json')


if __name__ == '__main__':
    main()
