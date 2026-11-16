// Vercel function: every /api/... request comes here (see the rewrite in vercel.json) and goes to the
// same handler `node server.js` uses. One function for all routes keeps the site within the Hobby plan's
// limit of 12 functions per deployment.
// Vercel hands over the original URL with the rewrite's own query added (?__p=<path>&path=<path>); those are
// taken off again so the handler sees exactly the address the browser asked for.
module.exports = (req, res) => {
  const i = req.url.indexOf("?");
  if (i >= 0) {
    let p = null;
    const pairs = req.url.slice(i + 1).split("&").filter(Boolean);
    for (const kv of pairs) if (kv.startsWith("__p=")) { try { p = decodeURIComponent(kv.slice(4)); } catch { p = kv.slice(4); } }
    if (p !== null) {
      const keep = pairs.filter((kv) => {
        if (kv.startsWith("__p=")) return false;
        if (kv.startsWith("path=")) { let v = kv.slice(5); try { v = decodeURIComponent(v); } catch { /* keep raw */ } return v !== p; }
        return true;
      });
      const here = req.url.slice(0, i);
      const pathname = here === "/api/index" || here === "/api/index.js" || here === "/api" ? "/api/" + p.replace(/^\/+/, "") : here;
      req.url = pathname + (keep.length ? "?" + keep.join("&") : "");
    }
  }
  return require("../server.js").handle(req, res);
};
