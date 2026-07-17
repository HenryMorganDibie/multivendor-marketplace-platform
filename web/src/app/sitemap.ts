import type { MetadataRoute } from "next";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.the platform.com";

const ROUTES = [
  "",
  "/features",
  "/pricing",
  "/vendors",
  "/customers",
  "/faq",
  "/contact",
  "/about",
  "/privacy-policy",
  "/terms-of-service",
  "/vendor-terms",
  "/customer-terms",
  "/cookie-policy",
  "/acceptable-use-policy",
];

export default function sitemap(): MetadataRoute.Sitemap {
  return ROUTES.map((route) => ({
    url: `${SITE_URL}${route}`,
    lastModified: new Date(),
    changeFrequency: route === "" ? "weekly" : "monthly",
    priority: route === "" ? 1 : 0.6,
  }));
}
