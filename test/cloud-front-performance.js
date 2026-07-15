const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'media', 'center.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'media', 'center.css'), 'utf8');

assert.match(script, /function cloudDataFingerprint\(/, 'cloud data should be fingerprinted');
assert.match(
  script,
  /fingerprint === cloudRenderedFingerprint/,
  'unchanged cached/fresh payloads should skip duplicate setOption work'
);
assert.match(script, /id: 'market-cloud'/, 'the treemap series should have a stable id');
assert.match(script, /id: 'stock:' \+ item\.code/, 'stock nodes should have stable ids');
assert.match(script, /id: 'industry:' \+ industry/, 'industry nodes should have stable ids');
assert.match(
  script,
  /var animate = cloudHasOption && state\.cloud\.length <= 1200/,
  'large clouds and the first paint should not animate thousands of nodes'
);
assert.match(
  script,
  /animationDurationUpdate: animate \? 120 : 0/,
  'small updates should use a short bounded animation'
);
assert.match(
  script,
  /function scheduleCloudResize\(/,
  'cloud resize work should be animation-frame scheduled'
);
assert.equal(
  (script.match(/cloudChart\.resize\(/g) || []).length,
  1,
  'all cloud resize triggers should flow through one dimension-deduplicated path'
);
assert.match(script, /new ResizeObserver\(scheduleCloudResize\)/);
assert.match(styles, /\.cloud-chart\.is-ready\s*\{[\s\S]*?opacity:\s*1/);
assert.match(styles, /transition:\s*opacity 150ms/);
assert.match(styles, /prefers-reduced-motion:\s*reduce/);

console.log(
  JSON.stringify({
    stableTreemapIds: true,
    duplicateLayoutGuard: true,
    largeCloudAnimationDisabled: true,
    resizeCallSites: 1,
    cssFadeMs: 150
  })
);

