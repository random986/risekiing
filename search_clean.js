import fs from 'fs';

const text = fs.readFileSync('scratch_results_clean.txt', 'utf8');

// Find all matches of important terms
const terms = ['POST', 'browser', 'cors', 'token', 'exchange'];
terms.forEach(term => {
  console.log(`\n=== Matches for ${term} ===`);
  let idx = 0;
  let count = 0;
  while ((idx = text.toLowerCase().indexOf(term.toLowerCase(), idx)) !== -1) {
    const start = Math.max(0, idx - 120);
    const end = Math.min(text.length, idx + term.length + 120);
    const snippet = text.substring(start, end).replace(/\s+/g, ' ').trim();
    console.log(`[${count++}]: ... ${snippet} ...`);
    idx += term.length;
    if (count > 20) break;
  }
});
