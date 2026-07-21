const TONE_CLASSES: Record<"success" | "warning" | "danger" | "neutral" | "info", string> = {
  success: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  warning: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  danger: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  neutral: "bg-gray-100 text-gray-600 dark:bg-gray-900 dark:text-gray-400",
  info: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
};

export type StatusTone = keyof typeof TONE_CLASSES;

export function StatusBadge({ label, tone }: { label: string; tone: StatusTone }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE_CLASSES[tone]}`}>{label}</span>;
}
