import fs from 'fs';

const content = fs.readFileSync('scratch_results_clean.txt', 'utf8');

// Find occurrences of "browser", "cors", "client-side", "server-side", "spa"
const terms = ['browser', 'cors', 'client-side', 'server-side', 'spa', 'token'];
terms.forEach(term => {
  console.log(`\n=== Matches for: ${term} ===`);
  let idx = 0;
  let matchesCount = 0;
  while ((idx = content.toLowerCase().indexOf(term, idx)) !== -1) {
    const start = Math.max(0, idx - 150);
    const end = Math.min(content.length, idx + term.length + 150);
    console.log(`[${matchesCount++}]: ... ${content.substring(start, end).replace(/\s+/g, ' ').trim()} ...`);
    idx += term.length;
    if (matchesCount > 15) break; // Limit output
  }
});
