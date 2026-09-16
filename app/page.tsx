import Link from "next/link";
import { Icon } from "@/components/Icon";

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
    body: "Generate a single image or video from one prompt — pick a model, aspect ratio, style and resolution with live controls.",
    href: "/generate/image",
    cta: "Open Solo Mode",
  },
  {
    icon: "story" as const,
    title: "Story Mode",
    body: "Build a continuing story scene by scene. Each render chains from the last frame, with a shared queue and one-click video conversion.",
    href: "/story",
    cta: "Open Story Mode",
  },
  {
    icon: "character" as const,
    title: "Character Studio",
    body: "Design a reusable AI character in a guided wizard, then attach them to Solo and Story scenes for a consistent look.",
    href: "/character",
    cta: "Open Character Studio",
  },
];

export default function HomePage() {
  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 pb-14 pt-4 sm:px-6 sm:pt-5">
      {/* Hero fills the first viewport; the feature grid peeks below. */}
      <section className="grid items-center gap-10 py-10 lg:min-h-[calc(100dvh-9rem)] lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-14 lg:py-0">
        <div className="animate-[fade-up_0.4s_ease-out_both]">
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-primary">
            AI image &amp; video generation studio
          </p>
          <h1 className="mt-3 text-[32px] font-extrabold leading-[1.06] tracking-[-0.03em] text-ink sm:text-[44px] lg:text-[48px]">
            Turn your ideas into{" "}
            <span className="text-primary">stunning images</span> and videos
          </h1>
          <p className="mt-4 max-w-xl text-[14.5px] leading-relaxed text-muted sm:text-[15px]">
            An easy-to-use image and video generation studio for everyone.
            Create, explore, and bring your imagination to life — in seconds.
          </p>

          <div className="mt-7 flex flex-wrap items-center gap-3">
            <Link
              href="/generate/image"
              className="inline-flex h-12 items-center gap-2 rounded-[14px] bg-primary px-6 text-[14.5px] font-bold text-white shadow-[0_1px_2px_rgba(37,99,235,0.35)] transition-all hover:bg-primary-dark hover:shadow-lift"
            >
              Get Started
              <Icon name="arrow-right" size={16} />
            </Link>
            <a
              href="#features"
              className="inline-flex h-12 items-center rounded-[14px] border border-border-strong bg-raised px-5 text-[13.5px] font-bold text-ink-soft transition-colors hover:border-primary/40 hover:text-ink"
            >
              Explore features
            </a>
          </div>
        </div>

        {/* Hero preview cluster: main render with two smaller previews in a
            side column — laid out in a flex row so nothing overlaps. */}
        <div className="animate-[fade-up_0.5s_ease-out_both]">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
            <div className="relative min-w-0 flex-1 overflow-hidden rounded-[24px] border border-border bg-surface shadow-lift">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={HERO_MAIN}
                alt="Example render: a mountain lake at sunrise"
                className="aspect-[16/10] w-full object-cover"
              />
              <span className="absolute bottom-3 left-3 rounded-full bg-black/55 px-2.5 py-1 text-[11px] font-semibold text-white backdrop-blur-sm">
                Text-to-image &amp; video
              </span>
              <span className="absolute left-1/2 top-1/2 inline-flex size-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white/85 text-ink shadow-lift backdrop-blur">
                <Icon name="play" size={22} />
              </span>
            </div>
            <div className="flex w-full flex-row gap-3 sm:w-[112px] sm:shrink-0 sm:flex-col lg:w-[124px]">
              {HERO_SIDE.map(({ src, alt }) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={src}
                  src={src}
                  alt={alt}
                  className="aspect-square w-full min-w-0 rounded-[14px] border border-border object-cover shadow-card"
                />
              ))}
            </div>
          </div>
        </div>
      </section>

      <section id="features" className="scroll-mt-6">
        <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-primary">
          Features
        </p>
        <h2 className="mt-1.5 text-[24px] font-extrabold tracking-[-0.02em] text-ink sm:text-[28px]">
          Three ways to create
        </h2>

        <div className="mt-6 grid gap-4 md:grid-cols-3">
          {FEATURES.map((feature) => (
            <Link
              key={feature.title}
              href={feature.href}
              className="group flex flex-col rounded-[20px] border border-border bg-raised p-5 shadow-card transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-lift"
            >
              <span className="inline-flex size-11 items-center justify-center rounded-[12px] bg-primary-soft text-primary">
                <Icon name={feature.icon} size={20} />
              </span>
              <span className="mt-4 block text-[15px] font-bold text-ink">
                {feature.title}
              </span>
              <span className="mt-1.5 block text-[13px] leading-relaxed text-muted">
                {feature.body}
              </span>
              <span className="mt-auto inline-flex items-center gap-1.5 pt-5 text-[12.5px] font-bold text-primary">
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
    </div>
  );
}
