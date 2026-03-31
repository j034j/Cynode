import { execSync } from 'child_process';
import os from 'os';

/**
 * Cynode Postinstall Guard
 * Prevents Windows-only scripts from crashing the Vercel (Linux) build.
 */

const isVercel = process.env.VERCEL === '1';
const isWindows = os.platform() === 'win32';

if (isVercel) {
    console.log('[Deploy] Vercel environment detected. Skipping local-only Windows postinstall.');
} else {
    console.log('[Deploy] Local environment detected. Running postinstall scripts...');
    
    try {
        // Only run Windows-specific Prisma binary hack if on Windows
        if (isWindows) {
            console.log('[Deploy] Running Windows-specific Prisma postinstall...');
            execSync('node scripts/postinstall-prisma-win.mjs', { stdio: 'inherit' });
        }
        
        console.log('[Deploy] Syncing assets...');
        execSync('node scripts/sync-chartjs.mjs', { stdio: 'inherit' });
        execSync('node scripts/sync-desktop-assets.mjs', { stdio: 'inherit' });
        
        console.log('[Deploy] Local postinstall complete.');
    } catch (err) {
        console.error('[Deploy] Postinstall failed:', err.message);
        // We don't exit with 1 here to avoid blocking the install if a minor sync tool fails
    }
}
