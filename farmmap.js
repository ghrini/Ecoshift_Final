// FieldShift farm map (used by server.js): an illustrated map of the farm from above, made by the team's
// converter (farmmap/stylize_farm.py, Python with OpenCV).
// - GET  /api/farmmap?lat&lon : fetches the same 1.6 km square from two free sources at once,
//        USDA NAIP aerial photos via the USGS National Map (0.6-1 m, US only, public domain) and
//        Sentinel-2 cloudless by EOX (10 m, worldwide), keeps the sharper one and converts it.
// - POST /api/farmmap/upload  : the farmer's own drone or aerial photo (JPEG, PNG or WebP, up to 8 MB).
// - GET  /api/farmmap/img/<key>.(png|jpg) : the illustrated map and the photo it was made from.
// Converting takes 15-40 s, so results are cached on disk by spot (about 100 m) or by photo.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

const DIR = path.join(os.tmpdir(), "fieldshift-farmmap");
const SCRIPT = path.join(__dirname, "farmmap", "make_map.py");
const HALF_KM = 0.8;
const UA = { "User-Agent": "fieldshift-simulator" };
const CREDIT = {
  usgs: "USDA NAIP aerial imagery via the USGS National Map (public domain)",
  s2: "Sentinel-2 cloudless 2020 by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2020), CC BY-NC-SA 4.0",
  upload: "Your own photo",
};
const DETAIL = { usgs: "aerial photo, about 1 m detail", s2: "satellite image, 10 m detail: field shapes only, trees and roads are rough", upload: "your photo" };

// Forget maps and photos from visitors more than a week ago (the folder otherwise only grows).
(function prune() {
  try {
    const old = Date.now() - 7 * 24 * 3600e3;
    for (const f of fs.readdirSync(DIR)) {
      const p = path.join(DIR, f);
      try { if (fs.statSync(p).mtimeMs < old) fs.rmSync(p, { force: true, recursive: true }); } catch { /* skip */ }
    }
  } catch { /* the folder does not exist yet */ }
})();

// Python: FARMMAP_PYTHON (for example "python3" or a full path), else the Windows launcher or python3
function python() {
  if (process.env.FARMMAP_PYTHON) return [process.env.FARMMAP_PYTHON, []];
  return process.platform === "win32" ? ["py", ["-3"]] : ["python3", []];
}

function boxOf(lat, lon) {
  const dLat = HALF_KM / 111.32, dLon = HALF_KM / (111.32 * Math.cos((lat * Math.PI) / 180));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}
const SOURCES = {
  usgs: (b) => `https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/export?bbox=${b.join(",")}&bboxSR=4326&imageSR=3857&size=1000,1000&format=jpg&f=image`,
  s2: (b) => `https://tiles.maps.eox.at/wms?service=WMS&request=GetMap&version=1.1.1&layers=s2cloudless-2020&styles=&srs=EPSG:4326&bbox=${b.join(",")}&width=1000&height=1000&format=image/jpeg`,
};

async function download(url, file) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25000) });
  const type = r.headers.get("content-type") || "";
  if (!r.ok || !/^image\//.test(type)) throw new Error(`${new URL(url).host} returned ${r.status}`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}

// at most two conversions at once; the same key waits for the one already running
let running = 0;
const queue = [], inflight = new Map();
function slot() { return new Promise((ok) => { if (running < 2) { running++; ok(); } else queue.push(ok); }); }
function release() { const next = queue.shift(); if (next) next(); else running--; }

function convert(key, candidates) {
  const [cmd, pre] = python();
  const map = path.join(DIR, key + ".png"), photo = path.join(DIR, key + ".jpg");
  const args = [...pre, SCRIPT, "--out-map", map, "--out-photo", photo, ...candidates.map(([n, f]) => `${n}=${f}`)];
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 180000, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const last = String(stdout || "").trim().split(/\r?\n/).pop() || "";
      let j = null; try { j = JSON.parse(last); } catch { /* not JSON */ }
      if (j && j.error) return reject(Object.assign(new Error(j.error), { user: true }));
      if (err || !j) {
        console.error("farmmap:", (err && err.message) || "", String(stderr || "").slice(-400));
        const missing = /No module named|not recognized|ENOENT/.test(String(stderr) + (err && err.message));
        return reject(Object.assign(new Error(missing ? "The farm map needs Python with the converter's packages on the server (pip install -r farmmap/requirements.txt)." : "The farm map could not be drawn."), { user: true }));
      }
      resolve(j);
    });
  });
}

async function make(key, getCandidates, extra) {
  const meta = path.join(DIR, key + ".json");
  if (fs.existsSync(meta)) return JSON.parse(fs.readFileSync(meta, "utf8"));
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    fs.mkdirSync(DIR, { recursive: true });
    const t0 = Date.now();
    const cands = await getCandidates();
    await slot();
    let j;
    try { j = await convert(key, cands); } finally { release(); for (const [, f] of cands) fs.rm(f, { force: true }, () => {}); }
    const out = { key, source: j.source, credit: CREDIT[j.source] || "", detail: DETAIL[j.source] || "", scores: j.scores, fields: Array.isArray(j.fields) ? j.fields : null, seconds: Math.round((Date.now() - t0) / 1000),
      map: `/api/farmmap/img/${key}.png`, photo: `/api/farmmap/img/${key}.jpg`, ...extra };
    fs.writeFileSync(meta, JSON.stringify(out));
    return out;
  })();
  inflight.set(key, job);
  try { return await job; } finally { inflight.delete(key); }
}

module.exports = function farmmap({ send }) {
  // FARMMAP_URL: another EcoShift server that runs the Python map tools (for example the same app on Hugging Face Spaces).
  // When it is set, map requests are passed on to it. That is how the farm map works on Vercel, which cannot run Python.
  const REMOTE = String(process.env.FARMMAP_URL || "").trim().replace(/\/+$/, "");
  const NO_PY = "Drawing a new farm map isn't switched on for this site yet. The example county maps still work.";
  async function forward(req, res, body) {
    try {
      const r = await fetch(REMOTE + req.url, {
        method: req.method, body,
        headers: body ? { "Content-Type": String(req.headers["content-type"] || "application/octet-stream") } : {},
        signal: AbortSignal.timeout(110000),
      });
      const buf = Buffer.from(await r.arrayBuffer()), h = { "Content-Type": r.headers.get("content-type") || "application/json; charset=utf-8" };
      if (/^image\//.test(h["Content-Type"])) h["Cache-Control"] = "public, max-age=86400";
      res.writeHead(r.status, h); res.end(buf);
    } catch (e) {
      console.error("farmmap forward:", e.message);
      send(res, 502, { error: "The farm map server did not answer. Try again in a minute." });
    }
  }
  function noPython(res) {
    console.warn("farmmap: this host cannot run the Python map tools; set FARMMAP_URL to an EcoShift server that can (see README).");
    return send(res, 503, { error: NO_PY });
  }
  async function handleFarmMap(req, res) {
    if (REMOTE) return forward(req, res);
    if (process.env.VERCEL) return noPython(res);
    const q = new URL(req.url, "http://x").searchParams, lat = Number(q.get("lat")), lon = Number(q.get("lon"));
    if (!q.get("lat") || !q.get("lon") || !isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) return send(res, 400, { error: "Missing farm location." });
    const spot = `${lat.toFixed(3)},${lon.toFixed(3)}`, key = crypto.createHash("sha1").update("spot" + spot).digest("hex").slice(0, 24), b = boxOf(lat, lon);
    try {
      const out = await make(key, async () => {
        // both sources at once; whichever answers with an image is a candidate
        const got = await Promise.all(Object.entries(SOURCES).map(async ([name, url]) => {
          const f = path.join(DIR, `${key}.${name}.src.jpg`);
          try { await download(url(b), f); return [name, f]; } catch (e) { console.warn(`farmmap ${name}:`, e.message); return null; }
        }));
        const c = got.filter(Boolean);
        if (!c.length) throw Object.assign(new Error("Neither aerial imagery service answered. Try again in a minute, or use your own photo."), { user: true });
        return c;
      }, { lat: Number(lat.toFixed(5)), lon: Number(lon.toFixed(5)), widthKm: HALF_KM * 2 });
      send(res, 200, out);
    } catch (e) {
      if (!e.user) console.error("farmmap:", e.message);
      send(res, 502, { error: e.user ? e.message : "The farm map could not be drawn right now." });
    }
  }

  async function handleUpload(req, res) {
    if (!REMOTE && process.env.VERCEL) return noPython(res);
    const type = String(req.headers["content-type"] || "");
    if (!/^image\/(jpeg|png|webp)$/.test(type)) return send(res, 415, { error: "Use a JPEG, PNG or WebP photo." });
    let buf;
    try {
      buf = await new Promise((resolve, reject) => {
        let size = 0, over = false; const chunks = [];
        req.on("data", (c) => { size += c.length; if (over) return; if (size > 8 * 1024 * 1024) { over = true; reject(new Error("big")); } else chunks.push(c); });
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
      });
    } catch { return send(res, 413, { error: "That photo is over 8 MB. Make it smaller and try again." }); }
    const png = buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    const jpg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    const webp = buf.length > 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP";
    if (buf.length >= 1000 && !png && !jpg && !webp) return send(res, 400, { error: "That file is not a real JPEG, PNG or WebP photo." });
    if (buf.length < 1000) return send(res, 400, { error: "That file is empty or too small." });
    if (REMOTE) return forward(req, res, buf);
    const key = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 24);
    try {
      const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[type];
      const out = await make(key, async () => {
        fs.mkdirSync(DIR, { recursive: true });
        const f = path.join(DIR, `${key}.upload.src.${ext}`); fs.writeFileSync(f, buf); return [["upload", f]];
      }, {});
      send(res, 200, out);
    } catch (e) {
      if (!e.user) console.error("farmmap upload:", e.message);
      send(res, 502, { error: e.user ? e.message : "Your photo could not be turned into a map." });
    }
  }

  function handleImage(req, res) {
    const m = /^\/api\/farmmap\/img\/([0-9a-f]{24})\.(png|jpg)$/.exec(new URL(req.url, "http://x").pathname);
    if (!m) return send(res, 404, "Not found");
    fs.readFile(path.join(DIR, `${m[1]}.${m[2]}`), (err, buf) => {
      if (err && REMOTE) return forward(req, res);   // drawn by the farm map server: fetch it from there
      if (err) return send(res, 404, "Not found");
      res.writeHead(200, { "Content-Type": m[2] === "png" ? "image/png" : "image/jpeg", "Cache-Control": "private, max-age=86400" });
      res.end(buf);
    });
  }

  return { handleFarmMap, handleUpload, handleImage };
};
