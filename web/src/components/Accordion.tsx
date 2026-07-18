"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";

export default function AccordionItem({ question, children }: { question: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-b border-hairline">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 py-4 text-left"
      >
        <span className="font-semibold text-ink">{question}</span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-ink-tertiary transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && <div className="pb-4 text-sm text-ink-secondary">{children}</div>}
    </div>
  );
}
