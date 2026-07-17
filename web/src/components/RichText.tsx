import { SiteContentNode, SiteContentSectionContent } from "@/lib/types";

const ALLOWED_SCHEMES = ["https:", "mailto:", "tel:"];

function isSafeHref(href: string): boolean {
  return ALLOWED_SCHEMES.some((scheme) => href.trim().toLowerCase().startsWith(scheme));
}

function renderNode(node: SiteContentNode, key: number, headingIndex?: number) {
  switch (node.type) {
    case "heading": {
      const Tag = (`h${node.level}` as unknown) as "h1" | "h2" | "h3";
      const sizeClass =
        node.level === 1 ? "text-4xl md:text-5xl font-bold" : node.level === 2 ? "text-2xl md:text-3xl font-semibold" : "text-xl font-semibold";
      return (
        <Tag key={key} id={headingIndex !== undefined ? `section-${headingIndex}` : undefined} className={`${sizeClass} tracking-tight scroll-mt-24`}>
          {node.text}
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p key={key} className="text-base leading-relaxed text-gray-700 dark:text-gray-300">
          {node.text}
        </p>
      );
    case "bold":
      return (
        <strong key={key} className="font-semibold">
          {node.text}
        </strong>
      );
    case "italic":
      return (
        <em key={key} className="italic">
          {node.text}
        </em>
      );
    case "link":
      return isSafeHref(node.href) ? (
        <a key={key} href={node.href} className="text-brand underline underline-offset-2 hover:text-brand-dark">
          {node.text}
        </a>
      ) : null;
    case "bulletList":
      return (
        <ul key={key} className="list-disc space-y-1 pl-6 text-gray-700 dark:text-gray-300">
          {node.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      );
    case "orderedList":
      return (
        <ol key={key} className="list-decimal space-y-1 pl-6 text-gray-700 dark:text-gray-300">
          {node.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ol>
      );
    default:
      return null;
  }
}

export default function RichText({ content }: { content: SiteContentSectionContent | null | undefined }) {
  if (!content || !Array.isArray(content.nodes)) return null;
  let headingIndex = -1;
  return (
    <div className="space-y-4">
      {content.nodes.map((node, i) => {
        if (node.type === "heading") headingIndex += 1;
        return renderNode(node, i, node.type === "heading" ? headingIndex : undefined);
      })}
    </div>
  );
}
