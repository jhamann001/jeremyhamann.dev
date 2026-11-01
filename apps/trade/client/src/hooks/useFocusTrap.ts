import { useEffect, useState, useCallback, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useFocusTrap(ref: RefObject<HTMLElement | null>, active = true) {
  const [el, setEl] = useState<HTMLElement | null>(null);

  const sync = useCallback(() => setEl(ref.current), [ref]);

  useEffect(() => {
    sync();
    const target = ref.current?.parentElement ?? document.body;
    const observer = new MutationObserver(sync);
    observer.observe(target, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [sync, ref]);

  useEffect(() => {
    if (!el || !active) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusableElements = el.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (focusableElements.length > 0) {
      focusableElements[0].focus();
    } else {
      el.focus();
    }

    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const elements = el.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (elements.length === 0) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    el.addEventListener('keydown', handler);
    return () => {
      el.removeEventListener('keydown', handler);
      if (previouslyFocused && previouslyFocused !== document.body) {
        previouslyFocused.focus();
      }
    };
  }, [el, active]);
}
