async (page) => {
  const fixtureUrl = 'http://127.0.0.1:8765/test/browser-fixture.html';
  const results = [];

  function record(name, pass, details = {}) {
    results.push({ name, pass, ...details });
    if (!pass) throw new Error(`${name}: ${JSON.stringify(details)}`);
  }

  function near(actual, expected, tolerance = 1.5) {
    return Math.abs(actual - expected) <= tolerance;
  }

  function percentile(values, percentileValue) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(sorted.length * percentileValue) - 1)];
  }

  function firstWriteAtOrBeyond(trace, expected, fraction) {
    return trace.writes.find((entry) => entry.y >= expected * fraction)?.t ?? null;
  }

  async function reset() {
    await page.waitForTimeout(150);
    await page.evaluate(() => window.fixture.reset());
    await page.waitForTimeout(50);
    await page.evaluate(() => window.fixture.reset());
  }

  async function pressAndSettle(key, waitMs = 220) {
    await page.keyboard.press(key);
    await page.waitForTimeout(waitMs);
  }

  async function traceRootTap(longTaskMs = 0) {
    await reset();
    const expected = await page.evaluate((taskDuration) => {
      window.fixture.choosePercentage(85);
      window.fixture.focusRoot();

      const root = document.scrollingElement;
      const originalScrollTo = Element.prototype.scrollTo;
      const trace = {
        keyAt: null,
        writes: [],
        originalScrollTo,
      };
      window.__timingTrace = trace;

      Element.prototype.scrollTo = function (...args) {
        const result = Reflect.apply(originalScrollTo, this, args);
        const options = args[0];
        if (this === root && trace.keyAt !== null && typeof options === 'object') {
          trace.writes.push({
            t: performance.now() - trace.keyAt,
            y: this.scrollTop,
            behavior: options.behavior,
          });
        }
        return result;
      };

      window.addEventListener('keydown', (event) => {
        if (event.key === 'PageDown') trace.keyAt = performance.now();
      }, { capture: true, once: true });

      if (taskDuration > 0) {
        window.addEventListener('keydown', (event) => {
          if (event.key !== 'PageDown') return;
          const deadline = performance.now() + taskDuration;
          while (performance.now() < deadline) {
            // Deliberately keep the main thread busy after the userscript handler.
          }
        }, { once: true });
      }

      return document.documentElement.clientHeight * 0.85;
    }, longTaskMs);

    await page.keyboard.press('PageDown');
    await page.waitForTimeout(180);

    const trace = await page.evaluate(() => {
      const root = document.scrollingElement;
      const activeTrace = window.__timingTrace;
      Element.prototype.scrollTo = activeTrace.originalScrollTo;
      delete activeTrace.originalScrollTo;
      return {
        keyAt: activeTrace.keyAt,
        writes: activeTrace.writes,
        final: root.scrollTop,
      };
    });

    return { expected, ...trace };
  }

  await page.goto(fixtureUrl, { waitUntil: 'networkidle' });

  const menuLabels = await page.evaluate(() => window.fixture.menuLabels());
  record(
    'menu presets',
    [70, 75, 80, 85, 90].every((value) => menuLabels.some((label) => label.endsWith(`${value}%`)))
      && menuLabels.some((label) => label.startsWith('✓ ') && label.endsWith('85%')),
    { menuLabels },
  );

  const viewportCases = [
    { width: 1280, height: 720, percentage: 70 },
    { width: 1920, height: 1080, percentage: 75 },
    { width: 2560, height: 1440, percentage: 80 },
    { width: 3200, height: 1800, percentage: 85 },
    { width: 3840, height: 2160, percentage: 90 },
  ];

  for (const testCase of viewportCases) {
    await page.setViewportSize({ width: testCase.width, height: testCase.height });
    await page.reload({ waitUntil: 'networkidle' });
    await reset();
    await page.evaluate((percentage) => {
      window.fixture.choosePercentage(percentage);
      window.fixture.focusRoot();
    }, testCase.percentage);
    await pressAndSettle('PageDown');
    const positions = await page.evaluate(() => window.fixture.positions());
    const expected = positions.rootViewport * (testCase.percentage / 100);
    record(
      `root ${testCase.width}x${testCase.height} at ${testCase.percentage}%`,
      near(positions.root, expected),
      { actual: positions.root, expected, viewport: positions.rootViewport },
    );
  }

  const cdp = await page.context().newCDPSession(page);
  for (const scaleFactor of [0.8, 1, 1.25, 1.5]) {
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: scaleFactor });
    await reset();
    await page.evaluate(() => {
      window.fixture.choosePercentage(85);
      window.fixture.focusRoot();
    });
    await pressAndSettle('PageDown');
    const positions = await page.evaluate(() => window.fixture.positions());
    const expected = positions.rootViewport * 0.85;
    record(
      `page scale ${scaleFactor} at 85%`,
      near(positions.root, expected),
      { actual: positions.root, expected, viewport: positions.rootViewport },
    );
  }
  await cdp.send('Emulation.resetPageScaleFactor');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload({ waitUntil: 'networkidle' });

  const simpleTimingTraces = [];
  for (let index = 0; index < 10; index++) {
    simpleTimingTraces.push(await traceRootTap());
  }
  const simpleHalfTimes = simpleTimingTraces.map((trace) => (
    firstWriteAtOrBeyond(trace, trace.expected, 0.5)
  ));
  const simpleTenTimes = simpleTimingTraces.map((trace) => (
    firstWriteAtOrBeyond(trace, trace.expected, 0.1)
  ));
  const simpleNinetyTimes = simpleTimingTraces.map((trace) => (
    firstWriteAtOrBeyond(trace, trace.expected, 0.9)
  ));
  const simpleTargetTimes = simpleTimingTraces.map((trace) => (
    firstWriteAtOrBeyond(trace, trace.expected - 1, 1)
  ));
  record(
    '10-trial short-animation timing',
    simpleTimingTraces.every((trace) => (
      trace.writes.length > 1
      && trace.writes[0].t <= 5
      && near(trace.writes[0].y, trace.expected * 0.01)
      && trace.writes.every((entry) => entry.behavior === 'instant')
      && near(trace.final, trace.expected)
    ))
      && simpleTenTimes.every(Number.isFinite)
      && simpleHalfTimes.every(Number.isFinite)
      && simpleNinetyTimes.every(Number.isFinite)
      && simpleTargetTimes.every(Number.isFinite)
      && percentile(simpleTenTimes, 0.95) >= 20
      && percentile(simpleTenTimes, 0.95) <= 45
      && percentile(simpleHalfTimes, 0.95) >= 60
      && percentile(simpleHalfTimes, 0.95) <= 90
      && percentile(simpleNinetyTimes, 0.95) >= 100
      && percentile(simpleNinetyTimes, 0.95) <= 135
      && percentile(simpleTargetTimes, 0.95) <= 165,
    {
      p95Ten: percentile(simpleTenTimes, 0.95),
      p95Half: percentile(simpleHalfTimes, 0.95),
      p95Ninety: percentile(simpleNinetyTimes, 0.95),
      p95Target: percentile(simpleTargetTimes, 0.95),
      traces: simpleTimingTraces,
    },
  );

  const longTaskTraces = [];
  for (let index = 0; index < 10; index++) {
    longTaskTraces.push(await traceRootTap(40));
  }
  const longTaskTargetTimes = longTaskTraces.map((trace) => (
    firstWriteAtOrBeyond(trace, trace.expected - 1, 1)
  ));
  record(
    '40ms long task preserves the native-like curve while honoring the deadline',
    longTaskTraces.every((trace) => {
      const catchUpWrite = trace.writes.slice(1).find((entry) => entry.t <= 55);
      return catchUpWrite
        && catchUpWrite.y >= trace.expected * 0.1
        && catchUpWrite.y <= trace.expected * 0.35
        && near(trace.final, trace.expected);
    })
      && longTaskTargetTimes.every(Number.isFinite)
      && percentile(longTaskTargetTimes, 0.95) <= 165,
    {
      p95Target: percentile(longTaskTargetTimes, 0.95),
      traces: longTaskTraces,
    },
  );

  await reset();
  await page.evaluate(() => {
    window.fixture.choosePercentage(85);
    window.fixture.focusNested();
  });
  await pressAndSettle('PageDown');
  let positions = await page.evaluate(() => window.fixture.positions());
  record(
    'focused nested scroller',
    near(positions.nested, positions.nestedViewport * 0.85) && near(positions.root, 0),
    positions,
  );

  await reset();
  await page.evaluate(() => {
    document.scrollingElement.scrollTo({ top: 2000, behavior: 'instant' });
    window.fixture.focusRoot();
  });
  await pressAndSettle('PageUp');
  positions = await page.evaluate(() => window.fixture.positions());
  record(
    'root PageUp uses selected percentage',
    near(positions.root, 2000 - positions.rootViewport * 0.85),
    positions,
  );

  await reset();
  await page.evaluate(() => {
    document.querySelector('#nested').scrollTo({ top: 1500, behavior: 'instant' });
    window.fixture.focusNested();
  });
  await pressAndSettle('PageUp');
  positions = await page.evaluate(() => window.fixture.positions());
  record(
    'nested PageUp uses selected percentage',
    near(positions.nested, 1500 - positions.nestedViewport * 0.85) && near(positions.root, 0),
    positions,
  );

  await reset();
  await page.evaluate(() => {
    const nested = document.querySelector('#nested');
    nested.scrollTo({ top: nested.scrollHeight, behavior: 'instant' });
    window.fixture.focusNested();
  });
  await pressAndSettle('PageDown');
  positions = await page.evaluate(() => window.fixture.positions());
  record(
    'nested boundary falls back to root',
    positions.root > 0 && near(positions.nested, positions.nestedMaximum),
    positions,
  );

  await reset();
  const nestedBox = await page.locator('#nested').boundingBox();
  if (!nestedBox) throw new Error('nested scroller has no bounding box');
  await page.mouse.move(nestedBox.x + 20, nestedBox.y + 120);
  await page.mouse.down();
  await page.mouse.up();
  await page.evaluate(() => window.fixture.focusRootAfterNestedPointer());
  await pressAndSettle('PageDown');
  positions = await page.evaluate(() => window.fixture.positions());
  record(
    'recent pointerdown selects nested scroller',
    positions.nested > 0 && near(positions.root, 0),
    positions,
  );

  for (const key of ['PageDown', 'PageUp']) {
    await reset();
    await page.evaluate(() => {
      const reverse = document.querySelector('#reverse');
      reverse.scrollTo({ top: -1200, behavior: 'instant' });
      window.fixture.focusReverse();
    });
    await pressAndSettle(key);
    positions = await page.evaluate(() => window.fixture.positions());
    const direction = key === 'PageDown' ? 1 : -1;
    record(
      `column-reverse ${key}`,
      near(positions.reverse, -1200 + direction * positions.reverseViewport * 0.85),
      positions,
    );
  }

  for (const scenario of [
    { name: 'editable target is not intercepted', focus: 'focusEditor' },
    { name: 'website widget role is not intercepted', focus: 'focusWidget' },
  ]) {
    await reset();
    await page.evaluate((focusMethod) => {
      window.fixture[focusMethod]();
      window.fixture.clearKeyEvents();
    }, scenario.focus);
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(50);
    const keyEvent = await page.evaluate(() => window.fixture.lastKeyEvent());
    record(scenario.name, keyEvent?.defaultPrevented === false, { keyEvent });
  }

  await reset();
  await page.evaluate(() => {
    window.fixture.setSitePrevention(true);
    window.fixture.focusRoot();
  });
  await pressAndSettle('PageDown');
  positions = await page.evaluate(() => window.fixture.positions());
  record('site-prevented key remains untouched', near(positions.root, 0), positions);

  await reset();
  await page.evaluate(() => {
    window.fixture.focusRoot();
    window.fixture.clearKeyEvents();
  });
  await page.keyboard.press('Shift+PageDown');
  await page.waitForTimeout(50);
  let keyEvent = await page.evaluate(() => window.fixture.lastKeyEvent());
  record('modifier combination is not intercepted', keyEvent?.defaultPrevented === false, { keyEvent });

  await page.reload({ waitUntil: 'networkidle' });
  await reset();
  await page.evaluate(() => {
    window.fixture.choosePercentage(85);
    window.fixture.focusRoot();
  });
  await page.keyboard.press('PageDown');
  await page.waitForTimeout(20);
  await page.keyboard.press('PageDown');
  await page.waitForTimeout(180);
  positions = await page.evaluate(() => window.fixture.positions());
  record(
    'rapid taps accumulate targets',
    near(positions.root, positions.rootViewport * 0.85 * 2),
    positions,
  );

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await reset();
  await page.evaluate(() => {
    window.fixture.choosePercentage(85);
    window.fixture.focusRoot();
  });
  await page.keyboard.press('PageDown');
  await page.waitForTimeout(20);
  positions = await page.evaluate(() => window.fixture.positions());
  record(
    'reduced motion completes immediately',
    near(positions.root, positions.rootViewport * 0.85),
    positions,
  );
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  await page.reload({ waitUntil: 'networkidle' });
  await reset();
  await page.evaluate(() => {
    window.fixture.focusRoot();
    window.fixture.clearKeyEvents();
  });
  await page.keyboard.down('PageDown');
  await page.waitForTimeout(180);
  const firstKeydown = await page.evaluate(() => ({
    keyEvent: window.fixture.lastKeyEvent(),
    positions: window.fixture.positions(),
  }));
  await page.keyboard.down('PageDown');
  await page.waitForTimeout(300);
  keyEvent = await page.evaluate(() => window.fixture.lastKeyEvent());
  const afterRepeat = await page.evaluate(() => window.fixture.positions().root);
  await page.keyboard.up('PageDown');
  record(
    'repeat is native after first custom step',
    firstKeydown.keyEvent?.repeat === false
      && firstKeydown.keyEvent?.defaultPrevented === true
      && near(firstKeydown.positions.root, firstKeydown.positions.rootViewport * 0.85)
      && keyEvent?.repeat === true
      && keyEvent?.defaultPrevented === false
      && afterRepeat > firstKeydown.positions.root,
    { firstKeydown, repeatKeyEvent: keyEvent, afterRepeat },
  );

  const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
  if (!frame) throw new Error('iframe fixture did not load');
  await frame.locator('#inner-nested').focus();
  await page.keyboard.press('PageDown');
  await page.waitForTimeout(180);
  const iframePositions = await frame.evaluate(() => {
    const element = document.querySelector('#inner-nested');
    return { top: element.scrollTop, viewport: element.clientHeight };
  });
  record(
    'same-origin iframe nested scroller',
    near(iframePositions.top, iframePositions.viewport * 0.85),
    iframePositions,
  );

  return { passed: results.length, results };
}
