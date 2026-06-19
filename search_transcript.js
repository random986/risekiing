import fs from 'fs';
import path from 'path';

const stepsDir = 'C:\\Users\\User\\.gemini\\antigravity\\brain\\8489707d-58e9-4e64-adc0-353b1df44c5f\\.system_generated\\steps';

let output = '';

function searchDir(dir) {
  const files = fs.readdirSync(dir);
  files.forEach(file => {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      searchDir(fullPath);
    } else if (file === 'content.md') {
      const content = fs.readFileSync(fullPath, 'utf8');
      if (content.includes('addOAuthAccounts') || content.includes('pkce_code_verifier') || content.includes('oauth_code_verifier')) {
        output += `\n===================================\nFOUND IN: ${fullPath}\n===================================\n`;
        const lines = content.split('\n');
        lines.forEach((line, idx) => {
          if (line.includes('addOAuthAccounts') || line.includes('pkce_code_verifier') || line.includes('oauth_code_verifier') || line.includes('grant_type')) {
            output += `\n[Line ${idx}]: ${line.trim()}\n`;
            for (let i = Math.max(0, idx - 8); i < Math.min(lines.length, idx + 12); i++) {
              output += `  ${i}: ${lines[i]}\n`;
            }
            output += '-----------------------------------\n';
          }
        });
      }
    }
  });
}

searchDir(stepsDir);
fs.writeFileSync('c:\\Users\\User\\Desktop\\Derivprinter\\scratch_token_results.txt', output, 'utf8');
console.log("Results written to scratch_token_results.txt");
