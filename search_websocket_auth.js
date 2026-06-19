import fs from 'fs';

const content = fs.readFileSync('scratch_results.txt', 'utf8');

const regex = /"authorize"/gi;
let match;
let count = 0;
while ((match = regex.exec(content)) !== null && count < 20) {
  const segment = content.substring(match.index - 200, match.index + 800);
  if (segment.toLowerCase().includes('schema') || segment.toLowerCase().includes('request') || segment.toLowerCase().includes('parameters')) {
    count++;
    console.log(`\n=== Match ${count} (Index ${match.index}) ===`);
    console.log(segment.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
  }
}
if (count === 0) {
  console.log('No matches for "authorize" parameters in scratch_results.txt');
}
