import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { info, error } from './logger.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', 'server', 'src');

function walk(dir) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            walk(filePath);
        } else if (filePath.endsWith('.ts')) {
            console.log(`Processing: ${filePath}`);
            let content = fs.readFileSync(filePath, 'utf8');
            
            // Replaces: getPrisma() with await getPrisma()
            // but NOT if it already has await beforehand.
            const updated = content.replace(/(?<!await\s+)getPrisma\(\)/g, 'await getPrisma()');
            
            if (content !== updated) {
                fs.writeFileSync(filePath, updated);
                console.log(`FIXED: ${filePath}`);
            }
        }
    }
}

export async function main() {
    info('Starting asynchronous database call update...');
    walk(root);
    info('DONE.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch((err) => {
        error('fix-async-db failed:', err?.message ?? err);
        process.exitCode = 1;
    });
}
