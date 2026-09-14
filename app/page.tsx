import Link from "next/link";
import { Icon } from "@/components/Icon";

/** Pre-rendered examples live in /public/demo so the landing page is instant. */
const HERO_MAIN = "/demo/mountain-lake.jpg";
const HERO_SIDE = [
  { src: "/demo/fantasy-forest.jpg", alt: "Example render: an enchanted forest" },
  { src: "/demo/city-night.jpg", alt: "Example render: a city street at night" },
];

const MODES = [
  {
    icon: "user" as const,
    title: "Solo Mode",
    body: "Generate a single image or video from a scene.",
    href: "/generate/image",
  },
  {
    icon: "story" as const,
    title: "Story Mode",
    body: "Generate a continuing story with multiple scenes.",
    href: "/story",
  },
];

export default function HomePage() {
  return (
    // The landing page is designed to fit the viewport on desktop: the hero
    // centres in the space left over after the slim footer, and the page
    // simply scrolls on short or mobile screens.
    <div className="mx-auto flex w-full max-w-[1280px] flex-1 flex-col px-4 pb-8 pt-4 sm:px-6 sm:pt-5 lg:min-h-[calc(100dvh-9rem)]">
      <section className="grid flex-1 items-center gap-10 py-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-14 lg:py-0">
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

          <div className="mt-7 grid gap-3">
            {MODES.map((mode) => (
              <Link
                key={mode.title}
                href={mode.href}
                className="group flex items-center gap-3.5 rounded-[16px] border border-border bg-white p-3.5 transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-card"
              >
                <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-[11px] bg-primary-soft text-primary">
                  <Icon name={mode.icon} size={18} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-bold text-ink">
                    {mode.title}
                  </span>
                  <span className="mt-0.5 block text-[12.5px] leading-snug text-muted">
                    {mode.body}
                  </span>
                </span>
                <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-border text-muted transition-colors group-hover:border-primary/40 group-hover:bg-primary-soft group-hover:text-primary">
                  <Icon name="arrow-right" size={15} />
                </span>
              </Link>
            ))}
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
              <span className="absolute bottom-3 left-3 rounded-full bg-ink/55 px-2.5 py-1 text-[11px] font-semibold text-white backdrop-blur-sm">
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
    </div>
  );
}
