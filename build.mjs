// Builds dist/index.html from src/index.html, filling in RELAY_URL.
// RELAY_URL comes from the environment, or from a local .env file.
// With no RELAY_URL the page still builds and tells visitors no relay is configured.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

function fromDotEnv(key) {
  if (!existsSync('.env')) return '';
  const line = readFileSync('.env', 'utf8').split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim().replace(/^["']|["']$/g, '') : '';
}

const relay = (process.env.RELAY_URL || fromDotEnv('RELAY_URL')).trim().replace(/\/+$/, '');
if (relay && !/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~\/-]*)?$/.test(relay)) {
  console.error(`RELAY_URL is not a plain http(s) URL: ${relay}`);
  process.exit(1);
}
if (!relay) console.warn('RELAY_URL is not set: the page will show a "no relay configured" notice.');

const html = readFileSync('src/index.html', 'utf8');
if (!html.includes('__RELAY_URL__')) {
  console.error('src/index.html has no __RELAY_URL__ placeholder');
  process.exit(1);
}
mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', html.replaceAll('__RELAY_URL__', relay));
console.log(`Built dist/index.html${relay ? ` with relay ${relay}` : ' without a relay'}`);
