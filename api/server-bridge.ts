import type { VercelRequest, VercelResponse } from '@vercel/node';
import { app } from '../server/src/index.js';
import { getPrisma } from '../server/src/db.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    await app.ready();
    // Perform a lightweight DB health check so the bridge returns 503 when
    // the database isn't available (instead of serving a partially functional app).
    try {
      const prisma = await getPrisma();
      // A simple cheap query to validate connectivity
      // Some adapters support $executeRaw; use $queryRaw for portability.
      await prisma.$queryRaw`SELECT 1`;
    } catch (dbErr) {
      console.error('Server Bridge DB health check failed:', dbErr);
      const detail = dbErr instanceof Error ? dbErr.message : String(dbErr);
      return res.status(503).json({ ok: false, error: 'Service Unavailable', message: `Database unavailable: ${detail}` });
    }

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
