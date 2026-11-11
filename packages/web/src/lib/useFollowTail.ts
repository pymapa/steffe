import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/** Distance from the bottom (px) that still counts as "at the bottom". */
const SLACK = 32;

/**
 * Terminal-style scrolling for a chat log: while the view is at the bottom it
 * stays pinned there as content streams in, grows or reflows (markdown, images,
 * a resized window). Scrolling up stops following; scrolling back to the
 * bottom, or calling jump(), resumes it. A new resetKey (e.g. another session)
 * starts at the bottom again.
 */
export function useFollowTail<T extends HTMLElement>(resetKey?: unknown) {
  const ref = useRef<T>(null);
  const pinned = useRef(true);
  const [following, setFollowing] = useState(true);

  const toBottom = useCallback(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const stick = () => {
      if (pinned.current) toBottom();
    };
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= SLACK;
      pinned.current = atBottom;
      setFollowing(atBottom);
    };
    // Size changes of the viewport (window, composer) and of the content (images, layout).
    const resize = new ResizeObserver(stick);
    const observeChildren = () => {
      for (const c of Array.from(el.children)) resize.observe(c);
    };
    resize.observe(el);
    observeChildren();
    // New entries and streamed text. Runs before paint, so there is no visible jump.
    const mutations = new MutationObserver(() => {
      observeChildren();
      stick();
    });
    mutations.observe(el, { childList: true, subtree: true, characterData: true });
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      resize.disconnect();
      mutations.disconnect();
    };
  }, [toBottom]);

  useLayoutEffect(() => {
    pinned.current = true;
    setFollowing(true);
    toBottom();
  }, [resetKey, toBottom]);

  const jump = useCallback(() => {
    pinned.current = true;
    setFollowing(true);
    toBottom();
  }, [toBottom]);

  return { ref, following, jump };
}
