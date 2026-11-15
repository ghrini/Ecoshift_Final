#!/usr/bin/env python3
"""
Ask a Gemini vision model (free tier works) to outline the fields, roads,
water, tree areas and buildings in an aerial photo.

    GEMINI_API_KEY=... python3 gemini_segment.py photo.png   # -> photo_seg.json + photo_seg.png

Writes the raw answer (JSON with one mask per object) and an overlay image.
"""
import argparse
import base64
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request

import cv2
import numpy as np

API = "https://generativelanguage.googleapis.com/v1beta"
FALLBACKS = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.5-flash", "gemini-flash-latest"]
LABELS = ["field", "bare_soil", "grass", "trees", "road", "water", "building"]

PROMPT = f"""This is a top-down aerial photo of countryside.
Trace the map of this image as vector shapes.

- Every individual agricultural field / plot: one polygon per field, following
  the paths, bunds or hedges that separate it from its neighbours. Include ALL
  fields, even small ones (there may be 100 or more).
- Every patch of trees or forest, every water body, every building: polygons.
- Every road, track or path: a polyline ("line") plus its width.

Use labels: {", ".join(LABELS)}.
Coordinates are [y, x], normalised to 0-1000 (0,0 = top-left).
Output ONLY JSON, a list of objects like
{{"label": "field", "points": [[y, x], [y, x], ...]}} or
{{"label": "road", "line": [[y, x], ...], "width": 6}}"""


def call(model, body, key, tries=4):
    """POST with retries on 'busy' (503) and rate-limit (429) answers."""
    for attempt in range(tries):
        req = urllib.request.Request(f"{API}/models/{model}:generateContent", method="POST")
        req.add_header("x-goog-api-key", key or "proxy-injects-key")
        req.add_header("Content-Type", "application/json")
        req.data = json.dumps(body).encode()
        try:
            with urllib.request.urlopen(req, timeout=600) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            msg = e.read().decode()[:600]
            if e.code in (429, 500, 503) and attempt < tries - 1 and "limit: 0" not in msg:
                wait = 10 * 2 ** attempt
                print(f"  {model}: HTTP {e.code}, retrying in {wait}s", file=sys.stderr)
                time.sleep(wait)
                continue
            raise RuntimeError(f"HTTP {e.code}: {msg}")


def segment(path, model, key, max_dim=1024):
    img = cv2.imread(str(path))
    h, w = img.shape[:2]
    s = min(1.0, max_dim / max(h, w))
    small = cv2.resize(img, (round(w * s), round(h * s)), interpolation=cv2.INTER_AREA)
    ok, png = cv2.imencode(".png", small)
    body = {
        "contents": [{"parts": [
            {"inline_data": {"mime_type": "image/png",
                             "data": base64.b64encode(png.tobytes()).decode()}},
            {"text": PROMPT}]}],
        "generationConfig": {"responseMimeType": "application/json", "temperature": 0.3},
    }
    if model.startswith("gemini-2.5"):
        body["generationConfig"]["thinkingConfig"] = {"thinkingBudget": 0}
    resp = call(model, body, key)
    text = "".join(p.get("text", "") for p in
                   resp["candidates"][0]["content"]["parts"])
    return json.loads(text), (h, w)


def to_masks(items, shape):
    """Polygons / polylines (0-1000 coords) -> full-size boolean masks."""
    h, w = shape
    if items and "mask" not in items[0]:
        out = []
        for it in items:
            m = np.zeros((h, w), np.uint8)
            pts = it.get("points") or it.get("line") or []
            try:
                xy = np.int32([[x / 1000 * w, y / 1000 * h] for y, x in pts])
            except (TypeError, ValueError):
                continue
            if len(xy) < 2:
                continue
            if "line" in it or (it.get("label") == "road" and "points" not in it):
                width = max(2, int(float(it.get("width", 6)) / 1000 * max(h, w)))
                cv2.polylines(m, [xy], False, 1, width)
            else:
                cv2.fillPoly(m, [xy], 1)
            if m.any():
                out.append((it.get("label", "field"), m.astype(bool)))
        return out
    return to_masks_png(items, shape)


def to_masks_png(items, shape):
    """Decode Gemini's per-object masks into full-size boolean masks."""
    h, w = shape
    out = []
    for it in items:
        try:
            y0, x0, y1, x1 = it["box_2d"]
            y0, y1 = int(y0 / 1000 * h), int(y1 / 1000 * h)
            x0, x1 = int(x0 / 1000 * w), int(x1 / 1000 * w)
            if y1 <= y0 or x1 <= x0:
                continue
            b64 = it["mask"].split(",", 1)[-1]
            m = cv2.imdecode(np.frombuffer(base64.b64decode(b64), np.uint8),
                             cv2.IMREAD_GRAYSCALE)
            m = cv2.resize(m, (x1 - x0, y1 - y0), interpolation=cv2.INTER_LINEAR)
            full = np.zeros((h, w), bool)
            full[y0:y1, x0:x1] = m > 127
            if full.any():
                out.append((it.get("label", "field"), full))
        except Exception as e:
            print("skip:", e, file=sys.stderr)
    return out


COLORS = {"field": (60, 200, 60), "bare_soil": (40, 120, 210), "grass": (120, 230, 140),
          "trees": (20, 90, 20), "road": (200, 200, 200), "water": (220, 120, 0),
          "building": (40, 40, 220)}


def overlay(path, masks):
    img = cv2.imread(str(path)).astype(np.float32)
    rng = np.random.default_rng(1)
    for label, m in masks:
        c = np.array(COLORS.get(label, (255, 0, 255)), np.float32)
        c = np.clip(c + rng.integers(-40, 40, 3), 0, 255)       # tell neighbours apart
        img[m] = img[m] * 0.45 + c * 0.55
        cnts, _ = cv2.findContours(m.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(img, cnts, -1, (255, 255, 255), 1)
    return img.astype(np.uint8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("--model", default="gemini-3.8-flash")
    a = ap.parse_args()
    key = os.environ.get("GEMINI_API_KEY")
    for model in [a.model] + [m for m in FALLBACKS if m != a.model]:
        try:
            items, shape = segment(a.input, model, key)
            print(f"model: {model}", file=sys.stderr)
            break
        except (RuntimeError, json.JSONDecodeError, KeyError) as e:
            print(f"  {model} failed: {str(e)[:200]}", file=sys.stderr)
    else:
        raise SystemExit("all models failed")
    stem = a.input.rsplit(".", 1)[0]
    pathlib.Path(stem + "_seg.json").write_text(json.dumps(items))
    masks = to_masks(items, shape)
    cv2.imwrite(stem + "_seg.png", overlay(a.input, masks))
    labels = {}
    for l, _ in masks:
        labels[l] = labels.get(l, 0) + 1
    print(f"{len(masks)} objects: {labels}")


if __name__ == "__main__":
    main()
