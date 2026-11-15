#!/usr/bin/env python3
"""
Restyle an aerial photo into the flat illustrated map style with a Gemini
image model (Google AI Studio API key).

    python3 gemini_stylize.py photo.png                 # -> photo_gemini.png
    python3 gemini_stylize.py photo.png --list-models   # show image models
    python3 gemini_stylize.py photo.png --model gemini-2.5-flash-image

The key is read from GEMINI_API_KEY.
A style example image is sent along with the photo; by default that is
style_example.png next to this script, an illustration made by stylize_farm.py.
"""
import argparse
import base64
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request

API = "https://generativelanguage.googleapis.com/v1beta"
HERE = pathlib.Path(__file__).resolve().parent

PROMPT = """You are given two images.
Image 1 is a top-down aerial / satellite photo.
Image 2 is a STYLE EXAMPLE only (do not copy its layout).

Redraw image 1 as a flat, vector-style illustrated map in the style of image 2.

Keep the geography of image 1 exactly: every field, path, road, river, pond,
tree, tree cluster and building stays in the same place with the same shape,
size and orientation. Same framing and aspect ratio, straight top-down view.

Style rules:
- Flat colour fills only. No photo texture, noise, gradients on land, or 3D.
- Crop fields: parallel stripes in two close tones, stripes running the same
  direction as the crop rows in the photo. Bare/ploughed soil in tan or
  terracotta stripes or flat fill, matching the photo's soil colour family.
- Grass / pasture: flat light or medium green. Dry grass: flat straw yellow.
- Trees: round dark olive-green blobs (a cluster of overlapping circles for a
  big crown), each with a soft darker shadow offset to one side. Forests are
  many such blobs packed together.
- Water: blue with a thin tan bank outline.
- Roads: light grey with a thin darker edge; a thin yellow centre line only on
  real roads. Dirt tracks: thin tan lines.
- Buildings: simple rectangles with a two-tone gabled roof (light half / dark
  half) in the roof's real colour family (red, grey or cream).
- Thin darker-green strips between neighbouring fields.
- No text, labels, logos, borders or watermarks.
"""


def call(path, body=None, key=None):
    req = urllib.request.Request(API + path, method="POST" if body else "GET")
    # A real key from the environment, or a placeholder the proxy replaces.
    req.add_header("x-goog-api-key", key or "proxy-injects-key")
    if body is not None:
        req.add_header("Content-Type", "application/json")
        req.data = json.dumps(body).encode()
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise SystemExit(f"HTTP {e.code}: {e.read().decode()[:800]}")


def image_models(key):
    out = []
    for m in call("/models?pageSize=200", key=key).get("models", []):
        name = m["name"].split("/", 1)[1]
        if "image" in name and "generateContent" in m.get("supportedGenerationMethods", []):
            out.append(name)
    return out


def part(path):
    data = pathlib.Path(path).read_bytes()
    mime = "image/png" if str(path).lower().endswith(".png") else "image/jpeg"
    return {"inline_data": {"mime_type": mime, "data": base64.b64encode(data).decode()}}


def aspect(path):
    try:
        import cv2
        h, w = cv2.imread(str(path)).shape[:2]
    except Exception:
        return None
    options = {"1:1": 1, "4:3": 4 / 3, "3:4": 3 / 4, "16:9": 16 / 9, "9:16": 9 / 16,
               "3:2": 1.5, "2:3": 2 / 3, "5:4": 1.25, "4:5": 0.8}
    return min(options, key=lambda k: abs(options[k] - w / h))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input")
    ap.add_argument("-o", "--output")
    ap.add_argument("--model", help="default: best image model the key can use")
    ap.add_argument("--style", default=str(HERE / "style_example.png"))
    ap.add_argument("--list-models", action="store_true")
    a = ap.parse_args()
    key = os.environ.get("GEMINI_API_KEY")

    models = image_models(key)
    if a.list_models:
        print("\n".join(models) or "no image models available to this key")
        return
    model = a.model
    if not model:
        prefs = [m for m in models if "pro" in m] + [m for m in models if "flash" in m]
        model = (prefs or models or [None])[0]
        if not model:
            raise SystemExit("no image-generation model is available to this key")
    print(f"model: {model}", file=sys.stderr)

    parts = [{"text": PROMPT}, part(a.input)]
    if a.style and pathlib.Path(a.style).exists():
        parts.append(part(a.style))
    config = {"responseModalities": ["TEXT", "IMAGE"]}
    ar = aspect(a.input)
    body = {"contents": [{"parts": parts}],
            "generationConfig": dict(config, imageConfig={"aspectRatio": ar}) if ar else config}
    try:
        resp = call(f"/models/{model}:generateContent", body, key)
    except SystemExit as e:                     # older models: no imageConfig
        if "imageConfig" not in str(e) and "aspect" not in str(e).lower():
            raise
        body["generationConfig"] = config
        resp = call(f"/models/{model}:generateContent", body, key)

    for cand in resp.get("candidates", []):
        for p in cand.get("content", {}).get("parts", []):
            blob = p.get("inline_data") or p.get("inlineData")
            if blob:
                dst = a.output or a.input.rsplit(".", 1)[0] + "_gemini.png"
                pathlib.Path(dst).write_bytes(base64.b64decode(blob["data"]))
                print(f"wrote {dst}")
                return
            if p.get("text"):
                print(p["text"], file=sys.stderr)
    raise SystemExit("no image in response: " + json.dumps(resp)[:600])


if __name__ == "__main__":
    main()
