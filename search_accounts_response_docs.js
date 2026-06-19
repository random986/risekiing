import fs from 'fs';

const content = fs.readFileSync('scratch_results.txt', 'utf8');

const regex = /trading\/v1\/options\/accounts/gi;
let match = regex.exec(content);
if (match) {
  console.log(`Found rest endpoint documentation at index ${match.index}`);
  console.log(content.substring(match.index - 300, match.index + 2000).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
} else {
  console.log('Rest endpoint not found');
}
