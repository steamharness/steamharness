import type React from "react";

function canScrollVertically(element: HTMLElement): boolean {
  return element.scrollHeight > element.clientHeight;
}

function hasScrollableVerticalOverflow(element: HTMLElement): boolean {
  const overflowY = window.getComputedStyle(element).overflowY;
  return overflowY !== "hidden" && overflowY !== "clip";
}

function findParentScrollableElement(element: HTMLElement): HTMLElement | null {
  let parent = element.parentElement;

  while (parent) {
    if (canScrollVertically(parent) && hasScrollableVerticalOverflow(parent)) {
      return parent;
    }
    parent = parent.parentElement;
  }

  return null;
}

export function chainWheelAtVerticalBoundary(event: React.WheelEvent<HTMLElement>): void {
  if (event.defaultPrevented || event.deltaY === 0) return;

  const element = event.currentTarget;
  if (!canScrollVertically(element)) return;

  const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
  const remainingScroll = event.deltaY > 0
    ? maxScrollTop - element.scrollTop
    : element.scrollTop;
  const remainingDelta = event.deltaY > 0
    ? Math.max(0, event.deltaY - remainingScroll)
    : Math.min(0, event.deltaY + remainingScroll);

  if (remainingDelta === 0) return;

  const parent = findParentScrollableElement(element);
  if (!parent) return;

  event.preventDefault();
  element.scrollTop = event.deltaY > 0 ? maxScrollTop : 0;
  parent.scrollTop += remainingDelta;
}
