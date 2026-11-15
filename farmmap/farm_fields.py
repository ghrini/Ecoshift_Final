#!/usr/bin/env python3
"""Draw the illustrated farm map AND find the four simulation fields on it.

Runs the team's converter (stylize_farm.py, unchanged) on an aerial photo, then cuts the farmland
into field blocks along what the converter detected as roads, tree lines, water and strong field edges,
and picks four blocks near the centre (the farm's point) as the simulator's four fields.

    python farm_fields.py photo.jpg --out-map map.jpg --out-json fields.json --width-km 1.6 [converter settings...]

fields.json: {"widthKm", "w", "h", "fields": [{"id", "poly": [[x, y], ...] (0-1 of the map), "acres",
"cx", "cy", "theta"}], "blocks": n}. Field ids are the simulator's north / creek / west / south, given by
position: the top block is north, the bottom one south, the left of the other two west, the last creek.
The last line printed is the same JSON summary without the polygons.
"""
import argparse
import io
import json
import math
import os
import sys
from contextlib import redirect_stdout

os.environ.setdefault("OPENCV_IO_MAX_IMAGE_PIXELS", "50000000")   # refuse giant images instead of using gigabytes of memory
import cv2
import numpy as np
from scipy import ndimage as ndi

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import stylize_farm  # noqa: E402  (the team's converter, unchanged)

ACRE_M2 = 4046.86


def run_converter(photo, out_png, settings):
    """Run stylize_farm exactly as its command line does, and keep what it detected."""
    got = {}
    real_render = stylize_farm.render

    def capture(img, cls, a):
        got.update(img=img, cls=cls, a=a)
        return real_render(img, cls, a)

    stylize_farm.render = capture
    old_argv = sys.argv
    sys.argv = ["stylize_farm.py", photo, "-o", out_png] + list(settings)
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            stylize_farm.main()
    finally:
        stylize_farm.render = real_render
        sys.argv = old_argv
    return got


def road_lines(img, mode="all"):
    """Straight, bright lines: gravel and paved roads, which in the Corn Belt run north-south and east-west.
    (The converter's own road finder often misses narrow gravel roads at this scale.)
    mode "all": bright grey ground in long straight runs; wide bright areas (dry grass, hay, lots) are caught too,
    which is fine when they are not crop fields. mode "thin": only narrow bright lines, for photos where bare,
    bright fields would otherwise be taken for roads."""
    h, w = img.shape[:2]
    hsv = cv2.cvtColor(img, cv2.COLOR_RGB2HSV)
    thin = ((hsv[..., 1] < 60) & (hsv[..., 2] > 150)).astype(np.uint8)
    if mode == "thin":
        wide = cv2.morphologyEx(thin, cv2.MORPH_OPEN, np.ones((15, 15), np.uint8))
        thin = thin & (1 - cv2.dilate(wide, stylize_farm.disk(2)))
    n = max(15, w // 25)
    lines = (cv2.morphologyEx(thin, cv2.MORPH_OPEN, np.ones((1, n), np.uint8)) |
             cv2.morphologyEx(thin, cv2.MORPH_OPEN, np.ones((n, 1), np.uint8)))
    return cv2.dilate(lines, stylize_farm.disk(2)).astype(bool)


def blocks_of(cls, h, w, img=None, wall_thr=0.85, roads="all"):
    """Farmland split into blocks by roads, trees, water and strong field edges (at the converter's working size)."""
    barrier = np.zeros((h, w), bool)
    for k in ("roads", "trees", "water"):
        m = cls.get(k)
        if isinstance(m, np.ndarray) and m.shape == (h, w):
            barrier |= m.astype(bool)
    walls = cls.get("walls")                     # edge strength between fields (0-1), not a mask
    if isinstance(walls, np.ndarray) and walls.shape == (h, w):
        barrier |= walls > wall_thr
    if img is not None and roads != "none":
        barrier |= road_lines(img, roads)
    for (c, sz, ang, kind) in cls.get("buildings", []):   # buildings: drawn boxes, not a mask
        cx, cy = int(c[0]), int(c[1])
        r = int(max(sz) if hasattr(sz, "__len__") else sz) + 3
        barrier[max(0, cy - r):cy + r, max(0, cx - r):cx + r] = True
    unit = max(h, w) / 1000.0
    barrier = cv2.dilate(barrier.astype(np.uint8), stylize_farm.disk(max(1, int(round(2 * unit))))).astype(bool)
    farm = ~barrier
    farm = cv2.morphologyEx(farm.astype(np.uint8), cv2.MORPH_OPEN, stylize_farm.disk(max(2, int(round(5 * unit))))).astype(bool)
    lab, n = ndi.label(farm)
    out = []
    for i in range(1, n + 1):
        m = lab == i
        m = ndi.binary_fill_holes(m)
        out.append(m)
    return out


def theta_of(mask, cls):
    """Row direction: the angle of the converter's striped parcel that covers most of this block."""
    best, area = 0.0, 0
    for p in cls.get("parcels", []):
        a = int((p["mask"] & mask).sum())
        if a > area and p.get("theta") is not None:
            best, area = float(p["theta"]), a
    return round(best, 3)


def split_largest(masks):
    """Cut the largest block in two along its longer side, so the simulator always gets four fields."""
    i = max(range(len(masks)), key=lambda k: masks[k].sum())
    m = masks.pop(i)
    ys, xs = np.nonzero(m)
    if (xs.max() - xs.min()) >= (ys.max() - ys.min()):
        cut = int(np.median(xs)); a, b = m.copy(), m.copy(); a[:, cut:] = False; b[:, :cut] = False
    else:
        cut = int(np.median(ys)); a, b = m.copy(), m.copy(); a[cut:, :] = False; b[:cut, :] = False
    masks += [a, b]
    return masks


def polygon(mask, w, h):
    cnts, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    c = max(cnts, key=cv2.contourArea)
    eps = 0.007 * max(w, h)          # smooth enough to look like a field outline, not a tree line
    c = cv2.approxPolyDP(c, eps, True).reshape(-1, 2)
    return [[round(float(x) / w, 4), round(float(y) / h, 4)] for x, y in c]


def fields_from(got, width_km=1.6, min_acres=8, strict=False):
    """The four simulation fields from what the converter detected. width_km=None (a farmer's own photo of unknown
    size): the shapes are still found, with acres left out."""
    cls, img = got["cls"], got["img"]
    h, w = img.shape[:2]
    mpp = (width_km or 1.6) * 1000.0 / w                # metres per working pixel
    acres = lambda m: float(m.sum()) * mpp * mpp / ACRE_M2

    floor = min_acres if width_km else 0.5 * min_acres
    # Try the road finder from strict to none and keep the cut that gives the most real fields (then the most farmland):
    # bright bare fields can be mistaken for roads, and some photos have no visible roads at all.
    # strict (the built-in county example farms): the photo must show at least three real field blocks with roads
    # or field edges between them; a town, or one huge unbroken block, is rejected so another spot can be tried.
    best = None
    for mode in (("all", "thin") if strict else ("all", "thin", "none")):
        bl = [m for m in blocks_of(cls, h, w, img, roads=mode) if acres(m) >= floor]
        key = (min(len(bl), 6), sum(acres(m) for m in bl))
        if best is None or key > best[0]:
            best = (key, bl)
        if len(bl) >= 4:
            break
    blocks = best[1]
    if strict and len(blocks) < 3:
        return None
    # four blocks near the farm's point (the centre): big and close wins
    cxy = lambda m: (float(np.nonzero(m)[1].mean()), float(np.nonzero(m)[0].mean()))
    def score(m):
        x, y = cxy(m)
        d = math.hypot(x - w / 2, y - h / 2) / max(w, h)
        return acres(m) / (1 + 6 * d * d)
    blocks.sort(key=score, reverse=True)
    chosen = blocks[:4]
    if not chosen:
        return None
    splits = 0
    while len(chosen) < 4:
        chosen = split_largest(chosen); splits += 1

    # simulator field ids by position: top = north, bottom = south, then left = west, the other = creek
    # by quadrant: the two upper blocks are north (left) and creek (right), the two lower ones west (left) and south (right)
    items = [dict(mask=m, cx=cxy(m)[0], cy=cxy(m)[1]) for m in chosen]
    items.sort(key=lambda d: d["cy"])
    top, bottom = sorted(items[:2], key=lambda d: d["cx"]), sorted(items[2:], key=lambda d: d["cx"])
    ids = [("north", top[0]), ("creek", top[1]), ("west", bottom[0]), ("south", bottom[1])]

    fields = []
    for fid, d in ids:
        fields.append(dict(id=fid, poly=polygon(d["mask"], w, h), acres=round(acres(d["mask"]), 1) if width_km else None,
                           cx=round(d["cx"] / w, 4), cy=round(d["cy"] / h, 4), theta=theta_of(d["mask"], cls)))
    return dict(widthKm=width_km, w=w, h=h, blocks=len(blocks), splits=splits, fields=fields)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("photo")
    ap.add_argument("--out-map", required=True, help="illustrated map (.png or .jpg)")
    ap.add_argument("--out-json", required=True)
    ap.add_argument("--width-km", type=float, default=1.6, help="ground width of the photo")
    ap.add_argument("--min-acres", type=float, default=8)
    ap.add_argument("--jpeg-quality", type=int, default=80)
    ap.add_argument("--strict", action="store_true", help="reject photos without at least three clear field blocks")
    a, settings = ap.parse_known_args()

    tmp_png = a.out_map + ".tmp.png"
    got = run_converter(a.photo, tmp_png, settings)
    if not got:
        print(json.dumps({"error": "The converter did not run."})); return
    res = fields_from(got, a.width_km, a.min_acres, a.strict)
    if not res:
        print(json.dumps({"error": "No farmland blocks were found in this photo."})); return

    out = cv2.imread(tmp_png, cv2.IMREAD_COLOR)
    if a.out_map.lower().endswith((".jpg", ".jpeg")):
        cv2.imwrite(a.out_map, out, [cv2.IMWRITE_JPEG_QUALITY, a.jpeg_quality])
    else:
        cv2.imwrite(a.out_map, out)
    os.remove(tmp_png)
    with open(a.out_json, "w") as f:
        json.dump(res, f)
    print(json.dumps(dict(widthKm=res["widthKm"], blocks=res["blocks"], splits=res["splits"], fields=[{k: v for k, v in x.items() if k != "poly"} for x in res["fields"]])))


if __name__ == "__main__":
    main()
