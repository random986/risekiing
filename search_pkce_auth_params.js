import fs from 'fs';

const content = fs.readFileSync('scratch_results.txt', 'utf8');

const regex = /auth\.deriv\.com\/oauth2\/auth/gi;
let match = regex.exec(content);
while (match) {
  console.log(`Found match at index ${match.index}`);
  console.log(content.substring(match.index - 500, match.index + 2000).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
  match = regex.exec(content);
}
