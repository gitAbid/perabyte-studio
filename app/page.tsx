import Link from "next/link";
import { Icon } from "@/components/Icon";
import { ThemeToggle } from "@/components/SiteChrome";

/** Pre-rendered examples live in /public/demo so the landing page is instant. */
const HERO_MAIN = "/demo/mountain-lake.jpg";
const HERO_SIDE = [
  { src: "/demo/fantasy-forest.jpg", alt: "Example render: an enchanted forest" },
  { src: "/demo/city-night.jpg", alt: "Example render: a city street at night" },
];

const FEATURES = [
  {
    icon: "sparkle" as const,
    title: "Solo Mode",
    body: "One prompt, one render. Pick a model, aspect ratio, style and resolution with live controls — then re-roll variations until it clicks.",
    href: "/generate/image",
    cta: "Open Solo Mode",
  },
  {
    icon: "story" as const,
    title: "Story Mode",
    body: "Build a story scene by scene: every render chains from the last frame, with a shared queue and one-click video conversion.",
    href: "/story",
    cta: "Open Story Mode",
  },
  {
    icon: "character" as const,
    title: "Character Studio",
    body: "Design a reusable AI character in a guided wizard — face, hair, outfit — then attach them to any Solo or Story scene.",
    href: "/character",
    cta: "Open Character Studio",
  },
  {
    icon: "history" as const,
    title: "Library",
    body: "Every render is saved automatically. Browse, favourite, re-open and reuse past work across modes.",
    href: "/history",
    cta: "Browse the library",
  },
];

const STEPS = [
  {
    title: "Describe the shot",
    body: "Write a prompt — or let Enhance expand it — then pick a style, ratio and model that fit the idea.",
  },
  {
    title: "Generate & refine",
    body: "Renders finish in seconds. Favourite the best take, re-roll variations, or tweak the prompt and try again.",
  },
  {
    title: "Chain into a story",
    body: "Keep going scene by scene — each frame continues from the last. Convert the whole story to video in one click.",
  },
];

/** Slim landing-only top bar; sticky, glassy, and out of the content's way. */
function LandingNav() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-canvas/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-[1200px] items-center gap-3 px-4 sm:px-6">
        <Link
          href="/"
          aria-label="PeraByte home"
          className="text-[15px] font-extrabold tracking-tight text-ink"
        >
          Pera<span className="text-primary">Byte</span>
        </Link>
        <nav
          aria-label="Landing"
          className="ml-5 hidden items-center gap-1 md:flex"
        >
          {[
            { href: "#features", label: "Features" },
            { href: "#how", label: "How it works" },
          ].map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="rounded-[8px] px-2.5 py-1.5 text-[13px] font-semibold text-muted transition-colors hover:bg-surface-2 hover:text-ink"
            >
              {item.label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <Link
            href="/generate/image"
            className="inline-flex h-9 items-center gap-1.5 rounded-[10px] bg-primary-strong px-3.5 text-[13px] font-bold text-white transition-colors hover:bg-primary-dark"
          >
            Get Started
            <Icon name="arrow-right" size={14} />
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

      <main className="mx-auto w-full max-w-[1200px] px-4 sm:px-6">
        {/* Hero — compact and above the fold; no full-viewport reservation. */}
        <section className="grid items-center gap-10 py-12 sm:py-16 lg:grid-cols-[minmax(0,1.02fr)_minmax(0,1fr)] lg:gap-14 lg:py-20">
          <div className="animate-[fade-up_0.4s_ease-out_both]">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary-soft px-3 py-1 text-[12px] font-bold text-primary">
              <Icon name="sparkle" size={12} />
              Story Mode now chains scenes into video
            </span>
            <h1 className="mt-4 text-[34px] font-extrabold leading-[1.05] tracking-[-0.035em] text-ink sm:text-[44px] lg:text-[52px]">
              Create stunning images and{" "}
              <span className="bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
                videos
              </span>{" "}
              from a single prompt
            </h1>
            <p className="mt-4 max-w-lg text-[15px] leading-relaxed text-muted">
              PeraByte Studio is an easy-to-use generation studio: describe an
              idea, tune the settings, and watch it render — then keep the
              story going.
            </p>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Link
                href="/generate/image"
                className="inline-flex h-12 items-center gap-2 rounded-[14px] bg-primary-strong px-6 text-[14.5px] font-bold text-white shadow-[0_1px_2px_rgba(37,99,235,0.35)] transition-all hover:bg-primary-dark hover:shadow-lift"
              >
                Start creating
                <Icon name="arrow-right" size={16} />
              </Link>
              <a
                href="#how"
                className="inline-flex h-12 items-center rounded-[14px] border border-border-strong bg-raised px-5 text-[13.5px] font-bold text-ink-soft transition-colors hover:border-primary/40 hover:text-ink"
              >
                See how it works
              </a>
            </div>

            <ul className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[12.5px] font-medium text-muted">
              {[
                "Free to start",
                "Brings your own API keys",
                "Images & video",
              ].map((item) => (
                <li key={item} className="flex items-center gap-1.5">
                  <Icon name="check" size={13} className="text-success" />
                  {item}
                </li>
              ))}
            </ul>
          </div>

          {/* Hero visual: soft glow, main render with product chips, two
              supporting previews. Literal-black chips stay readable on media
              in both themes. */}
          <div className="relative animate-[fade-up_0.5s_ease-out_both]">
            <div
              aria-hidden
              className="absolute -inset-8 -z-10 rounded-[40px] bg-[radial-gradient(60%_60%_at_60%_35%,color-mix(in_srgb,var(--color-primary)_22%,transparent),transparent_70%),radial-gradient(45%_45%_at_25%_80%,color-mix(in_srgb,var(--color-accent)_18%,transparent),transparent_70%)] blur-2xl"
            />
            <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch sm:gap-4">
              <div className="relative min-w-0 flex-1 overflow-hidden rounded-[24px] border border-border bg-surface shadow-lift">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={HERO_MAIN}
                  alt="Example render: a mountain lake at sunrise"
                  className="aspect-[16/11] w-full object-cover"
                />
                <span className="absolute bottom-3 left-3 rounded-full border border-white/20 bg-black/55 px-2.5 py-1 text-[11px] font-semibold text-white backdrop-blur-sm">
                  Text-to-image &amp; video
                </span>
                <span className="absolute right-3 top-3 inline-flex items-center gap-1.5 rounded-[10px] border border-border bg-raised/90 px-2.5 py-1.5 text-[11px] font-bold text-ink shadow-card backdrop-blur">
                  <Icon name="sparkle" size={12} className="text-primary" />
                  16:9 · 1080p
                </span>
              </div>
              <div className="flex w-full flex-row gap-3 sm:w-[104px] sm:shrink-0 sm:flex-col lg:w-[118px]">
                {HERO_SIDE.map(({ src, alt }) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={src}
                    src={src}
                    alt={alt}
                    className="aspect-square w-full min-w-0 flex-1 rounded-[16px] border border-border object-cover shadow-card"
                  />
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Features — 2×2 bento on desktop; tight and scannable. */}
        <section id="features" className="scroll-mt-20 pb-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-primary">
                Features
              </p>
              <h2 className="mt-1.5 text-[26px] font-extrabold tracking-[-0.02em] text-ink sm:text-[30px]">
                Four ways to create
              </h2>
            </div>
            <p className="max-w-xs text-[12.5px] leading-relaxed text-muted">
              Everything runs on the providers you configure — swap models and
              keys any time in Settings.
            </p>
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {FEATURES.map((feature) => (
              <Link
                key={feature.title}
                href={feature.href}
                className="group flex flex-col rounded-[20px] border border-border bg-raised p-5 shadow-card transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-lift"
              >
                <div className="flex items-center gap-3">
                  <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-[12px] bg-primary-soft text-primary">
                    <Icon name={feature.icon} size={18} />
                  </span>
                  <span className="text-[15px] font-bold text-ink">
                    {feature.title}
                  </span>
                </div>
                <span className="mt-3 block text-[13px] leading-relaxed text-muted">
                  {feature.body}
                </span>
                <span className="mt-auto inline-flex items-center gap-1.5 pt-4 text-[12.5px] font-bold text-primary">
                  {feature.cta}
                  <Icon
                    name="arrow-right"
                    size={14}
                    className="transition-transform group-hover:translate-x-0.5"
                  />
                </span>
              </Link>
            ))}
          </div>
        </section>

        {/* How it works — three numbered steps, one quiet row. */}
        <section id="how" className="scroll-mt-20 py-12 sm:py-14">
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-primary">
            How it works
          </p>
          <h2 className="mt-1.5 text-[26px] font-extrabold tracking-[-0.02em] text-ink sm:text-[30px]">
            From prompt to story in three steps
          </h2>

          <div className="mt-6 grid gap-4 md:grid-cols-3">
            {STEPS.map((step, index) => (
              <div
                key={step.title}
                className="rounded-[20px] border border-border bg-surface p-5"
              >
                <span
                  aria-hidden
                  className="text-[26px] font-extrabold leading-none text-primary/35"
                >
                  {String(index + 1).padStart(2, "0")}
                </span>
                <p className="mt-3 text-[14.5px] font-bold text-ink">
                  {step.title}
                </p>
                <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
                  {step.body}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* Final CTA band — one gradient panel, one action. */}
        <section className="pb-14">
          <div className="relative overflow-hidden rounded-[28px] bg-[linear-gradient(130deg,var(--color-primary),var(--color-accent))] px-6 py-10 text-center shadow-lift sm:px-10 sm:py-12">
            <div
              aria-hidden
              className="pointer-events-none absolute -left-16 -top-24 size-64 rounded-full bg-white/10"
            />
            <div
              aria-hidden
              className="pointer-events-none absolute -bottom-28 -right-10 size-72 rounded-full bg-white/10"
            />
            <h2 className="relative text-[24px] font-extrabold tracking-[-0.02em] text-white sm:text-[28px]">
              Start creating in seconds
            </h2>
            <p className="relative mx-auto mt-2 max-w-md text-[13.5px] leading-relaxed text-white/85">
              Open the studio, describe an idea, and watch it render — no
              setup required to try your first image.
            </p>
            <div className="relative mt-6 flex justify-center">
              <Link
                href="/generate/image"
                className="inline-flex h-12 items-center gap-2 rounded-[14px] bg-white px-6 text-[14px] font-bold text-primary-strong shadow-lift transition-transform hover:scale-[1.02]"
              >
                Open the studio
                <Icon name="arrow-right" size={16} />
              </Link>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
