'use strict';

(() => {
  const params = new URLSearchParams(window.location.search);
  const embedded = params.get('mode') === 'embedded';
  const viewToken = params.get('token') || '';
  const requestedNext = params.get('next') || '';
  const next = requestedNext === 'options' ? 'options' : '';
  const domainParam = params.get('d') || (embedded ? 'TRANG WEB' : 'TRÌNH DUYỆT');

  const elements = {
    card: document.getElementById('lock-card'),
    clock: document.getElementById('clock'),
    date: document.getElementById('date'),
    domain: document.getElementById('domain'),
    loading: document.getElementById('loading-state'),
    form: document.getElementById('unlock-form'),
    inputShell: document.getElementById('input-shell'),
    password: document.getElementById('password'),
    togglePassword: document.getElementById('toggle-password'),
    eyeOpen: document.querySelector('.eye-open'),
    eyeClosed: document.querySelector('.eye-closed'),
    helper: document.getElementById('helper'),
    error: document.getElementById('error-message'),
    unlockButton: document.getElementById('unlock-button'),
    unlockLabel: document.getElementById('unlock-label'),
    setup: document.getElementById('setup-state'),
    openOptions: document.getElementById('open-options-button'),
    success: document.getElementById('success-state'),
    successTitle: document.getElementById('success-title'),
    successActions: document.getElementById('success-actions'),
    closeTab: document.getElementById('close-tab-button'),
    successOptions: document.getElementById('success-options-button'),
    fatal: document.getElementById('fatal-state'),
    fatalCopy: document.getElementById('fatal-copy')
  };

  const timeFormatter = new Intl.DateTimeFormat('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });
  const dateFormatter = new Intl.DateTimeFormat('vi-VN', {
    weekday: 'long',
    day: '2-digit',
    month: 'long'
  });

  let busy = false;
  let unlocked = false;
  let cooldownUntil = 0;
  let cooldownTimer = 0;
  let clockTimer = 0;
  let unloaded = false;
  let readyPosted = false;
  let stateEpoch = 0;

  function sanitizeDomain(value) {
    const cleaned = String(value || '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    return (cleaned || (embedded ? 'TRANG WEB' : 'TRÌNH DUYỆT')).toLocaleUpperCase('vi-VN');
  }

  function updateClock() {
    const now = new Date();
    try {
      elements.clock.textContent = timeFormatter.format(now);
      const dateText = dateFormatter.format(now);
      elements.date.textContent =
        dateText.charAt(0).toLocaleUpperCase('vi-VN') + dateText.slice(1);
    } catch (_) {
      elements.clock.textContent = now.toLocaleTimeString('vi-VN');
      elements.date.textContent = now.toLocaleDateString('vi-VN');
    }
  }

  function showView(view) {
    elements.loading.hidden = view !== 'loading';
    elements.form.hidden = view !== 'form';
    elements.setup.hidden = view !== 'setup';
    elements.success.hidden = view !== 'success';
    elements.fatal.hidden = view !== 'fatal';

    if (view !== 'form') {
      busy = false;
      setBusyUi(false);
    }
  }

  function setBusyUi(value) {
    const lockedByCooldown = cooldownUntil > Date.now();
    elements.unlockButton.disabled = value || lockedByCooldown;
    elements.password.disabled = value || lockedByCooldown;
    elements.unlockButton.classList.toggle('is-busy', value);
    elements.unlockLabel.textContent = value ? 'Đang kiểm tra…' : 'Mở khóa';
    elements.togglePassword.disabled = value || lockedByCooldown;
  }

  function setBusy(value) {
    busy = value;
    setBusyUi(value);
  }

  function clearMessage() {
    elements.error.hidden = true;
    elements.error.textContent = '';
    elements.error.classList.remove('is-warning');
  }

  function setMessage(message, type = 'error') {
    elements.error.textContent = message;
    elements.error.hidden = false;
    elements.error.classList.toggle('is-warning', type === 'warning');
  }

  function setHelper(message) {
    elements.helper.textContent = message;
  }

  function shakeCard() {
    elements.card.classList.remove('shake');
    // Buộc trình duyệt tính lại animation.
    void elements.card.offsetWidth;
    elements.card.classList.add('shake');
  }

  elements.card.addEventListener('animationend', (event) => {
    if (event.animationName === 'card-shake') {
      elements.card.classList.remove('shake');
    }
  });

  function focusPassword() {
    window.setTimeout(() => {
      if (!unlocked && !elements.form.hidden) {
        try {
          elements.password.focus({ preventScroll: true });
        } catch (_) {
          elements.password.focus();
        }
      }
    }, 30);
  }

  function clearCooldownTimer() {
    if (cooldownTimer) {
      window.clearInterval(cooldownTimer);
      cooldownTimer = 0;
    }
    cooldownUntil = 0;
  }

  function finishCooldown() {
    cooldownUntil = 0;
    cooldownTimer = 0;
    clearMessage();
    setHelper('Nhập mật khẩu để tiếp tục');
    setBusyUi(busy);
    focusPassword();
  }

  function startCooldown(seconds) {
    const safeSeconds = Math.max(1, Math.ceil(Number(seconds) || 30));
    clearCooldownTimer();
    cooldownUntil = Date.now() + safeSeconds * 1000;
    setBusyUi(busy);

    const tick = () => {
      if (unloaded) {
        return;
      }

      const remaining = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
      if (remaining <= 0) {
        window.clearInterval(cooldownTimer);
        finishCooldown();
        return;
      }

      setMessage(`Tạm dừng nhập mật khẩu. Vui lòng thử lại sau ${remaining} giây.`, 'warning');
      setBusyUi(busy);
    };

    tick();
    cooldownTimer = window.setInterval(tick, 1000);
  }

  function formatAttemptsMessage(response) {
    if (response.error === 'WRONG_PASSWORD') {
      const remaining = Number(response.attemptsRemaining);
      if (Number.isFinite(remaining) && remaining > 0) {
        return `Mật khẩu không đúng. Bạn còn ${remaining} lần thử.`;
      }
      return 'Mật khẩu không đúng.';
    }

    if (response.error === 'COOLDOWN') {
      return 'Sai mật khẩu. Nhập mật khẩu đã tạm bị khóa.';
    }

    if (response.error === 'EMPTY_PASSWORD') {
      return 'Vui lòng nhập mật khẩu.';
    }

    if (response.error === 'NO_PASSWORD') {
      return 'Chưa có mật khẩu được cấu hình.';
    }

    if (response.error === 'UNTRUSTED_VIEW') {
      return 'Không thể xác minh ngữ cảnh hiển thị của LockWeb.';
    }

    return 'Không thể xác thực lúc này. Vui lòng thử lại.';
  }

  function showFatal(message) {
    elements.fatalCopy.textContent =
      message || 'Hãy đóng tab này, mở lại một trang web khác và thử lại.';
    showView('fatal');
    document.title = 'Lỗi · LockWeb';
    postReady();
  }

  function showSetup() {
    showView('setup');
    document.title = 'Chưa cấu hình · LockWeb';
    postReady();
  }

  function showSuccess() {
    unlocked = true;
    busy = false;
    clearCooldownTimer();
    elements.password.value = '';
    showView('success');
    document.title = 'Đã mở khóa · LockWeb';
    postReady();

    if (!embedded && next === 'options') {
      elements.successTitle.textContent = 'Đã mở khóa';
      window.setTimeout(() => {
        window.location.replace(chrome.runtime.getURL('options/options.html'));
      }, 500);
      return;
    }

    if (!embedded) {
      elements.successTitle.textContent = 'Trình duyệt đã mở khóa';
      elements.successActions.hidden = false;
    } else {
      elements.successTitle.textContent = 'Đã mở khóa';
      elements.successActions.hidden = true;
    }
  }

  function showUnlockForm(state) {
    showView('form');
    clearMessage();
    setHelper('Nhập mật khẩu để tiếp tục');
    document.title = 'Đã khóa · LockWeb';
    postReady();

    const cooldown = Math.max(0, Math.ceil(Number(state.cooldownSeconds) || 0));
    const attemptsRemaining = Number(state.attemptsRemaining);

    if (cooldown > 0) {
      startCooldown(cooldown);
    } else if (Number.isFinite(attemptsRemaining) && attemptsRemaining < 5) {
      setHelper(`Bạn còn ${Math.max(0, attemptsRemaining)} lần thử trước khi tạm khóa nhập.`);
    }

    setBusyUi(busy);
    focusPassword();
  }

  function postReady() {
    if (!embedded || readyPosted) {
      return;
    }
    readyPosted = true;
    try {
      window.parent.postMessage({ type: 'LW_LOCK_READY' }, '*');
    } catch (_) {
      // Không có parent hoặc parent đã đóng.
    }
  }

  async function sendMessage(message) {
    return chrome.runtime.sendMessage(message);
  }

  async function loadState() {
    const requestEpoch = stateEpoch;

    try {
      const response = await sendMessage({
        type: 'LW_GET_STATE',
        viewToken
      });

      // Một tab khác có thể vừa mở khóa/khóa lại trong lúc chờ phản hồi.
      if (requestEpoch !== stateEpoch || unlocked) {
        return;
      }

      if (!response || response.ok !== true) {
        showFatal(
          response && response.error === 'UNTRUSTED_VIEW'
            ? 'Không thể xác minh ngữ cảnh hiển thị của LockWeb. Hãy tải lại trang web.'
            : 'Không thể đọc trạng thái khóa. Hãy tải lại trang web.'
        );
        return;
      }

      if (!response.isLocked) {
        showSuccess();
        return;
      }

      if (!response.hasPassword) {
        showSetup();
        return;
      }

      showUnlockForm(response);
    } catch (_) {
      if (requestEpoch !== stateEpoch) {
        return;
      }
      showFatal(
        'Không thể kết nối tới LockWeb. Extension có thể vừa được tải lại — hãy tải lại trang web.'
      );
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();

    if (busy || unlocked || cooldownUntil > Date.now()) {
      return;
    }

    const password = elements.password.value;
    if (!password) {
      setMessage('Vui lòng nhập mật khẩu.');
      focusPassword();
      return;
    }

    // Xóa mật khẩu khỏi ô nhập ngay sau khi sao chép vào biến cục bộ.
    elements.password.value = '';
    clearMessage();
    setHelper('Đang xác thực cục bộ…');
    setBusy(true);

    let response;
    try {
      response = await sendMessage({
        type: 'LW_SUBMIT_PASSWORD',
        password,
        viewToken
      });
    } catch (_) {
      setBusy(false);
      setHelper('Nhập mật khẩu để tiếp tục');
      setMessage('Không thể kết nối tới LockWeb. Vui lòng thử lại.');
      focusPassword();
      return;
    }

    if (response && response.ok === true) {
      showSuccess();
      return;
    }

    setBusy(false);
    setHelper('Nhập mật khẩu để tiếp tục');

    if (!response) {
      setMessage('Không nhận được phản hồi từ LockWeb. Vui lòng thử lại.');
      focusPassword();
      return;
    }

    if (response.error === 'COOLDOWN') {
      startCooldown(response.cooldownSeconds || 30);
      shakeCard();
      focusPassword();
      return;
    }

    if (response.error === 'NO_PASSWORD') {
      showSetup();
      return;
    }

    if (response.error === 'UNTRUSTED_VIEW') {
      showFatal('Không thể xác minh ngữ cảnh hiển thị của LockWeb. Hãy tải lại trang web.');
      return;
    }

    if (response.error === 'EMPTY_PASSWORD') {
      setMessage('Vui lòng nhập mật khẩu.');
    } else {
      setMessage(formatAttemptsMessage(response));
    }

    shakeCard();
    focusPassword();
  }

  elements.form.addEventListener('submit', (event) => {
    void handleSubmit(event);
  });

  elements.password.addEventListener('input', () => {
    if (cooldownUntil <= Date.now()) {
      clearMessage();
    }
  });

  elements.togglePassword.addEventListener('click', () => {
    const show = elements.password.type === 'password';
    elements.password.type = show ? 'text' : 'password';
    elements.togglePassword.setAttribute('aria-pressed', String(show));
    elements.togglePassword.setAttribute(
      'aria-label',
      show ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'
    );
    elements.eyeOpen.hidden = show;
    elements.eyeClosed.hidden = !show;
    try {
      elements.password.focus({ preventScroll: true });
    } catch (_) {
      elements.password.focus();
    }
  });

  elements.openOptions.addEventListener('click', () => {
    try {
      chrome.runtime.openOptionsPage();
    } catch (_) {
      showFatal('Không thể mở trang Cài đặt của LockWeb.');
    }
  });

  elements.successOptions.addEventListener('click', () => {
    try {
      chrome.runtime.openOptionsPage();
    } catch (_) {
      showFatal('Không thể mở trang Cài đặt của LockWeb.');
    }
  });

  elements.closeTab.addEventListener('click', async () => {
    try {
      const currentTab = await chrome.tabs.getCurrent();
      if (currentTab && Number.isInteger(currentTab.id)) {
        await chrome.tabs.remove(currentTab.id);
        return;
      }
    } catch (_) {
      // Thử đóng bằng window.close() bên dưới.
    }

    try {
      window.close();
    } catch (_) {
      // Trình duyệt có thể chặn đóng tab không do script mở.
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes.lwLockState) {
      return;
    }

    const nextLocked = Boolean(
      changes.lwLockState.newValue && changes.lwLockState.newValue.isLocked === true
    );

    stateEpoch += 1;

    if (!nextLocked) {
      if (!unlocked) {
        showSuccess();
      }
      return;
    }

    if (nextLocked) {
      unlocked = false;
      clearCooldownTimer();
      void loadState();
    }
  });

  window.addEventListener('pagehide', () => {
    unloaded = true;
    elements.password.value = '';
    window.clearInterval(clockTimer);
    window.clearInterval(cooldownTimer);
  });

  window.addEventListener('pageshow', () => {
    if (unloaded) {
      unloaded = false;
      updateClock();
      clockTimer = window.setInterval(updateClock, 1000);
    }
    if (!unlocked) {
      void loadState();
    }
  });

  // Chỉ cho phép focus vào ô mật khẩu khi người dùng quay lại iframe.
  window.addEventListener('focus', () => {
    if (!unlocked && !elements.form.hidden) {
      focusPassword();
    }
  });

  elements.domain.textContent = `[ ${sanitizeDomain(domainParam)} ]`;
  updateClock();
  clockTimer = window.setInterval(updateClock, 1000);
  void loadState();
})();
