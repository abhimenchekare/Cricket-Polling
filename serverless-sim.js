'use strict';

/**
 * Simulates Vercel's serverless environment locally:
 *  - only the /api/* routes reach the function (static files are CDN-served)
 *  - the original URL is preserved through the rewrite
 *  - every request may land on a "cold" process
 *
 * Used by the test suite to prove api/index.js works without express.static.
 *
 *   node test/serverless-sim.js [port]
 */

require('dotenv').config({ quiet: true });
const http = require('http');

const PORT = Number(process.argv[2] || process.env.SIM_PORT || 4030);

// Exactly what Vercel loads for /api/*
const handler = require('../api/index');

const server = http.createServer((req, res) => {
  if (!req.url.startsWith('/api')) {
    res.statusCode = 404;
    res.setHeader('content-type', 'text/plain');
    return res.end('Static files are served by the CDN on Vercel');
  }
  handler(req, res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[sim] serverless function listening on http://localhost:${PORT}`);
});
