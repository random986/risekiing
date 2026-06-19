import fs from 'fs';

const content = fs.readFileSync('scratch_results.txt', 'utf8');

const regex = /app_id/gi;
let match;
let count = 0;
while ((match = regex.exec(content)) !== null && count < 20) {
  const segment = content.substring(match.index - 300, match.index + 500);
  if (segment.toLowerCase().includes('websocket') || segment.toLowerCase().includes('ws:')) {
    count++;
    console.log(`\n=== Match ${count} (Index ${match.index}) ===`);
    console.log(segment.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
  }
}
if (count === 0) {
  console.log('No matches for app_id and websocket in scratch_results.txt');
}
