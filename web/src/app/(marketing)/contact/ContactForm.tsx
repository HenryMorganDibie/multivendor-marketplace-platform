"use client";

import { useState } from "react";
import { callable } from "@/lib/firebase";

const SUBJECT_CATEGORIES = ["Vendor Support", "Customer Support", "General Enquiries", "Partnerships", "Media"];

interface SubmitContactFormResponse {
  success: true;
}

export default function ContactForm() {
  const [status, setStatus] = useState<"idle" | "submitting" | "sent" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus("submitting");
    setErrorMessage(null);

    const form = e.currentTarget;
    const formData = new FormData(form);

    try {
      const submit = callable<Record<string, unknown>, SubmitContactFormResponse>("submitContactForm");
      await submit({
        name: formData.get("name"),
        email: formData.get("email"),
        subjectCategory: formData.get("subjectCategory"),
        message: formData.get("message"),
        honeypot: formData.get("company_website"),
      });
      setStatus("sent");
      form.reset();
    } catch (err) {
      setStatus("error");
      setErrorMessage(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    }
  }

  if (status === "sent") {
    return (
      <div role="status" className="rounded-card border border-green-200 bg-green-50 p-6 text-green-800">
        <p className="font-semibold">Message sent</p>
        <p className="mt-1 text-sm">Thanks for reaching out — our team will get back to you.</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-5">
      {/* Honeypot — hidden from real users via CSS, not display:none, so screen readers/bots that check computed style still see an empty field to fill */}
      <div className="absolute -left-[9999px]" aria-hidden="true">
        <label htmlFor="company_website">Company website</label>
        <input type="text" id="company_website" name="company_website" tabIndex={-1} autoComplete="off" />
      </div>

      <div>
        <label htmlFor="name" className="block text-sm font-medium">
          Name
        </label>
        <input
          id="name"
          name="name"
          type="text"
          required
          maxLength={100}
          className="mt-1 w-full rounded-input border border-transparent bg-surface px-3 py-2.5 text-sm text-ink focus:border-brand focus:bg-white"
        />
      </div>

      <div>
        <label htmlFor="email" className="block text-sm font-medium">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          maxLength={254}
          className="mt-1 w-full rounded-input border border-transparent bg-surface px-3 py-2.5 text-sm text-ink focus:border-brand focus:bg-white"
        />
      </div>

      <div>
        <label htmlFor="subjectCategory" className="block text-sm font-medium">
          Subject
        </label>
        <select
          id="subjectCategory"
          name="subjectCategory"
          required
          className="mt-1 w-full rounded-input border border-transparent bg-surface px-3 py-2.5 text-sm text-ink focus:border-brand focus:bg-white"
        >
          {SUBJECT_CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {category}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="message" className="block text-sm font-medium">
          Message
        </label>
        <textarea
          id="message"
          name="message"
          required
          maxLength={4000}
          rows={6}
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
        className="rounded-button bg-brand px-6 py-3 text-sm font-semibold text-white shadow-soft-md transition hover:bg-brand-dark disabled:opacity-50"
      >
        {status === "submitting" ? "Sending…" : "Send message"}
      </button>
    </form>
  );
}
