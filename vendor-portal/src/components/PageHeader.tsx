import { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  description?: string;
  action?: ReactNode;
}

/**
 * The page's own heading, now the only place a screen names itself.
 *
 * The title was `text-xl` (20px) with a `text-sm` (14px) description, so a
 * page title sat closer in weight to its own subtitle than to a heading, and
 * the description competed with real content. Both now come from the shared
 * type scale: page-title for the h1, body-sm in secondary ink beneath it.
 */
export function PageHeader({ title, description, action }: PageHeaderProps) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-page-title text-ink">{title}</h1>
        {description && <p className="mt-1 text-body-sm text-ink-secondary">{description}</p>}
      </div>
      {action}
    </div>
  );
}
