"use client";

import { useEffect, useState } from "react";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, User } from "firebase/auth";
import { auth } from "@/lib/firebase";

interface AdminAuthState {
  loading: boolean;
  user: User | null;
  isSuperAdmin: boolean;
}

/**
 * Client-side gate only — the real enforcement is assertAdmin() re-checking
 * the live adminUsers doc status on every CMS callable (Section 2.2). This
 * hook just decides what the browser renders.
 */
export function useAdminAuth(): AdminAuthState {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (nextUser) => {
      setUser(nextUser);
      if (!nextUser) {
        setIsSuperAdmin(false);
        setLoading(false);
        return;
      }
      const tokenResult = await nextUser.getIdTokenResult();
      const claims = tokenResult.claims as { role?: string; adminRoleIds?: string[] };
      setIsSuperAdmin(claims.role === "admin" && Boolean(claims.adminRoleIds?.includes("super_admin")));
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  return { loading, user, isSuperAdmin };
}

export async function adminLogin(email: string, password: string): Promise<void> {
  await signInWithEmailAndPassword(auth, email, password);
}

export async function adminLogout(): Promise<void> {
  await signOut(auth);
}
