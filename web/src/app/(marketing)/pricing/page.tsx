import type { Metadata } from "next";
import PricingClient from "./PricingClient";

export const metadata: Metadata = {
  title: "Pricing",
  description: "See the platform vendor subscription pricing for your country.",
  alternates: { canonical: "/pricing" },
};

export default function PricingPage() {
  return (
    <section className="mx-auto max-w-5xl px-4 py-16 sm:px-6">
      <PricingClient />
    </section>
  );
}
