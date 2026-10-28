'use strict';

/**
 * Vercel Node.js function entry point.
 * Every request under /api/* is rewritten here (see vercel.json) and handled by Express.
 */

const app = require('../server/app');

module.exports = app;
