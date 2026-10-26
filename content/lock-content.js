/**
 * LockWeb - content script.
 *
 * Nhiệm vụ:
 *  - Đọc trạng thái khóa từ chrome.storage.local và duy trì lớp phủ trên trang.
 *  - Tạo một closed Shadow DOM chứa iframe chrome-extension://.../lock/lock.html.
 *  - Không đặt input mật khẩu trong DOM của trang. Nhờ iframe cùng origin
 *    extension, trang web không thể đọc value hoặc nghe sự kiện bàn phím của ô
 *    mật khẩu.
 *  - Gửi tín hiệu hoạt động (chỉ sự kiện isTrusted) để service worker tự khóa.
 */
(() => {
  'use strict';

  const isTopFrame = window.top === window;

  // Content script có thể được inject lại bằng chrome.scripting. Guard này
  // tránh gắn trùng listener; nếu đã có thì chỉ đồng bộ lại trạng thái.
  if (globalThis.__lockWebContentLoaded) {
    try {
      globalThis.__lockWebContentLoaded.sync();
    } catch (_) {
      // Bỏ qua.
    }
    return;
  }

  const LOCK_STORAGE_KEY = 'lwLockState';
  const ACTIVITY_MIN_INTERVAL_MS = 15000;
  const FRAME_READY_TIMEOUT_MS = 12000;

  const HOST_STYLE = [
    'all: initial !important',
    'position: fixed !important',
    'top: 0 !important',
    'left: 0 !important',
    'right: 0 !important',
    'bottom: 0 !important',
    'width: 100vw !important',
    'height: 100vh !important',
    'display: block !important',
    'visibility: visible !important',
    'opacity: 1 !important',
    'pointer-events: auto !important',
    'z-index: 2147483647 !important',
    'background: #050a13 !important',
    'margin: 0 !important',
    'padding: 0 !important',
    'border: 0 !important',
    'outline: 0 !important',
    'overflow: hidden !important',
    'isolation: isolate !important',
    'transform: none !important',
    'filter: none !important',
    'clip-path: none !important',
    'transition: none !important',
    'animation: none !important',
    'color-scheme: dark !important'
  ].join(';');

  const IFRAME_STYLE = [
    'all: initial !important',
    'display: block !important',
    'width: 100% !important',
    'height: 100% !important',
    'border: 0 !important',
    'margin: 0 !important',
    'padding: 0 !important',
    'background: #050a13 !important',
    'color-scheme: dark !important'
  ].join(';');

  let isLocked = false;
  let hostElement = null;
  let shadowRoot = null;
  let lockFrame = null;
  let viewToken = null;
  let overlayBuildId = 0;
  let frameReady = false;
  let readyTimer = 0;
  let focusGuardTimer = 0;
  let syncSequence = 0;
  let lastActivitySignal = 0;
  let activityListenersAttached = false;
  let errorLayer = null;

  const overlayApi = {
    sync: () => {
      if (isTopFrame) {
        void syncFromStorage();
      }
    }
  };

  Object.defineProperty(globalThis, '__lockWebContentLoaded', {
    value: overlayApi,
    configurable: false,
    enumerable: false,
    writable: false
  });

  function getDisplayDomain() {
    try {
      if (location.protocol === 'file:') {
        return 'TỆP CỤC BỘ';
      }
      if (location.hostname) {
        return location.hostname.replace(/^www\./i, '');
      }
      return location.protocol.replace(':', '').toUpperCase() || 'TRANG WEB';
    } catch (_) {
      return 'TRANG WEB';
    }
  }

  function randomToken() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function readLocked() {
    return chrome.storage.local
      .get(LOCK_STORAGE_KEY)
      .then((data) => data && data[LOCK_STORAGE_KEY] && data[LOCK_STORAGE_KEY].isLocked === true)
      .catch(() => false);
  }

  async function syncFromStorage() {
    const sequence = ++syncSequence;
    const nextLocked = await readLocked();

    if (sequence !== syncSequence) {
      return;
    }

    setLocked(nextLocked);
  }

  function setLocked(nextLocked) {
    if (nextLocked === isLocked) {
      if (nextLocked && !hostElement) {
        void startOverlay();
      }
      return;
    }

    isLocked = nextLocked;

    if (isLocked) {
      void startOverlay();
    } else {
      stopOverlay();
    }
  }

  function exitPageFullscreen() {
    if (document.fullscreenElement && typeof document.exitFullscreen === 'function') {
      document.exitFullscreen().catch(() => {});
    }
  }

  function ensureHostElement() {
    if (!document.documentElement) {
      return false;
    }

    // Nếu trang đang fullscreen, thoát để lớp phủ không bị phần tử top-layer che.
    exitPageFullscreen();

    if (hostElement) {
      if (hostElement.parentNode !== document.documentElement) {
        document.documentElement.appendChild(hostElement);
      }
      return true;
    }

    hostElement = document.createElement('div');
    hostElement.setAttribute('role', 'dialog');
    hostElement.setAttribute('aria-modal', 'true');
    hostElement.setAttribute('aria-label', 'Màn hình khóa LockWeb');
    hostElement.style.cssText = HOST_STYLE;

    shadowRoot = hostElement.attachShadow({ mode: 'closed' });

    lockFrame = document.createElement('iframe');
    lockFrame.title = 'Màn hình khóa LockWeb';
    lockFrame.setAttribute('referrerpolicy', 'no-referrer');
    lockFrame.setAttribute('loading', 'eager');
    lockFrame.style.cssText = IFRAME_STYLE;
    // Màu nền tối trong lúc iframe extension đang tải.
    lockFrame.src = 'about:blank';

    shadowRoot.appendChild(lockFrame);
    document.documentElement.appendChild(hostElement);

    startFocusGuard();
    return true;
  }

  async function startOverlay() {
    if (!isLocked) {
      return;
    }

    if (!document.documentElement) {
      window.setTimeout(() => {
        if (isLocked) {
          void startOverlay();
        }
      }, 20);
      return;
    }

    if (hostElement && hostElement.isConnected && frameReady) {
      return;
    }

    const buildId = ++overlayBuildId;
    ensureHostElement();

    let token;
    try {
      token = randomToken();
      const response = await chrome.runtime.sendMessage({
        type: 'LW_REGISTER_VIEW',
        token
      });

      if (!response || !response.ok) {
        throw new Error('REGISTER_VIEW_FAILED');
      }
    } catch (_) {
      if (isLocked && buildId === overlayBuildId) {
        showMountError(
          'Không thể khởi tạo lớp khóa. Extension có thể vừa được tải lại. Hãy tải lại trang này.'
        );
      }
      return;
    }

    if (!isLocked || buildId !== overlayBuildId) {
      return;
    }

    viewToken = token;
    frameReady = false;
    hideMountError();
    startFrameReadyTimeout(buildId);

    const separator = '?';
    lockFrame.src =
      chrome.runtime.getURL('lock/lock.html') +
      separator +
      'mode=embedded&d=' +
      encodeURIComponent(getDisplayDomain()) +
      '&token=' +
      encodeURIComponent(token);
  }

  function startFrameReadyTimeout(buildId) {
    window.clearTimeout(readyTimer);
    readyTimer = window.setTimeout(() => {
      if (!isLocked || buildId !== overlayBuildId || frameReady) {
        return;
      }

      showMountError(
        'Trang này đang chặn hoặc không thể tải giao diện khóa. Hãy chuyển sang tab khác, hoặc tải lại trang.'
      );
    }, FRAME_READY_TIMEOUT_MS);
  }

  function stopOverlay() {
    overlayBuildId += 1;
    frameReady = false;
    viewToken = null;
    window.clearTimeout(readyTimer);
    readyTimer = 0;
    stopFocusGuard();

    if (hostElement) {
      hostElement.remove();
    }

    hostElement = null;
    shadowRoot = null;
    lockFrame = null;
    errorLayer = null;
  }

  function showMountError(message) {
    if (!shadowRoot) {
      return;
    }

    if (lockFrame) {
      lockFrame.style.display = 'none';
    }

    if (!errorLayer) {
      errorLayer = document.createElement('div');
      errorLayer.style.cssText = [
        'position: fixed',
        'inset: 0',
        'z-index: 2',
        'display: flex',
        'align-items: center',
        'justify-content: center',
        'padding: 32px',
        'box-sizing: border-box',
        'background: radial-gradient(circle at 50% 30%, #0c1930 0%, #050a13 60%)',
        'color: #dbe7f6',
        'font: 500 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif',
        'text-align: center'
      ].join(';');

      const panel = document.createElement('div');
      panel.style.cssText = [
        'max-width: 420px',
        'padding: 24px',
        'border: 1px solid rgba(148, 163, 184, 0.2)',
        'border-radius: 16px',
        'background: rgba(11, 20, 34, 0.94)',
        'box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45)'
      ].join(';');

      const text = document.createElement('p');
      text.style.cssText = 'margin: 0 0 16px; color: #c4d4e8;';
      text.textContent = message;

      const reload = document.createElement('button');
      reload.type = 'button';
      reload.textContent = 'Tải lại trang';
      reload.style.cssText = [
        'appearance: none',
        'border: 0',
        'border-radius: 10px',
        'padding: 11px 18px',
        'background: #2563eb',
        'color: #fff',
        'font: 650 14px system-ui, -apple-system, "Segoe UI", sans-serif',
        'cursor: pointer'
      ].join(';');
      reload.addEventListener('click', () => location.reload());

      panel.appendChild(text);
      panel.appendChild(reload);
      errorLayer.appendChild(panel);
      shadowRoot.appendChild(errorLayer);
    } else {
      const text = errorLayer.querySelector('p');
      if (text) {
        text.textContent = message;
      }
    }
  }

  function hideMountError() {
    if (errorLayer) {
      errorLayer.remove();
      errorLayer = null;
    }
    if (lockFrame) {
      lockFrame.style.display = 'block';
    }
  }

  function startFocusGuard() {
    stopFocusGuard();
    focusGuardTimer = window.setInterval(() => {
      if (!isLocked || !hostElement || !lockFrame) {
        return;
      }

      // Chỉ gắn lại khi host bị gỡ. Không di chuyển một host đang gắn vì thao
      // tác đó sẽ khiến iframe tải lại và mất nội dung người dùng đang nhập.
      if (hostElement.parentNode !== document.documentElement) {
        document.documentElement.appendChild(hostElement);
      }

      if (document.fullscreenElement) {
        exitPageFullscreen();
      }

      if (hostElement.hidden) {
        hostElement.hidden = false;
      }
      if (hostElement.className) {
        hostElement.className = '';
      }
      hostElement.style.cssText = HOST_STYLE;

      // Nếu trang web giành focus khỏi iframe, đưa focus trở lại màn hình khóa.
      // Khi người dùng chuyển sang thanh địa chỉ/cửa sổ khác, document.hasFocus()
      // là false nên không can thiệp.
      if (document.hasFocus() && document.activeElement !== hostElement) {
        try {
          lockFrame.focus();
        } catch (_) {
          // Bỏ qua.
        }
      }
    }, 1000);
  }

  function stopFocusGuard() {
    if (focusGuardTimer) {
      window.clearInterval(focusGuardTimer);
      focusGuardTimer = 0;
    }
  }

  function signalActivity(event) {
    if (!event || event.isTrusted !== true || isLocked) {
      return;
    }

    if (document.visibilityState !== 'visible') {
      return;
    }

    const now = Date.now();
    if (now - lastActivitySignal < ACTIVITY_MIN_INTERVAL_MS) {
      return;
    }
    lastActivitySignal = now;

    try {
      const result = chrome.runtime.sendMessage({ type: 'LW_ACTIVITY' });
      if (result && typeof result.catch === 'function') {
        result.catch(() => {});
      }
    } catch (_) {
      // Extension vừa được reload/cập nhật: bỏ qua.
    }
  }

  function attachActivityListeners() {
    if (activityListenersAttached) {
      return;
    }
    activityListenersAttached = true;

    const options = { capture: true, passive: true };

    for (const eventName of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove']) {
      window.addEventListener(eventName, signalActivity, options);
    }

    // Không dùng sự kiện "focus" của window: trang có thể gọi window.focus()
    // và tạo ra sự kiện isTrusted mà không có thao tác thật của người dùng.
    window.addEventListener(
      'pageshow',
      (event) => {
        signalActivity(event);
        if (isTopFrame) {
          void syncFromStorage();
        }
      },
      { capture: true, passive: true }
    );

    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.visibilityState === 'visible') {
          signalActivity({ isTrusted: true });
          if (isTopFrame) {
            void syncFromStorage();
          }
        }
      },
      { capture: true, passive: true }
    );
  }

  // Activity trong iframe cũng được tính. Chỉ frame trên cùng mới gắn lớp khóa.
  attachActivityListeners();

  if (!isTopFrame) {
    return;
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes[LOCK_STORAGE_KEY]) {
      return;
    }

    const nextLocked = Boolean(
      changes[LOCK_STORAGE_KEY].newValue &&
        changes[LOCK_STORAGE_KEY].newValue.isLocked === true
    );

    // Vô hiệu hóa kết quả của một lần đọc storage đang chạy dở để nó không
    // ghi đè trạng thái mới hơn (ví dụ: khóa xảy ra đúng lúc trang đang tải).
    syncSequence += 1;
    setLocked(nextLocked);
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'LW_LOCK_STATE_CHANGED') {
      void syncFromStorage();
    }
  });

  // Handshake chỉ để phát hiện iframe bị CSP của trang chặn. Nội dung message
  // không chứa mật khẩu; token không thể dùng từ JavaScript của trang web.
  window.addEventListener(
    'message',
    (event) => {
      if (
        !event.isTrusted ||
        !lockFrame ||
        event.source !== lockFrame.contentWindow ||
        !event.data ||
        event.data.type !== 'LW_LOCK_READY'
      ) {
        return;
      }

      frameReady = true;
      window.clearTimeout(readyTimer);
      readyTimer = 0;
      hideMountError();
    },
    true
  );

  void syncFromStorage();
})();
