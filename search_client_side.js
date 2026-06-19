import fs from 'fs';

const text = fs.readFileSync('scratch_results_clean.txt', 'utf8');

const regex = /[^.]*(?:cors|browser|client-side|server-side|spa|token|backend)[^.]*\./gi;
const matches = text.match(regex);

if (matches) {
  console.log(`Found ${matches.length} sentences:`);
  const uniqueMatches = [...new Set(matches)];
  console.log(`Unique count: ${uniqueMatches.length}`);
  uniqueMatches.slice(0, 40).forEach((m, idx) => {
    console.log(`[${idx}]: ${m.trim()}\n`);
  });
} else {
  console.log("No sentences found.");
}
