// Vercel serverless entry: every /api/* request is rewritten here (see vercel.json)
// and handed to the same Express app that runs locally.
import { createApp } from '../backend/src/app.js';

let ready;

export default async function handler(req, res) {
  try {
    ready ??= createApp();
    const { app } = await ready;
    return app(req, res);
  } catch (err) {
    ready = undefined; // retry setup on the next request
    console.error('[startup]', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'The server is not configured correctly. Check the Vercel function logs.' }));
  }
}
