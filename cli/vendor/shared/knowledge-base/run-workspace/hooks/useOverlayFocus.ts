import { useCallback, useLayoutEffect, useRef } from "react";
import type { MutableRefObject, RefObject } from "react";

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=\"hidden\"])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable=\"true\"]",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(",");

const overlayFocusLayers: symbol[] = [];

function useOverlayFocusLayer(active: boolean): () => boolean {
  const layerIdRef = useRef<symbol | null>(null);
  if (layerIdRef.current === null) {
    layerIdRef.current = Symbol("rwi-overlay-focus-layer");
  }
  const layerId = layerIdRef.current;

  useLayoutEffect(() => {
    if (!active) return undefined;
    overlayFocusLayers.push(layerId);
    return () => {
      const index = overlayFocusLayers.lastIndexOf(layerId);
      if (index >= 0) overlayFocusLayers.splice(index, 1);
    };
  }, [active, layerId]);

  return useCallback(() => overlayFocusLayers.at(-1) === layerId, [layerId]);
}

function isAvailableFocusTarget(element: HTMLElement | null): element is HTMLElement {
  if (!element || !element.isConnected) return false;
  if (element.closest("[hidden], [inert], [aria-hidden=\"true\"]")) return false;
  if (element.matches(":disabled")) return false;
  return true;
}

function focusWithoutScrolling(element: HTMLElement | null): void {
  if (!isAvailableFocusTarget(element)) return;
  element.focus({ preventScroll: true });
}

function readFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector))
    .filter(isAvailableFocusTarget);
}

function findOverlayTabExitTarget({
  anchor,
  container,
  backwards,
}: {
  anchor: HTMLElement | null;
  container: HTMLElement;
  backwards: boolean;
}): HTMLElement | null {
  const candidates = readFocusableElements(document.body)
    .filter((element) => element.tabIndex >= 0 && !container.contains(element));
  if (candidates.length === 0) return anchor;
  if (!anchor || !anchor.isConnected) {
    return backwards ? candidates.at(-1) ?? null : candidates[0] ?? null;
  }

  const anchorIndex = candidates.indexOf(anchor);
  if (anchorIndex >= 0) {
    return backwards
      ? candidates[anchorIndex - 1] ?? anchor
      : candidates[anchorIndex + 1] ?? anchor;
  }

  const relativeCandidates = candidates.filter((candidate) => {
    const position = anchor.compareDocumentPosition(candidate);
    return backwards
      ? (position & Node.DOCUMENT_POSITION_PRECEDING) !== 0
      : (position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  });
  return backwards
    ? relativeCandidates.at(-1) ?? anchor
    : relativeCandidates[0] ?? anchor;
}

function useInitialAndReturnFocus({
  active,
  containerRef,
  initialFocusRef,
  initialSelector,
  returnFocusRef,
  restoreFocusOnCleanupRef,
}: {
  active: boolean;
  containerRef: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  initialSelector: string;
  returnFocusRef?: RefObject<HTMLElement | null>;
  restoreFocusOnCleanupRef?: MutableRefObject<boolean>;
}): void {
  const returnTargetRef = useRef<HTMLElement | null | undefined>(undefined);
  const wasActiveRef = useRef(false);

  useLayoutEffect(() => {
    if (!active) {
      if (!wasActiveRef.current) return undefined;
      wasActiveRef.current = false;
      if (restoreFocusOnCleanupRef?.current !== false) {
        focusWithoutScrolling(returnFocusRef?.current ?? returnTargetRef.current ?? null);
      }
      return undefined;
    }
    const container = containerRef.current;
    if (!container) return undefined;

    wasActiveRef.current = true;
    if (restoreFocusOnCleanupRef) {
      restoreFocusOnCleanupRef.current = true;
    }
    const explicitTarget = returnFocusRef?.current ?? null;
    returnTargetRef.current = explicitTarget ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const initialTarget = initialFocusRef?.current
      ?? container.querySelector<HTMLElement>(initialSelector)
      ?? container;
    focusWithoutScrolling(initialTarget);

    return () => {
      if (restoreFocusOnCleanupRef?.current === false) return;
      focusWithoutScrolling(returnFocusRef?.current ?? returnTargetRef.current ?? null);
    };
  }, [active, containerRef, initialFocusRef, initialSelector, restoreFocusOnCleanupRef, returnFocusRef]);
}

export function useModalFocus({
  active = true,
  containerRef,
  initialFocusRef,
  onClose,
  returnFocusRef,
  trapFocus = true,
}: {
  active?: boolean;
  containerRef: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  trapFocus?: boolean;
}): void {
  const isTopOverlay = useOverlayFocusLayer(active);
  const restoreFocusOnCleanupRef = useRef(true);
  useInitialAndReturnFocus({
    active,
    containerRef,
    initialFocusRef,
    initialSelector: focusableSelector,
    returnFocusRef,
    restoreFocusOnCleanupRef,
  });

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (!isTopOverlay()) return;
    const container = containerRef.current;
    if (!container) return;

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }

    if (event.key !== "Tab") return;

    const focusableElements = readFocusableElements(container);
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusIsInside = activeElement !== null && container.contains(activeElement);
    if (focusableElements.length === 0) {
      event.preventDefault();
      event.stopPropagation();
      if (!trapFocus) {
        const returnTarget = returnFocusRef?.current ?? null;
        const exitTarget = findOverlayTabExitTarget({
          anchor: returnTarget,
          container,
          backwards: event.shiftKey,
        });
        restoreFocusOnCleanupRef.current = false;
        onClose();
        focusWithoutScrolling(exitTarget ?? returnTarget);
        return;
      }
      focusWithoutScrolling(container);
      return;
    }

    const firstElement = focusableElements[0] ?? null;
    const lastElement = focusableElements.at(-1) ?? null;

    if (!trapFocus) {
      const leavingBackwards = event.shiftKey && (
        !focusIsInside || activeElement === firstElement
      );
      const leavingForwards = !event.shiftKey && (
        !focusIsInside || activeElement === lastElement
      );
      if (!leavingBackwards && !leavingForwards) return;

      const returnTarget = returnFocusRef?.current ?? null;
      const exitTarget = findOverlayTabExitTarget({
        anchor: returnTarget,
        container,
        backwards: event.shiftKey,
      });
      event.preventDefault();
      event.stopPropagation();
      restoreFocusOnCleanupRef.current = false;
      onClose();
      focusWithoutScrolling(exitTarget ?? returnTarget);
      return;
    }

    if (event.shiftKey && (!focusIsInside || activeElement === firstElement)) {
      event.preventDefault();
      focusWithoutScrolling(lastElement);
    } else if (!event.shiftKey && (!focusIsInside || activeElement === lastElement)) {
      event.preventDefault();
      focusWithoutScrolling(firstElement);
    }
  }, [containerRef, isTopOverlay, onClose, returnFocusRef, trapFocus]);

  useLayoutEffect(() => {
    if (!active) return undefined;
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [active, handleKeyDown]);
}
