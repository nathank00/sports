"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";

interface Props {
  /** Inline content shown on hover. */
  children: React.ReactNode;
  /** Optional URL to navigate to on click. If omitted, click does nothing. */
  href?: string;
}

/**
 * A circled "i" icon that shows a tooltip popup on hover.
 * If href is provided, clicking navigates to that URL and a "View full guide" link appears.
 * If href is omitted, the icon is purely informational.
 */
export default function InfoTooltip({ children, href }: Props) {
  const [open, setOpen] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleEnter = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setOpen(true);
  };

  const handleLeave = () => {
    timeoutRef.current = setTimeout(() => setOpen(false), 200);
  };

  // Close on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const iconClasses = "inline-flex items-center justify-center w-4 h-4 rounded-full border border-neutral-600 text-neutral-500 text-[10px] font-semibold leading-none hover:border-neutral-400 hover:text-neutral-300 transition-colors";

  return (
    <div
      ref={containerRef}
      className="relative inline-block"
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      {href ? (
        <Link href={href} className={iconClasses} title="Setup guide">
          i
        </Link>
      ) : (
        <span className={`${iconClasses} cursor-default`}>i</span>
      )}

      {open && (
        <div className="absolute left-6 top-0 z-50 w-80 max-h-72 overflow-y-auto rounded-lg border border-neutral-700 bg-neutral-900 p-4 shadow-xl text-xs text-neutral-400 space-y-2">
          {children}
          {href && (
            <div className="pt-2 border-t border-neutral-800">
              <Link
                href={href}
                className="text-neutral-300 underline underline-offset-2 hover:text-white text-[11px]"
              >
                View full guide &rarr;
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
