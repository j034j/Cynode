import type { VercelRequest, VercelResponse } from '@vercel/node';
import { app } from '../server/src/index.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    await app.ready();
    // Vercel can sometimes lose the method in the emit if not careful
    // Ensure Fastify handles the request correctly
    app.server.emit('request', req, res);
  } catch (err) {
    console.error('Server Bridge Error:', err);
    res.status(500).json({ error: 'Internal Server Error', message: err instanceof Error ? err.message : String(err) });
  }
}
