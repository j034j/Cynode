import type { IncomingMessage, ServerResponse } from 'node:http';
import { app } from '../server/src/index.js';
import { getPrisma } from '../server/src/db.js';

type BridgeRequest = IncomingMessage & {
  url?: string;
  method?: string;
};

// Cache successful DB health checks briefly to avoid hammering a cold database
// on every request while still surfacing temporary unavailability as retryable 503s.
let lastDbHealthTime = 0;
let lastDbHealthOk = false;

async function checkDbHealth(timeoutMs = 500): Promise<boolean> {
  const now = Date.now();
  if (now - lastDbHealthTime < 30000) {
    return lastDbHealthOk;
  }

  try {
    const prisma = await getPrisma();
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('DB health check timeout')), timeoutMs),
      ),
    ]);
    lastDbHealthOk = true;
    lastDbHealthTime = now;
    return true;
  } catch (err) {
    console.warn('Server Bridge DB health check failed:', err instanceof Error ? err.message : String(err));
    lastDbHealthOk = false;
    lastDbHealthTime = now;
    return false;
  }
}

export default async function handler(req: BridgeRequest, res: ServerResponse) {
  try {
    await app.ready();

    // Check if it's a direct health ping to the bridge
    if (req.url === '/api/server-bridge' && req.headers['x-now-route-matches'] === undefined) {
      const dbOk = await checkDbHealth();
      if (!dbOk) {
        return res.status(503).json({ ok: false, error: 'Service Unavailable', message: 'Database unavailable' });
      }
      return res.status(200).json({ ok: true, message: 'Server Bridge Active' });
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const dbOk = await checkDbHealth(300);
      if (!dbOk) {
        console.warn(`[ServerBridge] Proceeding with degraded DB health for ${req.method} ${req.url}`);
      }
    } else {
      const dbOk = await checkDbHealth(300);
      if (!dbOk) {
        return res.status(503).json({
          ok: false,
          error: 'Service Unavailable',
          message: 'Database temporarily unavailable. Please try again in a moment.',
        });
      }
    }

    // Pass the request to Fastify
    app.server.emit('request', req, res);
  } catch (err) {
    console.error('Server Bridge Error:', err);
    res.status(500).json({
      error: 'Internal Server Error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
