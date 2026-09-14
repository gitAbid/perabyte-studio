import Link from "next/link";
import { Icon } from "@/components/Icon";
import { LinkButton } from "@/components/ui";

/** Pre-rendered examples live in /public/demo so the landing page is instant. */
const HERO_MAIN = "/demo/mountain-lake.jpg";
const HERO_SIDE = ["/demo/fantasy-forest.jpg", "/demo/city-night.jpg"];

const MODES = [
  {
    icon: "user" as const,
    title: "Solo Mode",
    body: "Generate a single image or video from a scene.",
    cta: "Start Solo Mode",
    href: "/generate/image",
    variant: "primary" as const,
  },
  {
    icon: "story" as const,
    title: "Story Mode",
    body: "Generate a continuing story with multiple scenes.",
    cta: "Start Story Mode",
    href: "/story",
    variant: "secondary" as const,
  },
  {
    icon: "character" as const,
    title: "Character Studio",
    body: "Design a reusable AI character in a guided wizard.",
    cta: "Create a Character",
    href: "/character",
    variant: "secondary" as const,
  },
];

export default function HomePage() {
  return (
    // The landing page is designed to fit the viewport on desktop: the hero
    // centres in the space left over after the compact "Start creating" row,
    // and the page simply scrolls on short or mobile screens.
    <div className="mx-auto flex w-full max-w-[1280px] flex-1 flex-col px-4 pb-6 pt-4 sm:px-6 sm:pt-5 lg:min-h-[calc(100dvh-19rem)]">
      <section className="grid flex-1 items-center gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-12">
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

          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            {MODES.map((mode) => (
              <Link
                key={mode.title}
                href={mode.href}
                className="group flex items-start gap-3 rounded-[16px] border border-border bg-white p-3.5 transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-card"
              >
                <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-primary-soft text-primary">
                  <Icon name={mode.icon} size={17} />
                </span>
                <span>
                  <span className="block text-[13.5px] font-bold text-ink">
                    {mode.title}
                  </span>
                  <span className="mt-0.5 block text-[12.5px] leading-snug text-muted">
                    {mode.body}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </div>

        {/* Hero preview cluster */}
        <div className="relative animate-[fade-up_0.5s_ease-out_both]">
          <div className="relative overflow-hidden rounded-[24px] border border-border bg-surface shadow-lift">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={HERO_MAIN}
              alt="Example render: a mountain lake at sunrise"
              className="aspect-[16/9] w-full object-cover"
            />
            <span className="absolute left-1/2 top-1/2 inline-flex size-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white/85 text-ink shadow-lift backdrop-blur">
              <Icon name="play" size={22} />
            </span>
          </div>
          <div className="absolute -right-3 top-1/3 hidden w-[104px] flex-col gap-3 lg:flex">
            {HERO_SIDE.map((src, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={src}
                src={src}
                alt={`Example render ${i + 2}`}
                className="aspect-square w-full rounded-[14px] border border-border object-cover shadow-card"
              />
            ))}
          </div>
        </div>
      </section>

      <section className="mt-8 sm:mt-10">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="text-[20px] font-extrabold tracking-[-0.02em] text-ink sm:text-[22px]">
              Start creating
            </h2>
            <p className="mt-1 text-[13px] text-muted sm:text-sm">
              Choose a mode and begin your creative journey.
            </p>
          </div>
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {MODES.map((mode) => (
            <article
              key={mode.title}
              className="flex flex-col gap-4 rounded-[20px] border border-border bg-white p-4 shadow-card transition-shadow hover:shadow-lift sm:flex-row sm:items-center sm:gap-5 sm:p-5"
            >
              <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-[13px] bg-primary-soft text-primary">
                <Icon name={mode.icon} size={20} />
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="text-[15px] font-bold text-ink sm:text-[16px]">
                  {mode.title}
                </h3>
                <p className="mt-0.5 text-[12.5px] leading-snug text-muted sm:text-[13px]">
                  {mode.body}
                </p>
              </div>
              <LinkButton
                href={mode.href}
                variant={mode.variant}
                size="sm"
                className="shrink-0 max-md:w-full"
                iconRight="arrow-right"
              >
                {mode.cta}
              </LinkButton>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
