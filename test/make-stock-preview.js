const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'media', 'stock-trend.html');
const target = path.join(root, 'test', 'stock-preview.generated.html');
let html = fs.readFileSync(source, 'utf8');
html = html.replace(/\s*<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/i, '');
html = html
  .replaceAll('{{cssUri}}', '../media/stock-trend.css')
  .replaceAll('{{echartsUri}}', '../media/echarts.min.js')
  .replaceAll('{{appUri}}', '../media/stock-trend.js')
  .replaceAll('{{nonce}}', '')
  .replaceAll('{{cspSource}}', '');
html = html.replace(
  '<script nonce="" src="../media/echarts.min.js"></script>',
  '<script src="./stock-preview-bootstrap.js"></script><script src="../media/echarts.min.js"></script>'
);
html = html.replace(
  '<script nonce="" src="../media/stock-trend.js"></script>',
  '<script src="../media/stock-trend.js"></script>'
);
fs.writeFileSync(target, html, 'utf8');
console.log(target);
