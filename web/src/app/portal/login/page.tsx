"use client";

import { SyntheticEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { vendorLogin } from "@/lib/useVendorAuth";

export default function PortalLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus("submitting");
    setErrorMessage(null);
    try {
      await vendorLogin(email, password);
      router.replace("/portal/subscription");
    } catch {
      setStatus("error");
      setErrorMessage("Incorrect email or password.");
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-extrabold tracking-[-0.02em] text-ink">Vendor Portal</h1>
      <p className="mt-2 text-sm text-ink-secondary">
        Log in with the same account you use on the the platform mobile app. New vendors register in the mobile app first.
      </p>

      <form onSubmit={handleSubmit} className="mt-8 space-y-5">
        <div>
          <label htmlFor="email" className="block text-sm font-medium text-ink">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-input border border-transparent bg-surface px-3 py-2.5 text-sm text-ink focus:border-brand focus:bg-white"
          />
        </div>
        <div>
          <label htmlFor="password" className="block text-sm font-medium text-ink">
            Password
          </label>
          <input
            id="password"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-input border border-transparent bg-surface px-3 py-2.5 text-sm text-ink focus:border-brand focus:bg-white"
          />
        </div>

        {status === "error" && (
          <p role="alert" className="text-sm text-red-600">
            {errorMessage}
          </p>
        )}

        <button
          type="submit"
          disabled={status === "submitting"}
          className="w-full rounded-button bg-brand px-6 py-3 text-sm font-semibold text-white shadow-soft-md transition hover:bg-brand-dark disabled:opacity-50"
        >
          {status === "submitting" ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
