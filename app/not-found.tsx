import Link from "next/link";
import { Icon } from "@/components/Icon";

export default function NotFound() {
  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-1 flex-col justify-center px-5 py-10 sm:px-8 lg:px-12">
      <div className="grid overflow-hidden border border-border bg-raised lg:min-h-[540px] lg:grid-cols-[0.88fr_1.12fr]">
        <section className="flex flex-col justify-between p-6 sm:p-10 lg:p-12">
          <p className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.19em] text-accent">
            <span className="h-px w-6 bg-accent" /> Out of frame <span className="text-muted">/ 404</span>
          </p>
          <div className="py-10 lg:py-14">
            <h1 className="editorial-display max-w-lg text-[42px] leading-[1.02] text-ink sm:text-[58px]">This page missed its cue.</h1>
            <p className="mt-5 max-w-md text-[13px] leading-[1.8] text-muted sm:text-sm">
              The address may have changed, or the scene may never have existed. Your saved work is still in the studio library.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Link href="/generate/image" className="inline-flex h-11 items-center gap-2 bg-primary-strong px-4 text-[12px] font-bold text-white transition-colors hover:bg-primary-dark">
                Open the studio <Icon name="arrow-right" size={15} />
              </Link>
              <Link href="/images" className="inline-flex h-11 items-center gap-2 border border-border-strong px-4 text-[12px] font-semibold text-ink-soft transition-colors hover:bg-surface hover:text-ink">
                Visit the library
              </Link>
            </div>
          </div>
          <Link href="/" className="inline-flex w-fit items-center gap-2 border-t border-border pt-4 text-[11px] font-semibold text-muted transition-colors hover:text-ink">
            <Icon name="chevron-down" size={14} className="rotate-90" /> Return to PeraByte home
          </Link>
        </section>

        <div className="studio-canvas relative flex min-h-[280px] items-center justify-center overflow-hidden border-t border-border p-8 lg:border-l lg:border-t-0">
          <div className="relative aspect-[1.18] w-full max-w-[500px] border border-border-strong bg-canvas/70 p-4 sm:p-7">
            <div className="absolute inset-4 border border-dashed border-border-strong sm:inset-7" />
            <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-3 bg-raised px-4 py-3 sm:px-6 sm:py-4">
              <span className="editorial-display text-[56px] leading-none text-accent sm:text-[86px]">404</span>
              <span className="h-12 w-px bg-border sm:h-16" />
              <span className="max-w-[100px] text-[9px] font-bold uppercase leading-[1.7] tracking-[0.14em] text-muted sm:max-w-[120px] sm:text-[10px]">No image<br />in this frame</span>
            </div>
            <span className="absolute -left-2 top-1/2 size-4 -translate-y-1/2 rounded-full border border-border-strong bg-canvas" />
            <span className="absolute -right-2 top-1/2 size-4 -translate-y-1/2 rounded-full border border-border-strong bg-canvas" />
            <span className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-raised px-2 text-[9px] font-semibold uppercase tracking-[0.17em] text-muted sm:bottom-5">Frame not found</span>
          </div>
          <span className="absolute bottom-4 right-5 text-[9px] font-bold uppercase tracking-[0.18em] text-muted">Studio / 00</span>
        </div>
      </div>
    </div>
  );
}
