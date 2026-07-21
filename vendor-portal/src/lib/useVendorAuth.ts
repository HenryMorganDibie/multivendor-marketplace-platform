"use client";

import { useEffect, useState } from "react";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, User } from "firebase/auth";
import { auth, callable } from "@/lib/firebase";

export type VendorPortalAccessState = "full" | "read_only" | "denied" | "incomplete_registration";

interface PortalAccessResponse {
  success: true;
  accessState: VendorPortalAccessState;
  vendorId?: string;
  businessName?: string | null;
  verificationStatus?: string;
  vendorStatus?: string;
  reason?: string;
  logoImage?: string | null;
  username?: string | null;
  categoryName?: string | null;
  area?: string | null;
  country?: string | null;
  email?: string | null;
  phone?: string | null;
}

interface VendorAuthState {
  loading: boolean;
  user: User | null;
  access: PortalAccessResponse | null;
  error: string | null;
}

/**
 * Client-side auth + portal-access state (Section 4.1). This drives which
 * UI renders, but is never the actual security boundary — every callable
 * the portal invokes independently re-checks role/vendorId/status
 * server-side, so a stale or bypassed client check can't grant real access.
 */
export function useVendorAuth(): VendorAuthState {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [access, setAccess] = useState<PortalAccessResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (nextUser) => {
      setUser(nextUser);
      setError(null);
      if (!nextUser) {
        setAccess(null);
        setLoading(false);
        return;
      }
      try {
        const getAccess = callable<Record<string, never>, PortalAccessResponse>("getVendorPortalAccess");
        const res = await getAccess({});
        setAccess(res.data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't verify account access.");
      } finally {
        setLoading(false);
      }
    });
    return () => unsubscribe();
  }, []);

  return { loading, user, access, error };
}

export async function vendorLogin(email: string, password: string): Promise<void> {
  await signInWithEmailAndPassword(auth, email, password);
}

export async function vendorLogout(): Promise<void> {
  await signOut(auth);
}
