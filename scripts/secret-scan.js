import fs from 'node:fs';
import path from 'node:path';

/**
 * Secret scan.
 *
 * This repo is public and the account behind it is real. A live Razorpay secret
 * committed once is compromised permanently, because git keeps it forever even
 * after the "remove key" commit.
 *
 * Wire it into git so it runs before every commit:
 *
 *   echo 'node scripts/secret-scan.js || exit 1' > .git/hooks/pre-commit
 *   chmod +x .git/hooks/pre-commit
 */

const PATTERNS = [
  { re: /rzp_live_[A-Za-z0-9]{10,}/, what: 'Razorpay LIVE key id' },
  { re: /rzp_test_[A-Za-z0-9]{14,}/, what: 'Razorpay test key id (real value, not the placeholder)' },
  { re: /sk-ant-[A-Za-z0-9_-]{20,}/, what: 'Anthropic API key' },
  { re: /whsec_[A-Za-z0-9]{16,}/, what: 'Webhook secret' },
  { re: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/, what: 'Private key' },
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'screenshots']);
const SKIP_FILES = new Set(['.env.example', 'secret-scan.js']);

let findings = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      continue;
    }
    if (SKIP_FILES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    let text;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    text.split('\n').forEach((line, i) => {
      for (const { re, what } of PATTERNS) {
        if (re.test(line)) {
          console.error(`  ${full}:${i + 1}  ${what}`);
          findings++;
        }
      }
    });
  }
}

console.log('\nScanning for committed secrets...\n');
walk(process.cwd());

if (fs.existsSync('.env') && fs.existsSync('.gitignore')) {
  const ignored = fs.readFileSync('.gitignore', 'utf8').split('\n').some((l) => l.trim() === '.env');
  if (!ignored) {
    console.error('  .env exists but is not in .gitignore');
    findings++;
  }
}

if (findings) {
  console.error(`\n${findings} problem(s). Do not commit.\n`);
  process.exit(1);
}
console.log('  Clean.\n');
