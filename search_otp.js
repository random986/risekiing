import fs from 'fs';
const content = fs.readFileSync('scratch_results.txt', 'utf8');
const match = /otp/i.exec(content);
if (match) {
  console.log(`Found otp at index ${match.index}`);
  console.log(content.substring(match.index - 200, match.index + 500));
} else {
  console.log('No otp found');
}
