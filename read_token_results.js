import fs from 'fs';

const content = fs.readFileSync('scratch_token_results.txt', 'utf8');
console.log("Token results length:", content.length);
console.log("Snippet:", content.substring(0, 800));
