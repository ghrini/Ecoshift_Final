// FieldShift site server: the EcoShifters server by Shaurya (n-shaurya/nasa-space-apps).
// Changed for the site: static files are served from ./public (the three-tab site), with the
// questionnaire in ./public/app and the Deep Dive simulator in ./public/deepdive. API routes are unchanged.
// EcoShifters local server.
// Serves the web app and the farm-fitting, forecast and farm-map APIs (NASA POWER, USDA, Open-Meteo, Google Gemini).
// The Gemini key lives only here (in .env), never in browser code.
// Run: node server.js   (Node 18+, no npm install needed)

"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
loadEnv(path.join(ROOT, ".env"));

const PORT = Number(process.env.PORT) || 8787;
const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
// What farmers see when the key is missing; how to fix it is printed in the server log at startup.
const NO_KEY = "The AI helper isn't switched on yet. Ask the person who set up EcoShifters to add its key.";
let geminiModel = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

/* ---------------- .env ---------------- */
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m || line.trim().startsWith("#")) continue;
    const val = m[2].replace(/^["']|["']$/g, "");
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  }
}

/* ---------------- Gemini ---------------- */
// One Gemini call that must answer with JSON matching schema; retries other models when one is busy or retired.
async function geminiJSON(system, userText, schema) {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: userText }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.4 },
  };
  let res = await geminiRequest(geminiModel, body);
  if (res.status === 404 || res.status === 503) {
    // Model retired (404) or overloaded (503): try the next newest Flash-Lite models (fast), up to 2 more.
    const retired = res.status === 404;
    const others = (await listFlashModels()).filter((m) => m !== geminiModel).slice(0, 2);
    for (const m of others) {
      console.log(`Gemini model "${geminiModel}" returned ${res.status}; trying "${m}".`);
      res = await geminiRequest(m, body);
      if (res.ok) { if (retired) geminiModel = m; break; } // a busy model stays the default
    }
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json.error?.message || `HTTP ${res.status}`;
    console.error(`Gemini error ${res.status}: ${msg}`); // the details are for whoever runs the server, not for farmers
    if (res.status === 400 && /API key/i.test(msg)) throw new UserError("The AI helper's key isn't working. Ask the person who set up EcoShifters to check it.");
    if (res.status === 429 || res.status === 503) throw new UserError("The AI helper is busy right now. Wait a minute and try again.");
    throw new UserError("The AI helper couldn't answer just now. Try again in a minute.");
  }
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  try { return JSON.parse(text); } catch { throw new UserError("The AI helper's answer came back garbled. Try again."); }
}

async function geminiRequest(model, body) {
  try {
    return await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    if (e.name !== "TimeoutError") throw e;
    // An overloaded model can hang instead of answering 503; treat it the same way.
    return new Response(JSON.stringify({ error: { message: `${model} took too long to answer. Try again in a minute.` } }), { status: 503 });
  }
}

async function listFlashModels() {
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": GEMINI_KEY } });
  if (!res.ok) return [];
  const models = ((await res.json()).models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""))
    .filter((n) => /^gemini-\d+(\.\d+)?-flash-lite$/.test(n));
  // Newest version first.
  return models.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

class UserError extends Error {}

/* ---------------- HTTP ---------------- */
// Only the app's own web files: no hidden folders (.git, .env, .devcontainer), no server code, no other file types.
// Text files are gzipped once and kept in memory (keyed by path, modified time and size).
const GZIP_TYPES = new Set([".html", ".js", ".css", ".json", ".svg"]);
const gzCache = new Map();
function serveStatic(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { return send(res, 400, "Bad request"); }
  const file = path.normalize(path.join(PUBLIC, urlPath.endsWith("/") ? urlPath + "index.html" : urlPath));
  const rel = path.relative(PUBLIC, file);
  const hidden = rel.split(path.sep).some((part) => part.startsWith("."));
  const serverOnly = /^(server|farmfit|farmmap|sim\.test)\.js$/i.test(path.basename(file));
  const ext = path.extname(file).toLowerCase();
  if (rel.startsWith("..") || path.isAbsolute(rel) || hidden || serverOnly || !MIME[ext]) return send(res, 404, "Not found");
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, "Not found");
    fs.readFile(file, (err2, buf) => {
      if (err2) return send(res, 404, "Not found");
      const headers = { "Content-Type": MIME[ext], "Cache-Control": "public, max-age=300", "Vary": "Accept-Encoding", "X-Content-Type-Options": "nosniff" };
      if (GZIP_TYPES.has(ext) && /\bgzip\b/i.test(String(req.headers["accept-encoding"] || "")) && buf.length > 1024) {
        const key = `${file}|${st.mtimeMs}|${st.size}`;
        let gz = gzCache.get(key);
        if (!gz) {
          gz = zlib.gzipSync(buf, { level: 6 });
          if (gzCache.size >= 200) gzCache.delete(gzCache.keys().next().value);
          gzCache.set(key, gz);
        }
        headers["Content-Encoding"] = "gzip"; headers["Content-Length"] = gz.length;
        res.writeHead(200, headers);
        return res.end(req.method === "HEAD" ? undefined : gz);
      }
      headers["Content-Length"] = buf.length;
      res.writeHead(200, headers);
      res.end(req.method === "HEAD" ? undefined : buf);
    });
  });
}

// Too big a body gets a 413 (the caller sends it); the extra bytes are dropped and the connection is closed after the reply.
function readBody(req, limit) {
  // On Vercel the platform may hand the body over already read
  if (req.body !== undefined && req.readableEnded) {
    const b = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    return b.length > limit ? Promise.reject(Object.assign(new Error("too big"), { status: 413 })) : Promise.resolve(b);
  }
  return new Promise((resolve, reject) => {
    let size = 0, over = false; const chunks = [];
    req.on("data", (c) => { size += c.length; if (over) return; if (size > limit) { over = true; reject(Object.assign(new Error("too big"), { status: 413 })); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res, status, body) {
  if (res.headersSent) return;
  const isJson = typeof body !== "string";
  const headers = { "Content-Type": isJson ? MIME[".json"] : "text/plain; charset=utf-8" };
  if (status === 413) { headers.Connection = "close"; res.on("finish", () => res.req && res.req.destroy()); }
  res.writeHead(status, headers);
  res.end(isJson ? JSON.stringify(body) : body);
}

// Each visitor gets a fair number of AI calls, so a shared link can't run up the key's bill.
const AI_LIMIT = { localfit: 10, outlooknote: 12, translate: 120, geocode: 150, farmmap: 20, all: 600 }; // calls per visitor per 10 minutes; "all" = everyone together
const WINDOW = 10 * 60_000;
// X-Forwarded-For is only believed when TRUST_PROXY says how many proxies of ours sit in front of the server (0 = none: use the socket address).
// With N hops the visitor is the Nth address from the right; anything further left was written by the visitor and can be faked.
const TRUST_PROXY = Math.max(0, parseInt(process.env.TRUST_PROXY, 10) || 0);
function clientIp(req) {
  if (process.env.VERCEL && req.headers["x-real-ip"]) return String(req.headers["x-real-ip"]);
  if (TRUST_PROXY > 0) {
    const hops = String(req.headers["x-forwarded-for"] || "").split(",").map((x) => x.trim()).filter(Boolean);
    if (hops.length) return hops[Math.max(0, hops.length - TRUST_PROXY)];
  }
  return req.socket.remoteAddress || "";
}
const aiCalls = new Map(); // "visitor|kind" → recent call times
function overLimit(req, kind) {
  const who = clientIp(req);
  const now = Date.now();
  const recent = (key) => (aiCalls.get(key) || []).filter((t) => now - t < WINDOW);
  const mine = recent(`${who}|${kind}`), everyone = recent("*");
  const shared = kind !== "geocode" && kind !== "farmmap";   // address lookups are not AI calls: they do not use the shared AI budget
  if (mine.length >= AI_LIMIT[kind] || (shared && everyone.length >= AI_LIMIT.all)) return true;
  aiCalls.set(`${who}|${kind}`, [...mine, now]);
  if (shared) aiCalls.set("*", [...everyone, now]);
  if (aiCalls.size > 5000) for (const [k, v] of aiCalls) if (!v.some((t) => now - t < WINDOW)) aiCalls.delete(k);
  return false;
}
const FIT = require("./farmfit")({ geminiJSON, hasKey: () => !!GEMINI_KEY, readBody, send, UserError });
const MAP = require("./farmmap")({ send });
const TOO_MANY = { error: "That's a lot of requests in a short time. Wait a few minutes and try again." };
const oops = (res) => (e) => { console.error(e); send(res, 500, { error: "Something went wrong on our side. Try again in a minute." }); };

// A bug in one request must not take the whole demo down: log it and keep serving.
process.on("unhandledRejection", (e) => console.error("Unhandled rejection:", e && e.stack ? e.stack : e));
process.on("uncaughtException", (e) => console.error("Uncaught exception:", e && e.stack ? e.stack : e));

/* ---------------- translation (the farmer's language) ---------------- */
// The page's screen text, and what the farmer types in the chat, in another language. Keyed s0, s1, ... so every string
// comes back in its own slot. Kept while the server runs (and in the farmer's browser), so each sentence is translated once.
const translations = new Map(); // language -> Map(english -> translated)
async function handleTranslate(req, res) {
  if (!GEMINI_KEY) return send(res, 503, { error: NO_KEY });
  let language, strings;
  try { ({ language, strings } = JSON.parse(await readBody(req, 300_000))); } catch (e) { return send(res, e && e.status === 413 ? 413 : 400, { error: "Bad request." }); }
  if (typeof language !== "string" || !language.trim() || language.length > 40 || /[<>{}\n]/.test(language) || !Array.isArray(strings) || !strings.length || strings.length > 200 ||
      !strings.every((x) => typeof x === "string" && x.length <= 1500)) return send(res, 400, { error: "Bad request." });
  language = language.trim();
  if (!translations.has(language)) { if (translations.size >= 30) translations.delete(translations.keys().next().value); translations.set(language, new Map()); }
  const known = translations.get(language);
  const todo = [...new Set(strings.filter((x) => !known.has(x)))];
  if (todo.length) {
    const system = `Translate the screen text of a farm planning app into ${language}, for everyday farmers: short, plain, natural words, with the language's proper accents and punctuation.
Keep exactly as written: numbers, years, dates, units and $ amounts, {placeholders} in curly braces, symbols like → · … and %, the names "EcoShift", "NASA", "NASA POWER", "USDA" and "Gemini", county and state names, and field names such as "North 80", "Creek 40", "West 40" and "South 120".
If a text is already in ${language}, return it unchanged. Return the same keys with translated values.`;
    const batches = [];
    for (let i = 0; i < todo.length; i += 50) batches.push(todo.slice(i, i + 50));   // a response schema with too many keys is refused
    try {
      await Promise.all(batches.map(async (batch) => {
        const keyed = Object.fromEntries(batch.map((x, i) => [`s${i}`, x]));
        const schema = { type: "OBJECT", properties: Object.fromEntries(Object.keys(keyed).map((k) => [k, { type: "STRING" }])), required: Object.keys(keyed) };
        const out = await geminiJSON(system, JSON.stringify(keyed), schema);
        for (const [k, x] of Object.entries(keyed)) if (typeof out[k] === "string" && out[k].trim()) known.set(x, out[k]);
      }));
      if (known.size > 20000) for (const k of [...known.keys()].slice(0, 5000)) known.delete(k);
    } catch (e) {
      console.error(e);
      return send(res, 502, { error: e instanceof UserError ? e.message : "Couldn't reach the translation service." });
    }
  }
  send(res, 200, { translations: Object.fromEntries(strings.map((x) => [x, known.get(x) || x])) });
}

// One handler for every request. `node server.js` serves it on a port; on Vercel, api/*.js hand their requests to it.
function handle(req, res) {
  if (req.method === "POST" && req.url === "/api/localfit") return overLimit(req, "localfit") ? send(res, 429, TOO_MANY) : FIT.handleLocalFit(req, res).catch(oops(res));
  if (req.method === "GET" && req.url.startsWith("/api/outlook?")) return FIT.handleOutlook(req, res).catch(oops(res));
  if (req.method === "GET" && req.url.startsWith("/api/farmmap?")) return overLimit(req, "farmmap") ? send(res, 429, TOO_MANY) : MAP.handleFarmMap(req, res).catch(oops(res));
  if (req.method === "POST" && req.url === "/api/farmmap/upload") return overLimit(req, "farmmap") ? send(res, 429, TOO_MANY) : MAP.handleUpload(req, res).catch(oops(res));
  if (req.method === "GET" && req.url.startsWith("/api/farmmap/img/")) return MAP.handleImage(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/geocode?")) return overLimit(req, "geocode") ? send(res, 429, TOO_MANY) : FIT.handleGeocode(req, res).catch(oops(res));
  if (req.method === "POST" && req.url === "/api/translate") return overLimit(req, "translate") ? send(res, 429, TOO_MANY) : handleTranslate(req, res).catch(oops(res));
  if (req.method === "POST" && req.url === "/api/outlooknote") return overLimit(req, "outlooknote") ? send(res, 429, TOO_MANY) : FIT.handleOutlookNote(req, res).catch(oops(res));
  if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res);
  send(res, 405, "Method not allowed");
}
module.exports = { handle };
if (require.main !== module) return;

const server = http.createServer(handle);
server.requestTimeout = 120000;
server.listen(PORT, () => {
  console.log(`EcoShift running at http://localhost:${PORT}`);
  if (TRUST_PROXY) console.log(`Trusting ${TRUST_PROXY} proxy hop(s) for visitor addresses (TRUST_PROXY).`);
  if (GEMINI_KEY) console.log(`Gemini key loaded (model: ${geminiModel}).`);
  else if (process.env.CODESPACES === "true") console.log("No Gemini key yet: add a Codespaces secret named GEMINI_API_KEY for this repository (github.com/settings/codespaces), then rebuild or restart the codespace.");
  else console.log("No Gemini key yet: add GEMINI_API_KEY to .env and restart.");
});
