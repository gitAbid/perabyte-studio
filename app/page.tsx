import Link from "next/link";
import { Icon, Logo } from "@/components/Icon";
import { ThemeToggle } from "@/components/SiteChrome";

const HERO_MAIN = "/demo/mountain-lake.jpg";
const HERO_SIDE = [
  { src: "/demo/fantasy-forest.jpg", alt: "An imagined forest rendered in PeraByte" },
  { src: "/demo/city-night.jpg", alt: "A neon city scene rendered in PeraByte" },
];

const WORKSPACES = [
  {
    index: "01",
    title: "Image studio",
    body: "Find the frame. Compare variations, keep the right details, and build on a reference.",
    href: "/generate/image",
    icon: "image" as const,
    label: "Make a still",
  },
  {
    index: "02",
    title: "Motion studio",
    body: "Give a scene movement, set its opening and ending frames, then bring the clip into your library.",
    href: "/generate/video",
    icon: "video" as const,
    label: "Make a clip",
  },
  {
    index: "03",
    title: "Story & scenes",
    body: "Shape a premise into a sequence. Keep the cast and visual continuity close as the story grows.",
    href: "/writer",
    icon: "story" as const,
    label: "Start a story",
  },
  {
    index: "04",
    title: "Characters & places",
    body: "Build a small visual library of recurring faces and locations, ready to return in another scene.",
    href: "/character",
    icon: "character" as const,
    label: "Build a world",
  },
];

function LandingNav() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/80 bg-canvas/95 backdrop-blur-md">
      <div className="mx-auto flex h-[68px] w-full max-w-[1380px] items-center gap-5 px-4 sm:px-7 lg:px-10">
        <Link href="/" aria-label="PeraByte home"><Logo size={30} /></Link>
        <span className="hidden h-5 border-l border-border sm:block" />
        <nav aria-label="Explore" className="hidden items-center gap-1 md:flex">
          {[
            ["#workspaces", "The studio"],
            ["#approach", "How it works"],
          ].map(([href, label]) => (
            <a key={href} href={href} className="rounded-[8px] px-3 py-2 text-[12px] font-semibold text-ink-soft transition-colors hover:bg-surface hover:text-ink">{label}</a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <Link href="/generate/image" className="inline-flex h-10 items-center gap-2 rounded-[7px] bg-primary-strong px-4 text-[12px] font-bold text-white transition-colors hover:bg-primary-dark">
            Open the studio <Icon name="arrow-right" size={15} />
          </Link>
        </div>
      </div>
    </header>
  );
}

export default function HomePage() {
  return (
    <div className="flex w-full flex-col">
      <LandingNav />

      <main className="mx-auto w-full max-w-[1380px] px-4 sm:px-7 lg:px-10">
        <section className="grid items-center gap-9 border-b border-border py-10 sm:py-14 lg:min-h-[620px] lg:grid-cols-[0.92fr_1.08fr] lg:gap-12 lg:py-16">
          <div className="relative z-10 animate-[fade-up_0.4s_ease-out_both]">
            <p className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-primary">
              <span className="inline-block h-px w-7 bg-accent" />
              An image-making workspace
            </p>
            <h1 className="editorial-display mt-5 max-w-[660px] text-[43px] leading-[0.99] text-ink sm:text-[58px] lg:text-[70px]">
              Give your ideas a world to live in.
            </h1>
            <p className="mt-5 max-w-[470px] text-[14px] leading-[1.8] text-muted sm:text-[15px]">
              Make an image, follow a scene into motion, or grow a story across connected frames. Keep your creative tools and visual references in one calm, focused studio.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <Link href="/generate/image" className="inline-flex h-12 items-center gap-2 rounded-[7px] bg-primary-strong px-5 text-[13px] font-bold text-white shadow-card transition-colors hover:bg-primary-dark">
                Create your first image <Icon name="arrow-right" size={16} />
              </Link>
              <Link href="/story" className="inline-flex h-12 items-center gap-2 rounded-[7px] border border-border-strong bg-transparent px-4 text-[12px] font-semibold text-ink-soft transition-colors hover:bg-surface hover:text-ink">
                Explore scene studio <Icon name="chevron-down" size={14} className="-rotate-90" />
              </Link>
            </div>
            <div className="mt-10 flex max-w-[500px] items-center gap-4 border-t border-border pt-4">
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary-soft text-primary"><Icon name="layers" size={17} /></span>
              <p className="text-[11.5px] leading-relaxed text-muted">Keep the cast, the places, and the visual thread together as you create.</p>
              <span className="ml-auto hidden text-[10px] font-bold uppercase tracking-[0.18em] text-muted sm:inline">01 — 04</span>
            </div>
          </div>

          <div className="relative mx-auto w-full max-w-[720px] animate-[fade-up_0.55s_ease-out_both] lg:pl-4">
            <div className="absolute -right-1 top-[-22px] hidden h-24 w-24 border-r border-t border-accent/60 sm:block" aria-hidden="true" />
            <div className="relative overflow-hidden border border-border bg-surface p-2 shadow-lift sm:p-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={HERO_MAIN} alt="A mountain lake at sunrise, an example PeraByte render" className="aspect-[1.28] w-full object-cover" />
              <div className="absolute bottom-5 left-5 flex items-center gap-2 border border-white/20 bg-black/55 px-3 py-2 text-white backdrop-blur-sm sm:bottom-7 sm:left-7">
                <span className="size-1.5 rounded-full bg-accent" />
                <span className="text-[10px] font-semibold uppercase tracking-[0.16em]">Image / 16:9</span>
              </div>
              <span className="absolute right-5 top-5 bg-canvas px-2.5 py-1.5 text-[9px] font-bold uppercase tracking-[0.15em] text-ink sm:right-6 sm:top-6">Scene 01</span>
            </div>
            <div className="absolute -bottom-6 right-0 flex w-[42%] gap-2 sm:-right-3 sm:bottom-[-34px] sm:w-[45%] sm:gap-3">
              {HERO_SIDE.map((item, index) => (
                <div key={item.src} className={`relative w-1/2 border border-border bg-canvas p-1.5 shadow-lift sm:p-2 ${index === 1 ? "translate-y-[-16px]" : ""}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={item.src} alt={item.alt} className="aspect-square w-full object-cover" />
                </div>
              ))}
            </div>
            <span className="absolute -left-3 bottom-12 hidden -rotate-90 text-[9px] font-bold uppercase tracking-[0.25em] text-muted lg:block">A study in atmosphere</span>
          </div>
        </section>

        <section id="workspaces" className="scroll-mt-20 py-14 sm:py-20">
          <div className="grid gap-5 sm:grid-cols-[0.8fr_1.2fr] sm:items-end">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-accent">One desk, four ways in</p>
              <h2 className="editorial-display mt-3 max-w-lg text-[35px] leading-[1.05] text-ink sm:text-[44px]">Start small. Let the idea grow.</h2>
            </div>
            <p className="max-w-lg pb-1 text-[13px] leading-[1.8] text-muted sm:justify-self-end">Move between single images, moving frames, story drafts, and the reusable pieces that make a world feel familiar.</p>
          </div>

          <div className="mt-8 grid border-y border-border sm:grid-cols-2 lg:grid-cols-4">
            {WORKSPACES.map((item, index) => (
              <Link key={item.index} href={item.href} className={`group flex min-h-[226px] flex-col border-border px-4 py-5 transition-colors hover:bg-surface sm:px-5 ${index > 0 ? "border-t sm:border-l" : ""} ${index > 1 ? "lg:border-t-0" : ""}`}>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold tracking-[0.16em] text-muted">{item.index}</span>
                  <Icon name={item.icon} size={18} className="text-primary transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                </div>
                <h3 className="editorial-display mt-6 text-[25px] leading-tight text-ink">{item.title}</h3>
                <p className="mt-2 text-[12px] leading-[1.7] text-muted">{item.body}</p>
                <span className="mt-auto inline-flex items-center gap-1.5 pt-5 text-[10px] font-bold uppercase tracking-[0.12em] text-primary">
                  {item.label}<Icon name="arrow-right" size={13} className="transition-transform group-hover:translate-x-1" />
                </span>
              </Link>
            ))}
          </div>
        </section>

        <section id="approach" className="scroll-mt-20 border-t border-border py-14 sm:py-20">
          <div className="grid gap-8 lg:grid-cols-[0.75fr_1.25fr]">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-accent">A simple working rhythm</p>
              <h2 className="editorial-display mt-3 max-w-sm text-[35px] leading-[1.05] text-ink sm:text-[42px]">From first thought to final frame.</h2>
            </div>
            <div className="grid gap-0 sm:grid-cols-3">
              {[
                ["01", "Put the idea down", "Write a prompt or begin with a story premise."],
                ["02", "Shape the image", "Choose a model, tune the frame, and compare results."],
                ["03", "Carry it forward", "Reuse a reference or cast member in your next scene."],
              ].map(([number, title, body]) => (
                <article key={number} className="border-t border-border py-4 sm:border-l sm:pl-4 sm:pr-3 first:sm:border-l-0 first:sm:pl-0">
                  <span className="text-[10px] font-bold tracking-[0.16em] text-accent">{number}</span>
                  <h3 className="mt-4 text-[13px] font-bold text-ink">{title}</h3>
                  <p className="mt-1.5 max-w-[230px] text-[11.5px] leading-[1.7] text-muted">{body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="pb-12 sm:pb-16">
          <div className="relative flex flex-col gap-6 overflow-hidden bg-[#203b30] px-6 py-8 text-[#f5f2e9] sm:flex-row sm:items-center sm:justify-between sm:px-9 sm:py-10">
            <div aria-hidden="true" className="pointer-events-none absolute -right-8 -top-20 size-64 rounded-full border border-white/10" />
            <div aria-hidden="true" className="pointer-events-none absolute -right-1 top-[-54px] size-48 rounded-full border border-white/10" />
            <div className="relative">
              <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-[#c5d1a0]">Make room for the next idea</p>
              <h2 className="editorial-display mt-2 text-[30px] leading-tight sm:text-[36px]">Your studio is ready.</h2>
              <p className="mt-2 max-w-md text-[12px] leading-relaxed text-white/70">Open a blank canvas, bring a reference, and see where the scene takes you.</p>
            </div>
            <Link href="/generate/image" className="relative inline-flex h-11 shrink-0 items-center justify-center gap-2 bg-[#f4f1e9] px-5 text-[11px] font-bold text-[#203b30] transition-colors hover:bg-white">
              Enter PeraByte <Icon name="arrow-right" size={14} />
            </Link>
          </div>
        </section>
      </main>
    </div>
  );
}
