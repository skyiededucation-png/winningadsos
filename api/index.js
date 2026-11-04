// Vercel serverless entry: every /api/* request is rewritten here (see vercel.json).
const { handle } = require("../lib/app");
module.exports = (req, res) => handle(req, res);
