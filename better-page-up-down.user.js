// ==UserScript==
// @name         Better PageUp / PageDown
// @name:zh-TW   跨解析度 PageUp／PageDown
// @namespace    better-page-scroll
// @version      1.0.4
// @description  Scroll a configurable percentage on a tap, then leave held-key repeats to Chromium.
// @description:zh-TW 輕按時捲動可設定的畫面比例；長按後續 repeat 完全交回 Chromium。
// @homepageURL  https://greasyfork.org/zh-TW/scripts/593678-better-pageup-pagedown
// @source       https://github.com/29988122/better-page-up-down
// @supportURL   https://github.com/29988122/better-page-up-down/issues
// @updateURL    https://raw.githubusercontent.com/29988122/better-page-up-down/main/better-page-up-down.user.js
// @downloadURL  https://raw.githubusercontent.com/29988122/better-page-up-down/main/better-page-up-down.user.js
// @match        http://*/*
// @match        https://*/*
// @run-at       document-end
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @license      MIT
// ==/UserScript==

(() => {
  'use strict';

  const ALLOWED_PERCENTAGES = Object.freeze([70, 75, 80, 85, 90]);
  const DEFAULT_PERCENTAGE = 85;
  const STORAGE_KEY = 'page-scroll-percentage';
  const SCROLL_EPSILON = 1;
  const ANIMATION_DURATION_MS = 146;
  const INITIAL_PROGRESS = 0.01;

  const INTERACTIVE_SELECTOR = [
    'input',
    'textarea',
    'select',
    'option',
    '[contenteditable]:not([contenteditable="false"])',
    '[role="textbox"]',
    '[role="combobox"]',
    '[role="listbox"]',
    '[role="menu"]',
    '[role="menubar"]',
    '[role="grid"]',
    '[role="tree"]',
    '[role="slider"]',
    '[role="spinbutton"]',
    '[role="tablist"]',
  ].join(',');

  let currentPercentage = normalizePercentage(readStoredPercentage());
  let lastInteractionPath = [];
  let menuIds = [];
  const activeAnimations = new Map();

  function normalizePercentage(value) {
    const numericValue = Number(value);
    return ALLOWED_PERCENTAGES.includes(numericValue)
      ? numericValue
      : DEFAULT_PERCENTAGE;
  }

  function readStoredPercentage() {
    if (typeof GM_getValue !== 'function') return DEFAULT_PERCENTAGE;
    return GM_getValue(STORAGE_KEY, DEFAULT_PERCENTAGE);
  }

  function writeStoredPercentage(value) {
    if (typeof GM_setValue === 'function') {
      GM_setValue(STORAGE_KEY, value);
    }
  }

  function unregisterMenus() {
    if (typeof GM_unregisterMenuCommand !== 'function') {
      menuIds = [];
      return;
    }

    for (const id of menuIds) {
      try {
        GM_unregisterMenuCommand(id);
      } catch {
        // A page navigation or manager refresh may already have removed it.
      }
    }
    menuIds = [];
  }

  function registerMenus() {
    if (typeof GM_registerMenuCommand !== 'function') return;

    unregisterMenus();
    for (const percentage of ALLOWED_PERCENTAGES) {
      const selected = percentage === currentPercentage;
      const label = `${selected ? '✓ ' : ''}PageUp／PageDown：${percentage}%`;
      const id = GM_registerMenuCommand(
        label,
        () => setPercentage(percentage),
        {
          title: selected
            ? `目前每次輕按捲動 ${percentage}% 畫面高度`
            : `改為每次輕按捲動 ${percentage}% 畫面高度`,
          autoClose: true,
        },
      );
      menuIds.push(id);
    }
  }

  function setPercentage(value, persist = true) {
    const nextPercentage = normalizePercentage(value);
    if (nextPercentage === currentPercentage) return;

    currentPercentage = nextPercentage;
    if (persist) writeStoredPercentage(nextPercentage);
    registerMenus();
  }

  function isElement(node) {
    return Boolean(node && node.nodeType === 1);
  }

  function getRootScroller() {
    return document.scrollingElement || document.documentElement;
  }

  function isRootScroller(element) {
    const rootScroller = getRootScroller();
    return Boolean(
      element
      && (
        element === rootScroller
        || element === document.documentElement
        || (element === document.body && rootScroller === document.body)
      )
    );
  }

  function rootScrollportHeight() {
    return document.documentElement?.clientHeight || window.innerHeight || 0;
  }

  function scrollportHeight(element) {
    return isRootScroller(element)
      ? rootScrollportHeight()
      : element.clientHeight;
  }

  function isScrollable(element) {
    if (!isElement(element) || !element.isConnected) return false;

    const viewportHeight = scrollportHeight(element);
    if (viewportHeight <= 0 || element.scrollHeight <= viewportHeight + SCROLL_EPSILON) {
      return false;
    }

    if (isRootScroller(element)) return true;

    const overflowY = getComputedStyle(element).overflowY;
    return /^(auto|scroll|overlay)$/.test(overflowY);
  }

  function canScrollInDirection(element, direction) {
    if (!isScrollable(element)) return false;

    const viewportHeight = scrollportHeight(element);
    const scrollRange = Math.max(0, element.scrollHeight - viewportHeight);
    const currentScrollTop = element.scrollTop;
    const reverseColumn = !isRootScroller(element)
      && getComputedStyle(element).flexDirection === 'column-reverse';
    const minimumScrollTop = reverseColumn ? -scrollRange : 0;
    const maximumScrollTop = reverseColumn ? 0 : scrollRange;

    if (direction > 0) {
      return currentScrollTop < maximumScrollTop - SCROLL_EPSILON;
    }
    return currentScrollTop > minimumScrollTop + SCROLL_EPSILON;
  }

  function scrollBounds(element) {
    const viewportHeight = scrollportHeight(element);
    const scrollRange = Math.max(0, element.scrollHeight - viewportHeight);
    const reverseColumn = !isRootScroller(element)
      && getComputedStyle(element).flexDirection === 'column-reverse';

    return reverseColumn
      ? { minimum: -scrollRange, maximum: 0 }
      : { minimum: 0, maximum: scrollRange };
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function nativeEaseInOut(progress) {
    // Chromium's keyboard PageDown trace closely matches the standard CSS
    // ease-in-out curve: cubic-bezier(0.42, 0, 0.58, 1). Solve the Bezier x
    // coordinate, then return its y coordinate so scrollTop can use the same
    // acceleration and braking shape without CSS smooth scrolling.
    let lower = 0;
    let upper = 1;

    for (let iteration = 0; iteration < 10; iteration += 1) {
      const parameter = (lower + upper) / 2;
      const inverse = 1 - parameter;
      const x = 3 * inverse * inverse * parameter * 0.42
        + 3 * inverse * parameter * parameter * 0.58
        + parameter * parameter * parameter;

      if (x < progress) lower = parameter;
      else upper = parameter;
    }

    const parameter = (lower + upper) / 2;
    return parameter * parameter * (3 - 2 * parameter);
  }

  function setScrollTop(scroller, scrollTop) {
    scroller.scrollTo({
      top: scrollTop,
      behavior: 'instant',
    });
  }

  function cancelScrollAnimation(scroller) {
    const animation = activeAnimations.get(scroller);
    if (!animation) return;

    cancelAnimationFrame(animation.frameId);
    activeAnimations.delete(scroller);
  }

  function cancelAllScrollAnimations() {
    for (const scroller of activeAnimations.keys()) {
      cancelScrollAnimation(scroller);
    }
  }

  function animateScrollTo(scroller, targetScrollTop, startedAt) {
    const startScrollTop = scroller.scrollTop;
    cancelScrollAnimation(scroller);

    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setScrollTop(scroller, targetScrollTop);
      return;
    }

    const animation = {
      frameId: 0,
      targetScrollTop,
      lastAppliedScrollTop: startScrollTop,
    };

    const applyProgress = (progress) => {
      const easedProgress = Math.max(INITIAL_PROGRESS, nativeEaseInOut(progress));
      const nextScrollTop = startScrollTop
        + (targetScrollTop - startScrollTop) * easedProgress;

      setScrollTop(scroller, nextScrollTop);
      animation.lastAppliedScrollTop = scroller.scrollTop;
    };

    const step = () => {
      if (activeAnimations.get(scroller) !== animation) return;
      if (!scroller.isConnected) {
        activeAnimations.delete(scroller);
        return;
      }

      if (Math.abs(scroller.scrollTop - animation.lastAppliedScrollTop) > SCROLL_EPSILON) {
        activeAnimations.delete(scroller);
        return;
      }

      // The rAF timestamp describes the start of the frame. On a busy page,
      // earlier callbacks can consume tens of milliseconds before this one
      // runs, so read the actual execution time instead of extending the
      // animation with a stale timestamp.
      const progress = Math.min(
        Math.max((performance.now() - startedAt) / ANIMATION_DURATION_MS, 0),
        1,
      );
      applyProgress(progress);

      if (progress < 1) {
        animation.frameId = requestAnimationFrame(step);
        return;
      }

      setScrollTop(scroller, targetScrollTop);
      activeAnimations.delete(scroller);
    };

    activeAnimations.set(scroller, animation);
    applyProgress(0);
    animation.frameId = requestAnimationFrame(step);
  }

  function fallbackPathFromNode(node) {
    const path = [];
    const seen = new Set();
    let current = isElement(node) ? node : null;

    while (current && !seen.has(current)) {
      path.push(current);
      seen.add(current);

      if (current.parentElement) {
        current = current.parentElement;
        continue;
      }

      const root = current.getRootNode?.();
      current = isElement(root?.host) ? root.host : null;
    }

    return path;
  }

  function elementsFromEventPath(event) {
    const composedPath = typeof event.composedPath === 'function'
      ? event.composedPath()
      : [];
    const elements = composedPath.filter(isElement);
    return elements.length > 0 ? elements : fallbackPathFromNode(event.target);
  }

  function deepActiveElement() {
    let activeElement = document.activeElement;
    const seen = new Set();

    while (
      isElement(activeElement)
      && activeElement.shadowRoot
      && isElement(activeElement.shadowRoot.activeElement)
      && !seen.has(activeElement)
    ) {
      seen.add(activeElement);
      activeElement = activeElement.shadowRoot.activeElement;
    }

    return isElement(activeElement) ? activeElement : null;
  }

  function isInteractivePath(path) {
    for (const element of path) {
      if (!isElement(element)) continue;
      if (element.isContentEditable || element.matches?.(INTERACTIVE_SELECTOR)) {
        return true;
      }
    }
    return false;
  }

  function findNestedScroller(path, direction) {
    const seen = new Set();

    for (const pathElement of path) {
      const candidates = fallbackPathFromNode(pathElement);
      for (const candidate of candidates) {
        if (seen.has(candidate) || isRootScroller(candidate)) continue;
        seen.add(candidate);
        if (canScrollInDirection(candidate, direction)) return candidate;
      }
    }

    return null;
  }

  function resolveScroller(event, direction) {
    const eventPath = elementsFromEventPath(event);

    const focusedScroller = findNestedScroller(eventPath, direction);
    if (focusedScroller) return focusedScroller;

    const activeElement = deepActiveElement();
    const activeScroller = activeElement
      ? findNestedScroller(fallbackPathFromNode(activeElement), direction)
      : null;
    if (activeScroller) return activeScroller;

    const recentScroller = findNestedScroller(lastInteractionPath, direction);
    if (recentScroller) return recentScroller;

    const rootScroller = getRootScroller();
    return canScrollInDirection(rootScroller, direction) ? rootScroller : null;
  }

  function scrollByPercentage(scroller, direction, startedAt) {
    const viewportHeight = scrollportHeight(scroller);
    const distance = viewportHeight * (currentPercentage / 100) * direction;

    if (!Number.isFinite(distance) || Math.abs(distance) <= SCROLL_EPSILON) {
      return false;
    }

    const existingAnimation = activeAnimations.get(scroller);
    const startingTarget = existingAnimation?.targetScrollTop ?? scroller.scrollTop;
    const { minimum, maximum } = scrollBounds(scroller);
    const targetScrollTop = clamp(startingTarget + distance, minimum, maximum);

    if (Math.abs(targetScrollTop - scroller.scrollTop) <= SCROLL_EPSILON) {
      return false;
    }

    animateScrollTo(scroller, targetScrollTop, startedAt);
    return true;
  }

  function rememberInteraction(event) {
    cancelAllScrollAnimations();
    lastInteractionPath = elementsFromEventPath(event);
  }

  function hasModifier(event) {
    return event.metaKey || event.ctrlKey || event.altKey || event.shiftKey;
  }

  function handleKeydown(event) {
    const isPageDown = event.key === 'PageDown';
    const isPageUp = event.key === 'PageUp';
    if (!isPageDown && !isPageUp) return;

    // Every auto-repeat event stays untouched so Chromium owns held-key cadence.
    if (event.repeat) return;

    const startedAt = performance.now();

    if (
      event.defaultPrevented
      || event.isComposing
      || !event.cancelable
      || hasModifier(event)
    ) {
      return;
    }

    const eventPath = elementsFromEventPath(event);
    if (isInteractivePath(eventPath)) return;

    const direction = isPageDown ? 1 : -1;
    const scroller = resolveScroller(event, direction);
    if (!scroller) return;

    if (scrollByPercentage(scroller, direction, startedAt)) {
      event.preventDefault();
    }
  }

  window.addEventListener('pointerdown', rememberInteraction, {
    capture: true,
    passive: true,
  });
  window.addEventListener('wheel', rememberInteraction, {
    capture: true,
    passive: true,
  });
  window.addEventListener('keydown', handleKeydown, false);

  if (typeof GM_addValueChangeListener === 'function') {
    GM_addValueChangeListener(STORAGE_KEY, (_name, _oldValue, newValue) => {
      setPercentage(newValue, false);
    });
  }

  registerMenus();
})();
