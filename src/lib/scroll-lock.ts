"use client";

import { useEffect } from "react";

/**
 * Ref-counted so two overlapping sheets can't restore the page twice — the
 * first lock records where the page was, the last release puts it back.
 */
let locks = 0;
let restore: (() => void) | null = null;

function lockBody() {
  locks += 1;
  if (locks > 1) return;
  const { body } = document;
  const offset = window.scrollY;
  const previous = {
    position: body.style.position,
    top: body.style.top,
    left: body.style.left,
    right: body.style.right,
    width: body.style.width,
    overflow: body.style.overflow,
  };
  // `overflow: hidden` alone does not hold on iOS Safari, so the page is
  // pinned in place and given back its scroll offset on release. Without this
  // the page behind a full-screen sheet scrolls under it, and the sheet's own
  // scroll chains into the page the moment it reaches an end.
  body.style.position = "fixed";
  body.style.top = `-${offset}px`;
  body.style.left = "0";
  body.style.right = "0";
  body.style.width = "100%";
  body.style.overflow = "hidden";
  restore = () => {
    body.style.position = previous.position;
    body.style.top = previous.top;
    body.style.left = previous.left;
    body.style.right = previous.right;
    body.style.width = previous.width;
    body.style.overflow = previous.overflow;
    if (offset) window.scrollTo(0, offset);
  };
}

function unlockBody() {
  locks = Math.max(0, locks - 1);
  if (locks > 0) return;
  restore?.();
  restore = null;
}

/**
 * Freeze the page behind a full-screen sheet while `active` is true, and
 * return it to exactly where it was when the sheet closes.
 */
export function useScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    lockBody();
    return unlockBody;
  }, [active]);
}
