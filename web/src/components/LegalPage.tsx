import RichText from "@/components/RichText";
import { PublishedSections, sectionOrFallback } from "@/lib/siteContent";
import { SiteContentSectionContent, SiteContentSectionId } from "@/lib/types";

export default function LegalPage({
  sections,
  sectionId,
  fallback,
  title,
}: {
  sections: PublishedSections;
  sectionId: SiteContentSectionId;
  fallback: SiteContentSectionContent;
  title: string;
}) {
  const { content, version } = sectionOrFallback(sections, sectionId, fallback);
  const headingCount = content.nodes.filter((n) => n.type === "heading").length;

  return (
    <section className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{title}</h1>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-gray-500">
        <span>{version !== null ? `Version ${version}` : "Content pending publication"}</span>
        <span aria-hidden="true">&middot;</span>
        <span>
          Questions? <a href="/contact" className="underline hover:text-brand">Contact us</a>
        </span>
      </div>

      {headingCount > 2 && (
        <nav aria-label="Table of contents" className="mt-8 rounded-xl border border-gray-100 p-4 text-sm dark:border-gray-800">
          <p className="font-semibold">On this page</p>
          <ul className="mt-2 space-y-1">
            {content.nodes
              .filter((n) => n.type === "heading")
              .map((n, i) => (
                <li key={i}>
                  <a href={`#section-${i}`} className="text-gray-600 hover:text-brand dark:text-gray-400">
                    {"text" in n ? n.text : ""}
                  </a>
                </li>
              ))}
          </ul>
        </nav>
      )}

      <div className="prose mt-8 max-w-none">
        <RichText content={content} />
      </div>
    </section>
  );
}
