// Netlify Function: run the Express API (defined in server.js) serverlessly.
const serverless = require('serverless-http');
const app = require('../server.js');

module.exports.handler = serverless(app);
