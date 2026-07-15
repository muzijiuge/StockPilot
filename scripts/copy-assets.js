const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const copies = [
  [
    path.join(root, 'node_modules', 'echarts', 'dist', 'echarts.min.js'),
    path.join(root, 'media', 'echarts.min.js')
  ],
  [
    path.join(root, 'node_modules', 'echarts', 'LICENSE'),
    path.join(root, 'third_party_licenses', 'ECHARTS_LICENSE.txt')
  ]
];

for (const pair of copies) {
  const source = pair[0];
  const target = pair[1];
  if (!fs.existsSync(source)) {
    throw new Error('Missing build dependency: ' + source);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

console.log('Copied ECharts runtime and license.');
