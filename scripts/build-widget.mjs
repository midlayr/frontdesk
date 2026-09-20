// Inlines widget/chat.js into a TS module so the Worker can serve it without R2 or Pages.
import { readFileSync, writeFileSync } from 'node:fs';
const src = readFileSync('widget/chat.js', 'utf8');
const esc = src.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
writeFileSync('src/widget-asset.ts',
  '// Generated from widget/chat.js — edit that file, then run: npm run build:widget\n' +
  'export const CHAT_JS = `' + esc + '`;\n');
console.log('src/widget-asset.ts written from widget/chat.js');

// The plain-HTML console at /console predates the React app and stays as a dependency-free
// fallback for poking at the API. The real rep app is web/, served from [assets].
for (const [file, out, name] of [
  ['web/console.html', 'src/web-console.ts', 'CONSOLE_HTML'],
]) {
  const html = readFileSync(file, 'utf8');
  const e = html.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  writeFileSync(out, `// Generated from ${file} — edit that file, then run: npm run build:web\n` +
    `export const ${name} = \`` + e + '`;\n');
  console.log(out, 'written from', file);
}
