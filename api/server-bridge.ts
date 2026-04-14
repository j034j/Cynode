import type { VercelRequest, VercelResponse } from '@vercel/node';
import { app } from '../server/src/index.js';
import { getPrisma } from '../server/src/db.js';

// Cache successful DB health check for 30s to avoid hammering DB on every request
let lastDbHealthTime = 0;
let lastDbHealthOk = false;

async function checkDbHealth(timeoutMs = 500): Promise<boolean> {
  const now = Date.now();
  // Use cached result if within 30 seconds
  if (now - lastDbHealthTime < 30000) {
    return lastDbHealthOk;
  }

  try {
    const prisma = await getPrisma();
    // Use Promise.race with timeout to avoid hanging requests
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('DB health check timeout')), timeoutMs)
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    await app.ready();

    // Explicitly handle root/health check for the bridge
    if (req.url === '/api/server-bridge') {
      const dbOk = await checkDbHealth();
      if (!dbOk) {
        return res.status(503).json({ ok: false, error: 'Service Unavailable', message: 'Database unavailable' });
      }
      return res.status(200).json({ ok: true, message: 'Server Bridge Active' });
    }

    // For GET requests, allow request to proceed even if DB health check fails
    // (they'll get 500 errors from individual API calls, but at least they can try)
    if (req.method === 'GET') {
      // Check health but don't block GET requests
      const dbOk = await checkDbHealth(300);
      if (!dbOk) {
        console.warn(`[ServerBridge] Proceeding with degraded DB health for GET ${req.url}`);
      }
    } else {
      // For mutations (POST, PATCH, DELETE, PUT), enforce DB availability
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
