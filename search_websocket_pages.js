import fs from 'fs';

const content = fs.readFileSync('scratch_results.txt', 'utf8');

// Find the string "/docs/options/websocket" and see if there are other occurrences
const regex = /\"\/docs\/options\/websocket\"/gi;
let match;
let count = 0;
while ((match = regex.exec(content)) !== null && count < 10) {
  count++;
  console.log(`\n=== Match ${count} (Index ${match.index}) ===`);
  const sub = content.substring(match.index - 200, match.index + 800);
  console.log(sub.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
}
