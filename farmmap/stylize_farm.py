#!/usr/bin/env python3
"""
Turn an aerial / satellite photo of farmland into a flat, illustrated map:
striped crop fields, round cartoon trees with shadows, a blue river with a
tan bank, grey roads with a yellow centre line and two-tone roofs.

    python3 stylize_farm.py my_farm.png -o my_farm_illustrated.png
    python3 stylize_farm.py my_farm.png --debug      # also writes a mask overlay

Every threshold is a command-line option, because satellite photos differ a
lot in colour and brightness. Run with --debug and look at *_masks.png to see
what was detected as water / trees / roads / buildings, then adjust.
"""
import argparse
import math
import warnings

import cv2
import numpy as np
from scipy import ndimage as ndi
from skimage.segmentation import felzenszwalb
from skimage.morphology import skeletonize
from skimage.filters import threshold_multiotsu, sato
from skimage.morphology import h_minima
from skimage.segmentation import watershed

# Colours sampled from the reference illustration (RGB).
PAL = {
    "base":        (104, 134, 56),    # strips between fields
    "grass":       (155, 181, 79),
    "grass_mid":   (126, 158, 66),
    "grass_dark":  (92, 120, 46),
    "crop_yellow": ((194, 206, 98), (163, 180, 76)),   # (stripe A, stripe B)
    "crop_green":  ((142, 168, 72), (118, 146, 58)),
    "crop_dark":   ((110, 140, 56), (90, 118, 46)),
    "soil":        ((200, 168, 108), (174, 142, 88)),
    "dry":         ((230, 210, 144), (210, 188, 122)),
    "dry_flat":    (222, 200, 134),
    "water_light": (64, 168, 204),
    "water_dark":  (28, 90, 160),
    "bank":        (184, 146, 70),
    "road":        (186, 188, 196),
    "road_edge":   (138, 140, 150),
    "road_line":   (236, 208, 76),
    "roof_red":    ((166, 30, 40), (98, 12, 18)),
    "roof_light":  ((234, 240, 206), (178, 184, 152)),
    "roof_grey":   ((206, 208, 212), (150, 152, 160)),
    "tree":        (90, 110, 44),
    "tree_dark":   (66, 84, 32),
}

def field_style(L, A, B):
    """Pick an illustrated style from a field's average colour (OpenCV Lab,
    a/b centred on 128). Greenish -> grass/crop, otherwise dry grass/soil."""
    a, b = A - 128, B - 128
    if a < -6:                                  # green vegetation
        if L > 175 or (b > 38 and L > 160):
            return "crop_yellow"
        return "crop_dark" if L < 105 else "crop_green"
    return "dry" if L >= 165 else "soil"


FLAT_FOR = {"crop_yellow": "grass", "crop_green": "grass_mid",
            "crop_dark": "grass_dark", "soil": "soil", "dry": "dry_flat"}


# ----------------------------------------------------------------- helpers
def disk(r):
    r = max(1, int(round(r)))
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))


def clean(mask, open_r=0, close_r=0, min_area=0, max_hole=0):
    m = mask.astype(np.uint8)
    if open_r:
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, disk(open_r))
    if close_r:
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, disk(close_r))
    m = m.astype(bool)
    if min_area:
        lab, n = ndi.label(m)
        if n:
            sizes = ndi.sum(m, lab, range(1, n + 1))
            m = np.isin(lab, 1 + np.flatnonzero(sizes >= min_area))
    if max_hole:
        holes = ~m
        lab, n = ndi.label(holes)
        if n:
            sizes = ndi.sum(holes, lab, range(1, n + 1))
            m |= np.isin(lab, 1 + np.flatnonzero(sizes < max_hole))
    return m


def prune_spurs(sk, n):
    """Remove skeleton branches shorter than n px by eating end-points."""
    sk = sk.astype(np.uint8).copy()
    k = np.ones((3, 3), np.float32)
    for _ in range(int(n)):
        nb = cv2.filter2D(sk, -1, k, borderType=cv2.BORDER_CONSTANT) - sk
        ends = (sk == 1) & (nb <= 1)
        if not ends.any():
            break
        sk[ends] = 0
    return sk.astype(bool)


def lab_of(rgb):
    px = np.uint8([[list(rgb)]])
    return cv2.cvtColor(px, cv2.COLOR_RGB2LAB)[0, 0].astype(np.float32)


class Canvas:
    """Float RGB canvas at output resolution with soft-mask compositing."""

    def __init__(self, h, w, scale, color):
        self.h, self.w, self.scale = h, w, scale
        self.img = np.empty((h, w, 3), np.float32)
        self.img[:] = color

    def soft(self, mask, smooth_px):
        """Upscale a working-res bool mask, round its outline, anti-alias."""
        m = cv2.resize(mask.astype(np.float32), (self.w, self.h),
                       interpolation=cv2.INTER_LINEAR)
        s = max(smooth_px, 0.8)
        m = cv2.GaussianBlur(m, (0, 0), s)
        k = 1.4 / (s * 2.5)                       # ~1.5 px anti-alias band
        return np.clip((m - 0.5) / k + 0.5, 0, 1)

    def over(self, alpha, color, opacity=1.0):
        a = (alpha * opacity)[..., None]
        c = np.asarray(color, np.float32)
        self.img = self.img * (1 - a) + c * a

    def u8(self):
        return np.clip(self.img + 0.5, 0, 255).astype(np.uint8)


def merge_similar(seg, feats, valid, thr, walls=None, wall_thr=1.0):
    """Greedily merge touching segments whose mean features are close,
    unless the boundary between them is a strong wall (bund, path, edge)."""
    seg = seg.astype(np.int64)
    n = int(seg.max()) + 1
    flat = seg[valid]
    cnt = np.bincount(flat, minlength=n).astype(np.float64)
    mean = np.stack([np.bincount(flat, feats[valid][:, c], minlength=n)
                     for c in range(feats.shape[2])], 1) / np.maximum(cnt, 1)[:, None]
    keys, wv, ok = [], [], []
    W = walls if walls is not None else np.zeros(seg.shape, np.float32)
    V = valid
    for A, B, WA, WB, VA, VB in (
            (seg[:, :-1], seg[:, 1:], W[:, :-1], W[:, 1:], V[:, :-1], V[:, 1:]),
            (seg[:-1, :], seg[1:, :], W[:-1, :], W[1:, :], V[:-1, :], V[1:, :])):
        d = A != B
        lo, hi = np.minimum(A[d], B[d]), np.maximum(A[d], B[d])
        keys.append(lo * n + hi)
        wv.append(np.maximum(WA[d], WB[d]))
        ok.append(VA[d] & VB[d])           # only open ground counts as evidence
    keys, wv, ok = np.concatenate(keys), np.concatenate(wv), np.concatenate(ok)
    uniq, inv = np.unique(keys, return_inverse=True)
    wall_mean = (np.bincount(inv, wv * ok, minlength=len(uniq)) /
                 np.maximum(np.bincount(inv, ok.astype(np.float64), minlength=len(uniq)), 1))
    pairs = [(int(k // n), int(k % n), wm) for k, wm in zip(uniq, wall_mean)]
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i, j, wm in sorted(pairs, key=lambda p: np.linalg.norm(mean[p[0]] - mean[p[1]])):
        if wm > wall_thr:
            continue
        ri, rj = find(i), find(j)
        if ri == rj or not (cnt[ri] and cnt[rj]):
            continue
        if np.linalg.norm(mean[ri] - mean[rj]) < thr:
            tot = cnt[ri] + cnt[rj]
            mean[ri] = (mean[ri] * cnt[ri] + mean[rj] * cnt[rj]) / tot
            cnt[ri], parent[rj] = tot, ri
    roots = np.array([find(i) for i in range(n)])
    return roots[seg]


def field_walls(img_lab, L, unit, rows_feat, rows_scale=80.0):
    """0..1 map of likely field edges: colour steps between fields plus thin
    isolated lines (bunds, paths, hedges). Crop rows are repeated lines, so
    they are suppressed: a line only counts if its surroundings are plain."""
    lab_s = cv2.GaussianBlur(img_lab, (0, 0), 3 * unit)
    g = np.zeros(L.shape, np.float32)
    for c, wgt in ((0, 1.0), (1, 2.0), (2, 2.0)):
        gx = cv2.Sobel(lab_s[..., c], cv2.CV_32F, 1, 0, ksize=3)
        gy = cv2.Sobel(lab_s[..., c], cv2.CV_32F, 0, 1, ksize=3)
        g += wgt * (gx * gx + gy * gy)
    grad = np.sqrt(g) / 120.0           # fixed scale: same meaning in every photo
    Ln = cv2.GaussianBlur(L, (0, 0), 0.7) / 255.0
    sig = [max(1.0, unit), max(1.5, 2 * unit)]
    ridge = np.maximum(sato(Ln, sigmas=sig, black_ridges=False),
                       sato(Ln, sigmas=sig, black_ridges=True)).astype(np.float32)
    iso = np.clip(ridge - 2 * cv2.GaussianBlur(ridge, (0, 0), 8 * unit), 0, None)
    iso /= 0.012
    # edges between "has crop rows" and "plain" (or rows in another direction)
    rf = cv2.GaussianBlur(rows_feat, (0, 0), 3 * unit)
    gr = np.zeros(L.shape, np.float32)
    for c in range(rf.shape[2]):
        gx = cv2.Sobel(rf[..., c], cv2.CV_32F, 1, 0, ksize=3)
        gy = cv2.Sobel(rf[..., c], cv2.CV_32F, 0, 1, ksize=3)
        gr += gx * gx + gy * gy
    rows_edge = np.sqrt(gr) / rows_scale
    return np.clip(np.maximum.reduce([grad, iso, rows_edge]), 0, 1)


# ----------------------------------------------------------- 1. classify
def auto_levels(img, lo=0.5, hi=99.5):
    """Per-channel black/white point. Removes the blue haze satellite photos
    often have (it lifts the blue channel most in the dark areas)."""
    blacks = [np.percentile(img[..., c], lo) for c in range(3)]
    if blacks[2] - min(blacks[0], blacks[1]) < 25:
        return img                      # shadows aren't blue: leave colours
    out = np.empty_like(img)
    for c in range(3):
        a_, b_ = np.percentile(img[..., c], [lo, hi])
        out[..., c] = np.clip((img[..., c].astype(np.float32) - a_) * 255.0 /
                              max(b_ - a_, 1.0), 0, 255)
    return out


def classify(img, a):
    h, w = img.shape[:2]
    area = h * w
    unit = max(h, w) / 1000.0                     # thresholds scale with size
    if not a.no_levels:
        img = auto_levels(img)
    rgb = img.astype(np.float32)
    R, G, B = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    img_lab = cv2.cvtColor(img, cv2.COLOR_RGB2LAB).astype(np.float32)
    L = img_lab[..., 0]
    hsv = cv2.cvtColor(img, cv2.COLOR_RGB2HSV)
    H, S = hsv[..., 0].astype(np.int32), hsv[..., 1].astype(np.float32)

    Lb = cv2.GaussianBlur(L, (0, 0), 1.0)
    mu = cv2.blur(Lb, (9, 9))
    tex = np.sqrt(np.maximum(cv2.blur(Lb * Lb, (9, 9)) - mu * mu, 0))
    Ls = cv2.GaussianBlur(L, (0, 0), 1.5)
    texs = cv2.GaussianBlur(tex, (0, 0), 2 * unit)
    smooth = texs < a.smooth_tex

    # "Dark" = darker half of the photo (Otsu split) unless set by hand.
    if a.tree_dark > 0:
        dark_t = a.tree_dark
    else:
        # three brightness groups (trees+shadows / grass / bright ground):
        # "dark" is the lowest group
        dark_t = float(np.clip(threshold_multiotsu(Ls[::2, ::2], classes=3)[0], 60, 125))
    dark = Ls < dark_t
    if a.verbose:
        print(f"  dark threshold L<{dark_t:.0f}")

    # Built-up: smooth grey / white surfaces and red roofs.
    grey = (S < a.grey_sat) & (L > a.grey_light)
    red = ((H <= 8) | (H >= 168)) & (S > 90) & (L > 30)
    built = clean(grey | red, 1, 2 * unit, min_area=a.min_building * unit ** 2)

    # Dark + leafy texture = tree canopy.  Dark + smooth = shadow or water.
    flat_dark = clean(dark & smooth & ~built, 2 * unit, 3 * unit)
    # (the opening also removes the thin "textured" rim every dark area has)
    trees = clean(dark & ~flat_dark & ~built & ~(R > G + 15), 3.5 * unit, 3 * unit,
                  min_area=a.min_tree * unit ** 2, max_hole=80 * unit ** 2)

    # Water vs shadow: a shadow hangs off a tree, so much of its edge touches
    # canopy. Water is a big smooth area mostly bordered by open ground.
    blue = (B > R + a.water_blue) & (B >= G - 4) & (L < 190) & smooth
    not_green = B >= G - 8                       # grass/leaves are never water
    cand = clean((flat_dark & not_green) | (blue & ~built), 3 * unit, 6 * unit,
                 min_area=area * 0.004)
    tree_zone = cv2.dilate(trees.astype(np.uint8), disk(3 * unit)).astype(bool)
    water = np.zeros_like(cand)
    lab, n = ndi.label(cand)
    for i in range(1, n + 1):
        comp = lab == i
        ring = cv2.dilate(comp.astype(np.uint8), disk(2 * unit)).astype(bool) & ~comp
        contact = (ring & tree_zone).sum() / max(ring.sum(), 1)
        frac = comp.sum() / area
        if a.verbose:
            print(f"  water? area={frac:.3f} tree-contact={contact:.2f}")
        if contact < a.shadow_contact or frac > a.big_water:
            water |= comp
    if a.no_water:
        water[:] = False
    water = clean(water, 0, 0, max_hole=area * 0.002)
    shadows = flat_dark & ~water
    built &= ~water

    # Small-window texture: pavement and roofs are smooth inside.
    mu5 = cv2.blur(Lb, (5, 5))
    tex5 = np.sqrt(np.maximum(cv2.blur(Lb * Lb, (5, 5)) - mu5 * mu5, 0))

    def padded(sl, p=6):
        return (slice(max(sl[0].start - p, 0), sl[0].stop + p),
                slice(max(sl[1].start - p, 0), sl[1].stop + p))

    # Paved = grey/red areas that are smooth inside (grass and dirt aren't).
    paved = np.zeros_like(built)
    lab, n = ndi.label(built)
    for i, sl in enumerate(ndi.find_objects(lab), 1):
        comp = lab[sl] == i
        if np.median(tex5[sl][comp]) <= a.smooth_tex:
            paved[sl] |= comp

    # Roads: cut away areas too wide to be a road (yards, plazas, roofs),
    # then keep pieces that are long, thin and steady in width.
    half = a.road_width * unit / 2
    blobs = cv2.morphologyEx(paved.astype(np.uint8), cv2.MORPH_OPEN, disk(half + 1))
    net = paved & ~cv2.dilate(blobs, disk(3)).astype(bool)
    net = clean(net, 1, 0, min_area=a.min_building * unit ** 2)
    roads = np.zeros_like(built)
    lab, n = ndi.label(net)
    for i, sl in enumerate(ndi.find_objects(lab), 1):
        sl = padded(sl)
        comp = lab[sl] == i
        n_px = int(comp.sum())
        sk = skeletonize(comp)
        thick = n_px / max(int(sk.sum()), 1)
        core_sk = prune_spurs(sk, 2 * thick)          # drop side branches
        core = int(core_sk.sum())
        dist = cv2.distanceTransform(comp.astype(np.uint8), cv2.DIST_L2, 5)[core_sk]
        width_cv = float(dist.std() / max(dist.mean(), 1e-3)) if core else 9.0
        ok = (core > a.road_length * thick and core * thick > 0.6 * n_px
              and width_cv < a.road_cv)
        if a.verbose and n_px > 300:
            print(f"  road? px={n_px} thick={thick:.1f} core={core} "
                  f"line={core * thick / n_px:.2f} width_cv={width_cv:.2f} -> {ok}")
        if ok:
            roads[sl] |= comp
    roads = clean(roads, 2 * unit, 4 * unit, max_hole=400 * unit ** 2)

    # Buildings: what's left of the paved areas, if it's a crisp rectangle.
    buildings = []
    rest = paved & ~cv2.dilate(roads.astype(np.uint8), disk(2)).astype(bool)
    lab, n = ndi.label(clean(rest, 1, 0, min_area=a.min_building * unit ** 2))
    for i, sl in enumerate(ndi.find_objects(lab), 1):
        sl = padded(sl)
        comp = lab[sl] == i
        n_px = int(comp.sum())
        cnts, _ = cv2.findContours(comp.astype(np.uint8), cv2.RETR_EXTERNAL,
                                   cv2.CHAIN_APPROX_SIMPLE)
        (cx, cy), (bw, bh), ang = cv2.minAreaRect(max(cnts, key=cv2.contourArea))
        fill = n_px / max(bw * bh, 1)
        u8 = comp.astype(np.uint8)
        ring = cv2.dilate(u8, disk(4)).astype(bool) & ~cv2.dilate(u8, disk(1)).astype(bool)
        contrast = (float(np.linalg.norm(img_lab[sl][comp].mean(0) -
                                         np.median(img_lab[sl][ring], axis=0)))
                    if ring.any() else 0.0)
        ok = (n_px < a.max_building * area and not a.no_buildings
              and min(bw, bh) > 0.25 * max(bw, bh)
              and (fill > a.building_fill or (fill > 0.7 and contrast > 2 * a.building_contrast))
              and contrast > a.building_contrast)
        if a.verbose and n_px > 300:
            print(f"  building? at ({cx + sl[1].start:.0f},{cy + sl[0].start:.0f}) px={n_px} "
                  f"fill={fill:.2f} contrast={contrast:.0f} -> {ok}")
        if ok:
            mean = img[sl][comp].mean(axis=0)
            if mean[0] > mean[1] + 35:
                kind = "roof_red"
            elif mean.mean() > 175:
                kind = "roof_light"
            else:
                kind = "roof_grey"
            buildings.append(((cx + sl[1].start, cy + sl[0].start),
                              (bw, bh), ang, kind))
    road_thick = roads.sum() / max(int(skeletonize(roads).sum()), 1) if roads.any() else 0
    bmask = np.zeros_like(built)
    for (c, sz, ang, _) in buildings:
        box = cv2.boxPoints((c, (sz[0] + 4, sz[1] + 4), ang)).astype(np.int32)
        cv2.fillPoly(bmask.view(np.uint8), [box], 1)

    # Crop rows = fine texture that points the same way almost everywhere.
    hp = Lb - cv2.GaussianBlur(Lb, (0, 0), 6 * unit)
    gx = cv2.Sobel(hp, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(hp, cv2.CV_32F, 0, 1, ksize=3)
    win = 6 * unit
    Jxx = cv2.GaussianBlur(gx * gx, (0, 0), win)
    Jyy = cv2.GaussianBlur(gy * gy, (0, 0), win)
    Jxy = cv2.GaussianBlur(gx * gy, (0, 0), win)
    E = Jxx + Jyy + 1e-3
    local_coh = np.sqrt((Jxx - Jyy) ** 2 + 4 * Jxy ** 2) / E

    # Fields: split the rest into parcels using colour (blurred so rows don't
    # cut a field into strips) plus row direction (so a crop field separates
    # from grass of the same colour).
    bank_zone = cv2.dilate(water.astype(np.uint8), disk(a.bank + 4 * unit)).astype(bool)
    blocked = bank_zone | trees | roads | bmask
    lab_blur = cv2.cvtColor(cv2.GaussianBlur(img, (0, 0), a.seg_blur * unit),
                            cv2.COLOR_RGB2LAB).astype(np.float32)
    rows_feat = np.dstack([(Jxx - Jyy) / E, 2 * Jxy / E]) * a.row_weight
    feats = np.dstack([lab_blur, cv2.GaussianBlur(rows_feat, (0, 0), 2 * unit)])
    if a.fields == "felz":                               # older method
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            seg = felzenszwalb(feats, scale=a.seg_scale, sigma=0.8,
                               min_size=int(area * 0.0015), channel_axis=-1)
        seg = merge_similar(seg, feats, ~blocked, a.merge)
        walls = None
    else:
        # Every basin between walls is a candidate field; then neighbours
        # that look alike AND have no wall between them are joined.
        walls = field_walls(img_lab, L, unit, rows_feat, a.rows_edge)
        # Trees/roads/water are solid barriers while forming areas (no leaks),
        # but merge_similar ignores them as evidence, so areas separated only
        # by trees can still join if they look alike.
        ws = cv2.GaussianBlur(np.where(blocked, 1.0, walls).astype(np.float32), (0, 0), unit)
        markers, _ = ndi.label(h_minima(ws, a.wall_h))
        seg = watershed(ws, markers)
        seg = merge_similar(seg, feats, ~blocked, a.merge, walls, a.wall_strength)


    parcels, owner = [], np.full((h, w), -1, np.int32)
    for lbl in np.unique(seg):
        m = (seg == lbl) & ~blocked
        if m.sum() < area * a.min_parcel:
            continue
        inner = cv2.erode(m.astype(np.uint8), disk(5 * unit)).astype(bool)
        if inner.sum() < 50:
            inner = m
        rowed = np.median(local_coh[inner]) > a.row_coherence
        if rowed:
            sel = inner & (local_coh > a.row_coherence)
            sxx, syy, sxy = Jxx[sel].sum(), Jyy[sel].sum(), Jxy[sel].sum()
            theta = 0.5 * math.atan2(2 * sxy, sxx - syy)  # across the rows
        else:
            ys, xs = np.nonzero(m)                         # short axis
            _, evec = np.linalg.eigh(np.cov(np.vstack([xs, ys])))
            theta = math.atan2(evec[1, 0], evec[0, 0])
        style = field_style(*img_lab[m].mean(axis=0))
        owner[m] = len(parcels)
        parcels.append(dict(mask=m, style=style, theta=theta,
                            striped=rowed or a.stripe_all))

    # Everything left over (under trees, slivers) joins the nearest field, so
    # the ground under the cartoon trees is filled in.
    if parcels:
        _, (iy, ix) = ndi.distance_transform_edt(owner < 0, return_indices=True)
        owner = owner[iy, ix]
        # Neighbouring plain (unstriped) areas drawn in the same colour are
        # one area: no outline between them.
        parent = list(range(len(parcels)))

        def find(i):
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i
        # ...unless a path/bund/edge runs between them (wall evidence on open
        # ground, as in merge_similar).
        Wl = walls if walls is not None else np.zeros(owner.shape, np.float32)
        open_ground = ~blocked
        wsum, wcnt = {}, {}
        for A, B, WA, WB, VA, VB in (
                (owner[:, :-1], owner[:, 1:], Wl[:, :-1], Wl[:, 1:], open_ground[:, :-1], open_ground[:, 1:]),
                (owner[:-1, :], owner[1:, :], Wl[:-1, :], Wl[1:, :], open_ground[:-1, :], open_ground[1:, :])):
            d = A != B
            lo, hi = np.minimum(A[d], B[d]), np.maximum(A[d], B[d])
            ok = VA[d] & VB[d]
            wv = np.maximum(WA[d], WB[d])
            for i, j, w, o in zip(lo.tolist(), hi.tolist(), wv.tolist(), ok.tolist()):
                wsum[(i, j)] = wsum.get((i, j), 0.0) + (w if o else 0.0)
                wcnt[(i, j)] = wcnt.get((i, j), 0) + (1 if o else 0)
        for (i, j), s_ in wsum.items():
            pi, pj = parcels[i], parcels[j]
            wall = s_ / max(wcnt[(i, j)], 1)
            if (not pi["striped"] and not pj["striped"] and wall < a.wall_strength
                    and FLAT_FOR[pi["style"]] == FLAT_FOR[pj["style"]]):
                parent[find(i)] = find(j)
        roots = np.array([find(i) for i in range(len(parcels))])
        owner = roots[owner]
        parcels = [dict(parcels[r], mask=owner == r) for r in np.unique(roots)]

    return dict(water=water, trees=trees, roads=roads, buildings=buildings,
                parcels=parcels, shadows=shadows, walls=walls, road_thick=road_thick / unit,
                img=img)


# --------------------------------------------------------------- 2. render
def place_trees(trees, r_typ, rng):
    """Turn the tree mask into a list of (x, y, r) round canopies."""
    out = []
    dist = cv2.distanceTransform(trees.astype(np.uint8), cv2.DIST_L2, 5)
    lab, n = ndi.label(trees)
    for i, sl in enumerate(ndi.find_objects(lab), 1):
        comp = lab[sl] == i
        n_px = comp.sum()
        if n_px < math.pi * r_typ ** 2 * 1.4:
            cy, cx = ndi.center_of_mass(comp)
            r = float(np.clip(math.sqrt(n_px / math.pi) * 1.15,
                              r_typ * 0.55, r_typ * 1.2))
            out.append((cx + sl[1].start, cy + sl[0].start, r))
            continue
        step = r_typ * 1.15
        y0, x0 = sl[0].start, sl[1].start
        hh, ww = comp.shape
        for gy in np.arange(step * 0.4, hh, step):
            for gx in np.arange(step * 0.4, ww, step):
                jx = gx + rng.uniform(-0.3, 0.3) * step
                jy = gy + rng.uniform(-0.3, 0.3) * step
                ix, iy = int(round(jx)), int(round(jy))
                if not (0 <= ix < ww and 0 <= iy < hh) or not comp[iy, ix]:
                    continue
                d = dist[y0 + iy, x0 + ix]
                if d < r_typ * 0.3:
                    continue
                r = r_typ * rng.uniform(0.85, 1.15)
                out.append((jx + x0, jy + y0, min(r, d + r_typ * 0.6)))
    return out


def straighten(mask, eps):
    """Replace a region's wobbly outline (and holes) by straight-sided polygons."""
    m = mask.astype(np.uint8)
    if eps <= 0:
        return m
    cnts, hier = cv2.findContours(m, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    out = np.zeros_like(m)
    if hier is None:
        return out
    for c, hh in zip(cnts, hier[0]):
        poly = cv2.approxPolyDP(c, eps, True)
        cv2.fillPoly(out, [poly], 0 if hh[3] >= 0 else 1)
    return out


def tree_blobs(x, y, r, rng):
    """A canopy is a main circle plus a few overlapping lobes."""
    blobs = [(x, y, r)]
    for k in range(rng.integers(2, 4)):
        t = rng.uniform(0, 2 * math.pi)
        blobs.append((x + math.cos(t) * r * 0.45, y + math.sin(t) * r * 0.45,
                      r * rng.uniform(0.6, 0.75)))
    return blobs


def render(img, cls, a):
    h, w = img.shape[:2]
    sc = a.scale
    H, W = h * sc, w * sc
    unit = max(H, W) / 1000.0
    rng = np.random.default_rng(a.seed)
    cv_ = Canvas(H, W, sc, PAL["base"])
    smooth = a.smooth * unit

    # Fields, slightly inset so darker strips show between them.
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    period = max(W, H) / a.stripes
    gap = max(1, int(round(3 * max(h, w) / 1000.0)))
    for p in cls["parcels"]:
        m = cv2.erode(straighten(p["mask"], a.straighten * max(h, w) / 1000.0),
                      disk(gap)).astype(bool)
        if not m.any():
            continue
        alpha = cv_.soft(m, smooth)
        if p["striped"]:
            c1, c2 = (np.array(c, np.float32) for c in PAL[p["style"]])
            t = p["theta"]
            phase = (xx * math.cos(t) + yy * math.sin(t)) / period
            s = np.sin(2 * math.pi * phase)
            band = np.clip(s * period / 3.0 + 0.5, 0, 1)[..., None]  # crisp+AA
            cv_.over(alpha, c1 * band + c2 * (1 - band))
        else:
            flat = PAL[FLAT_FOR[p["style"]]]
            cv_.over(alpha, flat[0] if isinstance(flat[0], tuple) else flat)

    # River: tan bank, then water with a soft light-to-dark gradient.
    water = cls["water"]
    if water.any():
        bank_px = max(2, int(round(a.bank * max(h, w) / 1000.0)))
        bank = cv2.dilate(water.astype(np.uint8), disk(bank_px)).astype(bool)
        cv_.over(cv_.soft(bank, smooth * 1.4), PAL["bank"])
        t = np.clip((xx / W) * 0.75 + (yy / H) * 0.25, 0, 1)[..., None]
        wcol = (np.array(PAL["water_light"], np.float32) * (1 - t) +
                np.array(PAL["water_dark"], np.float32) * t)
        cv_.over(cv_.soft(water, smooth * 1.4), wcol)

    # Roads: darker edge, grey fill, yellow centre line.
    roads = cls["roads"]
    if roads.any():
        edge = cv2.dilate(roads.astype(np.uint8), disk(1)).astype(bool)
        cv_.over(cv_.soft(edge, smooth * 0.6), PAL["road_edge"])
        road_a = cv_.soft(roads, smooth * 0.6)
        cv_.over(road_a, PAL["road"])
    if roads.any() and cls["road_thick"] >= a.road_line_min:
        sk = skeletonize(cv_.soft(roads, smooth * 0.6) > 0.5)
        sk = prune_spurs(sk, max(8 * unit, 1.5 * cls["road_thick"] * sc)).astype(np.uint8)
        line = cv2.GaussianBlur(cv2.dilate(sk, disk(max(1, unit))).astype(np.float32),
                                (0, 0), 0.7)
        cv_.over(np.clip(line * 1.6, 0, 1), PAL["road_line"], 0.95)

    out = cv_.u8()

    # Buildings: soft shadow, then a two-tone gabled roof.
    shadow = np.zeros((H, W), np.uint8)
    roofs = []
    for (c, sz, ang, kind) in cls["buildings"]:
        cx, cy = c[0] * sc, c[1] * sc
        bw, bh = sz[0] * sc, sz[1] * sc
        p = cv2.boxPoints(((cx, cy), (bw, bh), ang))
        off = 0.12 * min(bw, bh) + 2 * unit
        cv2.fillPoly(shadow, [np.int32(np.round(p + [off * 0.4, off]))], 255,
                     cv2.LINE_AA)
        e01, e12 = np.linalg.norm(p[1] - p[0]), np.linalg.norm(p[2] - p[1])
        if e01 >= e12:
            m1, m2 = (p[0] + p[3]) / 2, (p[1] + p[2]) / 2
            halves = [np.array([p[0], p[1], m2, m1]), np.array([m1, m2, p[2], p[3]])]
        else:
            m1, m2 = (p[0] + p[1]) / 2, (p[3] + p[2]) / 2
            halves = [np.array([p[1], p[2], m2, m1]), np.array([m1, m2, p[3], p[0]])]
        halves.sort(key=lambda q: q[:, 1].mean() + 0.3 * q[:, 0].mean())
        roofs.append((halves, kind))
    sa = (shadow.astype(np.float32) / 255.0 * 0.35)[..., None]
    out = (out * (1 - sa)).astype(np.uint8)
    for halves, kind in roofs:
        light, dark = PAL[kind]
        cv2.fillPoly(out, [np.int32(np.round(halves[0]))], light, cv2.LINE_AA)
        cv2.fillPoly(out, [np.int32(np.round(halves[1]))], dark, cv2.LINE_AA)

    # Trees: shadows first, then canopies top-to-bottom (two-tone lobes).
    r_typ = a.tree_size * max(h, w) / 1000.0
    trees = sorted(place_trees(cls["trees"], r_typ, rng), key=lambda t: t[1])
    shapes = [tree_blobs(x * sc, y * sc, r * sc, rng) for x, y, r in trees]
    shadow[:] = 0
    for blobs in shapes:
        for (x, y, r) in blobs:
            cv2.circle(shadow, (int(x + r * 0.35), int(y + r * 0.55)), int(r),
                       255, -1, cv2.LINE_AA)
    sa = (shadow.astype(np.float32) / 255.0 * 0.33)[..., None]
    out = (out * (1 - sa)).astype(np.uint8)
    for blobs in shapes:
        for (x, y, r) in blobs:
            cv2.circle(out, (int(x), int(y)), int(r), PAL["tree_dark"], -1, cv2.LINE_AA)
        for (x, y, r) in blobs:
            cv2.circle(out, (int(x - r * 0.12), int(y - r * 0.16)), int(r * 0.86),
                       PAL["tree"], -1, cv2.LINE_AA)
    return out


def debug_overlay(img, cls):
    vis = img.copy().astype(np.float32)
    colours = [(cls["water"], (0, 120, 255)), (cls["trees"], (0, 200, 0)),
               (cls["shadows"], (120, 0, 160)),
               (cls["roads"], (255, 0, 255))]
    for m, c in colours:
        vis[m] = vis[m] * 0.4 + np.array(c) * 0.6
    vis = vis.astype(np.uint8)
    for p in cls["parcels"]:
        cnts, _ = cv2.findContours(p["mask"].astype(np.uint8), cv2.RETR_EXTERNAL,
                                   cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(vis, cnts, -1, (255, 255, 0) if p["striped"] else (255, 255, 255), 2)
    for (c, sz, ang, _) in cls["buildings"]:
        cv2.polylines(vis, [np.int32(cv2.boxPoints((c, sz, ang)))], True, (255, 0, 0), 2)
    return vis


def trim_border(img, max_frac=0.1):
    """Crop flat strips (white frames, toolbars) off the edges."""
    def flat(px):
        return px.std() < 6 or px.mean() > 245
    t, b, l, r = 0, img.shape[0], 0, img.shape[1]
    lim_y, lim_x = int(img.shape[0] * max_frac), int(img.shape[1] * max_frac)
    while t < lim_y and flat(img[t, l:r]): t += 1
    while img.shape[0] - b < lim_y and flat(img[b - 1, l:r]): b -= 1
    while l < lim_x and flat(img[t:b, l]): l += 1
    while img.shape[1] - r < lim_x and flat(img[t:b, r - 1]): r -= 1
    return img[t:b, l:r]


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input")
    ap.add_argument("-o", "--output")
    ap.add_argument("--max-dim", type=int, default=1000, help="working resolution")
    ap.add_argument("--scale", type=int, default=2, help="output = working x scale")
    ap.add_argument("--debug", action="store_true", help="also write *_masks.png")
    ap.add_argument("-v", "--verbose", action="store_true", help="print detection details")
    g = ap.add_argument_group("detection (tune these for your photo)")
    g.add_argument("--no-levels", action="store_true", help="skip the haze / colour-cast fix")
    g.add_argument("--tree-dark", type=float, default=0, help="L below this = tree/shadow (0 = auto)")
    g.add_argument("--smooth-tex", type=float, default=7.0, help="below this texture = shadow/water/pavement")
    g.add_argument("--shadow-contact", type=float, default=0.3, help="dark area touching trees more than this = shadow")
    g.add_argument("--big-water", type=float, default=0.03, help="dark smooth areas bigger than this are water")
    g.add_argument("--no-water", action="store_true")
    g.add_argument("--no-buildings", action="store_true")
    g.add_argument("--max-building", type=float, default=0.02, help="largest building, fraction of image")
    g.add_argument("--min-tree", type=float, default=40, help="smallest tree, px")
    g.add_argument("--water-blue", type=float, default=12, help="how much bluer than red water must be")
    g.add_argument("--grey-sat", type=float, default=38, help="max saturation of roads/roofs")
    g.add_argument("--grey-light", type=float, default=120, help="min lightness of roads/roofs")
    g.add_argument("--min-building", type=float, default=150, help="smallest building, px")
    g.add_argument("--road-width", type=float, default=40, help="max road width, px")
    g.add_argument("--road-length", type=float, default=10, help="road must be this many widths long")
    g.add_argument("--road-cv", type=float, default=0.45, help="how much a road's width may vary")
    g.add_argument("--building-fill", type=float, default=0.8, help="how rectangular a building must be")
    g.add_argument("--building-contrast", type=float, default=30, help="how much a roof must stand out")
    g.add_argument("--road-line-min", type=float, default=13, help="roads narrower than this get no centre line")
    g.add_argument("--seg-scale", type=float, default=900, help="bigger = fewer, larger fields")
    g.add_argument("--seg-blur", type=float, default=3.0, help="blur before finding fields")
    g.add_argument("--row-weight", type=float, default=60, help="how much row direction splits fields")
    g.add_argument("--merge", type=float, default=20, help="bigger = merge more similar fields")
    g.add_argument("--min-parcel", type=float, default=0.0008, help="smallest field, fraction of image")
    g.add_argument("--fields", choices=["walls", "felz"], default="walls", help="field-finding method")
    g.add_argument("--rows-edge", type=float, default=110, help="bigger = row changes matter less")
    g.add_argument("--wall-h", type=float, default=0.05, help="smaller = more, smaller candidate fields")
    g.add_argument("--wall-strength", type=float, default=0.6, help="edge strength that keeps two fields apart")
    g.add_argument("--row-coherence", type=float, default=0.5, help="how strong rows must be (0-1)")
    g.add_argument("--stripe-all", action="store_true", help="stripe every field")
    s = ap.add_argument_group("style")
    s.add_argument("--stripes", type=float, default=56, help="stripes across the image")
    s.add_argument("--smooth", type=float, default=4.0, help="outline rounding")
    s.add_argument("--straighten", type=float, default=3.0, help="straighten field edges (0 = off)")
    s.add_argument("--bank", type=float, default=7.0, help="river bank width")
    s.add_argument("--tree-size", type=float, default=15.0, help="tree radius")
    s.add_argument("--seed", type=int, default=3)
    a = ap.parse_args()

    img = cv2.imread(a.input, cv2.IMREAD_COLOR)
    if img is None:
        raise SystemExit(f"cannot read {a.input}")
    img = trim_border(img[:, :, ::-1].copy())
    h, w = img.shape[:2]
    f = a.max_dim / max(h, w)
    if f < 1:
        img = cv2.resize(img, (round(w * f), round(h * f)), interpolation=cv2.INTER_AREA)

    cls = classify(img, a)
    out = render(img, cls, a)
    stem = a.input.rsplit(".", 1)[0]
    dst = a.output or stem + "_illustrated.png"
    cv2.imwrite(dst, out[:, :, ::-1])
    print(f"wrote {dst}  ({len(cls['parcels'])} fields, "
          f"{len(cls['buildings'])} buildings)")
    if a.debug:
        cv2.imwrite(stem + "_masks.png", debug_overlay(cls["img"], cls)[:, :, ::-1])
        print(f"wrote {stem}_masks.png")


if __name__ == "__main__":
    main()
