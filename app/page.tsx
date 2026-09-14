import Link from "next/link";
import { Icon } from "@/components/Icon";
import { LinkButton } from "@/components/ui";
import { buildMediaUrl } from "@/lib/renderer";

const HERO_MAIN = buildMediaUrl(
  {
    kind: "image",
    prompt:
      "A serene mountain landscape with a lake, sunrise, and pine trees",
    aspect: "16:9",
    resolution: "1080p",
    style: "Realistic",
    enhance: true,
  },
  4821,
);

const HERO_SIDE = [
  buildMediaUrl(
    {
      kind: "image",
      prompt: "A glowing fantasy forest with floating lights",
      aspect: "1:1",
      resolution: "720p",
      style: "Digital Art",
      enhance: true,
    },
    3390,
  ),
  buildMediaUrl(
    {
      kind: "image",
      prompt: "A neon city street at night in the rain",
      aspect: "1:1",
      resolution: "720p",
      style: "Cinematic",
      enhance: true,
    },
    7712,
  ),
];

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
];

export default function HomePage() {
  return (
    <div className="mx-auto w-full max-w-[1240px] px-4 pb-10 pt-10 sm:px-6 sm:pt-14">
      <section className="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-14">
        <div className="animate-[fade-up_0.4s_ease-out_both]">
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-primary">
            AI image &amp; video generation studio
          </p>
          <h1 className="mt-4 text-[38px] font-extrabold leading-[1.05] tracking-[-0.03em] text-ink sm:text-[52px]">
            Turn your ideas into{" "}
            <span className="text-primary">stunning images</span> and videos
          </h1>
          <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-muted">
            An easy-to-use image and video generation studio for everyone.
            Create, explore, and bring your imagination to life — in seconds.
          </p>

          <div className="mt-7 grid gap-3 sm:grid-cols-2">
            {MODES.map((mode) => (
              <Link
                key={mode.title}
                href={mode.href}
                className="group flex items-start gap-3 rounded-[16px] border border-border bg-white p-4 transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-card"
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
              className="aspect-[16/10] w-full object-cover"
            />
            <span className="absolute left-1/2 top-1/2 inline-flex size-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white/85 text-ink shadow-lift backdrop-blur">
              <Icon name="play" size={22} />
            </span>
          </div>
          <div className="absolute -right-3 top-1/3 hidden w-[104px] flex-col gap-3 sm:flex">
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

      <section className="mt-16 sm:mt-20">
        <h2 className="text-[22px] font-extrabold tracking-[-0.02em] text-ink">
          Start creating
        </h2>
        <p className="mt-1.5 text-sm text-muted">
          Choose a mode and begin your creative journey.
        </p>

        <div className="mt-6 grid gap-5 md:grid-cols-2">
          {MODES.map((mode) => (
            <article
              key={mode.title}
              className="flex flex-col rounded-[20px] border border-border bg-white p-7 shadow-card transition-shadow hover:shadow-lift"
            >
              <span className="inline-flex size-12 items-center justify-center rounded-[14px] bg-primary-soft text-primary">
                <Icon name={mode.icon} size={22} />
              </span>
              <h3 className="mt-5 text-[17px] font-bold text-ink">{mode.title}</h3>
              <p className="mt-2 flex-1 text-sm leading-relaxed text-muted">
                {mode.body}
              </p>
              <div className="mt-6">
                <LinkButton
                  href={mode.href}
                  variant={mode.variant}
                  block
                  iconRight="arrow-right"
                >
                  {mode.cta}
                </LinkButton>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}