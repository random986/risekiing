import fs from 'fs';

const content = fs.readFileSync('scratch_results.txt', 'utf8');

const regex = /authorize/gi;
let match;
let count = 0;
while ((match = regex.exec(content)) !== null && count < 30) {
  const segment = content.substring(match.index - 300, match.index + 800);
  if (segment.toLowerCase().includes('bearer') || segment.toLowerCase().includes('websocket') || segment.toLowerCase().includes('token')) {
    count++;
    console.log(`\n=== Match ${count} (Index ${match.index}) ===`);
    console.log(segment.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
  }
}
