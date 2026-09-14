"use client";

import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { MediaFrame } from "@/components/Media";
import { Button, Segmented, SelectField, TextAreaField, Toggle } from "@/components/ui";
import {
  ASPECTS,
  IMAGE_STYLES,
  PROMPT_MAX,
  RESOLUTIONS,
} from "@/lib/constants";
import {
  ACCESSORIES,
  AGES,
  BODY_TYPES,
  BUILDS,
  EXPRESSIONS,
  EYE_COLORS,
  EYE_SHAPES,
  FACE_SHAPES,
  FACIAL_FEATURES,
  GENDERS,
  HAIR_COLORS,
  HAIR_STYLES,
  HEIGHTS,
  LOOK_PRESETS,
  OUTFITS,
  SKIN_TONES,
  WEIGHTS,
  lookById,
  type CharacterMode,
  type CharacterSpec,
} from "@/lib/character";

export const CHARACTER_STEPS = [
  "Character Details",
  "Appearance",
  "Advanced Settings",
  "Review",
] as const;

/* ------------------------------------------------------------------ */
/* Shared pieces                                                       */
/* ------------------------------------------------------------------ */

export function Stepper({
  current,
  maxVisited,
  onStepClick,
}: {
  current: number;
  maxVisited: number;
  onStepClick: (step: number) => void;
}) {
  return (
    <ol
      aria-label="Character wizard progress"
      className="flex w-full items-center gap-2 sm:gap-3"
    >
      {CHARACTER_STEPS.map((label, index) => {
        const step = index + 1;
        const done = step < current;
        const active = step === current;
        const reachable = step <= maxVisited && !active;
        return (
          <li key={label} className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3 last:flex-none">
            <button
              type="button"
              disabled={!reachable}
              onClick={() => reachable && onStepClick(step)}
              aria-current={active ? "step" : undefined}
              className={`flex min-w-0 items-center gap-2 rounded-full py-1 pr-2 text-left ${
                reachable ? "cursor-pointer" : "cursor-default"
              }`}
            >
              <span
                className={`inline-flex size-7 shrink-0 items-center justify-center rounded-full text-[12px] font-bold transition-colors ${
                  done
                    ? "bg-primary text-white"
                    : active
                      ? "bg-primary text-white ring-4 ring-primary-soft"
                      : "bg-surface-2 text-muted"
                }`}
              >
                {done ? <Icon name="check" size={13} /> : step}
              </span>
              <span
                className={`hidden truncate text-[13px] font-semibold sm:block ${
                  active ? "text-ink" : done ? "text-ink-soft" : "text-muted"
                }`}
              >
                {label}
              </span>
            </button>
            {step < CHARACTER_STEPS.length && (
              <span
                aria-hidden
                className={`h-px flex-1 ${done ? "bg-primary/40" : "bg-border"}`}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function StepHeading({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}) {
  return (
    <div>
      <h2 className="text-[19px] font-extrabold tracking-[-0.02em] text-ink">
        {title}
      </h2>
      <p className="mt-1 text-[13px] text-muted">{subtitle}</p>
    </div>
  );
}

function StepNav({
  onBack,
  onNext,
  nextLabel,
  nextIcon,
  backHidden,
  backLabel = "Back",
}: {
  onBack: () => void;
  onNext: () => void;
  nextLabel: string;
  nextIcon?: IconName;
  backHidden?: boolean;
  backLabel?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
      {backHidden ? (
        <span />
      ) : (
        <Button variant="secondary" icon="arrow-left" onClick={onBack}>
          {backLabel}
        </Button>
      )}
      <Button iconRight={nextIcon} onClick={onNext} className={backHidden ? "ml-auto" : ""}>
        {nextLabel}
      </Button>
    </div>
  );
}

export function ModePicker({
  value,
  onChange,
}: {
  value: CharacterMode;
  onChange: (mode: CharacterMode) => void;
}) {
  const cards: { id: CharacterMode; title: string; body: string; badge?: string }[] = [
    {
      id: "normal",
      title: "Normal",
      body: "Auto-enhanced prompt with standard styling.",
    },
    {
      id: "uncensored",
      title: "Uncensored",
      body: "Your prompt is sent exactly as written. For creative and artistic use only.",
      badge: "NEW",
    },
  ];
  return (
    <fieldset>
      <legend className="text-[13px] font-semibold text-ink-soft">Mode</legend>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        {cards.map((card) => {
          const active = value === card.id;
          return (
            <button
              key={card.id}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(card.id)}
              className={`flex items-start gap-3 rounded-[14px] border p-3.5 text-left transition-all ${
                active
                  ? "border-primary bg-primary-soft/60"
                  : "border-border bg-white hover:border-border-strong"
              }`}
            >
              <span
                className={`mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-[9px] ${
                  active ? "bg-primary text-white" : "bg-surface-2 text-ink-soft"
                }`}
              >
                <Icon name="user" size={15} />
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-2 text-[13.5px] font-bold text-ink">
                  {card.title}
                  {card.badge && (
                    <span className="rounded-full bg-danger-soft px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-danger">
                      {card.badge}
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block text-[12px] leading-snug text-muted">
                  {card.body}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

function ReviewRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="shrink-0 text-[12.5px] text-muted">{label}</span>
      <span className="min-w-0 text-right text-[12.5px] font-semibold text-ink">
        {children}
      </span>
    </div>
  );
}

function ReviewCard({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[16px] border border-border bg-white p-4">
      <h3 className="text-[13.5px] font-bold text-ink">{title}</h3>
      <div className="mt-1.5 divide-y divide-border/70">{children}</div>
    </section>
  );
}

const toneById = (id: string) => SKIN_TONES.find((t) => t.id === id);

/* ------------------------------------------------------------------ */
/* Step 1 — Character Details                                          */
/* ------------------------------------------------------------------ */

export function StepDetails({
  spec,
  patch,
  promptError,
  onBack,
  onNext,
}: {
  spec: CharacterSpec;
  patch: (patch: Partial<CharacterSpec>) => void;
  promptError?: string;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <div className="space-y-5">
      <StepHeading
        title="1. Character Details"
        subtitle="Describe your character or use the options below to build one."
      />

      <TextAreaField
        label="Character Prompt"
        value={spec.prompt}
        maxLength={PROMPT_MAX}
        rows={5}
        error={promptError}
        placeholder="e.g. A beautiful young woman with long black hair, wearing a red dress, standing in a forest."
        onChange={(value) => patch({ prompt: value })}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField
          label="Aspect Ratio"
          value={spec.aspect}
          onChange={(e) => patch({ aspect: e.target.value as CharacterSpec["aspect"] })}
        >
          {Object.entries(ASPECTS).map(([key, preset]) => (
            <option key={key} value={key}>
              {`${key} (${preset.hint})`}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Resolution"
          value={spec.resolution}
          onChange={(e) =>
            patch({ resolution: e.target.value as CharacterSpec["resolution"] })
          }
        >
          {Object.entries(RESOLUTIONS).map(([key, preset]) => (
            <option key={key} value={key}>
              {preset.label}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Style"
          value={spec.style}
          onChange={(e) => patch({ style: e.target.value })}
        >
          {Object.keys(IMAGE_STYLES).map((style) => (
            <option key={style} value={style}>
              {style}
            </option>
          ))}
        </SelectField>
      </div>

      <ModePicker value={spec.mode} onChange={(mode) => patch({ mode })} />

      <StepNav onBack={onBack} onNext={onNext} nextLabel="Next" nextIcon="arrow-right" backHidden />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Step 2 — Appearance                                                 */
/* ------------------------------------------------------------------ */

const APPEARANCE_TABS = ["Face", "Hair", "Eyes", "Clothing", "Accessories"] as const;
type AppearanceTab = (typeof APPEARANCE_TABS)[number];

export function StepAppearance({
  spec,
  patch,
  onBack,
  onNext,
}: {
  spec: CharacterSpec;
  patch: (patch: Partial<CharacterSpec>) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const [tab, setTab] = useState<AppearanceTab>("Face");

  return (
    <div className="space-y-5">
      <StepHeading
        title="2. Appearance"
        subtitle="Fine-tune your character's look and features."
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(240px,300px)]">
        <div className="min-w-0 space-y-5">
          <div>
            <p className="text-[13px] font-semibold text-ink-soft">Gender</p>
            <div className="mt-2">
              <Segmented
                ariaLabel="Gender"
                value={spec.gender}
                onChange={(gender) => patch({ gender })}
                options={GENDERS.map((gender) => ({ value: gender, label: gender }))}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              label="Age"
              value={spec.age}
              onChange={(e) => patch({ age: e.target.value })}
            >
              {AGES.map((age) => (
                <option key={age} value={age}>
                  {age}
                </option>
              ))}
            </SelectField>
            <SelectField
              label="Body Type"
              value={spec.bodyType}
              onChange={(e) => patch({ bodyType: e.target.value })}
            >
              {BODY_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </SelectField>
          </div>

          <div>
            <p className="text-[13px] font-semibold text-ink-soft">Skin Tone</p>
            <div className="mt-2 flex flex-wrap items-center gap-2.5">
              {SKIN_TONES.map((tone) => {
                const active = spec.skinTone === tone.id;
                return (
                  <button
                    key={tone.id}
                    type="button"
                    aria-label={`${tone.prompt} skin tone`}
                    aria-pressed={active}
                    title={tone.prompt}
                    onClick={() => patch({ skinTone: tone.id })}
                    className={`size-8 rounded-full border border-black/10 transition-shadow ${
                      active
                        ? "ring-2 ring-primary ring-offset-2 ring-offset-white"
                        : "hover:ring-2 hover:ring-border-strong hover:ring-offset-2 hover:ring-offset-white"
                    }`}
                    style={{ backgroundColor: tone.hex }}
                  />
                );
              })}
            </div>
          </div>

          <div className="rounded-[14px] border border-border bg-surface p-3.5">
            <div
              role="tablist"
              aria-label="Appearance feature groups"
              className="no-scrollbar flex items-center gap-1 overflow-x-auto"
            >
              {APPEARANCE_TABS.map((item) => {
                const active = item === tab;
                return (
                  <button
                    key={item}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setTab(item)}
                    className={`shrink-0 rounded-[9px] px-3 py-1.5 text-[12.5px] font-semibold transition-colors ${
                      active
                        ? "bg-primary text-white shadow-sm"
                        : "text-ink-soft hover:bg-white"
                    }`}
                  >
                    {item}
                  </button>
                );
              })}
            </div>

            <div className="mt-3.5 grid gap-4 sm:grid-cols-2">
              {tab === "Face" && (
                <>
                  <SelectField
                    label="Face Shape"
                    value={spec.faceShape}
                    onChange={(e) => patch({ faceShape: e.target.value })}
                  >
                    {FACE_SHAPES.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </SelectField>
                  <SelectField
                    label="Facial Features"
                    value={spec.facialFeatures}
                    onChange={(e) => patch({ facialFeatures: e.target.value })}
                  >
                    {FACIAL_FEATURES.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </SelectField>
                  <SelectField
                    label="Expression"
                    value={spec.expression}
                    onChange={(e) => patch({ expression: e.target.value })}
                  >
                    {EXPRESSIONS.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </SelectField>
                </>
              )}
              {tab === "Hair" && (
                <>
                  <SelectField
                    label="Hair Color"
                    value={spec.hairColor}
                    onChange={(e) => patch({ hairColor: e.target.value })}
                  >
                    {HAIR_COLORS.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </SelectField>
                  <SelectField
                    label="Hair Style"
                    value={spec.hairStyle}
                    onChange={(e) => patch({ hairStyle: e.target.value })}
                  >
                    {HAIR_STYLES.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </SelectField>
                </>
              )}
              {tab === "Eyes" && (
                <>
                  <SelectField
                    label="Eye Color"
                    value={spec.eyeColor}
                    onChange={(e) => patch({ eyeColor: e.target.value })}
                  >
                    {EYE_COLORS.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </SelectField>
                  <SelectField
                    label="Eye Shape"
                    value={spec.eyeShape}
                    onChange={(e) => patch({ eyeShape: e.target.value })}
                  >
                    {EYE_SHAPES.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </SelectField>
                </>
              )}
              {tab === "Clothing" && (
                <SelectField
                  label="Outfit Style"
                  value={spec.outfit}
                  onChange={(e) => patch({ outfit: e.target.value })}
                >
                  {OUTFITS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </SelectField>
              )}
              {tab === "Accessories" && (
                <SelectField
                  label="Accessories"
                  value={spec.accessories}
                  onChange={(e) => patch({ accessories: e.target.value })}
                >
                  {ACCESSORIES.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </SelectField>
              )}
            </div>
          </div>
        </div>

        {/* Inspiration looks */}
        <aside className="min-w-0">
          <p className="text-[13px] font-semibold text-ink-soft">Inspiration</p>
          <p className="mt-0.5 text-[12px] text-muted">
            Pick a starting look, or leave it untouched.
          </p>
          <div className="mt-2.5 grid grid-cols-3 gap-2.5">
            {LOOK_PRESETS.map((look) => {
              const active = spec.look === look.id;
              return (
                <button
                  key={look.id}
                  type="button"
                  aria-pressed={active}
                  aria-label={`${look.label} look`}
                  title={look.label}
                  onClick={() => patch({ look: active ? "" : look.id })}
                  className={`group relative overflow-hidden rounded-[12px] border-2 transition-all ${
                    active
                      ? "border-primary shadow-card"
                      : "border-transparent hover:border-border-strong"
                  }`}
                >
                  <MediaFrame
                    src={look.src}
                    alt=""
                    ratio="4/5"
                    rounded="rounded-[10px]"
                    className="w-full"
                  />
                  {active && (
                    <span className="absolute right-1.5 top-1.5 inline-flex size-5 items-center justify-center rounded-full bg-primary text-white shadow-sm">
                      <Icon name="check" size={12} />
                    </span>
                  )}
                  <span className="absolute inset-x-1.5 bottom-1.5 truncate rounded-md bg-ink/60 px-1.5 py-0.5 text-center text-[10px] font-semibold text-white backdrop-blur">
                    {look.label}
                  </span>
                </button>
              );
            })}
          </div>
        </aside>
      </div>

      <StepNav onBack={onBack} onNext={onNext} nextLabel="Next" nextIcon="arrow-right" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Step 3 — Advanced Settings                                          */
/* ------------------------------------------------------------------ */

function Disclosure({
  icon,
  title,
  subtitle,
  open,
  onToggle,
  children,
}: {
  icon: IconName;
  title: string;
  subtitle: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="rounded-[14px] border border-border bg-white">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-3 p-3.5 text-left"
      >
        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-primary-soft text-primary">
          <Icon name={icon} size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-bold text-ink">{title}</span>
          <span className="mt-0.5 block truncate text-[12px] text-muted">
            {subtitle}
          </span>
        </span>
        <Icon
          name="chevron-down"
          size={16}
          className={`shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && <div className="border-t border-border p-3.5">{children}</div>}
    </div>
  );
}

const REFERENCE_MAX_BYTES = 10 * 1024 * 1024;

/** Downscale an uploaded reference photo to a small JPEG data URL. */
function downscaleToDataUrl(file: File, max = 384): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(objectUrl);
      resolve(canvas.toDataURL("image/jpeg", 0.72));
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Could not read that image."));
    };
    img.src = objectUrl;
  });
}

export interface ReferenceImage {
  name: string;
  size: number;
  dataUrl: string;
}

export function StepAdvanced({
  spec,
  patch,
  reference,
  onReferenceChange,
  onBack,
  onNext,
}: {
  spec: CharacterSpec;
  patch: (patch: Partial<CharacterSpec>) => void;
  reference: ReferenceImage | null;
  onReferenceChange: (image: ReferenceImage | null) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const [personalityOpen, setPersonalityOpen] = useState(false);
  const [poseOpen, setPoseOpen] = useState(false);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function acceptFile(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) return;
    if (file.size > REFERENCE_MAX_BYTES) return;
    try {
      const dataUrl = await downscaleToDataUrl(file);
      onReferenceChange({ name: file.name, size: file.size, dataUrl });
    } catch {
      onReferenceChange(null);
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);
    void acceptFile(event.dataTransfer.files?.[0]);
  }

  return (
    <div className="space-y-5">
      <StepHeading
        title="3. Advanced Settings"
        subtitle="Add more details to make your character unique."
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField
          label="Height"
          value={spec.height}
          onChange={(e) => patch({ height: e.target.value })}
        >
          {HEIGHTS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Weight"
          value={spec.weight}
          onChange={(e) => patch({ weight: e.target.value })}
        >
          {WEIGHTS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Build"
          value={spec.build}
          onChange={(e) => patch({ build: e.target.value })}
        >
          {BUILDS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </SelectField>
      </div>

      <div className="grid gap-x-8 gap-y-3 rounded-[14px] border border-border bg-surface p-4 sm:grid-cols-3">
        <Toggle
          label="Tattoos"
          checked={spec.tattoos}
          onChange={(tattoos) => patch({ tattoos })}
        />
        <Toggle
          label="Piercings"
          checked={spec.piercings}
          onChange={(piercings) => patch({ piercings })}
        />
        <Toggle
          label="Facial Hair"
          checked={spec.facialHair}
          onChange={(facialHair) => patch({ facialHair })}
        />
      </div>

      <div className="space-y-3">
        <Disclosure
          icon="user"
          title="Character Personality"
          subtitle="Add personality traits, hobbies, or a backstory."
          open={personalityOpen}
          onToggle={() => setPersonalityOpen((v) => !v)}
        >
          <TextAreaField
            label="Personality (optional)"
            value={spec.personality}
            maxLength={300}
            rows={3}
            placeholder="e.g. friendly and adventurous, loves photography and travel."
            onChange={(personality) => patch({ personality })}
          />
        </Disclosure>

        <Disclosure
          icon="sparkle"
          title="Pose & Outfit"
          subtitle="Describe the pose, outfit, or scene you want."
          open={poseOpen}
          onToggle={() => setPoseOpen((v) => !v)}
        >
          <TextAreaField
            label="Pose & Outfit (optional)"
            value={spec.pose}
            maxLength={300}
            rows={3}
            placeholder="e.g. sitting on a café terrace, relaxed pose, morning light."
            onChange={(pose) => patch({ pose })}
          />
        </Disclosure>

        <Disclosure
          icon="upload"
          title="Reference Image"
          subtitle="Upload a photo to guide the character's appearance."
          open={referenceOpen}
          onToggle={() => setReferenceOpen((v) => !v)}
        >
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg"
            className="hidden"
            onChange={(e) => {
              void acceptFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          {reference ? (
            <div className="flex items-center gap-3 rounded-[12px] border border-border bg-surface p-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={reference.dataUrl}
                alt="Reference preview"
                className="size-16 rounded-[10px] border border-border object-cover"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-semibold text-ink">
                  {reference.name}
                </p>
                <p className="mt-0.5 text-[12px] text-muted">
                  Saved with your character for reference.
                </p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                icon="trash"
                onClick={() => onReferenceChange(null)}
              >
                Remove
              </Button>
            </div>
          ) : (
            <div
              role="button"
              tabIndex={0}
              aria-label="Upload reference image"
              onClick={() => fileInput.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") fileInput.current?.click();
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={handleDrop}
              className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-[12px] border-2 border-dashed px-4 py-8 text-center transition-colors ${
                dragActive
                  ? "border-primary bg-primary-soft/50"
                  : "border-border-strong bg-surface hover:border-muted"
              }`}
            >
              <span className="inline-flex size-10 items-center justify-center rounded-full bg-white text-primary shadow-card">
                <Icon name="upload" size={18} />
              </span>
              <p className="text-[13px] font-semibold text-ink">
                Drag &amp; drop an image or{" "}
                <span className="text-primary">click to upload</span>
              </p>
              <p className="text-[12px] text-muted">
                Supports .PNG, .JPG (Max 10MB)
              </p>
            </div>
          )}
        </Disclosure>
      </div>

      <StepNav onBack={onBack} onNext={onNext} nextLabel="Next" nextIcon="arrow-right" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Step 4 — Review & Generate                                          */
/* ------------------------------------------------------------------ */

export function StepReview({
  spec,
  reference,
  onBack,
  onGenerate,
}: {
  spec: CharacterSpec;
  reference: ReferenceImage | null;
  onBack: () => void;
  onGenerate: () => void;
}) {
  const look = lookById(spec.look);
  const tone = toneById(spec.skinTone);

  return (
    <div className="space-y-5">
      <StepHeading
        title="4. Review & Generate"
        subtitle="Check your settings before generating your character."
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(240px,300px)]">
        <div className="min-w-0 space-y-4">
          <ReviewCard title="Character Details">
            <ReviewRow label="Mode">{spec.mode === "normal" ? "Normal" : "Uncensored"}</ReviewRow>
            <ReviewRow label="Prompt">
              <span className="line-clamp-3 whitespace-pre-wrap font-normal text-ink-soft">
                {spec.prompt.trim() || "—"}
              </span>
            </ReviewRow>
            <ReviewRow label="Aspect Ratio">{spec.aspect}</ReviewRow>
            <ReviewRow label="Resolution">{spec.resolution}</ReviewRow>
            <ReviewRow label="Style">{spec.style}</ReviewRow>
          </ReviewCard>

          <ReviewCard title="Appearance">
            <ReviewRow label="Gender">{spec.gender}</ReviewRow>
            <ReviewRow label="Age">{spec.age}</ReviewRow>
            <ReviewRow label="Body Type">{spec.bodyType}</ReviewRow>
            <ReviewRow label="Skin Tone">
              <span className="inline-flex items-center justify-end gap-1.5">
                {tone && (
                  <span
                    aria-hidden
                    className="inline-block size-3.5 rounded-full border border-black/10"
                    style={{ backgroundColor: tone.hex }}
                  />
                )}
                {tone?.prompt ?? "—"}
              </span>
            </ReviewRow>
            <ReviewRow label="Inspiration">{look ? look.label : "None"}</ReviewRow>
          </ReviewCard>

          <ReviewCard title="Advanced Settings">
            <ReviewRow label="Hair">
              {spec.hairColor} · {spec.hairStyle}
            </ReviewRow>
            <ReviewRow label="Eyes">
              {spec.eyeColor} · {spec.eyeShape}
            </ReviewRow>
            <ReviewRow label="Height">{spec.height}</ReviewRow>
            <ReviewRow label="Weight">{spec.weight}</ReviewRow>
            <ReviewRow label="Build">{spec.build}</ReviewRow>
            <ReviewRow label="Extras">
              {[
                spec.tattoos && "Tattoos",
                spec.piercings && "Piercings",
                spec.facialHair && "Facial hair",
                reference && "Reference photo",
              ]
                .filter(Boolean)
                .join(", ") || "None"}
            </ReviewRow>
          </ReviewCard>
        </div>

        <aside className="min-w-0">
          <p className="text-[13px] font-semibold text-ink-soft">Preview</p>
          <div className="mt-2.5">
            {look ? (
              <MediaFrame
                src={look.src}
                alt={`${look.label} look preview`}
                ratio="4/5"
                rounded="rounded-[14px]"
                className="w-full border border-border"
              />
            ) : (
              <div className="flex aspect-[4/5] w-full flex-col items-center justify-center gap-2 rounded-[14px] border border-dashed border-border-strong bg-surface px-4 text-center">
                <Icon name="sparkle" size={20} className="text-muted" />
                <p className="text-[12px] text-muted">
                  Pick an inspiration look on the Appearance step to see a style
                  preview here.
                </p>
              </div>
            )}
          </div>
          <p className="mt-2.5 text-[11.5px] leading-snug text-muted">
            This is just a style preview. The final result may vary based on the
            AI model.
          </p>
          {reference && (
            <div className="mt-3 flex items-center gap-2.5 rounded-[12px] border border-border bg-surface p-2.5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={reference.dataUrl}
                alt="Reference thumbnail"
                className="size-10 rounded-lg border border-border object-cover"
              />
              <p className="min-w-0 truncate text-[12px] font-medium text-ink-soft">
                {reference.name}
              </p>
            </div>
          )}
        </aside>
      </div>

      <StepNav
        onBack={onBack}
        onNext={onGenerate}
        nextLabel="Generate Character"
        nextIcon="sparkle"
      />
    </div>
  );
}
