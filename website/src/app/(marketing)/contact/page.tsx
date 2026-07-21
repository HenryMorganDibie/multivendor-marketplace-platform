import type { Metadata } from "next";
import Link from "next/link";
import ContactForm from "./ContactForm";

export const metadata: Metadata = {
  title: "Contact Us",
  description: "Get in touch with the the platform team.",
  alternates: { canonical: "/contact" },
};

const SUPPORT_LINKS = [
  { href: "/privacy-policy", label: "Privacy Policy" },
  { href: "/terms-of-service", label: "Terms of Service" },
  { href: "/vendor-terms", label: "Vendor Terms" },
  { href: "/cookie-policy", label: "Cookie Policy" },
];

export default function ContactPage() {
  return (
    <section className="mx-auto max-w-xl px-4 py-16 sm:px-6">
      <h1 className="text-3xl font-extrabold tracking-[-0.02em] text-ink sm:text-4xl">Contact Us</h1>
      <p className="mt-3 text-ink-secondary">
        Have a question or ran into a problem? Send us a message and our team will get back to you.
      </p>
      <p className="mt-1 text-sm text-ink-tertiary">Typical response time: 24–48 hours.</p>
      <div className="mt-8">
        <ContactForm />
      </div>
      <div className="mt-10 border-t border-hairline pt-6">
        <p className="text-sm font-semibold text-ink">More resources</p>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {SUPPORT_LINKS.map((link) => (
            <Link key={link.href} href={link.href} className="text-sm text-ink-secondary hover:text-brand">
              {link.label}
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
