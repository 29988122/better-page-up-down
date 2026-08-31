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

test('script does not stop event propagation or implement its own animation loop', () => {
  assert.doesNotMatch(source, /stopImmediatePropagation\s*\(/);
  assert.doesNotMatch(source, /stopPropagation\s*\(/);
  assert.doesNotMatch(source, /requestAnimationFrame\s*\(/);
  assert.match(source, /behavior: 'smooth'/);
});
