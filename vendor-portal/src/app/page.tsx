"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function PortalIndexPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/subscription");
  }, [router]);
  return null;
}
