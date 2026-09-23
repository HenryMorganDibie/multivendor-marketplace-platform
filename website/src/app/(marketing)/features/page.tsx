import { redirect } from "next/navigation";

// This page's content moved to the homepage (/) per direction to make the
// new design the actual landing page, not a separate /features subpage.
// Redirecting rather than deleting outright preserves any existing
// inbound links/bookmarks/search-engine indexing pointing at /features.
export default function FeaturesRedirect() {
  redirect("/");
}
