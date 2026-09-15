import { Icon } from "@/components/Icon";

/**
 * Live render readout shared by Solo and Story: the provider's status line
 * plus a thin bar — a real percent fill when the provider reports one, an
 * indeterminate pulse while it doesn't.
 */
export function RenderProgress({
  message,
  percent,
}: {
  message: string;
  percent?: number;
}) {
  return (
    <div className="flex flex-col items-center gap-2">
      <p className="flex items-center gap-2 text-center text-[12.5px] font-medium text-muted">
        <Icon name="clock" size={14} />
        {message}
      </p>
      <div className="h-1 w-44 overflow-hidden rounded-full bg-ink/10">
        {percent !== undefined ? (
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
            style={{ width: `${percent}%` }}
          />
        ) : (
          <div className="h-full w-full animate-pulse rounded-full bg-primary/40" />
        )}
      </div>
    </div>
  );
}
