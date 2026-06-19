import fs from 'fs';

const text = fs.readFileSync('scratch_results.txt', 'utf8');
const lower = text.toLowerCase();

let idx = 0;
let count = 0;
while ((idx = lower.indexOf('cors', idx)) !== -1) {
  const start = Math.max(0, idx - 150);
  const end = Math.min(text.length, idx + 150);
  console.log(`[CORS Match ${count++}]:\n${text.substring(start, end).replace(/\s+/g, ' ').trim()}\n`);
  idx += 4;
}

idx = 0;
let spaCount = 0;
while ((idx = lower.indexOf('single page', idx)) !== -1) {
  const start = Math.max(0, idx - 150);
  const end = Math.min(text.length, idx + 150);
  console.log(`[SPA Match ${spaCount++}]:\n${text.substring(start, end).replace(/\s+/g, ' ').trim()}\n`);
  idx += 11;
}

idx = 0;
let clientCount = 0;
while ((idx = lower.indexOf('client-side', idx)) !== -1) {
  const start = Math.max(0, idx - 150);
  const end = Math.min(text.length, idx + 150);
  console.log(`[Client-side Match ${clientCount++}]:\n${text.substring(start, end).replace(/\s+/g, ' ').trim()}\n`);
  idx += 11;
}
