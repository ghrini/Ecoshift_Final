#!/usr/bin/env python3
"""Make a fake but photo-like aerial image of a farm, for testing the stylizer."""
import cv2
import numpy as np
from scipy.interpolate import splprep, splev

rng = np.random.default_rng(7)
H = W = 1000
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)


def noise(sigma, amp):
    n = cv2.GaussianBlur(rng.normal(0, 1, (H, W)).astype(np.float32), (0, 0), sigma)
    return n / (n.std() + 1e-6) * amp


img = np.empty((H, W, 3), np.float32)
img[:] = (92, 116, 60)
img += (noise(30, 9) + noise(2, 5))[..., None]


def field(poly, color, angle, period, amp):
    m = np.zeros((H, W), np.uint8)
    cv2.fillPoly(m, [np.int32(poly)], 1)
    t = np.deg2rad(angle)
    rows = np.sin(2 * np.pi * (xx * np.cos(t) + yy * np.sin(t)) / period)
    tex = (np.float32(color) + (rows * amp)[..., None] +
           noise(40, 9)[..., None] + rng.normal(0, 4, (H, W, 1)))
    img[m.astype(bool)] = tex[m.astype(bool)]


field([(0, 0), (455, 0), (445, 105), (0, 105)], (150, 158, 86), 90, 9, 13)
field([(495, 0), (1000, 0), (1000, 335), (495, 335)], (168, 172, 98), 0, 8, 12)
field([(425, 405), (830, 405), (810, 785), (425, 785)], (104, 134, 64), 90, 10, 12)
field([(0, 900), (330, 880), (360, 1000), (0, 1000)], (140, 114, 84), 30, 9, 14)
field([(0, 300), (300, 300), (300, 520), (0, 520)], (122, 142, 72), 0, 30, 2)  # yard


def path(pts, width, color, tex_amp=6):
    tck, _ = splprep(np.array(pts, float).T, s=0)
    x, y = splev(np.linspace(0, 1, 600), tck)
    m = np.zeros((H, W), np.uint8)
    cv2.polylines(m, [np.int32(np.c_[x, y])], False, 1, width, cv2.LINE_AA)
    m = m.astype(bool)
    img[m] = np.float32(color) + rng.normal(0, tex_amp, (m.sum(), 1))
    return np.c_[x, y]


# river with sandy banks
river_pts = [(-10, 590), (180, 690), (440, 790), (690, 805), (830, 760),
             (850, 640), (820, 530), (900, 470), (1010, 455)]
path(river_pts, 86, (166, 148, 112))
river = path(river_pts, 68, (50, 78, 92), 3)
# road and dirt drive
path([(468, -5), (462, 60), (430, 130), (360, 190), (250, 238), (120, 272), (-5, 290)],
     17, (152, 152, 150), 5)
path([(185, 282), (200, 340), (240, 395), (232, 450)], 8, (150, 128, 96), 6)


def building(x0, y0, x1, y1, color):
    img[y0 + 7:y1 + 7, x0 + 6:x1 + 6] *= 0.45            # shadow
    img[y0:y1, x0:x1] = np.float32(color) + rng.normal(0, 4, (y1 - y0, x1 - x0, 1))
    img[y0:(y0 + y1) // 2, x0:x1] *= 1.08                 # lit roof side


building(105, 372, 218, 418, (142, 50, 44))
building(105, 372, 182, 442, (142, 50, 44))
building(95, 305, 135, 336, (140, 48, 42))
building(255, 385, 302, 420, (206, 206, 196))
building(236, 462, 302, 520, (198, 196, 186))

# trees
trees = []
trees += [(312 + rng.normal(0, 3), y, rng.uniform(8, 11)) for y in range(235, 520, 16)]
trees += [(x, 255 - (x - 120) * 0.25 + rng.normal(0, 4), rng.uniform(8, 13))
          for x in range(30, 440, 26)]
trees += [(x + rng.normal(0, 10), 375 + rng.normal(0, 8), rng.uniform(10, 16))
          for x in rng.choice(np.arange(350, 900), 12)]
for i in rng.choice(len(river), 45):
    x, y = river[i]
    side = rng.choice([-1, 1])
    trees.append((x + side * rng.uniform(48, 70), y + side * rng.uniform(40, 60),
                  rng.uniform(9, 15)))
trees += [(rng.uniform(20, 300), rng.uniform(300, 520), rng.uniform(7, 12)) for _ in range(10)]
trees += [(rng.uniform(380, 420), rng.uniform(520, 800), rng.uniform(9, 13)) for _ in range(9)]

shade = img.copy()
for x, y, r in trees:
    cv2.circle(shade, (int(x + r * 0.4), int(y + r * 0.5)), int(r), (0, 0, 0), -1, cv2.LINE_AA)
img = img * 0.55 + shade * 0.45
canopy = np.zeros((H, W), np.uint8)
light = np.zeros((H, W), np.float32)
for x, y, r in trees:
    cv2.circle(canopy, (int(x), int(y)), int(r), 1, -1, cv2.LINE_AA)
    cv2.circle(light, (int(x - r * 0.3), int(y - r * 0.3)), int(r * 0.6), 1.0, -1)
light = cv2.GaussianBlur(light, (0, 0), 4)
m = canopy.astype(bool)
leaf = (np.float32((40, 60, 30)) + noise(1.5, 12)[..., None] + (light * 22)[..., None])
img[m] = leaf[m]

img = cv2.GaussianBlur(img, (0, 0), 0.7) + rng.normal(0, 3, (H, W, 3))
cv2.imwrite("test_aerial.png", np.clip(img, 0, 255).astype(np.uint8)[:, :, ::-1])
print("wrote test_aerial.png")
