"use client";

import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { MediaFrame } from "@/components/Media";
import { LoraPicker } from "@/components/LoraPicker";
import { Button, SelectField, Segmented, TextAreaField, Toggle } from "@/components/ui";
import { lorasForModel, visibleLoras } from "@/lib/lora-options";
import type { LoraOption } from "@/lib/providers/sogni/lora-catalog";
import type { LoraSelection } from "@/lib/types";
import { ASPECTS, PROMPT_MAX, RESOLUTIONS } from "@/lib/constants";
import {
  AGE_MAX,
  AGE_MIN,
  BUILDS,
  CHARACTER_STYLES,
  COUNTRIES,
  EYE_COLORS,
  EYE_SHAPES,
  ETHNICITIES,
  FACE_SHAPES,
  FACIAL_FEATURES,
  GENDERS,
  HAIR_COLORS,
  HAIR_STYLES,
  LOOK_PRESETS,
  NSFW_LEVELS,
  SKIN_TONES,
  accessoryGroups,
  ageBucketLabel,
  bodyDetailOptions,
  clampAge,
  clothingGroups,
  expressionOptions,
  lookById,
  personalityTemplates,
  type CharacterSpec,
  type CharacterRenderParams,
  type CharacterTemplate,
  type OptionGroup,
} from "@/lib/character";
import type { AspectKey, ResolutionKey } from "@/lib/constants";

export const CHARACTER_STEPS = [
  "Character",
  "Appearance",
  "Advanced",
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
                    ? "bg-primary-strong text-white"
                    : active
                      ? "bg-primary-strong text-white ring-4 ring-primary-soft"
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
    <section className="rounded-[16px] border border-border bg-raised p-4">
      <h3 className="text-[13.5px] font-bold text-ink">{title}</h3>
      <div className="mt-1.5 divide-y divide-border/70">{children}</div>
    </section>
  );
}

const toneById = (id: string) => SKIN_TONES.find((t) => t.id === id);

/** Whole-year age picker — precise steps with the classic buckets as a hint. */
function AgeSlider({
  value,
  onChange,
}: {
  value: number;
  onChange: (age: number) => void;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor="character-age" className="text-[13px] font-semibold text-ink-soft">
          Age
        </label>
        <span className="text-[12px] font-semibold text-ink">{value} years old</span>
      </div>
      <input
        id="character-age"
        type="range"
        min={AGE_MIN}
        max={AGE_MAX}
        step={1}
        value={clampAge(value)}
        aria-valuetext={`${value} years old`}
        onChange={(e) => onChange(clampAge(Number(e.target.value)))}
        className="mt-2 w-full accent-primary"
      />
      <div className="mt-1 flex justify-between text-[10.5px] font-medium text-muted">
        <span>{AGE_MIN}</span>
        <span>{AGE_MAX}</span>
      </div>
      <p className="mt-1.5 text-[12px] text-muted">{ageBucketLabel(value)}</p>
    </div>
  );
}

function NsfwSlider({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  const current = NSFW_LEVELS.find((level) => level.value === value) ?? NSFW_LEVELS[0];
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor="nsfw-level" className="text-[13px] font-semibold text-ink-soft">
          NSFW Level
        </label>
        <span className="text-[12px] font-semibold text-ink">
          {current.value} · {current.label}
        </span>
      </div>
      <input
        id="nsfw-level"
        type="range"
        min={0}
        max={5}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-2 w-full accent-primary"
      />
      <div className="mt-1 flex justify-between text-[10.5px] font-medium text-muted">
        {NSFW_LEVELS.map((level) => (
          <span key={level.value}>{level.value}</span>
        ))}
      </div>
      <p className="mt-1.5 text-[12px] text-muted">{current.hint}</p>
    </div>
  );
}

function TemplateChips({
  templates,
  activeText,
  onPick,
}: {
  templates: CharacterTemplate[];
  activeText: string;
  onPick: (text: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {templates.map((template) => {
        const active = activeText === template.text;
        return (
          <button
            key={template.id}
            type="button"
            aria-pressed={active}
            title={template.text}
            onClick={() => onPick(active ? "" : template.text)}
            className={`rounded-full border px-2.5 py-1 text-[12px] font-semibold transition-colors ${
              active
                ? "border-primary bg-primary-soft text-primary"
                : "border-border bg-raised text-ink-soft hover:border-border-strong hover:text-ink"
            }`}
          >
            {template.label}
          </button>
        );
      })}
    </div>
  );
}

function GroupedSelect({
  label,
  value,
  groups,
  onChange,
}: {
  label: string;
  value: string;
  groups: OptionGroup[];
  onChange: (value: string) => void;
}) {
  return (
    <SelectField label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {groups.map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </optgroup>
      ))}
    </SelectField>
  );
}

/* ------------------------------------------------------------------ */
/* Step 1 — Character                                                  */
/* ------------------------------------------------------------------ */

/** One-click starters that show the kind of info the prompt should carry. */
export const PROMPT_EXAMPLES = [
  "A young artist with ink-stained fingers, messy hair and a paint-splattered apron, warm smile.",
  "A battle-worn warrior in ornate scarred armor, dark braid, storm-grey eyes.",
  "A cheerful barista in a lavender apron, freckles, curls escaping a messy bun.",
];

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
        title="1. Character"
        subtitle="Describe your character, then fine-tune with the options on the next steps."
      />

      <TextAreaField
        label="Character Prompt"
        value={spec.prompt}
        maxLength={PROMPT_MAX}
        rows={5}
        error={promptError}
        placeholder="e.g. A young artist with ink-stained fingers and a paint-splattered apron, warm smile."
        onChange={(value) => patch({ prompt: value })}
      />

      <div className="rounded-[14px] border border-border bg-surface p-3.5">
        <p className="text-[12.5px] font-semibold text-ink-soft">
          What to include in the prompt
        </p>
        <p className="mt-1 text-[12px] leading-snug text-muted">
          Who they are, their distinctive features, what they wear and their
          mood or setting. Everything else is tuned from the options in the
          next steps.
        </p>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {PROMPT_EXAMPLES.map((example, index) => (
            <button
              key={example}
              type="button"
              aria-pressed={spec.prompt === example}
              title={example}
              onClick={() => patch({ prompt: spec.prompt === example ? "" : example })}
              className={`rounded-full border px-2.5 py-1 text-[12px] font-semibold transition-colors ${
                spec.prompt === example
                  ? "border-primary bg-primary-soft text-primary"
                  : "border-border bg-raised text-ink-soft hover:border-border-strong hover:text-ink"
              }`}
            >
              {["Artist", "Warrior", "Barista"][index]}
            </button>
          ))}
        </div>
      </div>

      <SelectField
        label="Art Style"
        value={spec.style}
        onChange={(e) => patch({ style: e.target.value })}
      >
        {CHARACTER_STYLES.map((style) => (
          <option key={style} value={style}>
            {style}
          </option>
        ))}
      </SelectField>

      <p className="text-[12px] text-muted">
        Aspect ratio, resolution and model are picked at the Review step. Adult
        options across the wizard follow the Uncensored Mode switch in
        Settings.
      </p>

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
  uncensored,
  onBack,
  onNext,
}: {
  spec: CharacterSpec;
  patch: (patch: Partial<CharacterSpec>) => void;
  /** Global Uncensored Mode gate — surfaces the adult option groups. */
  uncensored: boolean;
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
            <AgeSlider value={spec.age} onChange={(age) => patch({ age })} />
            <SelectField
              label="Build"
              value={spec.build}
              onChange={(e) => patch({ build: e.target.value })}
            >
              {["Slim", "Athletic", "Average", "Muscular", "Curvy", "Plus-size"].map((build) => (
                <option key={build} value={build}>
                  {build}
                </option>
              ))}
            </SelectField>
            <SelectField
              label="Ethnicity"
              value={spec.ethnicity}
              onChange={(e) => patch({ ethnicity: e.target.value })}
            >
              {ETHNICITIES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </SelectField>
            <SelectField
              label="Country"
              value={spec.country}
              onChange={(e) => patch({ country: e.target.value })}
            >
              {COUNTRIES.map((value) => (
                <option key={value} value={value}>
                  {value}
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
                    className={`size-8 rounded-full border border-ink/10 transition-shadow ${
                      active
                        ? "ring-2 ring-primary ring-offset-2 ring-offset-canvas"
                        : "hover:ring-2 hover:ring-border-strong hover:ring-offset-2 hover:ring-offset-canvas"
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
                        ? "bg-primary-strong text-white shadow-sm"
                        : "text-ink-soft hover:bg-raised"
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
                    {expressionOptions(uncensored).map((value) => (
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
                <GroupedSelect
                  label="Outfit"
                  value={spec.outfit}
                  groups={clothingGroups(uncensored)}
                  onChange={(outfit) => patch({ outfit })}
                />
              )}
              {tab === "Accessories" && (
                <GroupedSelect
                  label="Accessories"
                  value={spec.accessories}
                  groups={accessoryGroups(uncensored)}
                  onChange={(accessories) => patch({ accessories })}
                />
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
                    <span className="absolute right-1.5 top-1.5 inline-flex size-5 items-center justify-center rounded-full bg-primary-strong text-white shadow-sm">
                      <Icon name="check" size={12} />
                    </span>
                  )}
                  <span className="absolute inset-x-1.5 bottom-1.5 truncate rounded-md bg-black/60 px-1.5 py-0.5 text-center text-[10px] font-semibold text-white backdrop-blur">
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
/* Step 3 — Advanced                                                   */
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
    <div className="rounded-[14px] border border-border bg-raised">
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
  uncensored,
  reference,
  onReferenceChange,
  onBack,
  onNext,
}: {
  spec: CharacterSpec;
  patch: (patch: Partial<CharacterSpec>) => void;
  /** Global Uncensored Mode gate — surfaces the NSFW slider. */
  uncensored: boolean;
  reference: ReferenceImage | null;
  onReferenceChange: (image: ReferenceImage | null) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const [personalityOpen, setPersonalityOpen] = useState(false);
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
        title="3. Advanced"
        subtitle="Add more details to make your character unique."
      />

      <SelectField
        label="Body Details"
        value={spec.bodyDetails}
        onChange={(e) => patch({ bodyDetails: e.target.value })}
      >
        {bodyDetailOptions(uncensored).map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </SelectField>

      {uncensored ? (
        <div className="space-y-4 rounded-[14px] border border-warning/30 bg-[#fffbeb] p-4">
          <p className="text-[12.5px] font-semibold text-warning">
            Uncensored · 18+ only · auto-tagged in History
          </p>
          <NsfwSlider
            value={spec.nsfwLevel}
            onChange={(nsfwLevel) => patch({ nsfwLevel })}
          />
        </div>
      ) : (
        <p className="rounded-[14px] border border-border bg-surface px-4 py-3 text-[12.5px] text-muted">
          Adult options are hidden while Uncensored Mode is off. Enable it in
          Settings to unlock the NSFW slider and adult outfit options.
        </p>
      )}

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
          <TemplateChips
            templates={personalityTemplates(uncensored)}
            activeText={spec.personality}
            onPick={(text) => patch({ personality: text })}
          />
          <div className="mt-3">
            <TextAreaField
              label="Personality (optional)"
              value={spec.personality}
              maxLength={300}
              rows={3}
              placeholder="e.g. friendly and adventurous, loves photography and travel."
              onChange={(personality) => patch({ personality })}
            />
          </div>
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
              <span className="inline-flex size-10 items-center justify-center rounded-full bg-raised text-primary shadow-card">
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
  uncensored,
  reference,
  renderParams,
  onRenderParamsChange,
  models,
  modelId,
  onModelChange,
  loraCatalog,
  loraMaxPerRequest = 8,
  loraCapable = false,
  loraModel,
  allowNsfwLoras = false,
  loras,
  onLorasChange,
  onBack,
  onGenerate,
}: {
  spec: CharacterSpec;
  /** Global Uncensored Mode gate — shows the NSFW row. */
  uncensored: boolean;
  reference: ReferenceImage | null;
  /** Generation-time aspect/resolution, edited here and on the Review step. */
  renderParams: { aspect: AspectKey; resolution: ResolutionKey };
  onRenderParamsChange: (patch: Partial<{ aspect: AspectKey; resolution: ResolutionKey }>) => void;
  /** Image model catalog for the picker; row hidden while empty. */
  models?: { id: string; label: string; hint?: string; providerLabel: string }[];
  modelId?: string | null;
  onModelChange?: (modelId: string) => void;
  /** LoRA catalog + raw model id — the adapter row renders only when the
   * chosen model accepts adapters (krea2-class), mirroring Solo/Story. */
  loraCatalog?: LoraOption[];
  loraMaxPerRequest?: number;
  loraCapable?: boolean;
  loraModel?: string;
  allowNsfwLoras?: boolean;
  loras?: LoraSelection[];
  onLorasChange?: (loras: LoraSelection[]) => void;
  onBack: () => void;
  onGenerate: () => void;
}) {
  const look = lookById(spec.look);
  const tone = toneById(spec.skinTone);
  const loraEntries =
    loraCapable && loraModel && loraCatalog?.length
      ? visibleLoras(lorasForModel(loraCatalog, loraModel), allowNsfwLoras)
      : [];

  return (
    <div className="space-y-5">
      <StepHeading
        title="4. Review & Render"
        subtitle="Check your settings, then render the full character sheet."
      />

      <div className="space-y-4">
        <ReviewCard title="Render">
          <ReviewRow label="Aspect Ratio">
            <select
              aria-label="Aspect ratio"
              value={renderParams.aspect}
              onChange={(e) => onRenderParamsChange({ aspect: e.target.value as AspectKey })}
              className="h-8 max-w-[220px] appearance-none rounded-[9px] border border-border-strong bg-raised pl-2.5 pr-6 text-[12px] font-semibold text-ink transition-colors hover:border-muted focus:border-primary focus:outline-none"
            >
              {Object.keys(ASPECTS).map((key) => (
                <option key={key} value={key}>
                  {key} ({ASPECTS[key as AspectKey].hint})
                </option>
              ))}
            </select>
          </ReviewRow>
          <ReviewRow label="Resolution">
            <select
              aria-label="Resolution"
              value={renderParams.resolution}
              onChange={(e) =>
                onRenderParamsChange({ resolution: e.target.value as ResolutionKey })
              }
              className="h-8 max-w-[220px] appearance-none rounded-[9px] border border-border-strong bg-raised pl-2.5 pr-6 text-[12px] font-semibold text-ink transition-colors hover:border-muted focus:border-primary focus:outline-none"
            >
              {Object.keys(RESOLUTIONS).map((key) => (
                <option key={key} value={key}>
                  {RESOLUTIONS[key as ResolutionKey].label}
                </option>
              ))}
            </select>
          </ReviewRow>
          <ReviewRow label="Style">{spec.style}</ReviewRow>
          {models && models.length > 0 && onModelChange && (
            <ReviewRow label="Model">
              <select
                aria-label="Image model"
                value={modelId ?? models[0].id}
                onChange={(event) => onModelChange(event.target.value)}
                className="h-8 max-w-[220px] appearance-none rounded-[9px] border border-border-strong bg-raised pl-2.5 pr-6 text-[12px] font-semibold text-ink transition-colors hover:border-muted focus:border-primary focus:outline-none"
                style={{
                  backgroundImage:
                    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239ca3af' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9.5l6 6 6-6'/%3E%3C/svg%3E\")",
                  backgroundRepeat: "no-repeat",
                  backgroundPosition: "right 8px center",
                }}
              >
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                    {model.hint ? ` — ${model.hint}` : ""} · {model.providerLabel}
                  </option>
                ))}
              </select>
            </ReviewRow>
          )}
          {onLorasChange && loraEntries.length > 0 && (
            <ReviewRow label="LoRA">
              {/* Relative anchor so the popover opens upward inside the card. */}
              <span className="relative inline-flex">
                <LoraPicker
                  entries={loraEntries}
                  selection={loras ?? []}
                  onChange={onLorasChange}
                  maxPerRequest={loraMaxPerRequest}
                />
              </span>
            </ReviewRow>
          )}
        </ReviewCard>

        <ReviewCard title="Appearance">
          <ReviewRow label="Gender">{spec.gender}</ReviewRow>
          <ReviewRow label="Age">{spec.age} years old</ReviewRow>
          <ReviewRow label="Ethnicity">{spec.ethnicity}</ReviewRow>
          <ReviewRow label="Country">{spec.country}</ReviewRow>
          <ReviewRow label="Build">{spec.build}</ReviewRow>
          <ReviewRow label="Skin Tone">
            <span className="inline-flex items-center justify-end gap-1.5">
              {tone && (
                <span
                  aria-hidden
                  className="inline-block size-3.5 rounded-full border border-ink/10"
                  style={{ backgroundColor: tone.hex }}
                />
              )}
              {tone?.prompt ?? "—"}
            </span>
          </ReviewRow>
          <ReviewRow label="Inspiration">{look ? look.label : "None"}</ReviewRow>
        </ReviewCard>

        <ReviewCard title="Details">
          <ReviewRow label="Hair">
            {spec.hairColor} · {spec.hairStyle}
          </ReviewRow>
          <ReviewRow label="Eyes">
            {spec.eyeColor} · {spec.eyeShape}
          </ReviewRow>
          <ReviewRow label="Clothing">{spec.outfit}</ReviewRow>
          <ReviewRow label="Body Details">{spec.bodyDetails}</ReviewRow>
          {uncensored && (
            <ReviewRow label="NSFW Level">
              {spec.nsfwLevel} · {NSFW_LEVELS.find((l) => l.value === spec.nsfwLevel)?.label}
            </ReviewRow>
          )}
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

        {reference && (
          <div className="flex items-center gap-2.5 rounded-[12px] border border-border bg-surface p-2.5">
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
      </div>

      <StepNav
        onBack={onBack}
        onNext={onGenerate}
        nextLabel="Render Character Sheet"
        nextIcon="sparkle"
      />
    </div>
  );
}