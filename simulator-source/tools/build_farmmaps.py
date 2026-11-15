#!/usr/bin/env python3
"""Real illustrated farm maps for the 14 county points, built into the simulator page (src/farmmaps.js).

For each county point: download the same 1.6 km square (moved about 2 km into farmland when the point itself is a town or
one unbroken block) from USDA NAIP aerial photos (via the USGS National Map,
public domain) and Sentinel-2 cloudless (EOX, CC BY-NC-SA 4.0), keep the sharper one, draw the illustrated map with
the team's converter (farmmap/stylize_farm.py) and find the four simulation fields on it (farmmap/farm_fields.py).
Downloads are cached in raw/farmmaps/<id>/ (hashes in raw/HASHES.txt).

    python3 tools/build_farmmaps.py            # from simulator-source/
Needs: pip install -r ../farmmap/requirements.txt, and network access to basemap.nationalmap.gov and tiles.maps.eox.at.
"""
import base64
import hashlib
import json
import math
import os
import subprocess
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))          # simulator-source/
FARMMAP = os.path.join(os.path.dirname(ROOT), 'farmmap')                    # ../farmmap
sys.path.insert(0, FARMMAP)
import cv2                     # noqa: E402
import make_map               # noqa: E402  (sharpness and per-source converter settings)

HALF_KM = 0.8
URL = {
    'usgs': 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/export?bbox={b}&bboxSR=4326&imageSR=3857&size=1000,1000&format=jpg&f=image',
    's2': 'https://tiles.maps.eox.at/wms?service=WMS&request=GetMap&version=1.1.1&layers=s2cloudless-2020&styles=&srs=EPSG:4326&bbox={b}&width=1000&height=1000&format=image/jpeg',
}
CREDIT = {
    'usgs': 'USDA NAIP aerial imagery via the USGS National Map (public domain)',
    's2': 'Sentinel-2 cloudless 2020 by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2020), CC BY-NC-SA 4.0',
}


def sites():
    """The county points from src/sites.js (Story County's point is in its entry too)."""
    js = open(os.path.join(ROOT, 'src', 'sites.js'), encoding='utf-8').read()
    arr = json.loads(js[js.index('['):js.rindex(']') + 1])
    return [(s['id'], s['name'], float(s['lat']), float(s['lon'])) for s in arr]


def box(lat, lon):
    dlat, dlon = HALF_KM / 111.32, HALF_KM / (111.32 * math.cos(math.radians(lat)))
    return ','.join('%.6f' % v for v in (lon - dlon, lat - dlat, lon + dlon, lat + dlat))


def fetch(url, path):
    if os.path.exists(path) and os.path.getsize(path) > 1000:
        return path
    req = urllib.request.Request(url, headers={'User-Agent': 'fieldshift-simulator'})
    with urllib.request.urlopen(req, timeout=60) as r, open(path, 'wb') as f:
        f.write(r.read())
    return path


# Where the county point itself is a town or one unbroken block, the example farm moves a little (about 2 km) into farmland.
OFFSETS_KM = [(0, 0), (0, 2.2), (0, -2.2), (2.2, 0), (-2.2, 0), (2.2, 2.2), (-2.2, 2.2), (2.2, -2.2), (-2.2, -2.2)]


def try_point(sid, d, lat, lon, tag):
    """Download both sources for this square, keep the sharper, draw the map and find the fields (strict). None if it fails."""
    b = box(lat, lon)
    scores = {}
    for src in ('usgs', 's2'):
        p = os.path.join(d, src + tag + '.jpg')
        try:
            fetch(URL[src].format(b=b), p)
            img = cv2.imread(p, cv2.IMREAD_COLOR)
            scores[src] = make_map.sharpness(img) if img is not None else 0
        except Exception as e:          # one source down: use the other
            print(sid, tag or 'centre', src, 'failed:', e)
            scores[src] = 0
    best = max(scores, key=scores.get)
    if not scores[best]:
        return None
    photo = os.path.join(d, best + tag + '.jpg')
    mp, fj = os.path.join(d, 'map.jpg'), os.path.join(d, 'fields.json')
    if os.path.exists(fj):
        os.remove(fj)
    cmd = [sys.executable, os.path.join(FARMMAP, 'farm_fields.py'), photo, '--out-map', mp, '--out-json', fj,
           '--width-km', str(2 * HALF_KM), '--strict'] + make_map.SETTINGS[best]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if not os.path.exists(fj):
        print(sid, tag or 'centre', 'rejected:', (r.stdout + r.stderr).strip()[-160:])
        return None
    return best, scores, mp, json.load(open(fj))


def main():
    out, hashes = {}, []
    for sid, name, lat, lon in sites():
        d = os.path.join(ROOT, 'raw', 'farmmaps', sid)
        os.makedirs(d, exist_ok=True)
        got = None
        for dx, dy in OFFSETS_KM:
            tag = '' if (dx, dy) == (0, 0) else '_%+.1f_%+.1f' % (dx, dy)
            plat, plon = lat + dy / 111.32, lon + dx / (111.32 * math.cos(math.radians(lat)))
            got = try_point(sid, d, plat, plon, tag)
            if got:
                break
        if not got:
            print(sid, 'no usable map near the county point'); continue
        best, scores, mp, f = got
        # the page gets a 1000 px JPEG (the converter draws at 2x)
        im = cv2.imread(mp, cv2.IMREAD_COLOR)
        im = cv2.resize(im, (1000, 1000), interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode('.jpg', im, [cv2.IMWRITE_JPEG_QUALITY, 74])
        out[sid] = dict(site=sid, name=name, lat=round(plat, 5), lon=round(plon, 5), offsetKm=[dx, dy], widthKm=f['widthKm'], source=best,
                        credit=CREDIT[best], sharpness={k: round(v, 1) for k, v in scores.items()}, fields=f['fields'],
                        img='data:image/jpeg;base64,' + base64.b64encode(buf.tobytes()).decode('ascii'))
        print(sid, best, 'offset km', (dx, dy), 'blocks', f['blocks'], 'splits', f.get('splits'), [(x['id'], x['acres']) for x in f['fields']], '%d KB' % (len(buf) // 1024))
        for fn in sorted(os.listdir(d)):
            if fn.endswith('.jpg') and fn != 'map.jpg':
                hashes.append('%s  farmmaps/%s/%s' % (hashlib.sha256(open(os.path.join(d, fn), 'rb').read()).hexdigest(), sid, fn))

    js = ('/* GENERATED by tools/build_farmmaps.py: illustrated maps of the 14 county points, drawn by the team\'s farm map\n'
          '   converter from USDA NAIP aerial photos or Sentinel-2, with the four simulation fields found on each. Do not hand-edit. */\n'
          'window.FS = window.FS || {};\nFS.data = FS.data || {};\nFS.data.farmMaps = ' + json.dumps(out, separators=(',', ':')) + ';\n')
    open(os.path.join(ROOT, 'src', 'farmmaps.js'), 'w', encoding='utf-8').write(js)
    hp = os.path.join(ROOT, 'raw', 'HASHES.txt')
    keep = [l for l in open(hp).read().splitlines() if ' farmmaps/' not in l]
    open(hp, 'w').write('\n'.join(keep + hashes) + '\n')
    print('wrote src/farmmaps.js, %d maps, %d KB' % (len(out), len(js) // 1024))


if __name__ == '__main__':
    main()
