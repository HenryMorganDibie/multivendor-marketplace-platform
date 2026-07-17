import type { Metadata } from "next";
import ContactForm from "./ContactForm";

export const metadata: Metadata = {
  title: "Contact Us",
  description: "Get in touch with the the platform team.",
  alternates: { canonical: "/contact" },
};

export default function ContactPage() {
  return (
    <section className="mx-auto max-w-xl px-4 py-16 sm:px-6">
      <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Contact Us</h1>
      <p className="mt-3 text-gray-600 dark:text-gray-400">
        Have a question or ran into a problem? Send us a message and our team will get back to you.
      </p>
      <div className="mt-8">
        <ContactForm />
      </div>
    </section>
  );
}
