import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const scriptUrl = new URL('../better-page-up-down.user.js', import.meta.url);
const source = await readFile(scriptUrl, 'utf8');

function executeSettingsHarness({
  hostname = 'example.com',
  topHostname = hostname,
  ancestorOrigins = [],
  crossOriginTop = false,
  initialValues = [],
} = {}) {
  const store = new Map(initialValues);
  const menus = new Map();
  const listeners = new Map();
  const requestedKeys = [];
  let nextMenuId = 1;
  let nextListenerId = 1;

  const windowObject = {
    location: { hostname, ancestorOrigins },
    addEventListener() {},
    matchMedia: () => ({ matches: false }),
  };
  if (crossOriginTop) {
    const topObject = {};
    Object.defineProperty(topObject, 'location', {
      get() {
        throw new Error('Blocked a frame with origin from accessing a cross-origin frame.');
      },
    });
    windowObject.top = topObject;
  } else if (topHostname === hostname) {
    windowObject.top = windowObject;
  } else {
    windowObject.top = { location: { hostname: topHostname } };
  }

  const notify = (key, oldValue, newValue) => {
    for (const listener of listeners.values()) {
      if (listener.key === key) listener.callback(key, oldValue, newValue, false);
    }
  };
  const context = vm.createContext({
    URL,
    window: windowObject,
    document: {},
    performance: { now: () => 0 },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    getComputedStyle: () => ({}),
    GM_getValue(key, defaultValue) {
      requestedKeys.push(key);
      return store.has(key) ? store.get(key) : defaultValue;
    },
    GM_setValue(key, value) {
      const oldValue = store.get(key);
      store.set(key, value);
      notify(key, oldValue, value);
    },
    GM_deleteValue(key) {
      const oldValue = store.get(key);
      store.delete(key);
      notify(key, oldValue, undefined);
    },
    GM_registerMenuCommand(label, callback, options) {
      const id = nextMenuId++;
      menus.set(id, { label, callback, options });
      return id;
    },
    GM_unregisterMenuCommand(id) {
      menus.delete(id);
    },
    GM_addValueChangeListener(key, callback) {
      const id = nextListenerId++;
      listeners.set(id, { key, callback });
      return id;
    },
  });
  new vm.Script(source).runInContext(context);

  return {
    store,
    menus,
    requestedKeys,
    labels: () => [...menus.values()].map((entry) => entry.label),
    clickLabelContaining(text) {
      const entry = [...menus.values()].find((candidate) => candidate.label.includes(text));
      assert.ok(entry, `Missing menu containing: ${text}`);
      entry.callback();
    },
  };
}

test('userscript compiles as JavaScript', () => {
  assert.doesNotThrow(() => new vm.Script(source));
});

test('metadata targets ordinary HTTP(S) pages without external code', () => {
  assert.match(source, /\/\/ @match\s+http:\/\/\*\/\*/);
  assert.match(source, /\/\/ @match\s+https:\/\/\*\/\*/);
  assert.doesNotMatch(source, /\/\/ @require\s+/);
  assert.match(source, /\/\/ @run-at\s+document-end/);
});

test('menu exposes per-site presets and defaults to 85%', () => {
  assert.match(source, /\[70, 75, 80, 85, 90\]/);
  assert.match(source, /DEFAULT_PERCENTAGE = 85/);
  assert.match(source, /SITE_STORAGE_PREFIX = 'page-scroll-percentage:site:'/);
  assert.match(source, /GM_registerMenuCommand/);
  assert.match(source, /GM_getValue/);
  assert.match(source, /GM_setValue/);
  assert.match(source, /GM_deleteValue/);
});

test('site override wins over the preserved global default', () => {
  const harness = executeSettingsHarness({
    hostname: 'chatgpt.com',
    initialValues: [
      ['page-scroll-percentage', 75],
      ['page-scroll-percentage:site:chatgpt.com', 90],
    ],
  });

  assert.ok(harness.labels().includes('✓ 此網站 chatgpt.com：90%'));
  assert.ok(harness.labels().includes('清除此網站設定（改用全域 75%）'));
  assert.ok(harness.labels().includes('將目前 90% 設為全域預設'));
});

test('site menu persists, clears, and can promote the current value to global', () => {
  const harness = executeSettingsHarness({
    hostname: 'chatgpt.com',
    initialValues: [['page-scroll-percentage', 85]],
  });

  harness.clickLabelContaining('此網站 chatgpt.com：70%');
  assert.equal(harness.store.get('page-scroll-percentage:site:chatgpt.com'), 70);
  assert.equal(harness.store.get('page-scroll-percentage'), 85);
  assert.ok(harness.labels().includes('✓ 此網站 chatgpt.com：70%'));

  harness.clickLabelContaining('清除此網站設定');
  assert.equal(harness.store.has('page-scroll-percentage:site:chatgpt.com'), false);
  assert.ok(harness.labels().includes('✓ 此網站 chatgpt.com：85%'));

  harness.clickLabelContaining('此網站 chatgpt.com：90%');
  harness.clickLabelContaining('將目前 90% 設為全域預設');
  assert.equal(harness.store.get('page-scroll-percentage'), 90);
  assert.equal(harness.store.has('page-scroll-percentage:site:chatgpt.com'), false);
  assert.ok(harness.labels().includes('✓ 此網站 chatgpt.com：90%'));
});

test('invalid stored values fall back to 85 without creating a site key', () => {
  const harness = executeSettingsHarness({
    hostname: 'example.com',
    initialValues: [
      ['page-scroll-percentage', 77],
      ['page-scroll-percentage:site:example.com', 91],
    ],
  });

  assert.ok(harness.labels().includes('✓ 此網站 example.com：85%'));
  assert.equal(harness.labels().some((label) => label.startsWith('清除此網站設定')), false);
});

test('hostname is normalized and cross-origin iframe uses the outermost hostname', () => {
  const topHarness = executeSettingsHarness({ hostname: 'WWW.Example.COM' });
  assert.ok(topHarness.requestedKeys.includes('page-scroll-percentage:site:www.example.com'));

  const frameHarness = executeSettingsHarness({
    hostname: 'frame.vendor.test',
    crossOriginTop: true,
    ancestorOrigins: ['https://parent.vendor.test', 'https://APP.Example.COM:8443'],
    initialValues: [['page-scroll-percentage:site:app.example.com', 70]],
  });
  assert.ok(frameHarness.requestedKeys.includes('page-scroll-percentage:site:app.example.com'));
  assert.equal(frameHarness.menus.size, 0);
});

test('distance is derived from the live scrollport instead of a fixed pixel step', () => {
  assert.match(source, /viewportHeight \* \(currentPercentage \/ 100\) \* direction/);
  assert.match(source, /document\.documentElement\?\.clientHeight/);
  assert.match(source, /element\.clientHeight/);
});

test('held-key repeats are returned before any prevention or scrolling', () => {
  const handlerStart = source.indexOf('function handleKeydown');
  const handlerEnd = source.indexOf("window.addEventListener('pointerdown'", handlerStart);
  const handler = source.slice(handlerStart, handlerEnd);

  const repeatReturn = handler.indexOf('if (event.repeat) return;');
  const preventDefault = handler.indexOf('event.preventDefault()');
  const customScroll = handler.indexOf('scrollByPercentage');

  assert.ok(repeatReturn >= 0);
  assert.ok(repeatReturn < preventDefault);
  assert.ok(repeatReturn < customScroll);
});

test('single-tap animation follows Chromium-like acceleration and braking', () => {
  assert.doesNotMatch(source, /stopImmediatePropagation\s*\(/);
  assert.doesNotMatch(source, /stopPropagation\s*\(/);
  assert.match(source, /ANIMATION_DURATION_MS = 146/);
  assert.match(source, /INITIAL_PROGRESS = 0\.01/);
  assert.match(source, /function nativeEaseInOut/);
  assert.match(source, /cubic-bezier\(0\.42, 0, 0\.58, 1\)/);
  assert.match(source, /applyProgress\(0\)/);
  assert.match(source, /requestAnimationFrame\s*\(/);
  assert.match(source, /performance\.now\(\) - startedAt/);
  assert.match(source, /behavior: 'instant'/);
  assert.doesNotMatch(source, /behavior: 'smooth'/);
  assert.doesNotMatch(source, /const step = \(now\)/);
});
