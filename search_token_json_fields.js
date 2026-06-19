import fs from 'fs';

const content = fs.readFileSync('scratch_results.txt', 'utf8');

const regex = /access_token/gi;
let match;
let count = 0;
while ((match = regex.exec(content)) !== null && count < 20) {
  count++;
  console.log(`\n=== Match ${count} (Index ${match.index}) ===`);
  const segment = content.substring(match.index - 300, match.index + 900);
  console.log(segment.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
}
if (count === 0) {
  console.log('No matches for "access_token" in scratch_results.txt');
}
