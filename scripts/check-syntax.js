// Syntax-check every .gs file (compiled as plain scripts, as Apps Script V8 does) and the inline <script> of HTML files.
const fs = require('fs'), path = require('path'), vm = require('vm');
let bad = 0;
const src = path.join(__dirname, '..', 'src');
for (const f of fs.readdirSync(src)) {
  const p = path.join(src, f);
  let code = null;
  if (f.endsWith('.gs')) code = fs.readFileSync(p, 'utf8');
  else if (f.endsWith('.html')) {
    const html = fs.readFileSync(p, 'utf8'); const parts = [];
    html.replace(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g, (m, c) => { if (c.trim() && !/src=/.test(m)) parts.push(c); });
    code = parts.join('\n;\n').replace(/<\?!?=?[\s\S]*?\?>/g, 'null'); // HtmlService template tags stand for a value
  }
  if (code === null || !code.trim()) continue;
  try { new vm.Script(code, { filename: f }); console.log('ok  ', f); }
  catch (e) { bad++; console.log('FAIL', f, e.message, (e.stack || '').split('\n')[0]); }
}
process.exit(bad ? 1 : 0);
