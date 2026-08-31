import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const scriptUrl = new URL('../better-page-up-down.user.js', import.meta.url);
const source = await readFile(scriptUrl, 'utf8');

test('userscript compiles as JavaScript', () => {
  assert.doesNotThrow(() => new vm.Script(source));
});

test('metadata targets ordinary HTTP(S) pages without external code', () => {
  assert.match(source, /\/\/ @match\s+http:\/\/\*\/\*/);
  assert.match(source, /\/\/ @match\s+https:\/\/\*\/\*/);
  assert.doesNotMatch(source, /\/\/ @require\s+/);
  assert.match(source, /\/\/ @run-at\s+document-end/);
});

test('menu exposes the agreed percentages and defaults to 85%', () => {
  assert.match(source, /\[70, 75, 80, 85, 90\]/);
  assert.match(source, /DEFAULT_PERCENTAGE = 85/);
  assert.match(source, /GM_registerMenuCommand/);
  assert.match(source, /GM_getValue/);
  assert.match(source, /GM_setValue/);
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
