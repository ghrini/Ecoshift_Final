// Vercel function: hands the request to the same handler `node server.js` uses.
module.exports = (req, res) => require("../server.js").handle(req, res);
