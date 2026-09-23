"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signInWithCustomToken } from "firebase/auth";
import { auth } from "@/lib/firebase";

const ALLOWED_DESTINATIONS = new Set(["/subscription", "/billing"]);

function PortalHandoffInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<"signing_in" | "error">("signing_in");

  useEffect(() => {
    const token = searchParams.get("token");
    const dest = searchParams.get("dest");
    const destination = dest && ALLOWED_DESTINATIONS.has(dest) ? dest : "/subscription";

    if (!token) {
      setStatus("error");
      return;
    }

    signInWithCustomToken(auth, token)
      .then(() => router.replace(destination))
      .catch(() => setStatus("error"));
  }, [router, searchParams]);

  if (status === "error") {
    return (
      <div>
        <h1 className="text-2xl font-extrabold tracking-[-0.02em] text-ink">Link expired</h1>
        <p className="mt-2 text-sm text-ink-secondary">
          This sign-in link is no longer valid. Go back to the Platform app and tap &quot;Open Vendor Portal&quot; again,
          or{" "}
          <a href="/login" className="font-medium text-brand underline">
            log in directly
          </a>
          .
        </p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-extrabold tracking-[-0.02em] text-ink">Signing you in…</h1>
      <p className="mt-2 text-sm text-ink-secondary">Taking you to the Vendor Portal.</p>
    </div>
  );
}

export default function PortalHandoffPage() {
  return (
    <Suspense fallback={null}>
      <PortalHandoffInner />
    </Suspense>
  );
}
