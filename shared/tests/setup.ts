import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { initI18n } from "@steamharness/i18n/react";

initI18n({ preference: "zh-CN" });

afterEach(() => cleanup());

if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value(query: string) {
      return {
        matches: false,
        media: query,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() { return false; },
      };
    },
  });
}

if (typeof window !== "undefined" && !("ResizeObserver" in window)) {
  Object.defineProperty(window, "ResizeObserver", {
    writable: true,
    value: class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
}

if (typeof window !== "undefined" && !window.HTMLElement.prototype.scrollIntoView) {
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
    writable: true,
    value() {},
  });
}

if (typeof window !== "undefined" && !("hasPointerCapture" in window.HTMLElement.prototype)) {
  Object.defineProperties(window.HTMLElement.prototype, {
    hasPointerCapture: { writable: true, value: () => false },
    setPointerCapture: { writable: true, value() {} },
    releasePointerCapture: { writable: true, value() {} },
  });
}
