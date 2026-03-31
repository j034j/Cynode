import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', 'public');

function walk(dir) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            walk(filePath);
        } else if (filePath.endsWith('.html') || filePath.endsWith('.js')) {
            console.log(`Processing: ${filePath}`);
            let content = fs.readFileSync(filePath, 'utf8');
            
            // Replaces http://127.0.0.1:3000 or http://localhost:3000 with relative links
            let updated = content.replace(/http:\/\/127\.0\.0\.1:3000/g, '');
            updated = updated.replace(/http:\/\/localhost:3000/g, '');
            
            if (content !== updated) {
                fs.writeFileSync(filePath, updated);
                console.log(`FIXED URLS: ${filePath}`);
            }
        }
    }
}

console.log('Starting frontend URL update...');
walk(root);
console.log('DONE.');
