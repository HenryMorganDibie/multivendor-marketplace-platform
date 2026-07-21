import RichText from "@/components/RichText";
import { SiteContentSectionContent } from "@/lib/types";

export default function MarketingSection({
  content,
  children,
}: {
  content: SiteContentSectionContent;
  children?: React.ReactNode;
}) {
  return (
    <section className="mx-auto max-w-4xl px-4 py-12 sm:px-6 sm:py-16">
      <RichText content={content} />
      {children}
    </section>
  );
}
