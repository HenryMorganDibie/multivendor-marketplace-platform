"use client";

import AccordionItem from "@/components/Accordion";
import { SiteContentSectionContent, SiteContentNode } from "@/lib/types";

interface FaqItem {
  question: string;
  answer: string;
}
interface FaqCategory {
  title: string;
  items: FaqItem[];
}

// Parses the CMS's generic RichText nodes into category/question/answer
// groups: heading level 2 = category, heading level 3 = question,
// the paragraph immediately after it = answer. This is a structural
// assumption specific to how the FAQ page's content is authored (see the
// fallback in page.tsx) — the CMS node schema itself has no dedicated
// "FAQ" node type, so this page interprets the general schema rather than
// needing a new one.
function parseFaq(content: SiteContentSectionContent): FaqCategory[] {
  const categories: FaqCategory[] = [];
  let currentCategory: FaqCategory | null = null;
  let pendingQuestion: string | null = null;

  for (const node of content.nodes as SiteContentNode[]) {
    if (node.type === "heading" && node.level === 2) {
      currentCategory = { title: node.text, items: [] };
      categories.push(currentCategory);
      pendingQuestion = null;
    } else if (node.type === "heading" && node.level === 3) {
      pendingQuestion = node.text;
    } else if (node.type === "paragraph" && pendingQuestion && currentCategory) {
      currentCategory.items.push({ question: pendingQuestion, answer: node.text });
      pendingQuestion = null;
    }
  }
  return categories;
}

export default function FaqAccordion({ content }: { content: SiteContentSectionContent }) {
  const categories = parseFaq(content);

  return (
    <div className="space-y-8">
      {categories.map((category) => (
        <div key={category.title}>
          <h2 className="text-lg font-bold tracking-[-0.01em] text-ink">{category.title}</h2>
          <div className="mt-1">
            {category.items.map((item) => (
              <AccordionItem key={item.question} question={item.question}>
                {item.answer}
              </AccordionItem>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
