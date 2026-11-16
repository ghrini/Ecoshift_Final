// Vercel function: every /api/... request comes here (see the rewrite in vercel.json) and goes to the
// same handler `node server.js` uses. One function for all routes keeps the site within the Hobby plan's
// limit of 12 functions per deployment.
// The rewrite passes the original path as ?__p=...; if Vercel already hands us the original URL, it is kept.
module.exports = (req, res) => {
  const i = req.url.indexOf("?");
  if (i >= 0) {
    let p = null;
    const keep = [];
    for (const kv of req.url.slice(i + 1).split("&")) {
      if (kv.startsWith("__p=")) { try { p = decodeURIComponent(kv.slice(4)); } catch { p = kv.slice(4); } }
      else if (kv) keep.push(kv);
    }
    if (p !== null) {
      const here = req.url.slice(0, i);
      const pathname = here === "/api/index" || here === "/api/index.js" || here === "/api" ? "/api/" + p.replace(/^\/+/, "") : here;
      req.url = pathname + (keep.length ? "?" + keep.join("&") : "");
    }
  }
  return require("../server.js").handle(req, res);
};
