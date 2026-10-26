'use strict';

(() => {
  const elements = {
    loading: document.getElementById('page-loading'),
    dashboard: document.getElementById('dashboard'),
    pageError: document.getElementById('page-error'),
    topStatus: document.getElementById('top-status'),
    topStatusText: document.getElementById('top-status-text'),
    quickIcon: document.getElementById('quick-icon'),
    quickTitle: document.getElementById('quick-title'),
    quickCopy: document.getElementById('quick-copy'),
    quickHint: document.getElementById('quick-hint'),
    lockNowButton: document.getElementById('lock-now-button'),

    passwordForm: document.getElementById('password-form'),
    passwordBadge: document.getElementById('password-badge'),
    passwordIntro: document.getElementById('password-intro'),
    currentPasswordGroup: document.getElementById('current-password-group'),
    currentPassword: document.getElementById('current-password'),
    newPassword: document.getElementById('new-password'),
    confirmPassword: document.getElementById('confirm-password'),
    showPasswords: document.getElementById('show-passwords'),
    passwordMessage: document.getElementById('password-message'),
    savePasswordButton: document.getElementById('save-password-button'),
    savePasswordLabel: document.getElementById('save-password-label'),

    settingsForm: document.getElementById('settings-form'),
    autoLockToggle: document.getElementById('auto-lock-toggle'),
    idleMinutes: document.getElementById('idle-minutes'),
    openPanelToggle: document.getElementById('open-panel-toggle'),
    autolockBadge: document.getElementById('autolock-badge'),
    settingsHint: document.getElementById('settings-hint'),
    settingsMessage: document.getElementById('settings-message'),
    saveSettingsButton: document.getElementById('save-settings-button'),

    shortcutsButton: document.getElementById('shortcuts-button'),
    topShortcutsButton: document.getElementById('top-shortcuts-button'),
    shortcutDisplay: document.getElementById('shortcut-display'),
    shortcutUrl: document.getElementById('shortcut-url'),
    shortcutMessage: document.getElementById('shortcut-message')
  };

  let uiState = null;
  let hasPassword = false;
  let shortcutText = '';
  let shortcutsPageUrl = 'chrome://extensions/shortcuts';
  let redirecting = false;
  let lockNowBusy = false;
  let passwordBusy = false;
  let settingsBusy = false;
  let lastUiActivity = 0;

  const shortcutUrlForBrowser = /Edg\//.test(navigator.userAgent)
    ? 'edge://extensions/shortcuts'
    : 'chrome://extensions/shortcuts';

  shortcutsPageUrl = shortcutUrlForBrowser;
  elements.shortcutUrl.textContent = shortcutsPageUrl;

  function setStatusPill(text, variant) {
    elements.topStatusText.textContent = text;
    elements.topStatus.className = `status-pill ${variant}`;
  }

  function setMessage(element, text, type = 'error') {
    element.textContent = text;
    element.hidden = false;
    element.className = 'inline-message';
    if (type === 'success') {
      element.classList.add('is-success');
    } else if (type === 'warning') {
      element.classList.add('is-warning');
    }
  }

  function clearMessage(element) {
    element.textContent = '';
    element.hidden = true;
    element.className = 'inline-message';
  }

  function setFieldHint() {
    if (!hasPassword) {
      elements.settingsHint.textContent = 'Đặt mật khẩu trước khi bật tự khóa.';
      return;
    }

    if (!elements.autoLockToggle.checked) {
      elements.settingsHint.textContent = 'Tự khóa đang tắt. Bạn vẫn có thể khóa thủ công.';
      return;
    }

    elements.settingsHint.textContent = `Sẽ tự khóa sau ${elements.idleMinutes.value} phút không thao tác trong trình duyệt.`;
  }

  function updateSettingsAvailability() {
    elements.autoLockToggle.disabled = !hasPassword;
    elements.idleMinutes.disabled = !hasPassword || !elements.autoLockToggle.checked;
    setFieldHint();
  }

  function renderStatus() {
    if (!uiState) {
      return;
    }

    const settings = uiState.settings || {};
    const shortcutSuffix = shortcutText ? ` hoặc ${shortcutText}` : '';

    if (!hasPassword) {
      setStatusPill('Chưa cấu hình', 'is-warning');
      elements.quickIcon.className = 'quick-icon is-neutral';
      elements.quickTitle.textContent = 'Chưa được bảo vệ';
      elements.quickCopy.textContent =
        'Tạo mật khẩu để bật lớp khóa trên các trang web.';
      elements.quickHint.textContent =
        'Đặt mật khẩu trước, sau đó bấm biểu tượng LockWeb để khóa.';
      elements.lockNowButton.disabled = true;
      elements.passwordBadge.textContent = 'Chưa đặt';
      elements.passwordBadge.className = 'badge is-muted';
      elements.passwordIntro.textContent =
        'Đặt mật khẩu để bật lớp khóa. Mật khẩu chỉ được dùng để tạo giá trị xác minh PBKDF2.';
      elements.currentPasswordGroup.hidden = true;
      elements.savePasswordLabel.textContent = 'Đặt mật khẩu';
      elements.autolockBadge.textContent = 'Chưa bật';
      elements.autolockBadge.className = 'badge is-muted';
      return;
    }

    setStatusPill('Đã bảo vệ', 'is-protected');
    elements.quickIcon.className = 'quick-icon';
    elements.quickTitle.textContent = 'Sẵn sàng khóa';
    elements.quickCopy.textContent =
      'Mật khẩu đã được đặt. Các tab đang mở sẽ được phủ màn hình khóa khi bạn khóa.';
    elements.lockNowButton.disabled = lockNowBusy;
    elements.passwordBadge.textContent = 'Đã đặt';
    elements.passwordBadge.className = 'badge is-green';
    elements.passwordIntro.textContent =
      'Đổi mật khẩu định kỳ nếu cần. LockWeb chỉ lưu salt và giá trị băm PBKDF2, không lưu mật khẩu.';
    elements.currentPasswordGroup.hidden = false;
    elements.savePasswordLabel.textContent = 'Đổi mật khẩu';
    elements.autolockBadge.textContent = settings.autoLockEnabled
      ? `${settings.idleMinutes} phút`
      : 'Đang tắt';
    elements.autolockBadge.className = settings.autoLockEnabled
      ? 'badge is-blue'
      : 'badge is-muted';

    if (settings.openPanelOnIcon) {
      elements.quickHint.textContent =
        'Bấm biểu tượng LockWeb để mở bảng điều khiển nhanh.';
    } else {
      elements.quickHint.textContent = `Bấm biểu tượng LockWeb${shortcutSuffix} để khóa tức thì.`;
    }
  }

  function populateSettings(settings) {
    elements.autoLockToggle.checked = settings.autoLockEnabled !== false;

    const idleValue = String(settings.idleMinutes || 5);
    if (!Array.from(elements.idleMinutes.options).some((option) => option.value === idleValue)) {
      const option = document.createElement('option');
      option.value = idleValue;
      option.textContent = `${idleValue} phút`;
      elements.idleMinutes.appendChild(option);
    }
    elements.idleMinutes.value = idleValue;
    elements.openPanelToggle.checked = settings.openPanelOnIcon === true;
    updateSettingsAvailability();
  }

  function applyState(state) {
    uiState = state;
    hasPassword = state.hasPassword === true;
    populateSettings(state.settings || {});
    renderStatus();
    updateSettingsAvailability();
  }

  async function refreshState() {
    const response = await chrome.runtime.sendMessage({ type: 'LW_GET_STATE' });
    if (!response || response.ok !== true) {
      throw new Error('STATE_UNAVAILABLE');
    }

    if (response.isLocked && response.hasPassword) {
      redirectToLockPage();
      return null;
    }

    applyState(response);
    return response;
  }

  function redirectToLockPage() {
    if (redirecting) {
      return;
    }
    redirecting = true;

    const url =
      chrome.runtime.getURL('lock/lock.html') +
      '?mode=standalone&next=options&d=' +
      encodeURIComponent('Cài đặt LockWeb');
    window.location.replace(url);
  }

  function showPageError(message) {
    elements.loading.hidden = true;
    elements.dashboard.hidden = true;
    elements.pageError.hidden = false;
    elements.pageError.textContent = message;
    setStatusPill('Không tải được', 'is-warning');
  }

  function refreshShortcut() {
    return chrome.commands
      .getAll()
      .then((commands) => {
        const command = commands.find((item) => item.name === 'lock-browser');
        shortcutText = command && command.shortcut ? command.shortcut : '';
        elements.shortcutDisplay.textContent = shortcutText || 'Chưa gán';
        renderStatus();
      })
      .catch(() => {
        elements.shortcutDisplay.textContent = 'Chưa gán';
      });
  }

  function signalActivity() {
    const now = Date.now();
    if (now - lastUiActivity < 10000) {
      return;
    }
    lastUiActivity = now;
    try {
      const result = chrome.runtime.sendMessage({ type: 'LW_ACTIVITY' });
      if (result && typeof result.catch === 'function') {
        result.catch(() => {});
      }
    } catch (_) {
      // Extension vừa reload.
    }
  }

  function setPasswordBusy(value) {
    passwordBusy = value;
    elements.savePasswordButton.disabled = value;
    elements.savePasswordButton.classList.toggle('is-busy', value);
    elements.currentPassword.disabled = value;
    elements.newPassword.disabled = value;
    elements.confirmPassword.disabled = value;
    elements.savePasswordLabel.textContent = value
      ? 'Đang xử lý…'
      : hasPassword
        ? 'Đổi mật khẩu'
        : 'Đặt mật khẩu';
  }

  async function handlePasswordSubmit(event) {
    event.preventDefault();

    if (passwordBusy) {
      return;
    }

    const current = elements.currentPassword.value;
    const nextPassword = elements.newPassword.value;
    const confirmation = elements.confirmPassword.value;

    if (hasPassword && !current) {
      setMessage(elements.passwordMessage, 'Vui lòng nhập mật khẩu hiện tại.');
      elements.currentPassword.focus();
      return;
    }

    if (!nextPassword) {
      setMessage(elements.passwordMessage, 'Vui lòng nhập mật khẩu mới.');
      elements.newPassword.focus();
      return;
    }

    if (nextPassword.length < 8) {
      setMessage(elements.passwordMessage, 'Mật khẩu mới phải có ít nhất 8 ký tự.');
      elements.newPassword.focus();
      return;
    }

    if (nextPassword.length > 1024) {
      setMessage(elements.passwordMessage, 'Mật khẩu mới quá dài.');
      elements.newPassword.focus();
      return;
    }

    if (!nextPassword.trim()) {
      setMessage(elements.passwordMessage, 'Mật khẩu không được chỉ gồm khoảng trắng.');
      elements.newPassword.focus();
      return;
    }

    if (nextPassword !== confirmation) {
      setMessage(elements.passwordMessage, 'Hai lần nhập mật khẩu mới không khớp.');
      elements.confirmPassword.focus();
      return;
    }

    clearMessage(elements.passwordMessage);
    setPasswordBusy(true);

    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: 'LW_SET_PASSWORD',
        currentPassword: current,
        newPassword: nextPassword
      });
    } catch (_) {
      setPasswordBusy(false);
      setMessage(
        elements.passwordMessage,
        'Không thể kết nối tới LockWeb. Extension có thể vừa được tải lại.'
      );
      return;
    }

    setPasswordBusy(false);
    elements.currentPassword.value = '';
    elements.newPassword.value = '';
    elements.confirmPassword.value = '';
    elements.showPasswords.checked = false;
    setPasswordVisibility(false);

    if (!response || response.ok !== true) {
      if (response && response.error === 'LOCKED') {
        redirectToLockPage();
        return;
      }

      if (response && response.error === 'WRONG_CURRENT_PASSWORD') {
        const remaining = Number(response.attemptsRemaining);
        const suffix =
          Number.isFinite(remaining) && remaining > 0
            ? ` Bạn còn ${remaining} lần thử.`
            : '';
        setMessage(elements.passwordMessage, `Mật khẩu hiện tại không đúng.${suffix}`);
        elements.currentPassword.focus();
        return;
      }

      if (response && response.error === 'COOLDOWN') {
        const seconds = Math.max(1, Math.ceil(Number(response.cooldownSeconds) || 30));
        setMessage(
          elements.passwordMessage,
          `Tạm dừng đổi mật khẩu. Vui lòng thử lại sau ${seconds} giây.`,
          'warning'
        );
        return;
      }

      if (response && response.error === 'PASSWORD_TOO_SHORT') {
        setMessage(elements.passwordMessage, 'Mật khẩu mới phải có ít nhất 8 ký tự.');
        return;
      }

      if (response && response.error === 'PASSWORD_TOO_LONG') {
        setMessage(elements.passwordMessage, 'Mật khẩu mới quá dài.');
        return;
      }

      if (response && response.error === 'CURRENT_PASSWORD_REQUIRED') {
        setMessage(elements.passwordMessage, 'Vui lòng nhập mật khẩu hiện tại.');
        return;
      }

      setMessage(elements.passwordMessage, 'Không thể lưu mật khẩu. Vui lòng thử lại.');
      return;
    }

    const wasConfigured = hasPassword;
    hasPassword = true;
    uiState = {
      ...uiState,
      hasPassword: true
    };
    renderStatus();
    updateSettingsAvailability();
    setPasswordVisibility(false);
    setMessage(
      elements.passwordMessage,
      wasConfigured
        ? 'Đã đổi mật khẩu. Hãy dùng mật khẩu mới ở lần mở khóa tiếp theo.'
        : 'Đã đặt mật khẩu. Bây giờ bạn có thể khóa trình duyệt.',
      'success'
    );
  }

  function setPasswordVisibility(visible) {
    const type = visible ? 'text' : 'password';
    elements.currentPassword.type = type;
    elements.newPassword.type = type;
    elements.confirmPassword.type = type;
  }

  function setSettingsBusy(value) {
    settingsBusy = value;
    elements.saveSettingsButton.disabled = value;
    elements.saveSettingsButton.textContent = value ? 'Đang lưu…' : 'Lưu cài đặt';
  }

  async function handleSettingsSubmit(event) {
    event.preventDefault();

    if (settingsBusy) {
      return;
    }

    const settings = {
      autoLockEnabled: elements.autoLockToggle.checked,
      idleMinutes: Number(elements.idleMinutes.value) || 5,
      openPanelOnIcon: elements.openPanelToggle.checked
    };

    clearMessage(elements.settingsMessage);
    setSettingsBusy(true);

    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: 'LW_SET_SETTINGS',
        settings
      });
    } catch (_) {
      setSettingsBusy(false);
      setMessage(
        elements.settingsMessage,
        'Không thể kết nối tới LockWeb. Extension có thể vừa được tải lại.'
      );
      return;
    }

    setSettingsBusy(false);

    if (!response || response.ok !== true) {
      if (response && response.error === 'LOCKED') {
        redirectToLockPage();
        return;
      }
      setMessage(elements.settingsMessage, 'Không thể lưu cài đặt. Vui lòng thử lại.');
      return;
    }

    uiState = {
      ...uiState,
      settings: response.settings
    };
    populateSettings(response.settings);
    renderStatus();
    setMessage(elements.settingsMessage, 'Đã lưu cài đặt.', 'success');
  }

  async function openShortcutsPage() {
    clearMessage(elements.shortcutMessage);

    try {
      await chrome.tabs.create({ url: shortcutsPageUrl });
    } catch (_) {
      try {
        await navigator.clipboard.writeText(shortcutsPageUrl);
        setMessage(
          elements.shortcutMessage,
          `Không mở được trực tiếp. Đã sao chép địa chỉ: ${shortcutsPageUrl}`,
          'warning'
        );
      } catch (_) {
        setMessage(
          elements.shortcutMessage,
          `Hãy mở thủ công địa chỉ ${shortcutsPageUrl} trong một tab mới.`,
          'warning'
        );
      }
    }
  }

  async function handleLockNow() {
    if (!hasPassword || lockNowBusy) {
      if (!hasPassword) {
        setMessage(elements.passwordMessage, 'Hãy đặt mật khẩu trước khi khóa.');
        elements.newPassword.focus();
      }
      return;
    }

    lockNowBusy = true;
    elements.lockNowButton.disabled = true;
    elements.lockNowButton.textContent = 'Đang khóa…';

    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: 'LW_LOCK_NOW' });
    } catch (_) {
      response = null;
    }

    if (response && response.ok === true) {
      redirectToLockPage();
      return;
    }

    lockNowBusy = false;
    elements.lockNowButton.textContent = 'Khóa ngay';
    elements.lockNowButton.disabled = false;

    if (response && response.error === 'NO_PASSWORD') {
      setMessage(elements.passwordMessage, 'Hãy đặt mật khẩu trước khi khóa.');
      return;
    }

    setMessage(elements.passwordMessage, 'Không thể khóa lúc này. Vui lòng thử lại.');
  }

  elements.passwordForm.addEventListener('submit', (event) => {
    void handlePasswordSubmit(event);
  });

  elements.settingsForm.addEventListener('submit', (event) => {
    void handleSettingsSubmit(event);
  });

  for (const input of [
    elements.currentPassword,
    elements.newPassword,
    elements.confirmPassword
  ]) {
    input.addEventListener('input', () => {
      clearMessage(elements.passwordMessage);
    });
  }

  elements.showPasswords.addEventListener('change', () => {
    setPasswordVisibility(elements.showPasswords.checked);
  });

  elements.autoLockToggle.addEventListener('change', () => {
    updateSettingsAvailability();
  });

  elements.idleMinutes.addEventListener('change', () => {
    setFieldHint();
  });

  elements.lockNowButton.addEventListener('click', () => {
    void handleLockNow();
  });

  elements.shortcutsButton.addEventListener('click', () => {
    void openShortcutsPage();
  });

  elements.topShortcutsButton.addEventListener('click', () => {
    void openShortcutsPage();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes.lwLockState) {
      return;
    }

    const nextLocked = Boolean(
      changes.lwLockState.newValue && changes.lwLockState.newValue.isLocked === true
    );
    if (nextLocked && hasPassword) {
      redirectToLockPage();
    }
  });

  window.addEventListener('focus', () => {
    void refreshShortcut();
    signalActivity();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void refreshShortcut();
      signalActivity();
    }
  });

  document.addEventListener('pointerdown', signalActivity, {
    capture: true,
    passive: true
  });
  document.addEventListener('keydown', signalActivity, {
    capture: true,
    passive: true
  });

  async function initialize() {
    signalActivity();

    let state;
    try {
      state = await refreshState();
    } catch (_) {
      showPageError(
        'Không thể đọc cấu hình LockWeb. Hãy tải lại trang này hoặc kiểm tra extension trong chrome://extensions.'
      );
      return;
    }

    if (!state) {
      return;
    }

    await refreshShortcut();
    elements.loading.hidden = true;
    elements.dashboard.hidden = false;
  }

  void initialize();
})();
