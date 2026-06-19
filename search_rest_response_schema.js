import fs from 'fs';

const content = fs.readFileSync('scratch_results.txt', 'utf8');

const regex = /trading\/v1\/options\/accounts/gi;
let match;
let count = 0;
while ((match = regex.exec(content)) !== null && count < 10) {
  count++;
  console.log(`\n=== Match ${count} (Index ${match.index}) ===`);
  // Print more characters around the match to find the JSON schema/example response
  const sub = content.substring(match.index - 500, match.index + 8000);
  
  // Let's look for JSON blocks in this chunk
  const jsonRegex = /\{[\s\S]*?\}/g;
  let jsonMatch;
  let jsonCount = 0;
  while ((jsonMatch = jsonRegex.exec(sub)) !== null && jsonCount < 5) {
    if (jsonMatch[0].includes('loginid') || jsonMatch[0].includes('token') || jsonMatch[0].includes('balance')) {
      jsonCount++;
      console.log(`  JSON Match ${jsonCount}:`);
      console.log(jsonMatch[0].substring(0, 800).replace(/\s+/g, ' '));
    }
  }
}
