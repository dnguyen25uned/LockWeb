/**
 * Smoke test cho service worker với chrome API giả lập.
 * Chạy: node tests/service-worker.test.js
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const SW_PATH = path.join(ROOT, 'background', 'service-worker.js');
const EXT_ID = 'testextensionid';
const EXT_ORIGIN = `chrome-extension://${EXT_ID}/`;

function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    },
    async emit(...args) {
      for (const listener of listeners) {
        await listener(...args);
      }
    }
  };
}

function createStorageArea(initial = {}, areaName = 'local') {
  const data = initial;
  const onChanged = [];

  function notify(changes) {
    if (!Object.keys(changes).length) {
      return;
    }
    for (const listener of onChanged) {
      try {
        listener(changes, areaName);
      } catch (error) {
        console.error('storage listener error', error);
      }
    }
  }

  function select(keys) {
    if (keys == null) {
      return { ...data };
    }
    if (typeof keys === 'string') {
      return { [keys]: data[keys] };
    }
    if (Array.isArray(keys)) {
      const result = {};
      for (const key of keys) {
        result[key] = data[key];
      }
      return result;
    }
    if (typeof keys === 'object') {
      const result = {};
      for (const [key, fallback] of Object.entries(keys)) {
        result[key] = data[key] === undefined ? fallback : data[key];
      }
      return result;
    }
    return {};
  }

  return {
    data,
    onChanged,
    async get(keys) {
      return select(keys);
    },
    async set(values) {
      const changes = {};
      for (const [key, value] of Object.entries(values)) {
        changes[key] = { oldValue: data[key], newValue: value };
        data[key] = value;
      }
      notify(changes);
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      const changes = {};
      for (const key of list) {
        if (Object.prototype.hasOwnProperty.call(data, key)) {
          changes[key] = { oldValue: data[key], newValue: undefined };
          delete data[key];
        }
      }
      notify(changes);
    },
    async clear() {
      const changes = {};
      for (const key of Object.keys(data)) {
        changes[key] = { oldValue: data[key], newValue: undefined };
        delete data[key];
      }
      notify(changes);
    }
  };
}

function createChromeMock({ localData, sessionData, tabs }) {
  const local = createStorageArea(localData, 'local');
  const session = createStorageArea(sessionData, 'session');
  const storageOnChanged = createEvent();
  local.onChanged.push((changes) => storageOnChanged.emit(changes, 'local'));
  session.onChanged.push((changes) => storageOnChanged.emit(changes, 'session'));

  const messageEvent = createEvent();
  const alarmEvent = createEvent();
  const commandEvent = createEvent();
  const clickedEvent = createEvent();
  const installedEvent = createEvent();
  const startupEvent = createEvent();
  const tabRemovedEvent = createEvent();
  const tabActivatedEvent = createEvent();

  const alarms = new Map();
  const action = {
    badgeText: '',
    title: '',
    popup: '',
    async setBadgeText({ text }) {
      action.badgeText = text;
    },
    async setBadgeBackgroundColor() {},
    async setTitle({ title }) {
      action.title = title;
    },
    async setPopup({ popup }) {
      action.popup = popup;
    },
    onClicked: clickedEvent
  };

  let injectionCount = 0;

  const chrome = {
    runtime: {
      id: EXT_ID,
      getURL(resource) {
        return `${EXT_ORIGIN}${String(resource || '').replace(/^\//, '')}`;
      },
      onMessage: messageEvent,
      onInstalled: installedEvent,
      onStartup: startupEvent,
      async sendMessage() {
        throw new Error('No receiver');
      },
      async openOptionsPage() {
        chrome.runtime.optionsOpened += 1;
      },
      optionsOpened: 0
    },
    storage: {
      local,
      session,
      onChanged: storageOnChanged
    },
    action,
    alarms: {
      async create(name, info) {
        alarms.set(name, info);
      },
      async get(name) {
        return alarms.has(name) ? { name, ...alarms.get(name) } : undefined;
      },
      async clear(name) {
        alarms.delete(name);
        return true;
      },
      onAlarm: alarmEvent
    },
    tabs: {
      async query() {
        return tabs;
      },
      async create() {},
      async getCurrent() {
        return tabs[0];
      },
      async remove() {},
      onRemoved: tabRemovedEvent,
      onActivated: tabActivatedEvent
    },
    scripting: {
      async executeScript({ target }) {
        if (target.tabId === 999) {
          throw new Error('Cannot access chrome:// page');
        }
        injectionCount += 1;
        return [];
      }
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: createEvent()
    },
    commands: {
      onCommand: commandEvent
    },
    __mock: {
      local,
      session,
      alarms,
      action,
      messageEvent,
      alarmEvent,
      commandEvent,
      clickedEvent,
      installedEvent,
      startupEvent,
      storageOnChanged,
      get injectionCount() {
        return injectionCount;
      }
    }
  };

  return chrome;
}

async function flush(milliseconds = 60) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function sendMessage(chromeMock, message, sender) {
  const handlers = chromeMock.runtime.onMessage.listeners;
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(undefined);
      }
    }, 5000);

    const sendResponse = (response) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(response);
    };

    try {
      for (const handler of handlers) {
        handler(message, sender, sendResponse);
      }
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

function loadServiceWorker(chromeMock, clock) {
  const context = vm.createContext({
    chrome: chromeMock,
    crypto: webcrypto,
    btoa,
    atob,
    TextEncoder,
    TextDecoder,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    Date: clock ? clock.DateClass : Date,
    Promise,
    Uint8Array,
    Array,
    Object,
    Number,
    String,
    Math,
    JSON
  });
  const code = fs.readFileSync(SW_PATH, 'utf8');
  vm.runInContext(code, context, { filename: 'service-worker.js' });
  return context;
}

function makeClock() {
  const RealDate = Date;
  let offset = 0;
  class FakeDate extends RealDate {
    static now() {
      return RealDate.now() + offset;
    }
    constructor(...args) {
      if (args.length === 0) {
        super(RealDate.now() + offset);
      } else {
        super(...args);
      }
    }
  }
  return {
    DateClass: FakeDate,
    advance(ms) {
      offset += ms;
    }
  };
}

function makeSender({ url = `${EXT_ORIGIN}options/options.html`, frameId = 0, tabId = 1 } = {}) {
  const sender = {
    id: EXT_ID,
    url,
    frameId
  };
  if (Number.isInteger(tabId)) {
    sender.tab = { id: tabId };
  }
  return sender;
}

async function run() {
  const localData = {};
  const sessionData = {};
  const tabs = [
    { id: 1, url: 'https://example.com/' },
    { id: 2, url: 'https://openai.com/' },
    { id: 999, url: 'chrome://settings/' }
  ];
  const chrome = createChromeMock({ localData, sessionData, tabs });
  const clock = makeClock();
  loadServiceWorker(chrome, clock);
  await flush(120);

  const optionsSender = makeSender();
  const popupSender = makeSender({
    url: `${EXT_ORIGIN}popup/popup.html`,
    frameId: undefined,
    tabId: null
  });
  const webSender = makeSender({
    url: 'https://example.com/',
    frameId: 0,
    tabId: 2
  });

  let response = await sendMessage(chrome, { type: 'LW_GET_STATE' }, optionsSender);
  assert.equal(response.ok, true);
  assert.equal(response.isLocked, false);
  assert.equal(response.hasPassword, false);

  response = await sendMessage(chrome, { type: 'LW_LOCK_NOW' }, optionsSender);
  assert.equal(response.ok, false);
  assert.equal(response.error, 'NO_PASSWORD');
  assert.equal(chrome.__mock.action.badgeText, '');

  response = await sendMessage(
    chrome,
    {
      type: 'LW_SET_PASSWORD',
      currentPassword: '',
      newPassword: 'mật-khẩu-rất-dài-123'
    },
    optionsSender
  );
  assert.equal(response.ok, true);
  const auth = localData.lwAuth;
  assert.ok(auth);
  assert.equal(auth.algorithm, 'PBKDF2-HMAC-SHA-256');
  assert.equal(auth.iterations, 600000);
  assert.ok(!JSON.stringify(auth).includes('mật-khẩu'));
  assert.equal(localData.lwAttempts.count, 0);

  response = await sendMessage(
    chrome,
    { type: 'LW_SUBMIT_PASSWORD', password: 'mật-khẩu-rất-dài-123', viewToken: '' },
    popupSender
  );
  assert.equal(response.ok, true);
  assert.equal(response.alreadyUnlocked, true);

  response = await sendMessage(chrome, { type: 'LW_LOCK_NOW' }, popupSender);
  assert.equal(response.ok, true);
  assert.equal(localData.lwLockState.isLocked, true);
  assert.equal(chrome.__mock.action.badgeText, 'LOCK');
  assert.ok(chrome.__mock.injectionCount >= 2, 'phải inject vào các tab web');
  assert.equal(localData.lwAttempts.count, 0);

  const token = 'a'.repeat(32);
  response = await sendMessage(
    chrome,
    { type: 'LW_REGISTER_VIEW', token },
    webSender
  );
  assert.equal(response.ok, true);

  const embeddedSender = makeSender({
    url: `${EXT_ORIGIN}lock/lock.html`,
    frameId: 7,
    tabId: 2
  });

  response = await sendMessage(
    chrome,
    { type: 'LW_GET_STATE', viewToken: 'b'.repeat(32) },
    embeddedSender
  );
  assert.equal(response.ok, false);
  assert.equal(response.error, 'UNTRUSTED_VIEW');

  response = await sendMessage(
    chrome,
    { type: 'LW_GET_STATE', viewToken: token },
    embeddedSender
  );
  assert.equal(response.ok, true);
  assert.equal(response.isLocked, true);
  assert.equal(response.hasPassword, true);

  response = await sendMessage(
    chrome,
    { type: 'LW_SUBMIT_PASSWORD', password: 'sai-mật-khẩu', viewToken: token },
    embeddedSender
  );
  assert.equal(response.ok, false);
  assert.equal(response.error, 'WRONG_PASSWORD');
  assert.equal(response.attemptsRemaining, 4);
  assert.equal(localData.lwAttempts.count, 1);

  response = await sendMessage(
    chrome,
    { type: 'LW_SUBMIT_PASSWORD', password: 'sai-mật-khẩu', viewToken: token },
    webSender
  );
  assert.equal(response.ok, false);
  assert.equal(response.error, 'UNTRUSTED_VIEW');

  response = await sendMessage(
    chrome,
    { type: 'LW_SUBMIT_PASSWORD', password: 'mật-khẩu-rất-dài-123', viewToken: token },
    embeddedSender
  );
  assert.equal(response.ok, true);
  assert.equal(localData.lwLockState.isLocked, false);
  assert.equal(chrome.__mock.action.badgeText, '');
  assert.equal(localData.lwAttempts.count, 0);
  assert.equal(localData.lwAttempts.blockedUntil, 0);

  response = await sendMessage(
    chrome,
    {
      type: 'LW_SET_SETTINGS',
      settings: {
        autoLockEnabled: true,
        idleMinutes: 1,
        openPanelOnIcon: true
      }
    },
    optionsSender
  );
  assert.equal(response.ok, true);
  assert.equal(response.settings.idleMinutes, 1);
  assert.equal(chrome.__mock.action.popup, 'popup/popup.html');
  assert.ok(chrome.__mock.alarms.has('lw-auto-lock'));

  clock.advance(120000);
  await chrome.__mock.alarmEvent.emit({ name: 'lw-auto-lock' });
  await flush(120);
  assert.equal(localData.lwLockState.isLocked, true);
  assert.equal(localData.lwLockState.reason, 'inactivity');
  assert.equal(chrome.__mock.action.badgeText, 'LOCK');

  // Khóa nhiều lần không được reset cooldown của màn hình đang khóa.
  localData.lwAttempts = { count: 3, blockedUntil: 0 };
  chrome.__mock.clickedEvent.emit();
  await flush(100);
  assert.equal(localData.lwAttempts.count, 3);

  // Mất auth không được để trạng thái khóa mồ côi.
  await localData.lwLockState; // no-op, giữ dữ liệu dễ đọc
  await chrome.__mock.local.remove('lwAuth');
  await flush(120);
  assert.equal(localData.lwLockState.isLocked, false);

  console.log('PASS: service worker smoke test');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
