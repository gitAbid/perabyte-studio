"use client";

import { Icon, type IconName } from "@/components/Icon";
import { Badge, Button, Segmented, SelectField, Toggle } from "@/components/ui";

const COLORS = [
  { name: "Evergreen", role: "Action · selection", value: "#315F4B", text: "#FFFFFF" },
  { name: "Deep pine", role: "Emphasis", value: "#183D30", text: "#FFFFFF" },
  { name: "Warm stock", role: "Canvas", value: "#F4F1E9", text: "#202B27" },
  { name: "Raised paper", role: "Panels", value: "#FBF9F4", text: "#202B27" },
  { name: "Soft surface", role: "Grouping", value: "#E9E5DB", text: "#202B27" },
  { name: "Ink", role: "Headings", value: "#202B27", text: "#FFFFFF" },
  { name: "Muted text", role: "Supporting copy", value: "#5F6B64", text: "#FFFFFF" },
  { name: "Clay", role: "Wayfinding", value: "#C96C4C", text: "#FFFFFF" },
];

const ICONS: IconName[] = [
  "image", "video", "play", "pause", "sparkle", "download", "share", "heart",
  "grid", "story", "clock", "lock", "user", "search", "check", "more",
];

const INDEX = [
  ["01", "Color", "#color"],
  ["02", "Type", "#type"],
  ["03", "Controls", "#controls"],
  ["04", "Signals", "#signals"],
];

export function StyleGuideView() {
  return (
    <div className="mx-auto w-full max-w-[1320px] px-5 pb-16 pt-8 sm:px-8 lg:px-12">
      <header className="grid gap-8 border-b border-border pb-8 lg:grid-cols-[1fr_auto] lg:items-end">
        <div>
          <p className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-accent">
            <span className="h-px w-6 bg-accent" /> Studio field guide <span className="text-muted">/ 2026</span>
          </p>
          <h1 className="editorial-display mt-4 max-w-3xl text-[42px] leading-[1.02] text-ink sm:text-[56px]">
            A visual language for making worlds.
          </h1>
          <p className="mt-4 max-w-2xl text-[13px] leading-[1.8] text-muted sm:text-sm">
            A working reference for color, type, and interaction across the PeraByte studio. Built from the warm stock, evergreen ink, and clay accents used throughout the workspace.
          </p>
        </div>
        <div className="border-l border-border pl-4 text-[11px] leading-[1.7] text-muted lg:max-w-[190px]">
          <span className="block font-bold uppercase tracking-[0.16em] text-ink-soft">Reference</span>
          <span className="mt-1 block">Tokens live in <code className="text-ink">app/globals.css</code></span>
          <span className="block">Principles live in <code className="text-ink">DESIGN.md</code></span>
        </div>
      </header>

      <nav aria-label="Style guide sections" className="grid grid-cols-2 border-b border-border sm:grid-cols-4">
        {INDEX.map(([number, label, href]) => (
          <a key={number} href={href} className="group flex min-h-[56px] items-center gap-3 border-border px-2 transition-colors hover:bg-surface sm:border-l sm:px-4 first:sm:border-l-0">
            <span className="text-[10px] font-bold tracking-[0.12em] text-accent">{number}</span>
            <span className="text-[12px] font-semibold text-ink-soft group-hover:text-ink">{label}</span>
            <Icon name="arrow-right" size={13} className="ml-auto text-muted transition-transform group-hover:translate-x-0.5" />
          </a>
        ))}
      </nav>

      <section id="color" className="scroll-mt-8 border-b border-border py-10 sm:py-14">
        <div className="grid gap-8 lg:grid-cols-[0.65fr_1.35fr]">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-accent">01 / Palette</p>
            <h2 className="editorial-display mt-3 text-[32px] leading-tight text-ink">Color with a point of view.</h2>
            <p className="mt-3 max-w-sm text-[13px] leading-[1.8] text-muted">A small material palette keeps the interface quiet while the work takes focus. Clay is reserved for accents; evergreen carries action.</p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {COLORS.map((color) => (
              <article key={color.name} className="min-w-0 border border-border bg-raised">
                <div className="flex h-[88px] items-end justify-between p-3" style={{ background: color.value, color: color.text }}>
                  <span className="text-[12px] font-bold">{color.name}</span>
                  <span className="text-[9px] font-semibold uppercase tracking-[0.12em] opacity-80">Aa</span>
                </div>
                <div className="flex items-center justify-between gap-2 px-3 py-2.5">
                  <span className="truncate text-[10px] text-muted">{color.role}</span>
                  <code className="shrink-0 text-[10px] tabular-nums text-ink-soft">{color.value}</code>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="type" className="scroll-mt-8 border-b border-border py-10 sm:py-14">
        <div className="grid gap-8 lg:grid-cols-[0.65fr_1.35fr]">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-accent">02 / Typography</p>
            <h2 className="editorial-display mt-3 text-[32px] leading-tight text-ink">Editorial voice, studio clarity.</h2>
            <p className="mt-3 max-w-sm text-[13px] leading-[1.8] text-muted">A bookish display face gives ideas room to breathe. A compact sans keeps controls and production details easy to scan.</p>
          </div>
          <div className="grid gap-0 border-y border-border sm:grid-cols-[1fr_0.72fr]">
            <div className="border-b border-border py-5 sm:border-b-0 sm:border-r sm:pr-7">
              <div className="mb-5 flex items-center justify-between text-[10px] font-bold uppercase tracking-[0.15em] text-muted"><span>Display / serif</span><span>500 · -0.045em</span></div>
              <p className="editorial-display text-[42px] leading-[1.02] text-ink sm:text-[54px]">Make a scene<br />worth returning to.</p>
              <p className="mt-4 text-[10px] text-muted">Iowan Old Style · Palatino · Georgia</p>
            </div>
            <div className="py-5 sm:pl-7">
              <div className="mb-5 flex items-center justify-between text-[10px] font-bold uppercase tracking-[0.15em] text-muted"><span>Interface / sans</span><span>400–700</span></div>
              <p className="max-w-xs text-[15px] leading-[1.75] text-ink-soft">Describe the frame, keep the details that matter, then carry your choices into the next scene.</p>
              <p className="mt-5 text-[10px] text-muted">Inter · Avenir Next · system sans</p>
              <p className="mt-5 text-[10px] font-bold uppercase tracking-[0.18em] text-primary">Eyebrow / section label</p>
            </div>
          </div>
        </div>
      </section>

      <section id="controls" className="scroll-mt-8 border-b border-border py-10 sm:py-14">
        <div className="grid gap-8 lg:grid-cols-[0.65fr_1.35fr]">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-accent">03 / Controls</p>
            <h2 className="editorial-display mt-3 text-[32px] leading-tight text-ink">Clear, tactile, in context.</h2>
            <p className="mt-3 max-w-sm text-[13px] leading-[1.8] text-muted">Primary actions are easy to find. Supporting controls use quiet surfaces and labels that explain their purpose.</p>
            <div className="mt-6 flex flex-wrap items-center gap-2">
              <Button>Start a render <Icon name="arrow-right" size={15} /></Button>
              <Button variant="secondary">Save draft</Button>
              <Button variant="text" iconRight="arrow-right">Learn more</Button>
            </div>
          </div>
          <div className="grid gap-6 border-y border-border bg-surface/45 p-4 sm:grid-cols-2 sm:p-6">
            <div className="space-y-5">
              <SelectField label="Frame shape" defaultValue="wide">
                <option value="wide">16:9 · Landscape</option>
                <option value="portrait">9:16 · Portrait</option>
              </SelectField>
              <div className="rounded-[8px] border border-border-strong bg-raised px-3.5 py-3">
                <span className="text-[12px] font-semibold text-ink-soft">Prompt</span>
                <p className="mt-2 text-[12px] leading-[1.7] text-muted">A quiet greenhouse at the edge of an old city…</p>
                <p className="mt-4 border-t border-border pt-2 text-right text-[10px] tabular-nums text-muted">56 / 1000</p>
              </div>
            </div>
            <div className="flex flex-col justify-between gap-5">
              <Toggle label="Polish prompt" description="Refine the description before rendering" checked onChange={() => {}} />
              <Segmented ariaLabel="Example media type" value="image" onChange={() => {}} options={[{ value: "image", label: "Image", icon: "image" }, { value: "video", label: "Motion", icon: "video" }]} />
              <div className="flex items-center justify-between border-t border-border pt-4 text-[10px] text-muted"><span>Control height</span><span className="font-semibold tabular-nums text-ink-soft">44 px minimum</span></div>
            </div>
          </div>
        </div>
      </section>

      <section id="signals" className="scroll-mt-8 py-10 sm:py-14">
        <div className="grid gap-8 lg:grid-cols-[0.65fr_1.35fr]">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-accent">04 / Signals</p>
            <h2 className="editorial-display mt-3 text-[32px] leading-tight text-ink">Small signals, useful meaning.</h2>
            <p className="mt-3 max-w-sm text-[13px] leading-[1.8] text-muted">Labels pair with color so readiness, status, and media type stay legible at a glance.</p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Badge tone="primary">In progress</Badge>
              <Badge tone="success">Ready</Badge>
              <Badge tone="warning">Needs review</Badge>
              <Badge tone="danger">Failed</Badge>
            </div>
          </div>
          <div className="grid content-start grid-cols-4 gap-2 border-y border-border py-5 text-ink-soft sm:grid-cols-8">
            {ICONS.map((name) => (
              <span key={name} className="flex aspect-square items-center justify-center border border-border bg-raised transition-colors hover:border-primary hover:text-primary" title={name}>
                <Icon name={name} size={18} />
              </span>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
