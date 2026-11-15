#!/usr/bin/env python3
"""Pick the sharper of several aerial images of the same farm and turn it into an illustrated map.

Used by the EcoShifters server (farmmap.js). Each candidate is NAME=PATH; NAME chooses the converter
settings (usgs: 0.6-1 m aerial photo, s2: 10 m satellite, upload: the farmer's own photo).

    python make_map.py --out-map map.png --out-photo photo.jpg usgs=a.jpg s2=b.jpg

The last line printed is JSON: {"source": ..., "scores": {...}, "fields": n}.
Sharpness is the variance of the Laplacian at a common 500 px size; an image that is nearly flat
(no imagery there, only a blurred background) is skipped.
"""
import argparse
import json
import os
import sys

# refuse huge images (a tiny PNG can claim 30000 x 30000 pixels): must be set before cv2 is imported
os.environ.setdefault("OPENCV_IO_MAX_IMAGE_PIXELS", "50000000")

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import stylize_farm  # noqa: E402  (the team's converter, unchanged)

# converter settings per source, tuned on Iowa (USGS and Sentinel-2), France and India (Sentinel-2)
SETTINGS = {
    "usgs": ["--max-dim", "700", "--scale", "2", "--tree-size", "11", "--min-tree", "20"],
    # 10 m pixels: work at the real detail (about 320 px for 1.6 km) and keep fields big, or they break into blobs
    "s2": ["--max-dim", "320", "--scale", "3", "--wall-strength", "0.95", "--merge", "45", "--min-parcel", "0.003",
           "--smooth", "5", "--tree-size", "6", "--min-tree", "10", "--no-buildings"],
    "upload": ["--max-dim", "800", "--scale", "2"],
}


def sharpness(img):
    g = cv2.cvtColor(cv2.resize(img, (500, 500), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
    if g.std() < 8:            # flat: nothing there
        return 0.0
    return float(cv2.Laplacian(g, cv2.CV_64F).var())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-map", required=True)
    ap.add_argument("--out-photo", required=True)
    ap.add_argument("--width-km", type=float, default=1.6, help="ground width of the downloaded square")
    ap.add_argument("candidates", nargs="+", help="NAME=PATH")
    a = ap.parse_args()

    scores, imgs = {}, {}
    too_big = False
    for c in a.candidates:
        name, _, p = c.partition("=")
        try:
            img = cv2.imread(p, cv2.IMREAD_COLOR)
        except Exception:      # cv2.error, or out of memory
            img = None
            too_big = True
        if img is None or min(img.shape[:2]) < 64:
            scores[name] = None
            continue
        imgs[name] = (p, img)
        scores[name] = round(sharpness(img), 1)
    ok = {k: v for k, v in scores.items() if v}
    if not ok:
        if too_big:
            print(json.dumps({"error": "That photo is too large to process. Use one under about 50 megapixels (for example 7000 x 7000) and try again.", "scores": scores}))
            return 2
        print(json.dumps({"error": "No usable aerial image for this spot.", "scores": scores}))
        return 2
    best = max(ok, key=ok.get)
    src, img = imgs[best]

    h, w = img.shape[:2]
    f = 1000 / max(h, w)
    photo = cv2.resize(img, (round(w * f), round(h * f)), interpolation=cv2.INTER_AREA) if f < 1 else img
    cv2.imwrite(a.out_photo, photo, [cv2.IMWRITE_JPEG_QUALITY, 85])

    # Draw the map with the converter (unchanged) and find the simulator's four fields on it (farm_fields.py).
    # A farmer's own photo has no known size, so its fields come without acres.
    import farm_fields  # noqa: E402
    got = farm_fields.run_converter(src, a.out_map, SETTINGS.get(best, SETTINGS["upload"]))
    width_km = None if best == "upload" else a.width_km
    fields = None
    try:
        res = farm_fields.fields_from(got, width_km) if got else None
        fields = res["fields"] if res else None
    except Exception as e:  # the map still works without the fields
        print("fields:", e, file=sys.stderr)
    print(json.dumps({"source": best, "scores": scores, "fields": fields, "widthKm": width_km}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
