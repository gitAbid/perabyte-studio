import type { ReactNode } from "react";
import { EmptyState as UiEmptyState } from "@/components/ui";
import { Icon, type IconName } from "@/components/Icon";

/* ------------------------------------------------------------------ */
/* EmptyState — UX spec §5 (every empty surface teaches the next action)*/
/* ------------------------------------------------------------------ */
/* Teaching empty state: a plain title, a one-to-two sentence reason to */
/* care, and the primary action that fixes it. Composes the existing   */
/* EmptyState from components/ui when only an icon is needed and adds  */
/* an optional illustration slot (any node) for feature-specific art.  */

export interface EmptyStateProps {
  title: string;
  /** One or two sentences that teach why this surface matters. */
  body: string;
  /** Named icon from components/Icon. Ignored when `illustration` is set. */
  icon?: IconName;
  /** Custom art replacing the icon circle (e.g. a stack of frames). */
  illustration?: ReactNode;
  /** Primary action, usually a single Button. */
  action?: ReactNode;
  /** Stable test id for this stateful surface (feature.entity.action). */
  testId?: string;
  className?: string;
}

export function EmptyState({
  title,
  body,
  icon = "image",
  illustration,
  action,
  testId = "empty.state",
  className = "",
}: EmptyStateProps) {
  if (illustration) {
    return (
      <div data-testid={testId} className={className}>
        <div className="flex flex-col items-center justify-center rounded-[12px] border border-dashed border-border-strong bg-surface px-6 py-14 text-center">
          <div className="mb-4">{illustration}</div>
          <h3 className="text-base font-bold text-ink">{title}</h3>
          <p className="mt-1.5 max-w-sm text-sm text-muted">{body}</p>
          {action && <div className="mt-5">{action}</div>}
        </div>
      </div>
    );
  }

  // `UiEmptyState` takes no extra props, so the test id lives on this wrapper.
  return (
    <div data-testid={testId} className={className}>
      <UiEmptyState icon={icon} title={title} body={body} action={action} />
    </div>
  );
}
