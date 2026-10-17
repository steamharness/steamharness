import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { initI18n } from "@workflow-code/i18n/react";

initI18n({ preference: "zh-CN" });
afterEach(() => cleanup());

if (typeof window !== "undefined") {
  if (typeof window.matchMedia !== "function") {
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

  if (!("ResizeObserver" in window)) {
    Object.defineProperty(window, "ResizeObserver", {
      writable: true,
      value: class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    });
  }

  if (!("scrollIntoView" in window.HTMLElement.prototype)) {
    Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", { writable: true, value() {} });
  }

  if (!("hasPointerCapture" in window.HTMLElement.prototype)) {
    Object.defineProperties(window.HTMLElement.prototype, {
      hasPointerCapture: { writable: true, value() { return false; } },
      setPointerCapture: { writable: true, value() {} },
      releasePointerCapture: { writable: true, value() {} },
    });
  }
}
