/**
 * Accessible modal dialog: role="dialog", aria-modal, labelled and described,
 * focus moved inside on open, Tab / Shift+Tab trapped, Escape closes, focus
 * returned to the opener on close, background made inert while open.
 */
import { useEffect, useId, useRef } from "react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableWithin(node: HTMLElement): HTMLElement[] {
  return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute("inert") && el.getAttribute("aria-hidden") !== "true");
}

export interface DialogProps {
  open: boolean;
  title: string;
  /** Short description announced with the dialog. */
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Element to focus first; defaults to the first focusable element. */
  initialFocusRef?: RefObject<HTMLElement | null>;
}

export function Dialog({ open, title, description, onClose, children, initialFocusRef }: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  if (open && hostRef.current === null && typeof document !== "undefined") {
    hostRef.current = document.createElement("div");
    hostRef.current.setAttribute("data-dialog-host", "");
  }

  useEffect(() => {
    if (!open) return;
    const host = hostRef.current;
    if (!host) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.appendChild(host);

    // Make everything outside the dialog inert (not focusable, hidden from assistive technology).
    const inerted: Element[] = [];
    for (const child of Array.from(document.body.children)) {
      if (child === host || child.hasAttribute("inert")) continue;
      child.setAttribute("inert", "");
      inerted.push(child);
    }

    const node = dialogRef.current;
    if (node) {
      const target = initialFocusRef?.current ?? focusableWithin(node)[0] ?? node;
      target.focus();
    }

    return () => {
      for (const el of inerted) el.removeAttribute("inert");
      host.remove();
      if (opener && opener.isConnected) opener.focus();
    };
    // Focus management runs once per open; initialFocusRef is read at open time.
  }, [open]);

  if (!open || !hostRef.current) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
      return;
    }
    if (event.key !== "Tab") return;
    const node = dialogRef.current;
    if (!node) return;
    const items = focusableWithin(node);
    if (items.length === 0) {
      event.preventDefault();
      node.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === node)) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  return createPortal(
    <div className="dialog-backdrop">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className="dialog"
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className="dialog-title">
          {title}
        </h2>
        {description ? (
          <div id={descriptionId} className="dialog-description">
            {description}
          </div>
        ) : null}
        {children}
      </div>
    </div>,
    hostRef.current,
  );
}
