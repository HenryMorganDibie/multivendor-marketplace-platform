import { LucideIcon } from "lucide-react";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: { label: string; onClick: () => void };
  /**
   * Informational rather than "nothing here yet" — drops the CTA framing and
   * the muted icon treatment for something that reads as intentional. Used
   * for states the vendor cannot act on, like paid plans not being available
   * in their country.
   */
  tone?: "empty" | "info";
}

/**
 * The dashed border is gone.
 *
 * A dashed rectangle is the established convention for a drop target, so the
 * invoices empty state looked like somewhere to drag a file rather than a
 * message. It also ran `py-14` (56px top and bottom) which is most of a phone
 * screen for two lines of text. This is a normal card now, at card padding.
 */
export function EmptyState({ icon: Icon, title, description, action, tone = "empty" }: EmptyStateProps) {
  const isInfo = tone === "info";

  return (
    <div
      className={`flex flex-col items-center rounded-card border px-card-p py-8 text-center ${
        isInfo ? "border-brand/20 bg-brand-light" : "border-hairline bg-white"
      }`}
    >
      <div
        className={`flex h-11 w-11 items-center justify-center rounded-full ${
          isInfo ? "bg-white" : "bg-surface"
        }`}
      >
        <Icon size={20} className={isInfo ? "text-brand" : "text-ink-tertiary"} />
      </div>
      <p className="mt-3 text-card-title text-ink">{title}</p>
      <p className="mt-1 max-w-xs text-body-sm text-ink-secondary">{description}</p>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-4 rounded-button bg-brand px-4 py-2.5 text-button text-white transition-colors hover:bg-brand-dark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand active:bg-brand-darker"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
