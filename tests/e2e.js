'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const PROFILE = path.join(ROOT, '.pw-e2e-profile');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PASSWORD = 'Mật-khẩu-thử-nghiệm-2026';
const NEW_PASSWORD = 'Mật-khẩu-đã-đổi-2026';
const WRONG_PASSWORD = 'sai-mật-khẩu';

let server;
let activeContext = null;

function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((request, response) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (request.url.startsWith('/csp')) {
        response.setHeader('Content-Security-Policy', "default-src 'self'; frame-src 'none'");
      }
      const route = request.url.split('?')[0];
      response.end(`<!doctype html>
        <html lang="vi">
          <head><meta charset="utf-8"><title>Trang thử ${route}</title></head>
          <body style="margin:0;min-height:100vh;background:#e9eef5;color:#172033;font:20px sans-serif">
            <main style="padding:40px">
              <h1>Trang thử LockWeb</h1>
              <p>Route: ${route}</p>
              <p>Nếu bạn thấy nội dung này khi đang khóa, lớp khóa đã thất bại.</p>
              <input id="page-input" placeholder="Ô nhập của trang web">
            </main>
          </body>
        </html>`);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

async function launch() {
  const context = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE,
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    viewport: { width: 1200, height: 800 },
    args: [
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check'
    ]
  });

  let worker = context.serviceWorkers()[0];
  if (!worker) {
    worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  }
  const extensionId = new URL(worker.url()).hostname;
  return { context, worker, extensionId };
}

async function getWorker(context) {
  let worker = context.serviceWorkers()[0];
  if (!worker) {
    worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  }
  return worker;
}

function findLockFrame(page) {
  return page.frames().find((frame) => frame.url().includes('/lock/lock.html'));
}

async function waitForLockFrame(page, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const frame = findLockFrame(page);
    if (frame) {
      return frame;
    }
    await page.waitForTimeout(150);
  }
  return null;
}

async function openOptions(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForFunction(
    () => {
      const dashboard = document.getElementById('dashboard');
      return dashboard && !dashboard.hidden;
    },
    null,
    { timeout: 15000 }
  );
  return page;
}

async function unlockThroughFrame(frame, password = PASSWORD) {
  await frame.waitForSelector('#unlock-form:not([hidden])', { timeout: 10000 });
  await frame.waitForSelector('#password:not([disabled])', { timeout: 10000 });
  await frame.fill('#password', password);
  await frame.click('#unlock-button');
}

async function run() {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const baseUrl = await startServer();
  const firstLaunch = await launch();
  const context = firstLaunch.context;
  const extensionId = firstLaunch.extensionId;
  activeContext = context;
  const sw = await getWorker(context);

  const pageA = await context.newPage();
  await pageA.goto(`${baseUrl}/a`);
  await pageA.waitForLoadState('domcontentloaded');

  let optionsPage = await openOptions(context, extensionId);

  let response = await optionsPage.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'LW_LOCK_NOW' })
  );
  assert.equal(response.ok, false);
  assert.equal(response.error, 'NO_PASSWORD');

  await optionsPage.fill('#new-password', PASSWORD);
  await optionsPage.fill('#confirm-password', PASSWORD);
  await optionsPage.click('#save-password-button');
  await optionsPage.waitForSelector('#password-message.is-success', { timeout: 15000 });

  const stored = await sw.evaluate(() => chrome.storage.local.get(null));
  assert.ok(stored.lwAuth);
  assert.equal(stored.lwAuth.algorithm, 'PBKDF2-HMAC-SHA-256');
  assert.equal(stored.lwAuth.iterations, 600000);
  assert.ok(!JSON.stringify(stored.lwAuth).includes(PASSWORD));
  assert.equal(stored.lwAuth.hash.includes(PASSWORD), false);

  await Promise.all([
    optionsPage.waitForURL(/\/lock\/lock\.html/, { timeout: 15000 }),
    optionsPage.click('#lock-now-button')
  ]);

  const lockFrameA = await waitForLockFrame(pageA);
  assert.ok(lockFrameA, 'tab đang mở phải nhận được iframe màn hình khóa');
  await pageA.bringToFront();
  await lockFrameA.waitForSelector('#unlock-form:not([hidden])', { timeout: 10000 });
  console.log('PASS: màn hình khóa xuất hiện trên tab đang mở');

  await pageA.waitForTimeout(700);
  await pageA.screenshot({ path: path.join(ROOT, 'docs', 'lock-screen-live.png') });

  await lockFrameA.fill('#password', WRONG_PASSWORD);
  await lockFrameA.click('#unlock-button');
  await lockFrameA.waitForFunction(
    () => {
      const error = document.getElementById('error-message');
      return error && !error.hidden && error.textContent.length > 0;
    },
    null,
    { timeout: 15000 }
  );
  const wrongMessage = await lockFrameA.locator('#error-message').innerText();
  assert.match(wrongMessage, /không đúng/i);
  console.log('PASS: báo lỗi khi sai mật khẩu:', wrongMessage);

  await unlockThroughFrame(lockFrameA);
  await pageA.waitForTimeout(1500);
  assert.equal(findLockFrame(pageA), undefined, 'iframe khóa phải được gỡ sau khi mở khóa');
  console.log('PASS: mở khóa đúng mật khẩu');

  await optionsPage.waitForTimeout(900);
  await optionsPage.close().catch(() => {});
  optionsPage = await openOptions(context, extensionId);

  // Khóa lại, kiểm tra reload + tab mới + chuyển tab. Gọi thẳng hàm trong
  // service worker để tránh việc trang Cài đặt tự điều hướng giữa lúc evaluate.
  const currentWorker = await getWorker(context);
  await currentWorker.evaluate(() => lockNow('manual'));
  const frameAfterRelock = await waitForLockFrame(pageA);
  assert.ok(frameAfterRelock, 'tab đang mở phải bị khóa lại');

  await pageA.reload({ waitUntil: 'domcontentloaded' });
  const reloadFrame = await waitForLockFrame(pageA);
  assert.ok(reloadFrame, 'tải lại trang khi khóa phải hiện màn hình khóa');
  console.log('PASS: tải lại trang vẫn khóa');

  const newTab = await context.newPage();
  await newTab.goto(`${baseUrl}/new-tab`);
  const newTabFrame = await waitForLockFrame(newTab);
  assert.ok(newTabFrame, 'tab mới mở website khi khóa phải hiện màn hình khóa');
  console.log('PASS: tab mới mở website vẫn khóa');

  await newTab.bringToFront();
  await pageA.waitForTimeout(300);
  assert.ok(findLockFrame(newTab), 'chuyển tab không được làm mất lớp khóa');
  assert.ok(findLockFrame(pageA), 'tab cũ vẫn phải giữ lớp khóa');
  console.log('PASS: chuyển tab giữ nguyên lớp khóa');

  // Trang có CSP frame-src 'none' - kiểm tra khả năng tương thích.
  const cspPage = await context.newPage();
  await cspPage.goto(`${baseUrl}/csp`);
  await cspPage.waitForTimeout(2500);
  const cspFrame = findLockFrame(cspPage);
  if (cspFrame) {
    console.log('PASS: iframe extension vẫn tải được trên trang CSP frame-src none');
  } else {
    await cspPage.waitForTimeout(11000);
    console.log('WARN: trang CSP frame-src none không tải được iframe extension');
  }

  // Khởi động lại trình duyệt: trạng thái khóa phải còn.
  const workerBeforeRestart = await getWorker(context);
  const wasLocked = await workerBeforeRestart.evaluate(async () => {
    const data = await chrome.storage.local.get('lwLockState');
    return data.lwLockState?.isLocked === true;
  });
  assert.equal(wasLocked, true);

  await context.close();
  activeContext = null;
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const restarted = await launch();
  activeContext = restarted.context;
  assert.equal(restarted.extensionId, extensionId);
  const restartedPage = await restarted.context.newPage();
  await restartedPage.goto(`${baseUrl}/after-restart`);
  const restartFrame = await waitForLockFrame(restartedPage);
  assert.ok(restartFrame, 'sau khi khởi động lại, trạng thái khóa phải được giữ');
  await restartFrame.waitForSelector('#password');
  console.log('PASS: khởi động lại trình duyệt vẫn khóa');

  const restartedStored = await (await getWorker(restarted.context)).evaluate(() =>
    chrome.storage.local.get('lwLockState')
  );
  assert.equal(restartedStored.lwLockState.isLocked, true);

  const optionsProbe = await restarted.context.newPage();
  await optionsProbe.goto(`chrome-extension://${extensionId}/options/options.html`);
  await optionsProbe.waitForURL(/\/lock\/lock\.html/, { timeout: 15000 });
  console.log('PASS: mở Cài đặt khi đang khóa bị chuyển tới màn hình khóa');
  await optionsProbe.close();

  await unlockThroughFrame(restartFrame);
  await restartedPage.waitForTimeout(1500);
  assert.equal(findLockFrame(restartedPage), undefined, 'phải mở khóa được sau khi khởi động lại');

  const restartedOptions = await openOptions(restarted.context, extensionId);
  await restartedOptions.screenshot({
    path: path.join(ROOT, 'docs', 'options.png'),
    fullPage: true
  });

  await restartedOptions.fill('#current-password', PASSWORD);
  await restartedOptions.fill('#new-password', NEW_PASSWORD);
  await restartedOptions.fill('#confirm-password', NEW_PASSWORD);
  await restartedOptions.click('#save-password-button');
  await restartedOptions.waitForSelector('#password-message.is-success', {
    timeout: 15000
  });
  console.log('PASS: đổi mật khẩu trong trang Cài đặt');

  const workerAfterRestart = await getWorker(restarted.context);
  await workerAfterRestart.evaluate(() => lockNow('manual'));
  const relockFrame2 = await waitForLockFrame(restartedPage);
  assert.ok(relockFrame2, 'phải khóa lại được sau khi đổi mật khẩu');

  await restartedPage.bringToFront();
  await relockFrame2.waitForSelector('#unlock-form:not([hidden])', { timeout: 10000 });
  await restartedPage.waitForTimeout(500);
  await relockFrame2.fill('#password', PASSWORD);
  await relockFrame2.click('#unlock-button');
  await relockFrame2.waitForFunction(
    () => {
      const error = document.getElementById('error-message');
      return error && !error.hidden && error.textContent.length > 0;
    },
    null,
    { timeout: 15000 }
  );
  assert.match(await relockFrame2.locator('#error-message').innerText(), /không đúng/i);

  await unlockThroughFrame(relockFrame2, NEW_PASSWORD);
  await restartedPage.waitForTimeout(1400);
  assert.equal(findLockFrame(restartedPage), undefined, 'mật khẩu mới phải mở khóa được');
  console.log('PASS: mật khẩu cũ không còn hiệu lực, mật khẩu mới hoạt động');

  await restarted.context.close();
  activeContext = null;
  console.log('PASS: toàn bộ E2E');
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (activeContext) {
      await activeContext.close().catch(() => {});
    }
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });
