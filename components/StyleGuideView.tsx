"use client";

import { Icon, type IconName } from "@/components/Icon";
import {
  Badge,
  Button,
  Card,
  Segmented,
  SelectField,
  Toggle,
} from "@/components/ui";

const COLORS = [
  { name: "Primary", value: "#2563EB" },
  { name: "Text", value: "#0F172A" },
  { name: "Muted", value: "#64748B" },
  { name: "Background", value: "#F8FAFC" },
];

const ICONS: IconName[] = [
  "image",
  "video",
  "play",
  "pause",
  "sparkle",
  "download",
  "share",
  "heart",
  "grid",
  "story",
  "clock",
  "lock",
  "user",
  "search",
  "check",
  "more",
];

export function StyleGuideView() {
  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 pb-12 pt-8 sm:px-6">
      <h1 className="text-[28px] font-extrabold tracking-[-0.03em] text-ink sm:text-[34px]">
        UI Elements &amp; Style Guide
      </h1>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        Every value below comes from{" "}
        <code className="rounded bg-surface-2 px-1.5 py-0.5 text-[12.5px]">
          DESIGN.md
        </code>{" "}
        and is implemented as a Tailwind v4 theme token, so the whole studio can
        be re-skinned from one file.
      </p>

      <div className="mt-8 grid gap-5 lg:grid-cols-3">
        <Card>
          <h2 className="text-[15px] font-bold text-ink">Colors</h2>
          <ul className="mt-4 space-y-3">
            {COLORS.map((color) => (
              <li key={color.name} className="flex items-center gap-3">
                <span
                  className="inline-block size-9 shrink-0 rounded-full border border-border"
                  style={{ background: color.value }}
                />
                <span>
                  <span className="block text-[13.5px] font-semibold text-ink">
                    {color.name}
                  </span>
                  <span className="block text-[12.5px] tabular-nums text-muted">
                    {color.value}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <h2 className="text-[15px] font-bold text-ink">Typography</h2>
          <div className="mt-4 space-y-3">
            <div className="flex items-baseline justify-between text-[12px] text-muted">
              <span>Heading</span>
              <span className="tabular-nums">H1 · weight 700</span>
            </div>
            <p className="text-[30px] font-extrabold leading-none tracking-[-0.03em]">
              Aa
            </p>
            <div className="flex items-baseline justify-between text-[12px] text-muted">
              <span>Body</span>
              <span className="tabular-nums">Body · weight 400</span>
            </div>
            <p className="text-[17px]">Aa</p>
            <div className="flex items-baseline justify-between text-[12px] text-muted">
              <span>Small</span>
              <span className="tabular-nums">Small · weight 400</span>
            </div>
            <p className="text-[13px]">Aa</p>
          </div>
        </Card>

        <Card>
          <h2 className="text-[15px] font-bold text-ink">Buttons</h2>
          <div className="mt-4 flex flex-col items-start gap-3">
            <Button>Primary Button</Button>
            <Button variant="secondary">Secondary Button</Button>
            <Button variant="text" iconRight="arrow-right">
              Text Button
            </Button>
          </div>
        </Card>

        <Card>
          <h2 className="text-[15px] font-bold text-ink">Input &amp; Controls</h2>
          <div className="mt-4 space-y-4">
            <SelectField label="Dropdown" defaultValue="16:9">
              <option value="16:9">16:9 — Landscape</option>
              <option value="9:16">9:16 — Portrait</option>
            </SelectField>
            <div className="space-y-2">
              <span className="text-[13px] font-semibold text-ink-soft">
                Text area
              </span>
              <div className="rounded-[12px] border border-border-strong bg-white px-3.5 py-3">
                <p className="text-[13px] text-muted">
                  Describe what you want to create
                </p>
                <p className="mt-6 text-right text-[12px] tabular-nums text-muted">
                  0/1000
                </p>
              </div>
            </div>
            <Toggle
              label="Toggle"
              description="Prompt enhancement"
              checked
              onChange={() => {}}
            />
            <Segmented
              ariaLabel="Example segmented control"
              value="image"
              onChange={() => {}}
              options={[
                { value: "image", label: "Image", icon: "image" },
                { value: "video", label: "Video", icon: "video" },
              ]}
            />
          </div>
        </Card>

        <Card>
          <h2 className="text-[15px] font-bold text-ink">Cards &amp; Containers</h2>
          <div className="mt-4 rounded-[16px] border border-border bg-surface p-5">
            <span className="inline-flex size-10 items-center justify-center rounded-[12px] bg-white text-primary shadow-card">
              <Icon name="sparkle" size={19} />
            </span>
            <h3 className="mt-4 text-[14.5px] font-bold text-ink">Card Title</h3>
            <p className="mt-1 text-[13px] text-muted">
              Short description goes here
            </p>
            <p className="mt-4 text-[13px] font-semibold text-primary">
              Action →
            </p>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Badge tone="primary">Primary</Badge>
            <Badge tone="success">Success</Badge>
            <Badge tone="warning">Warning</Badge>
            <Badge tone="danger">Danger</Badge>
          </div>
        </Card>

        <Card>
          <h2 className="text-[15px] font-bold text-ink">Icons</h2>
          <div className="mt-4 grid grid-cols-6 gap-3 text-ink-soft">
            {ICONS.map((name) => (
              <span
                key={name}
                className="inline-flex size-9 items-center justify-center rounded-[10px] border border-border bg-surface"
              >
                <Icon name={name} size={17} />
              </span>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}