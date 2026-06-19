import fs from 'fs';

const content = fs.readFileSync('scratch_results.txt', 'utf8');
const regex = /jwt|authorize/gi;
let match;
let count = 0;
while ((match = regex.exec(content)) !== null && count < 20) {
  const segment = content.substring(match.index - 100, match.index + 200);
  if (segment.toLowerCase().includes('websocket')) {
    count++;
    console.log(`\n=== Match ${count} (Index ${match.index}) ===`);
    console.log(segment.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
  }
}
