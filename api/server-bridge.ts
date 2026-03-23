import type { VercelRequest, VercelResponse } from '@vercel/node';
import { app } from '../server/src/index.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  await app.ready();
  app.server.emit('request', req, res);
}
