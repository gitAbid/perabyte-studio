"use client";

import Link from "next/link";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { Icon, type IconName } from "./Icon";

/* ------------------------------------------------------------------ */
/* Button                                                              */
/* ------------------------------------------------------------------ */

type Variant = "primary" | "secondary" | "ghost" | "danger" | "text";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-primary text-white hover:bg-primary-dark active:bg-primary-dark shadow-[0_1px_2px_rgba(37,99,235,0.35)]",
  secondary:
    "bg-white text-ink border border-border-strong hover:border-muted hover:bg-surface",
  ghost: "bg-transparent text-ink hover:bg-surface-2",
  danger: "bg-danger text-white hover:brightness-110",
  text: "bg-transparent text-primary hover:underline underline-offset-4 px-0",
};

const SIZES: Record<Size, string> = {
  sm: "h-9 px-3.5 text-[13px] gap-1.5",
  md: "h-11 px-4 text-sm gap-2",
  lg: "h-12 px-5 text-[15px] gap-2",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: IconName;
  iconRight?: IconName;
  loading?: boolean;
  block?: boolean;
}

export function Button({
  variant = "primary",
  size = "md",
  icon,
  iconRight,
  loading,
  block,
  className = "",
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex items-center justify-center rounded-[12px] font-semibold transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-55 ${VARIANTS[variant]} ${SIZES[size]} ${block ? "w-full" : ""} ${className}`}
    >
      {loading ? (
        <Spinner />
      ) : (
        icon && <Icon name={icon} size={size === "sm" ? 15 : 17} />
      )}
      {children}
      {iconRight && !loading && (
        <Icon name={iconRight} size={size === "sm" ? 15 : 17} />
      )}
    </button>
  );
}

export function LinkButton({
  href,
  variant = "primary",
  size = "md",
  icon,
  iconRight,
  block,
  children,
  className = "",
  ...rest
}: {
  href: string;
  variant?: Variant;
  size?: Size;
  icon?: IconName;
  iconRight?: IconName;
  block?: boolean;
  children: ReactNode;
  className?: string;
} & Omit<React.ComponentProps<typeof Link>, "href" | "className">) {
  return (
    <Link
      href={href}
      {...rest}
      className={`inline-flex items-center justify-center rounded-[12px] font-semibold transition-all duration-150 ${VARIANTS[variant]} ${SIZES[size]} ${block ? "w-full" : ""} ${className}`}
    >
      {icon && <Icon name={icon} size={size === "sm" ? 15 : 17} />}
      {children}
      {iconRight && <Icon name={iconRight} size={size === "sm" ? 15 : 17} />}
    </Link>
  );
}

function Spinner() {
  return (
    <span
      className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent"
      aria-hidden="true"
    />
  );
}

/* ------------------------------------------------------------------ */
/* Card / Badge                                                        */
/* ------------------------------------------------------------------ */

export function Card({
  children,
  className = "",
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "article";
}) {
  return (
    <Tag
      className={`rounded-[20px] border border-border bg-white p-6 shadow-card ${className}`}
    >
      {children}
    </Tag>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "primary" | "success" | "warning" | "danger";
}) {
  const tones = {
    neutral: "bg-surface-2 text-ink-soft",
    primary: "bg-primary-soft text-primary",
    success: "bg-[#f0fdf4] text-success",
    warning: "bg-[#fffbeb] text-warning",
    danger: "bg-danger-soft text-danger",
  } as const;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Form controls                                                       */
/* ------------------------------------------------------------------ */

export function FieldShell({
  label,
  htmlFor,
  hint,
  error,
  children,
  counter,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  counter?: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <label
          htmlFor={htmlFor}
          className="text-[13px] font-semibold text-ink-soft"
        >
          {label}
        </label>
        {counter && (
          <span className="text-[12px] tabular-nums text-muted">{counter}</span>
        )}
      </div>
      {children}
      {hint && !error && <p className="text-[12px] text-muted">{hint}</p>}
      {error && (
        <p
          role="alert"
          className="flex items-center gap-1.5 text-[12px] font-medium text-danger"
        >
          <Icon name="alert" size={14} />
          {error}
        </p>
      )}
    </div>
  );
}

export function SelectField({
  label,
  value,
  error,
  hint,
  children,
  ...rest
}: {
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
} & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return (
    <FieldShell label={label} htmlFor={id} error={error} hint={hint}>
      <div className="relative">
        <select
          id={id}
          {...rest}
          value={value}
          className={`h-11 w-full appearance-none rounded-[12px] border bg-white pl-3.5 pr-10 text-sm font-medium text-ink transition-colors hover:border-muted focus:border-primary focus:outline-none ${
            error ? "border-danger" : "border-border-strong"
          }`}
        >
          {children}
        </select>
        <Icon
          name="chevron-down"
          size={16}
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted"
        />
      </div>
    </FieldShell>
  );
}

export function TextAreaField({
  label,
  value,
  maxLength,
  error,
  placeholder,
  onChange,
  rows = 4,
  hint,
}: {
  label: string;
  value: string;
  maxLength: number;
  error?: string;
  placeholder?: string;
  onChange: (value: string) => void;
  rows?: number;
  hint?: string;
}) {
  const id = useId();
  return (
    <FieldShell
      label={label}
      htmlFor={id}
      error={error}
      hint={hint}
      counter={`${value.length}/${maxLength}`}
    >
      <textarea
        id={id}
        value={value}
        rows={rows}
        maxLength={maxLength}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full resize-y rounded-[12px] border bg-white px-3.5 py-3 text-sm leading-relaxed text-ink placeholder:text-muted focus:border-primary focus:outline-none ${
          error ? "border-danger" : "border-border-strong"
        }`}
      />
    </FieldShell>
  );
}

export function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-[13px] font-semibold text-ink-soft">{label}</p>
        {description && (
          <p className="mt-0.5 text-[12px] text-muted">{description}</p>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors ${
          checked ? "bg-primary" : "bg-border-strong"
        }`}
      >
        <span
          className={`absolute top-0.5 size-5 rounded-full bg-white shadow-sm transition-all ${
            checked ? "left-[22px]" : "left-0.5"
          }`}
        />
      </button>
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  size = "md",
  collapseOnMobile,
}: {
  options: { value: T; label: string; icon?: IconName }[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  size?: "sm" | "md";
  /** Show icons only on narrow screens so the row never wraps. */
  collapseOnMobile?: boolean;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="inline-flex items-center gap-1 rounded-[12px] border border-border bg-surface p-1"
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={option.label}
            onClick={() => onChange(option.value)}
            className={`inline-flex items-center gap-1.5 rounded-[9px] font-semibold transition-all ${
              size === "sm" ? "h-7 px-2.5 text-[12px]" : "h-8 px-3 text-[13px]"
            } ${
              active
                ? "bg-primary text-white shadow-sm"
                : "text-ink-soft hover:bg-white"
            }`}
          >
            {option.icon && <Icon name={option.icon} size={14} />}
            <span className={collapseOnMobile ? "hidden sm:inline" : undefined}>
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

type Toast = { id: number; message: string; tone: "info" | "success" | "error" };
type ToastContextValue = {
  push: (message: string, tone?: Toast["tone"]) => void;
};

const ToastContext = createContext<ToastContextValue>({ push: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  function push(message: string, tone: Toast["tone"] = "info") {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5200);
  }

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4 sm:bottom-6"
      >
        {toasts.map((toast) => (
          <ToastRow key={toast.id} toast={toast} onClose={() => setToasts((t) => t.filter((x) => x.id !== toast.id))} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastRow({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  const [entered, setEntered] = useState(false);
  useEffect(() => setEntered(true), []);
  const tone = {
    info: "border-border bg-white text-ink",
    success: "border-[#bbf7d0] bg-[#f0fdf4] text-ink",
    error: "border-[#fecaca] bg-danger-soft text-ink",
  }[toast.tone];
  const iconName: IconName =
    toast.tone === "success" ? "check" : toast.tone === "error" ? "alert" : "sparkle";

  return (
    <div
      role="status"
      className={`pointer-events-auto flex w-full max-w-md items-start gap-2.5 rounded-[14px] border px-4 py-3 text-sm shadow-lift transition-all duration-200 ${tone} ${
        entered ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"
      }`}
    >
      <Icon name={iconName} size={16} className="mt-0.5 shrink-0 text-primary" />
      <p className="flex-1 leading-snug">{toast.message}</p>
      <button
        type="button"
        onClick={onClose}
        aria-label="Dismiss notification"
        className="rounded p-0.5 text-muted hover:text-ink"
      >
        <Icon name="close" size={15} />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* States                                                             */
/* ------------------------------------------------------------------ */

export function EmptyState({
  icon = "image",
  title,
  body,
  action,
}: {
  icon?: IconName;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[20px] border border-dashed border-border-strong bg-surface px-6 py-14 text-center">
      <span className="mb-4 inline-flex size-12 items-center justify-center rounded-full bg-white text-muted shadow-card">
        <Icon name={icon} size={22} />
      </span>
      <h3 className="text-base font-bold text-ink">{title}</h3>
      <p className="mt-1.5 max-w-sm text-sm text-muted">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "Delete",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
    >
      <div className="w-full max-w-sm rounded-[20px] border border-border bg-white p-6 shadow-lift">
        <h2 className="text-base font-bold text-ink">{title}</h2>
        <p className="mt-2 text-sm text-muted">{body}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onCancel} autoFocus>
            Cancel
          </Button>
          <Button variant="danger" size="sm" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}