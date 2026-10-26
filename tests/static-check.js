'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function ids(html) {
  return new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
}

function referencedIds(js) {
  return new Set(
    [...js.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map((match) => match[1])
  );
}

for (const page of [
  { html: 'lock/lock.html', js: 'lock/lock.js' },
  { html: 'options/options.html', js: 'options/options.js' },
  { html: 'popup/popup.html', js: 'popup/popup.js' }
]) {
  const pageIds = ids(read(page.html));
  for (const id of referencedIds(read(page.js))) {
    assert.ok(pageIds.has(id), `${page.js} tham chiếu id không tồn tại: #${id}`);
  }
}

const manifest = JSON.parse(read('manifest.json'));
assert.equal(manifest.manifest_version, 3);
assert.ok(Array.isArray(manifest.permissions));
assert.ok(!manifest.permissions.includes('tabs'));

const files = [
  manifest.background.service_worker,
  manifest.options_ui.page,
  ...manifest.content_scripts.flatMap((entry) => entry.js),
  ...manifest.web_accessible_resources.flatMap((entry) => entry.resources),
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon)
];

for (const file of files) {
  assert.ok(fs.existsSync(path.join(ROOT, file)), `Thiếu tệp trong manifest: ${file}`);
}

for (const page of ['lock/lock.html', 'options/options.html', 'popup/popup.html']) {
  const html = read(page);
  assert.ok(!/<script(?![^>]+src=)[^>]*>/i.test(html), `${page} chứa script inline`);
  assert.ok(!/\son[a-z]+=/i.test(html), `${page} chứa event handler inline`);
}

const lockHtml = read('lock/lock.html');
assert.ok(lockHtml.includes('id="password"'));
assert.ok(lockHtml.includes('type="password"'));

const lockContent = read('content/lock-content.js');
assert.ok(lockContent.includes("mode: 'closed'"));
assert.ok(lockContent.includes('lock/lock.html'));
assert.ok(!lockContent.includes('password.value'));

const serviceWorker = read('background/service-worker.js');
assert.ok(serviceWorker.includes('PBKDF2'));
assert.ok(serviceWorker.includes('PBKDF2_ITERATIONS = 600000'));
assert.ok(!/console\.(log|info)\(/.test(serviceWorker), 'Service worker không được log dữ liệu');
assert.ok(!/localStorage\.setItem\([^)]*password/i.test(serviceWorker));

console.log('PASS: static checks');
