"use client";

import { SyntheticEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { adminLogin } from "@/lib/useAdminAuth";
import { mapLoginError } from "@/lib/authErrors";

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

const inputClass =
  "mt-1 w-full rounded-input border border-transparent bg-surface px-3 py-2.5 text-sm text-ink focus:border-brand focus:bg-white";
const inputErrorClass =
  "mt-1 w-full rounded-input border border-red-500 bg-surface px-3 py-2.5 text-sm text-ink focus:border-red-500 focus:bg-white";

export default function CmsLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting">("idle");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  /**
   * Show the failure on the field it is about, and put the cursor there.
   *
   * This page previously rendered one fixed line for every rejection, so a
   * disabled admin account and a lockout both read as a mistyped password.
   */
  function showFailure(error: unknown) {
    const mapped = mapLoginError(error);
    if (mapped.field === "email") {
      setEmailError(mapped.message);
      emailRef.current?.focus();
      return;
    }
    if (mapped.field === "password") {
      setPasswordError(mapped.message);
      passwordRef.current?.focus();
      return;
    }
    setFormError(mapped.message);
  }

  async function handleSubmit(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setEmailError(null);
    setPasswordError(null);
    setFormError(null);

    const trimmedEmail = email.trim();
    if (!isEmail(trimmedEmail)) {
      setEmailError("Enter a valid email address.");
      emailRef.current?.focus();
      return;
    }
    if (!password) {
      setPasswordError("Enter your password.");
      passwordRef.current?.focus();
      return;
    }

    setStatus("submitting");
    try {
      await adminLogin(trimmedEmail, password);
      router.replace("/cms");
    } catch (error) {
      setStatus("idle");
      showFailure(error);
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-extrabold tracking-[-0.02em] text-ink">Platform CMS</h1>
      <p className="mt-2 text-sm text-ink-secondary">Super-Admin sign in.</p>
      {/* noValidate: the browser's own bubble would pre-empt the messages below
          with wording we do not control. */}
      <form onSubmit={handleSubmit} className="mt-8 space-y-5" noValidate>
        <div>
          <label htmlFor="email" className="block text-sm font-medium text-ink">
            Email
          </label>
          <input
            id="email"
            ref={emailRef}
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setEmailError(null);
              setFormError(null);
            }}
            /* Checked on blur, not only on submit. */
            onBlur={() => {
              const trimmed = email.trim();
              if (trimmed && !isEmail(trimmed)) setEmailError("Enter a valid email address.");
            }}
            aria-invalid={emailError ? true : undefined}
            aria-describedby={emailError ? "email-error" : undefined}
            className={emailError ? inputErrorClass : inputClass}
          />
          {emailError && (
            <p id="email-error" className="mt-1.5 text-sm text-red-600">
              {emailError}
            </p>
          )}
        </div>
        <div>
          <label htmlFor="password" className="block text-sm font-medium text-ink">
            Password
          </label>
          <input
            id="password"
            ref={passwordRef}
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setPasswordError(null);
              setFormError(null);
            }}
            aria-invalid={passwordError ? true : undefined}
            aria-describedby={passwordError ? "password-error" : undefined}
            className={passwordError ? inputErrorClass : inputClass}
          />
          {passwordError && (
            <p id="password-error" className="mt-1.5 text-sm text-red-600">
              {passwordError}
            </p>
          )}
        </div>

        {/* Only what no single field can own: a lockout, a disabled account, a
            network failure. */}
        {formError && (
          <p role="alert" className="rounded-input bg-red-50 px-3 py-2.5 text-sm text-red-600">
            {formError}
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
