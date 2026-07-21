"use client";

import { SyntheticEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { adminLogin } from "@/lib/useAdminAuth";

export default function CmsLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "error">("idle");

  async function handleSubmit(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus("submitting");
    try {
      await adminLogin(email, password);
      router.replace("/cms");
    } catch {
      setStatus("error");
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-extrabold tracking-[-0.02em] text-ink">the platform CMS</h1>
      <p className="mt-2 text-sm text-ink-secondary">Super-Admin sign in.</p>
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
        {status === "error" && <p role="alert" className="text-sm text-red-600">Incorrect email or password.</p>}
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
