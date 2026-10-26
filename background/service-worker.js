/**
 * LockWeb - MV3 service worker.
 *
 * Toàn bộ việc băm / xác minh mật khẩu diễn ra tại đây. Service worker chỉ lưu
 * salt + hash PBKDF2, không bao giờ lưu hoặc trả về mật khẩu dạng văn bản.
 */
'use strict';

const STORAGE = Object.freeze({
  SETTINGS: 'lwSettings',
  AUTH: 'lwAuth',
  LOCK_STATE: 'lwLockState',
  ATTEMPTS: 'lwAttempts',
  VIEW_TOKENS: 'lwViewTokens',
  LAST_ACTIVITY: 'lwLastActivityAt'
});

const DEFAULT_SETTINGS = Object.freeze({
  autoLockEnabled: true,
  idleMinutes: 5,
  openPanelOnIcon: false
});

const UNLOCKED_STATE = Object.freeze({
  isLocked: false,
  lockedAt: null,
  reason: null,
  unlockedAt: null
});

const ALARM_NAME = 'lw-auto-lock';
const PBKDF2_ITERATIONS = 600000;
const MAX_FAILED_ATTEMPTS = 5;
const COOLDOWN_MS = 30 * 1000;
const MAX_PASSWORD_LENGTH = 1024;
const MIN_PASSWORD_LENGTH = 8;
const ACTIVITY_THROTTLE_MS = 5000;
const VIEW_TOKEN_PATTERN = /^[a-f0-9]{32}$/;
const EXTENSION_ORIGIN = chrome.runtime.getURL('');

let initPromise = null;
let lockOperation = null;
let authOperation = Promise.resolve();
let cachedActivityAt = 0;
let lastActivityPersistAt = 0;

function serializeAuthOperation(task) {
  const run = authOperation.then(task, task);
  authOperation = run.catch(() => {});
  return run;
}

function inBackground(promise) {
  Promise.resolve(promise).catch((error) => {
    // Không log nội dung message: có thể chứa mật khẩu.
    console.error('[LockWeb] Lỗi xử lý nền:', error && error.message ? error.message : error);
  });
}

function toSafeInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const idleMinutes = Math.min(120, Math.max(1, toSafeInteger(source.idleMinutes, DEFAULT_SETTINGS.idleMinutes)));
  return {
    autoLockEnabled: source.autoLockEnabled !== false,
    idleMinutes,
    openPanelOnIcon: source.openPanelOnIcon === true
  };
}

function normalizeLockState(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    isLocked: source.isLocked === true,
    lockedAt: Number.isFinite(Number(source.lockedAt)) ? Number(source.lockedAt) : null,
    reason: typeof source.reason === 'string' ? source.reason : null,
    unlockedAt: Number.isFinite(Number(source.unlockedAt)) ? Number(source.unlockedAt) : null
  };
}

function normalizeAttempts(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    count: Math.min(100, Math.max(0, toSafeInteger(source.count, 0))),
    blockedUntil: Math.max(0, toSafeInteger(source.blockedUntil, 0))
  };
}

function isAuthConfigured(auth) {
  return Boolean(
    auth &&
      typeof auth === 'object' &&
      auth.version === 1 &&
      auth.algorithm === 'PBKDF2-HMAC-SHA-256' &&
      Number.isInteger(auth.iterations) &&
      auth.iterations >= 100000 &&
      auth.iterations <= 2000000 &&
      typeof auth.salt === 'string' &&
      auth.salt.length >= 16 &&
      typeof auth.hash === 'string' &&
      auth.hash.length >= 32
  );
}

function makeUnlockedState() {
  return { ...UNLOCKED_STATE };
}

async function readCore() {
  const data = await chrome.storage.local.get([
    STORAGE.SETTINGS,
    STORAGE.AUTH,
    STORAGE.LOCK_STATE,
    STORAGE.ATTEMPTS
  ]);

  return {
    settings: normalizeSettings(data[STORAGE.SETTINGS]),
    auth: data[STORAGE.AUTH] || null,
    lockState: normalizeLockState(data[STORAGE.LOCK_STATE]),
    attempts: normalizeAttempts(data[STORAGE.ATTEMPTS])
  };
}

async function syncActionIcon(settings, lockState, auth) {
  const hasPassword = isAuthConfigured(auth);
  let title = 'LockWeb — Khóa trình duyệt ngay';

  if (lockState.isLocked) {
    title = 'LockWeb — Đang khóa. Nhập mật khẩu trên trang để mở khóa.';
  } else if (!hasPassword) {
    title = 'LockWeb — Chưa đặt mật khẩu. Bấm để mở Cài đặt.';
  }

  await Promise.allSettled([
    chrome.action.setBadgeText({ text: lockState.isLocked ? 'LOCK' : '' }),
    chrome.action.setBadgeBackgroundColor({ color: '#b45309' }),
    chrome.action.setTitle({ title }),
    chrome.action.setPopup({ popup: settings.openPanelOnIcon ? 'popup/popup.html' : '' })
  ]);
}

async function getLastActivityAt() {
  if (cachedActivityAt > 0) {
    return cachedActivityAt;
  }

  const data = await chrome.storage.session.get(STORAGE.LAST_ACTIVITY);
  const value = Number(data[STORAGE.LAST_ACTIVITY]);
  cachedActivityAt = Number.isFinite(value) && value > 0 ? value : 0;
  return cachedActivityAt;
}

async function setLastActivityAt(timestamp) {
  cachedActivityAt = timestamp;
  lastActivityPersistAt = Date.now();
  await chrome.storage.session.set({ [STORAGE.LAST_ACTIVITY]: timestamp });
}

async function scheduleAutoLock(fromTimestamp) {
  const { settings, lockState, auth } = await readCore();

  if (lockState.isLocked || !settings.autoLockEnabled || !isAuthConfigured(auth)) {
    await chrome.alarms.clear(ALARM_NAME);
    return;
  }

  const when = fromTimestamp + settings.idleMinutes * 60 * 1000;
  await chrome.alarms.create(ALARM_NAME, { when });
}

async function ensureAutoLockTimer() {
  const { settings, lockState, auth } = await readCore();

  if (lockState.isLocked || !settings.autoLockEnabled || !isAuthConfigured(auth)) {
    await chrome.alarms.clear(ALARM_NAME);
    return;
  }

  const existing = await chrome.alarms.get(ALARM_NAME);
  if (existing) {
    return;
  }

  let lastActivityAt = await getLastActivityAt();
  if (!lastActivityAt) {
    lastActivityAt = Date.now();
    await setLastActivityAt(lastActivityAt);
  }
  await scheduleAutoLock(lastActivityAt);
}

async function ensureInitialized() {
  if (!initPromise) {
    initPromise = (async () => {
      const data = await chrome.storage.local.get([
        STORAGE.SETTINGS,
        STORAGE.AUTH,
        STORAGE.LOCK_STATE,
        STORAGE.ATTEMPTS
      ]);

      const updates = {};
      const settings = normalizeSettings(data[STORAGE.SETTINGS]);
      let lockState = normalizeLockState(data[STORAGE.LOCK_STATE]);
      const auth = data[STORAGE.AUTH] || null;

      if (!data[STORAGE.SETTINGS]) {
        updates[STORAGE.SETTINGS] = settings;
      }
      if (!data[STORAGE.ATTEMPTS]) {
        updates[STORAGE.ATTEMPTS] = normalizeAttempts(null);
      }
      if (!data[STORAGE.LOCK_STATE]) {
        updates[STORAGE.LOCK_STATE] = lockState;
      }

      // Không để trạng thái khóa mồ côi nếu dữ liệu xác thực bị thiếu/hỏng.
      // Người có quyền sửa storage của extension vốn đã có thể gỡ extension.
      if (lockState.isLocked && !isAuthConfigured(auth)) {
        lockState = makeUnlockedState();
        updates[STORAGE.LOCK_STATE] = lockState;
        console.warn('[LockWeb] Đã bỏ trạng thái khóa vì không có cấu hình mật khẩu hợp lệ.');
      }

      if (Object.keys(updates).length > 0) {
        await chrome.storage.local.set(updates);
      }

      await syncActionIcon(settings, lockState, auth);
      await ensureAutoLockTimer();

      return { settings, lockState, auth };
    })().catch((error) => {
      initPromise = null;
      throw error;
    });
  }

  return initPromise;
}

async function getAttempts() {
  const data = await chrome.storage.local.get(STORAGE.ATTEMPTS);
  return normalizeAttempts(data[STORAGE.ATTEMPTS]);
}

async function resetAttempts() {
  await chrome.storage.local.set({
    [STORAGE.ATTEMPTS]: { count: 0, blockedUntil: 0 }
  });
}

function getCooldownSeconds(attempts, now = Date.now()) {
  return Math.max(0, Math.ceil((attempts.blockedUntil - now) / 1000));
}

async function recordFailedAttempt() {
  const now = Date.now();
  const attempts = await getAttempts();

  if (attempts.blockedUntil > now) {
    return {
      attemptsRemaining: 0,
      cooldownSeconds: getCooldownSeconds(attempts, now)
    };
  }

  let count = attempts.count + 1;
  let blockedUntil = 0;

  if (count >= MAX_FAILED_ATTEMPTS) {
    count = 0;
    blockedUntil = now + COOLDOWN_MS;
  }

  await chrome.storage.local.set({
    [STORAGE.ATTEMPTS]: { count, blockedUntil }
  });

  return {
    attemptsRemaining: blockedUntil ? 0 : Math.max(0, MAX_FAILED_ATTEMPTS - count),
    cooldownSeconds: blockedUntil ? Math.ceil(COOLDOWN_MS / 1000) : 0
  };
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }

  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

async function derivePasswordHash(password, salt, iterations) {
  const normalizedPassword = password.normalize('NFC');
  const passwordBytes = new TextEncoder().encode(normalizedPassword);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    passwordBytes,
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations,
      hash: 'SHA-256'
    },
    keyMaterial,
    256
  );

  return new Uint8Array(bits);
}

async function createAuthRecord(password) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await derivePasswordHash(password, salt, PBKDF2_ITERATIONS);

  return {
    version: 1,
    algorithm: 'PBKDF2-HMAC-SHA-256',
    iterations: PBKDF2_ITERATIONS,
    salt: bytesToBase64(salt),
    hash: bytesToBase64(hash),
    createdAt: Date.now()
  };
}

async function verifyPassword(password, auth) {
  if (!isAuthConfigured(auth) || typeof password !== 'string') {
    return false;
  }

  try {
    const salt = base64ToBytes(auth.salt);
    const expected = base64ToBytes(auth.hash);
    const actual = await derivePasswordHash(password, salt, auth.iterations);
    return constantTimeEqual(actual, expected);
  } catch (error) {
    console.error('[LockWeb] Không thể xác minh mật khẩu:', error && error.message ? error.message : error);
    return false;
  }
}

function validateNewPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    return 'EMPTY_PASSWORD';
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return 'PASSWORD_TOO_SHORT';
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return 'PASSWORD_TOO_LONG';
  }
  if (password.trim().length === 0) {
    return 'PASSWORD_TOO_WEAK';
  }
  return null;
}

async function openOptionsPageSafely() {
  try {
    await chrome.runtime.openOptionsPage();
  } catch (error) {
    try {
      await chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') });
    } catch (fallbackError) {
      console.error('[LockWeb] Không mở được trang Cài đặt:', fallbackError);
    }
  }
}

async function injectLockIntoAllTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (error) {
    console.error('[LockWeb] Không thể liệt kê tab:', error);
    return;
  }

  const tabIds = tabs
    .map((tab) => tab.id)
    .filter((tabId) => Number.isInteger(tabId));

  // Chia lô để tránh mở quá nhiều tác vụ scripting cùng lúc.
  for (let offset = 0; offset < tabIds.length; offset += 6) {
    const batch = tabIds.slice(offset, offset + 6);
    await Promise.allSettled(
      batch.map(async (tabId) => {
        try {
          await chrome.scripting.executeScript({
            target: { tabId, frameIds: [0] },
            files: ['content/lock-content.js']
          });
        } catch (_) {
          // chrome://, edge://, Chrome Web Store, trang của extension khác,
          // hoặc trang chưa được cấp quyền file:// không thể chèn content script.
        }
      })
    );
  }
}

async function broadcastLockState(isLocked) {
  try {
    await chrome.runtime.sendMessage({
      type: 'LW_LOCK_STATE_CHANGED',
      isLocked
    });
  } catch (_) {
    // Không có receiver nào đang mở là chuyện bình thường.
  }
}

async function lockNow(reason = 'manual') {
  if (lockOperation) {
    return lockOperation;
  }

  lockOperation = (async () => {
    const { auth, lockState } = await readCore();

    if (!isAuthConfigured(auth)) {
      return { ok: false, error: 'NO_PASSWORD' };
    }

    const alreadyLocked = lockState.isLocked;
    const now = Date.now();

    if (!alreadyLocked) {
      // Xóa token cũ TRƯỚC khi phát sự kiện khóa để content script mới đăng ký
      // token mới và không bị xóa nhầm.
      await chrome.storage.session.remove(STORAGE.VIEW_TOKENS);
      await chrome.storage.local.set({
        [STORAGE.LOCK_STATE]: {
          isLocked: true,
          lockedAt: now,
          reason: String(reason).slice(0, 40),
          unlockedAt: null
        },
        [STORAGE.ATTEMPTS]: { count: 0, blockedUntil: 0 }
      });
    }

    await chrome.alarms.clear(ALARM_NAME);

    const latest = await readCore();
    await syncActionIcon(latest.settings, latest.lockState, latest.auth);
    await injectLockIntoAllTabs();
    await broadcastLockState(true);

    return { ok: true, alreadyLocked };
  })().finally(() => {
    lockOperation = null;
  });

  return lockOperation;
}

async function completeUnlock() {
  const now = Date.now();
  await chrome.storage.local.set({
    [STORAGE.LOCK_STATE]: {
      isLocked: false,
      lockedAt: null,
      reason: null,
      unlockedAt: now
    },
    [STORAGE.ATTEMPTS]: { count: 0, blockedUntil: 0 }
  });

  await chrome.storage.session.remove(STORAGE.VIEW_TOKENS);
  await setLastActivityAt(now);
  await chrome.alarms.clear(ALARM_NAME);

  const { settings, auth } = await readCore();
  await syncActionIcon(settings, makeUnlockedState(), auth);
  await scheduleAutoLock(now);
  await broadcastLockState(false);
}

async function submitPassword(password, sender, viewToken) {
  if (!(await isAuthorizedLockView(sender, viewToken))) {
    return { ok: false, error: 'UNTRUSTED_VIEW' };
  }

  const { auth, lockState } = await readCore();

  if (!lockState.isLocked) {
    return { ok: true, alreadyUnlocked: true };
  }

  if (!isAuthConfigured(auth)) {
    return { ok: false, error: 'NO_PASSWORD' };
  }

  if (typeof password !== 'string' || password.length === 0) {
    return { ok: false, error: 'EMPTY_PASSWORD' };
  }

  if (password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, error: 'INVALID_PASSWORD' };
  }

  const now = Date.now();
  const attempts = await getAttempts();

  if (attempts.blockedUntil > now) {
    return {
      ok: false,
      error: 'COOLDOWN',
      attemptsRemaining: 0,
      cooldownSeconds: getCooldownSeconds(attempts, now)
    };
  }

  const matches = await verifyPassword(password, auth);

  if (!matches) {
    const failed = await recordFailedAttempt();
    return {
      ok: false,
      error: failed.cooldownSeconds > 0 ? 'COOLDOWN' : 'WRONG_PASSWORD',
      attemptsRemaining: failed.attemptsRemaining,
      cooldownSeconds: failed.cooldownSeconds
    };
  }

  await completeUnlock();
  return { ok: true, isLocked: false };
}

async function setPassword(currentPassword, newPassword, sender) {
  if (!isTopLevelExtensionSender(sender)) {
    return { ok: false, error: 'FORBIDDEN' };
  }

  await ensureInitialized();
  const { auth, lockState, settings } = await readCore();

  if (lockState.isLocked) {
    return { ok: false, error: 'LOCKED' };
  }

  const newPasswordProblem = validateNewPassword(newPassword);
  if (newPasswordProblem) {
    return { ok: false, error: newPasswordProblem };
  }

  if (isAuthConfigured(auth)) {
    if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
      return { ok: false, error: 'CURRENT_PASSWORD_REQUIRED' };
    }

    const attempts = await getAttempts();
    const now = Date.now();
    if (attempts.blockedUntil > now) {
      return {
        ok: false,
        error: 'COOLDOWN',
        cooldownSeconds: getCooldownSeconds(attempts, now)
      };
    }

    const matches = await verifyPassword(currentPassword, auth);
    if (!matches) {
      const failed = await recordFailedAttempt();
      return {
        ok: false,
        error: failed.cooldownSeconds > 0 ? 'COOLDOWN' : 'WRONG_CURRENT_PASSWORD',
        attemptsRemaining: failed.attemptsRemaining,
        cooldownSeconds: failed.cooldownSeconds
      };
    }
  }

  await markBrowserActivity({ force: true });
  const nextAuth = await createAuthRecord(newPassword);
  await chrome.storage.local.set({ [STORAGE.AUTH]: nextAuth });
  await resetAttempts();
  await syncActionIcon(settings, lockState, nextAuth);

  if (!isAuthConfigured(auth)) {
    const now = Date.now();
    await setLastActivityAt(now);
    await scheduleAutoLock(now);
  }

  return { ok: true, hadPassword: isAuthConfigured(auth) };
}

async function setSettings(input, sender) {
  if (!isTopLevelExtensionSender(sender)) {
    return { ok: false, error: 'FORBIDDEN' };
  }

  await ensureInitialized();
  const { auth, lockState } = await readCore();

  if (lockState.isLocked) {
    return { ok: false, error: 'LOCKED' };
  }

  const currentData = await chrome.storage.local.get(STORAGE.SETTINGS);
  const current = normalizeSettings(currentData[STORAGE.SETTINGS]);
  const next = normalizeSettings({
    autoLockEnabled:
      input && typeof input.autoLockEnabled === 'boolean'
        ? input.autoLockEnabled
        : current.autoLockEnabled,
    idleMinutes:
      input && input.idleMinutes !== undefined ? input.idleMinutes : current.idleMinutes,
    openPanelOnIcon:
      input && typeof input.openPanelOnIcon === 'boolean'
        ? input.openPanelOnIcon
        : current.openPanelOnIcon
  });

  await chrome.storage.local.set({ [STORAGE.SETTINGS]: next });
  await syncActionIcon(next, lockState, auth);
  await markBrowserActivity({ force: true });

  if (next.autoLockEnabled && isAuthConfigured(auth)) {
    const now = Date.now();
    await setLastActivityAt(now);
    await scheduleAutoLock(now);
  } else {
    await chrome.alarms.clear(ALARM_NAME);
  }

  return { ok: true, settings: next };
}

async function markBrowserActivity({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastActivityPersistAt < ACTIVITY_THROTTLE_MS) {
    return { ok: true, throttled: true };
  }
  lastActivityPersistAt = now;

  const { settings, lockState, auth } = await readCore();

  if (lockState.isLocked || !settings.autoLockEnabled || !isAuthConfigured(auth)) {
    return { ok: true, ignored: true };
  }

  cachedActivityAt = now;
  await chrome.storage.session.set({ [STORAGE.LAST_ACTIVITY]: now });
  await scheduleAutoLock(now);
  return { ok: true };
}

async function isAuthorizedLockView(sender, viewToken) {
  if (!isExtensionPageSender(sender)) {
    return false;
  }

  // frameId === 0: tab extension; frameId === undefined: popup/extension page
  // không gắn với tab. Cả hai đều là ngữ cảnh extension tin cậy.
  if (sender.frameId === 0 || sender.frameId === undefined) {
    return true;
  }

  if (typeof viewToken !== 'string' || !VIEW_TOKEN_PATTERN.test(viewToken)) {
    return false;
  }

  if (!sender.tab || !Number.isInteger(sender.tab.id)) {
    return false;
  }

  const data = await chrome.storage.session.get(STORAGE.VIEW_TOKENS);
  const tokens = data[STORAGE.VIEW_TOKENS];
  const entry = tokens && tokens[String(sender.tab.id)];
  return Boolean(entry && entry.token === viewToken);
}

function isExtensionPageSender(sender) {
  return Boolean(
    sender &&
      sender.id === chrome.runtime.id &&
      typeof sender.url === 'string' &&
      sender.url.startsWith(EXTENSION_ORIGIN)
  );
}

function isTopLevelExtensionSender(sender) {
  return (
    isExtensionPageSender(sender) &&
    (sender.frameId === 0 || sender.frameId === undefined)
  );
}

async function registerLockView(sender, token) {
  if (
    !sender ||
    !sender.tab ||
    !Number.isInteger(sender.tab.id) ||
    sender.frameId !== 0 ||
    typeof token !== 'string' ||
    !VIEW_TOKEN_PATTERN.test(token)
  ) {
    return { ok: false, error: 'FORBIDDEN' };
  }

  const { lockState } = await readCore();
  if (!lockState.isLocked) {
    return { ok: false, error: 'NOT_LOCKED' };
  }

  const data = await chrome.storage.session.get(STORAGE.VIEW_TOKENS);
  const previous = data[STORAGE.VIEW_TOKENS];
  const tokens = previous && typeof previous === 'object' ? { ...previous } : {};
  tokens[String(sender.tab.id)] = { token, registeredAt: Date.now() };

  // Giới hạn bộ nhớ nếu người dùng mở rất nhiều tab trong thời gian dài.
  const entries = Object.entries(tokens);
  if (entries.length > 200) {
    entries
      .sort((left, right) => (left[1].registeredAt || 0) - (right[1].registeredAt || 0))
      .slice(0, entries.length - 200)
      .forEach(([tabId]) => {
        delete tokens[tabId];
      });
  }

  await chrome.storage.session.set({ [STORAGE.VIEW_TOKENS]: tokens });
  return { ok: true };
}

async function removeLockViewToken(tabId) {
  const data = await chrome.storage.session.get(STORAGE.VIEW_TOKENS);
  const tokens = data[STORAGE.VIEW_TOKENS];
  if (!tokens || typeof tokens !== 'object' || !tokens[String(tabId)]) {
    return;
  }
  const next = { ...tokens };
  delete next[String(tabId)];
  await chrome.storage.session.set({ [STORAGE.VIEW_TOKENS]: next });
}

async function getUiState(sender, viewToken) {
  if (!(await isAuthorizedLockView(sender, viewToken))) {
    return { ok: false, error: 'UNTRUSTED_VIEW' };
  }

  await ensureInitialized();
  const { settings, auth, lockState } = await readCore();
  const attempts = await getAttempts();
  const now = Date.now();

  return {
    ok: true,
    isLocked: lockState.isLocked,
    hasPassword: isAuthConfigured(auth),
    attemptsRemaining:
      attempts.blockedUntil > now ? 0 : Math.max(0, MAX_FAILED_ATTEMPTS - attempts.count),
    cooldownSeconds: getCooldownSeconds(attempts, now),
    settings
  };
}

async function handleMessage(message, sender) {
  if (!message || typeof message.type !== 'string') {
    return { ok: false, error: 'BAD_REQUEST' };
  }

  if (!sender || sender.id !== chrome.runtime.id) {
    return { ok: false, error: 'FORBIDDEN' };
  }

  switch (message.type) {
    case 'LW_GET_STATE':
      return getUiState(sender, message.viewToken);

    case 'LW_REGISTER_VIEW':
      return registerLockView(sender, message.token);

    case 'LW_ACTIVITY': {
      // Chấp nhận hoạt động từ mọi frame tin cậy của content script để thao tác
      // bên trong iframe cũng được tính. Chỉ frame 0 mới được đăng ký màn khóa.
      const fromContentScript = Boolean(sender.tab);
      if (!fromContentScript && !isExtensionPageSender(sender)) {
        return { ok: false, error: 'FORBIDDEN' };
      }
      return markBrowserActivity();
    }

    case 'LW_SUBMIT_PASSWORD':
      // Tuần tự hóa để nhiều tab không thể gửi thử mật khẩu song song và lách
      // bộ đếm số lần sai / thời gian chờ.
      return serializeAuthOperation(() =>
        submitPassword(message.password, sender, message.viewToken)
      );

    case 'LW_SET_PASSWORD':
      return serializeAuthOperation(() =>
        setPassword(message.currentPassword, message.newPassword, sender)
      );

    case 'LW_SET_SETTINGS':
      return setSettings(message.settings, sender);

    case 'LW_LOCK_NOW':
      if (!isTopLevelExtensionSender(sender)) {
        return { ok: false, error: 'FORBIDDEN' };
      }
      return lockNow('manual');

    default:
      return { ok: false, error: 'UNKNOWN_MESSAGE' };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((response) => {
      try {
        sendResponse(response);
      } catch (_) {
        // Kênh đã đóng (tab/popup biến mất) - bỏ qua.
      }
    })
    .catch((error) => {
      console.error(
        '[LockWeb] Lỗi message:',
        message && message.type,
        error && error.message ? error.message : error
      );
      try {
        sendResponse({ ok: false, error: 'INTERNAL' });
      } catch (_) {
        // Kênh đã đóng.
      }
    });
  return true;
});

chrome.action.onClicked.addListener(() => {
  inBackground(
    (async () => {
      const result = await lockNow('manual');
      if (!result.ok && result.error === 'NO_PASSWORD') {
        await openOptionsPageSafely();
      }
    })()
  );
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'lock-browser') {
    return;
  }

  inBackground(
    (async () => {
      const result = await lockNow('shortcut');
      if (!result.ok && result.error === 'NO_PASSWORD') {
        await openOptionsPageSafely();
      }
    })()
  );
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) {
    return;
  }

  inBackground(
    (async () => {
      const { settings, lockState, auth } = await readCore();
      if (lockState.isLocked || !settings.autoLockEnabled || !isAuthConfigured(auth)) {
        await chrome.alarms.clear(ALARM_NAME);
        return;
      }

      const lastActivityAt = await getLastActivityAt();
      if (!lastActivityAt) {
        const now = Date.now();
        await setLastActivityAt(now);
        await scheduleAutoLock(now);
        return;
      }

      const dueAt = lastActivityAt + settings.idleMinutes * 60 * 1000;
      if (Date.now() + 1000 < dueAt) {
        await scheduleAutoLock(lastActivityAt);
        return;
      }

      await lockNow('inactivity');
    })()
  );
});

chrome.tabs.onActivated.addListener(() => {
  inBackground(markBrowserActivity());
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    inBackground(markBrowserActivity());
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  inBackground(removeLockViewToken(tabId));
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') {
    return;
  }

  if (!changes[STORAGE.SETTINGS] && !changes[STORAGE.LOCK_STATE] && !changes[STORAGE.AUTH]) {
    return;
  }

  inBackground(
    (async () => {
      const { settings, lockState, auth } = await readCore();

      if (lockState.isLocked && !isAuthConfigured(auth)) {
        await chrome.storage.local.set({ [STORAGE.LOCK_STATE]: makeUnlockedState() });
        return;
      }

      await syncActionIcon(settings, lockState, auth);

      if (changes[STORAGE.LOCK_STATE]) {
        if (lockState.isLocked) {
          await chrome.alarms.clear(ALARM_NAME);
        } else {
          await ensureAutoLockTimer();
        }
      }

      if (changes[STORAGE.SETTINGS]) {
        if (!settings.autoLockEnabled || lockState.isLocked) {
          await chrome.alarms.clear(ALARM_NAME);
        } else if (isAuthConfigured(auth)) {
          // Đổi cài đặt là một thao tác của người dùng: đặt lại mốc hoạt động
          // để tránh việc rút ngắn thời gian chờ làm khóa ngay lập tức.
          const now = Date.now();
          await setLastActivityAt(now);
          await scheduleAutoLock(now);
        }
      }
    })()
  );
});

chrome.runtime.onInstalled.addListener((details) => {
  inBackground(
    (async () => {
      await ensureInitialized();

      if (details.reason === 'install') {
        await openOptionsPageSafely();
        return;
      }

      if (details.reason === 'update') {
        const { lockState } = await readCore();
        if (lockState.isLocked) {
          await injectLockIntoAllTabs();
        }
      }
    })()
  );
});

chrome.runtime.onStartup.addListener(() => {
  inBackground(
    (async () => {
      initPromise = null;
      cachedActivityAt = 0;
      lastActivityPersistAt = 0;

      await ensureInitialized();
      const { settings, lockState, auth } = await readCore();

      if (lockState.isLocked) {
        await chrome.alarms.clear(ALARM_NAME);
        await syncActionIcon(settings, lockState, auth);
        await injectLockIntoAllTabs();
        return;
      }

      const now = Date.now();
      await setLastActivityAt(now);
      await syncActionIcon(settings, lockState, auth);
      if (settings.autoLockEnabled && isAuthConfigured(auth)) {
        await scheduleAutoLock(now);
      } else {
        await chrome.alarms.clear(ALARM_NAME);
      }
    })()
  );
});

inBackground(ensureInitialized());
