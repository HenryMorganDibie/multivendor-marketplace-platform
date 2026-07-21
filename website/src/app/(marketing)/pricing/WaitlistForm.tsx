"use client";

import { SyntheticEvent, useState } from "react";
import { callable } from "@/lib/firebase";

interface JoinWaitlistResponse {
  success: true;
}

export default function WaitlistForm({ countryCode, countryLabel }: { countryCode: string; countryLabel: string }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "joined" | "error">("idle");

  async function handleSubmit(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus("submitting");
    try {
      const join = callable<{ email: string; countryCode: string }, JoinWaitlistResponse>("joinWaitlist");
      await join({ email, countryCode });
      setStatus("joined");
    } catch {
      setStatus("error");
    }
  }

  if (status === "joined") {
    return (
      <p role="status" className="mt-4 text-sm font-medium text-brand">
        You&apos;re on the list — we&apos;ll email you when the platform launches paid plans in {countryLabel}.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-2 sm:flex-row">
      <input
        type="email"
        required
        placeholder="you@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="w-full rounded-input border border-transparent bg-white px-3 py-2 text-sm text-ink focus:border-brand sm:max-w-xs"
      />
      <button
        type="submit"
        disabled={status === "submitting"}
        className="rounded-button bg-brand px-5 py-2 text-sm font-semibold text-white shadow-soft transition hover:bg-brand-dark disabled:opacity-50"
      >
        {status === "submitting" ? "Joining…" : "Join Waitlist"}
      </button>
      {status === "error" && <p className="text-sm text-red-600">Couldn&apos;t join the waitlist. Try again.</p>}
    </form>
  );
}
