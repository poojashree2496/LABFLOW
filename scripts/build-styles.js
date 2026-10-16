// Wrap the compiled Tailwind CSS in a <style> tag so HtmlService can include it (<?!= include('Styles') ?>).
const fs = require('fs'), path = require('path');
const css = fs.readFileSync(path.join(__dirname, '..', '.build', 'tailwind.css'), 'utf8');
if (/<\/style/i.test(css)) throw new Error('CSS contains </style');
fs.writeFileSync(path.join(__dirname, '..', 'src', 'Styles.html'), '<style>\n' + css + '\n</style>\n');
console.log('Styles.html written (' + css.length + ' bytes)');
