import type { Page } from "playwright";

export async function installHorizontalScrollLock(page: Page): Promise<void> {
  await page.evaluate(horizontalScrollLockScript()).catch(() => {});
  await resetHorizontalScroll(page);
}

export async function resetHorizontalScroll(page: Page): Promise<void> {
  await page.evaluate(resetHorizontalScrollScript()).catch(() => {});
}

export function horizontalScrollLockScript(): string {
  return `(() => {
    const w = window;
    if (w.__adcHorizontalScrollLockInstalled) {
      if (typeof w.__adcResetHorizontalScroll === "function") {
        w.__adcResetHorizontalScroll();
      }
      return;
    }
    w.__adcHorizontalScrollLockInstalled = true;

    const tracked = new Set();
    const track = (node) => {
      if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node;
      tracked.add(el);
      if (typeof el.querySelectorAll === "function") {
        for (const child of el.querySelectorAll("*")) tracked.add(child);
      }
    };
    const trackDocument = () => {
      track(document.documentElement);
      if (document.body) track(document.body);
    };

    const originalWindowScrollTo = w.scrollTo.bind(w);
    const originalWindowScrollBy = w.scrollBy.bind(w);
    const originalElementScrollTo = Element.prototype.scrollTo;
    const originalElementScrollBy = Element.prototype.scrollBy;
    const originalScrollIntoView = Element.prototype.scrollIntoView;

    const resetHorizontalScroll = () => {
      trackDocument();
      const y = w.scrollY || document.documentElement.scrollTop || document.body?.scrollTop || 0;
      try {
        if (w.scrollX !== 0) originalWindowScrollTo(0, y);
      } catch {}

      const scrolling = document.scrollingElement;
      if (scrolling) tracked.add(scrolling);

      for (const el of Array.from(tracked)) {
        try {
          if (el.scrollLeft !== 0) el.scrollLeft = 0;
        } catch {}
      }
    };

    w.__adcResetHorizontalScroll = resetHorizontalScroll;

    w.scrollTo = (...args) => {
      if (args.length === 1 && typeof args[0] === "object") {
        const opts = args[0] || {};
        originalWindowScrollTo({ ...opts, left: 0 });
      } else {
        originalWindowScrollTo(0, Number(args[1] ?? w.scrollY ?? 0));
      }
      resetHorizontalScroll();
    };

    w.scrollBy = (...args) => {
      if (args.length === 1 && typeof args[0] === "object") {
        const opts = args[0] || {};
        originalWindowScrollBy({ ...opts, left: 0 });
      } else {
        originalWindowScrollBy(0, Number(args[1] ?? 0));
      }
      resetHorizontalScroll();
    };

    Element.prototype.scrollTo = function (...args) {
      tracked.add(this);
      if (args.length === 1 && typeof args[0] === "object") {
        const opts = args[0] || {};
        originalElementScrollTo.call(this, { ...opts, left: 0 });
      } else {
        originalElementScrollTo.call(this, 0, Number(args[1] ?? this.scrollTop ?? 0));
      }
      resetHorizontalScroll();
    };

    Element.prototype.scrollBy = function (...args) {
      tracked.add(this);
      if (args.length === 1 && typeof args[0] === "object") {
        const opts = args[0] || {};
        originalElementScrollBy.call(this, { ...opts, left: 0 });
      } else {
        originalElementScrollBy.call(this, 0, Number(args[1] ?? 0));
      }
      resetHorizontalScroll();
    };

    Element.prototype.scrollIntoView = function (...args) {
      tracked.add(this);
      originalScrollIntoView.apply(this, args);
      resetHorizontalScroll();
      setTimeout(resetHorizontalScroll, 0);
      requestAnimationFrame(resetHorizontalScroll);
    };

    try {
      new MutationObserver((mutations) => {
        trackDocument();
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) track(node);
        }
        resetHorizontalScroll();
      }).observe(document.documentElement || document, { childList: true, subtree: true });
    } catch {}

    const tick = () => {
      resetHorizontalScroll();
      w.__adcHorizontalScrollLockFrame = requestAnimationFrame(tick);
    };
    trackDocument();
    resetHorizontalScroll();
    tick();
  })()`;
}

function resetHorizontalScrollScript(): string {
  return `(() => {
    const w = window;
    if (typeof w.__adcResetHorizontalScroll === "function") {
      w.__adcResetHorizontalScroll();
      return;
    }

    const y = w.scrollY || document.documentElement.scrollTop || document.body?.scrollTop || 0;
    w.scrollTo(0, y);
    document.documentElement.scrollLeft = 0;
    if (document.body) document.body.scrollLeft = 0;
    const scrolling = document.scrollingElement;
    if (scrolling) scrolling.scrollLeft = 0;
    for (const el of document.querySelectorAll("*")) {
      try {
        if (el.scrollLeft !== 0) el.scrollLeft = 0;
      } catch {}
    }
  })()`;
}
