'use strict';

(() => {
  const elements = {
    statusPill: document.getElementById('status-pill'),
    statusText: document.getElementById('status-text'),
    loading: document.getElementById('loading-state'),
    content: document.getElementById('content'),
    heroIcon: document.getElementById('hero-icon'),
    heroTitle: document.getElementById('hero-title'),
    heroCopy: document.getElementById('hero-copy'),
    passwordInfo: document.getElementById('password-info'),
    autolockInfo: document.getElementById('autolock-info'),
    lockButton: document.getElementById('lock-button'),
    lockButtonLabel: document.getElementById('lock-button-label'),
    optionsButton: document.getElementById('options-button'),
    optionsButtonLabel: document.getElementById('options-button-label'),
    shortcutHint: document.getElementById('shortcut-hint'),
    error: document.getElementById('popup-error')
  };

  let state = null;
  let shortcutText = '';
  let lockBusy = false;
  let lastActivity = 0;

  function setStatus(text, variant) {
    elements.statusText.textContent = text;
    elements.statusPill.className = `status-pill ${variant}`;
  }

  function setError(message) {
    elements.error.textContent = message;
    elements.error.hidden = false;
  }

  function clearError() {
    elements.error.hidden = true;
    elements.error.textContent = '';
  }

  function signalActivity() {
    const now = Date.now();
    if (now - lastActivity < 10000) {
      return;
    }
    lastActivity = now;
    try {
      const result = chrome.runtime.sendMessage({ type: 'LW_ACTIVITY' });
      if (result && typeof result.catch === 'function') {
        result.catch(() => {});
      }
    } catch (_) {
      // Extension vừa reload.
    }
  }

  function setButtonBusy(value) {
    lockBusy = value;
    elements.lockButton.disabled = value;
    elements.lockButton.classList.toggle('is-busy', value);
    if (state && state.hasPassword && !state.isLocked) {
      elements.lockButtonLabel.textContent = value ? 'Đang khóa…' : 'Khóa ngay';
    }
  }

  function render() {
    if (!state) {
      return;
    }

    const settings = state.settings || {};
    const autoLockText = settings.autoLockEnabled
      ? `${settings.idleMinutes} phút`
      : 'Đang tắt';

    elements.content.hidden = false;
    elements.loading.hidden = true;
    setButtonBusy(lockBusy);

    if (state.isLocked) {
      setStatus('Đang khóa', 'is-warning');
      elements.heroIcon.className = 'hero-icon is-locked';
      elements.heroTitle.textContent = 'Trình duyệt đang khóa';
      elements.heroCopy.textContent =
        'Hãy nhập mật khẩu trên tab đang mở để tiếp tục sử dụng.';
      elements.passwordInfo.textContent = 'Đã đặt';
      elements.autolockInfo.textContent = autoLockText;
      elements.lockButton.hidden = true;
      elements.optionsButton.hidden = false;
      elements.optionsButtonLabel.textContent = 'Mở Cài đặt';
      elements.shortcutHint.textContent = 'Mọi tab web đang được phủ lớp khóa.';
      return;
    }

    if (!state.hasPassword) {
      setStatus('Chưa cấu hình', 'is-warning');
      elements.heroIcon.className = 'hero-icon is-neutral';
      elements.heroTitle.textContent = 'Chưa có mật khẩu';
      elements.heroCopy.textContent =
        'Tạo mật khẩu để bật màn hình khóa trên các trang web.';
      elements.passwordInfo.textContent = 'Chưa đặt';
      elements.autolockInfo.textContent = 'Chưa bật';
      elements.lockButton.hidden = false;
      elements.lockButtonLabel.textContent = 'Tạo mật khẩu';
      elements.optionsButton.hidden = true;
      elements.shortcutHint.textContent = 'Bạn có thể đặt mật khẩu trong trang Cài đặt.';
      return;
    }

    setStatus('Đã bảo vệ', 'is-protected');
    elements.heroIcon.className = 'hero-icon';
    elements.heroTitle.textContent = 'Sẵn sàng khóa';
    elements.heroCopy.textContent =
      'Khóa tất cả tab web ngay bây giờ. Nhập mật khẩu để mở lại.';
    elements.passwordInfo.textContent = 'Đã đặt';
    elements.autolockInfo.textContent = autoLockText;
    elements.lockButton.hidden = false;
    elements.lockButtonLabel.textContent = lockBusy ? 'Đang khóa…' : 'Khóa ngay';
    elements.optionsButton.hidden = false;
    elements.optionsButtonLabel.textContent = 'Mở Cài đặt';

    if (shortcutText) {
      elements.shortcutHint.textContent = `Phím tắt: ${shortcutText}`;
    } else {
      elements.shortcutHint.textContent = 'Chưa gán phím tắt. Có thể cài trong Cài đặt.';
    }
  }

  async function openOptions() {
    try {
      await chrome.runtime.openOptionsPage();
      window.close();
    } catch (_) {
      try {
        await chrome.tabs.create({
          url: chrome.runtime.getURL('options/options.html')
        });
        window.close();
      } catch (_) {
        setError('Không thể mở Cài đặt. Hãy thử lại.');
      }
    }
  }

  async function handlePrimaryAction() {
    if (!state) {
      return;
    }

    if (!state.hasPassword) {
      await openOptions();
      return;
    }

    if (state.isLocked || lockBusy) {
      return;
    }

    clearError();
    setButtonBusy(true);

    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: 'LW_LOCK_NOW' });
    } catch (_) {
      response = null;
    }

    if (response && response.ok === true) {
      window.setTimeout(() => window.close(), 120);
      return;
    }

    setButtonBusy(false);
    if (response && response.error === 'NO_PASSWORD') {
      setError('Chưa có mật khẩu. Hãy mở Cài đặt để tạo mật khẩu.');
    } else {
      setError('Không thể khóa lúc này. Vui lòng thử lại.');
    }
  }

  async function loadState() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'LW_GET_STATE' });
      if (!response || response.ok !== true) {
        throw new Error('STATE_UNAVAILABLE');
      }
      state = response;
      clearError();
      render();
    } catch (_) {
      elements.loading.hidden = true;
      elements.content.hidden = false;
      setStatus('Không tải được', 'is-warning');
      elements.heroIcon.className = 'hero-icon is-neutral';
      elements.heroTitle.textContent = 'Không tải được trạng thái';
      elements.heroCopy.textContent =
        'Hãy đóng bảng điều khiển, tải lại trang và thử lại.';
      elements.passwordInfo.textContent = '—';
      elements.autolockInfo.textContent = '—';
      elements.lockButton.hidden = true;
      elements.optionsButton.hidden = false;
      elements.shortcutHint.textContent = 'Bạn vẫn có thể mở trang Cài đặt.';
      setError('Không thể kết nối tới LockWeb. Extension có thể vừa được tải lại.');
    }
  }

  async function loadShortcut() {
    try {
      const commands = await chrome.commands.getAll();
      const command = commands.find((item) => item.name === 'lock-browser');
      shortcutText = command && command.shortcut ? command.shortcut : '';
      if (state) {
        render();
      }
    } catch (_) {
      // Không hiển thị phím tắt nếu API không khả dụng.
    }
  }

  elements.lockButton.addEventListener('click', () => {
    void handlePrimaryAction();
  });

  elements.optionsButton.addEventListener('click', () => {
    void openOptions();
  });

  document.addEventListener('pointerdown', signalActivity, {
    capture: true,
    passive: true
  });
  document.addEventListener('keydown', signalActivity, {
    capture: true,
    passive: true
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes.lwLockState) {
      return;
    }
    void loadState();
  });

  signalActivity();
  void loadState();
  void loadShortcut();
})();
