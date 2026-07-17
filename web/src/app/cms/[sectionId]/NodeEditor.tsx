"use client";

import { SiteContentNode } from "@/lib/types";

const NODE_TYPES: SiteContentNode["type"][] = ["heading", "paragraph", "bold", "italic", "link", "bulletList", "orderedList"];

function blankNode(type: SiteContentNode["type"]): SiteContentNode {
  switch (type) {
    case "heading":
      return { type: "heading", level: 2, text: "" };
    case "paragraph":
      return { type: "paragraph", text: "" };
    case "bold":
      return { type: "bold", text: "" };
    case "italic":
      return { type: "italic", text: "" };
    case "link":
      return { type: "link", text: "", href: "https://" };
    case "bulletList":
      return { type: "bulletList", items: [""] };
    case "orderedList":
      return { type: "orderedList", items: [""] };
  }
}

export default function NodeEditor({
  nodes,
  onChange,
}: {
  nodes: SiteContentNode[];
  onChange: (nodes: SiteContentNode[]) => void;
}) {
  function updateNode(index: number, next: SiteContentNode) {
    onChange(nodes.map((n, i) => (i === index ? next : n)));
  }

  function removeNode(index: number) {
    onChange(nodes.filter((_, i) => i !== index));
  }

  function moveNode(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= nodes.length) return;
    const next = [...nodes];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  function addNode(type: SiteContentNode["type"]) {
    onChange([...nodes, blankNode(type)]);
  }

  return (
    <div className="space-y-4">
      {nodes.map((node, i) => (
        <div key={i} className="rounded-xl border border-gray-200 p-4 dark:border-gray-800">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase text-gray-400">{node.type}</span>
            <div className="flex gap-2 text-xs">
              <button type="button" onClick={() => moveNode(i, -1)} className="text-gray-500 hover:text-brand">
                Up
              </button>
              <button type="button" onClick={() => moveNode(i, 1)} className="text-gray-500 hover:text-brand">
                Down
              </button>
              <button type="button" onClick={() => removeNode(i)} className="text-red-500 hover:text-red-700">
                Remove
              </button>
            </div>
          </div>

          <div className="mt-3">
            {node.type === "heading" && (
              <div className="flex gap-3">
                <select
                  value={node.level}
                  onChange={(e) => updateNode(i, { ...node, level: Number(e.target.value) as 1 | 2 | 3 })}
                  className="rounded-lg border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
                >
                  <option value={1}>H1</option>
                  <option value={2}>H2</option>
                  <option value={3}>H3</option>
                </select>
                <input
                  value={node.text}
                  onChange={(e) => updateNode(i, { ...node, text: e.target.value })}
                  className="flex-1 rounded-lg border border-gray-300 px-3 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
                />
              </div>
            )}

            {(node.type === "paragraph" || node.type === "bold" || node.type === "italic") && (
              <textarea
                value={node.text}
                onChange={(e) => updateNode(i, { ...node, text: e.target.value })}
                rows={3}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
              />
            )}

            {node.type === "link" && (
              <div className="grid gap-2 sm:grid-cols-2">
                <input
                  placeholder="Link text"
                  value={node.text}
                  onChange={(e) => updateNode(i, { ...node, text: e.target.value })}
                  className="rounded-lg border border-gray-300 px-3 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
                />
                <input
                  placeholder="https://, mailto:, or tel: only"
                  value={node.href}
                  onChange={(e) => updateNode(i, { ...node, href: e.target.value })}
                  className="rounded-lg border border-gray-300 px-3 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
                />
              </div>
            )}

            {(node.type === "bulletList" || node.type === "orderedList") && (
              <div className="space-y-2">
                {node.items.map((item, itemIndex) => (
                  <div key={itemIndex} className="flex gap-2">
                    <input
                      value={item}
                      onChange={(e) => {
                        const items = node.items.map((it, ii) => (ii === itemIndex ? e.target.value : it));
                        updateNode(i, { ...node, items });
                      }}
                      className="flex-1 rounded-lg border border-gray-300 px-3 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
                    />
                    <button
                      type="button"
                      onClick={() => updateNode(i, { ...node, items: node.items.filter((_, ii) => ii !== itemIndex) })}
                      className="text-xs text-red-500 hover:text-red-700"
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => updateNode(i, { ...node, items: [...node.items, ""] })}
                  className="text-xs font-medium text-brand hover:text-brand-dark"
                >
                  + Add item
                </button>
              </div>
            )}
          </div>
        </div>
      ))}

      <div className="flex flex-wrap gap-2">
        {NODE_TYPES.map((type) => (
          <button
            key={type}
            type="button"
            onClick={() => addNode(type)}
            className="rounded-full border border-gray-300 px-3 py-1 text-xs font-medium hover:border-brand hover:text-brand"
          >
            + {type}
          </button>
        ))}
      </div>
    </div>
  );
}
