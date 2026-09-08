const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'media', 'center.html');
const target = path.join(root, 'test', 'preview.generated.html');

let html = fs.readFileSync(source, 'utf8');
html = html.replace(
  /\s*<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/i,
  ''
);
html = html
  .replaceAll('{{cssUri}}', '../media/center.css')
  .replaceAll('{{echartsUri}}', '../media/echarts.min.js')
  .replaceAll('{{appUri}}', '../media/center.js')
  .replaceAll('{{nonce}}', '')
  .replaceAll('{{initialTab}}', '')
  .replaceAll('{{initialSectorCode}}', '')
  .replaceAll('{{initialSectorKind}}', '')
  .replaceAll('{{cspSource}}', '');
html = html.replace(
  '<script nonce="" src="../media/echarts.min.js"></script>',
  '<script src="./preview-bootstrap.js"></script><script src="../media/echarts.min.js"></script>'
);
html = html.replace(
  '<script nonce="" src="../media/center.js"></script>',
  '<script src="../media/center.js"></script>'
);

fs.writeFileSync(target, html, 'utf8');
console.log(target);
