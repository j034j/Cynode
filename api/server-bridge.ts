import type { VercelRequest, VercelResponse } from '@vercel/node';
import { app } from '../server/src/index.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    await app.ready();
    
    // Explicitly handle root/health check for the bridge
    if (req.url === '/api/server-bridge') {
      return res.status(200).json({ ok: true, message: 'Server Bridge Active' });
    }

    // Pass the request to Fastify
    app.server.emit('request', req, res);
  } catch (err) {
    console.error('Server Bridge Error:', err);
    res.status(500).json({ error: 'Internal Server Error', message: err instanceof Error ? err.message : String(err) });
  }
}
