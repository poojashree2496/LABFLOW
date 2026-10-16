#!/usr/bin/env node
/**
 * Builds the hosted app into dist/ (Vercel runs this). It is the same src/Index.html with its includes inlined, plus
 * the install manifest, service worker and icons from web/. The page talks to the Apps Script /exec URL; nothing in
 * dist/ is secret (the OAuth client ID is public by design).
 *
 *   LABFLOW_API_URL=https://script.google.com/macros/s/<id>/exec LABFLOW_GOOGLE_CLIENT_ID=<id>.apps.googleusercontent.com npm run build:web
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const WEB = path.join(ROOT, 'web');
const API_RE = /^https:\/\/script\.google\.com\/(a\/macros\/[a-z0-9.-]+|macros)\/s\/[A-Za-z0-9_-]{20,}\/exec$/;
const CLIENT_RE = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

/** src/Index.html with every <?!= include('X') ?> replaced by src/X.html (what HtmlService does on the server). */
function render(file) {
  const read = (n) => fs.readFileSync(path.join(SRC, n + '.html'), 'utf8');
  return read(file).replace(/<\?!= include\('([A-Za-z_]+)'\) \?>/g, (_, n) => read(n));
}

/** The hosted page. config: { apiUrl, clientId, devSignIn? }. opts.sw = false leaves out the service worker. */
function page(config, opts) {
  opts = opts || {};
  const head = [
    '<link rel="manifest" href="/manifest.webmanifest">',
    '<link rel="icon" href="/icons/icon.svg" type="image/svg+xml">',
    '<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">',
    '<meta name="mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-title" content="LABFLOW">',
    '<meta name="apple-mobile-web-app-status-bar-style" content="default">',
    '<script>window.LF_CONFIG = ' + JSON.stringify(config).replace(/</g, '\u003c') + ';</script>'
  ].join('\n  ');
  let html = render('Index').replace('<?!= launch ?>', 'null').replace('</head>', '  ' + head + '\n</head>');
  if (opts.sw !== false) html = html.replace('</body>', "<script>if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));</script>\n</body>");
  if (/<\?/.test(html)) throw new Error('An Apps Script template tag was left in the page.');
  return html;
}

function build(config, out) {
  if (!API_RE.test(config.apiUrl || '')) throw new Error('LABFLOW_API_URL must be the web app /exec URL, e.g. https://script.google.com/macros/s/AKfy.../exec (got "' + (config.apiUrl || '') + '")');
  if (!CLIENT_RE.test(config.clientId || '')) throw new Error('LABFLOW_GOOGLE_CLIENT_ID must look like 1234-abcd.apps.googleusercontent.com (got "' + (config.clientId || '') + '")');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, 'icons'), { recursive: true });
  fs.writeFileSync(path.join(out, 'index.html'), page({ apiUrl: config.apiUrl, clientId: config.clientId }));
  fs.copyFileSync(path.join(WEB, 'manifest.webmanifest'), path.join(out, 'manifest.webmanifest'));
  const buildId = (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 12) || String(Date.now());
  fs.writeFileSync(path.join(out, 'sw.js'), fs.readFileSync(path.join(WEB, 'sw.js'), 'utf8').replace('__BUILD__', buildId));
  for (const f of fs.readdirSync(path.join(WEB, 'icons'))) fs.copyFileSync(path.join(WEB, 'icons', f), path.join(out, 'icons', f));
  return out;
}

if (require.main === module) {
  try {
    const out = build({ apiUrl: (process.env.LABFLOW_API_URL || '').trim(), clientId: (process.env.LABFLOW_GOOGLE_CLIENT_ID || '').trim() }, path.join(ROOT, 'dist'));
    console.log('Built the hosted app into ' + path.relative(ROOT, out) + '/');
  } catch (e) { console.error('build:web failed: ' + e.message); process.exit(1); }
}

module.exports = { render, page, build };
