import fs from 'fs';

const content = fs.readFileSync('scratch_results.txt', 'utf8');

const regex = /websocket/gi;
let match;
let count = 0;
while ((match = regex.exec(content)) !== null && count < 20) {
  const segment = content.substring(match.index - 200, match.index + 800);
  if (segment.toLowerCase().includes('bearer') || segment.toLowerCase().includes('oauth') || segment.toLowerCase().includes('auth')) {
    count++;
    console.log(`\n=== Match ${count} (Index ${match.index}) ===`);
    console.log(segment.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
  }
}
