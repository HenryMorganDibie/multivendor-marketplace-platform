import Link from "next/link";

export default function MarketingNotFound() {
  return (
    <div id="main-content" className="mx-auto flex max-w-2xl flex-col items-center px-4 py-32 text-center">
      <p className="text-sm font-semibold text-brand">404</p>
      <h1 className="mt-2 text-3xl font-extrabold tracking-[-0.02em] text-ink">Page not found</h1>
      <p className="mt-4 text-ink-secondary">
        The page you&apos;re looking for doesn&apos;t exist or has moved.
      </p>
      <Link
        href="/"
        className="mt-8 rounded-button bg-brand px-6 py-3 text-sm font-semibold text-white shadow-soft-md hover:bg-brand-dark"
      >
        Back to home
      </Link>
    </div>
  );
}
