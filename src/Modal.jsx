import React, { useEffect, useRef } from 'react';

export function Modal({ labelId, className = '', onClose, children }) {
  const backdrop = useRef(null);
  const dialog = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const trigger = document.activeElement;
    const siblings = [...backdrop.current.parentElement.children].filter(
      (el) => el !== backdrop.current,
    );
    const previous = siblings.map((el) => el.inert);
    siblings.forEach((el) => {
      el.inert = true;
    });
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const controls = () =>
      [
        ...dialog.current.querySelectorAll('button, a[href], input, select, textarea, [tabindex]'),
      ].filter((el) => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length);
    const focusFirst = () => (controls()[0] || dialog.current).focus();
    focusFirst();
    const keydown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close.current();
      } else if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault();
        event.stopPropagation();
      } else if (event.key === 'Tab') {
        const items = controls(),
          first = items[0],
          last = items[items.length - 1];
        if (
          !items.length ||
          !dialog.current.contains(document.activeElement) ||
          (event.shiftKey ? document.activeElement === first : document.activeElement === last)
        ) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        }
      }
    };
    const focus = (event) => {
      if (!dialog.current.contains(event.target)) focusFirst();
    };
    document.addEventListener('keydown', keydown);
    document.addEventListener('focusin', focus);
    return () => {
      document.removeEventListener('keydown', keydown);
      document.removeEventListener('focusin', focus);
      siblings.forEach((el, index) => {
        el.inert = previous[index];
      });
      document.body.style.overflow = overflow;
      (trigger?.isConnected ? trigger : document.querySelector('main'))?.focus();
    };
  }, []);
  return (
    <div ref={backdrop} className="modal-backdrop" onClick={() => close.current()}>
      <div
        ref={dialog}
        className={`format-modal ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
