"use client";

import { useId, useState, type KeyboardEvent } from "react";
import { Icon } from "@/components/Icon";
import { Button, FieldShell } from "@/components/ui";
import {
  ENVIRONMENT_FIELD_MAX,
  PERSISTENT_PROPS_MAX,
} from "@/components/environments/environment-store";

/**
 * Structured environment-state editor (spec 07 §5 / C6): zone, lighting,
 * time of day and weather as structured values — never folded into prompt
 * prose — plus persistent props as discrete tagged items with bounds that
 * mirror the frozen EnvironmentStateSchema.
 */

export interface StructuredStateValue {
  zone: string;
  lighting: string;
  timeOfDay: string;
  weather: string;
  persistentProps: string[];
}

export const EMPTY_STRUCTURED_STATE: StructuredStateValue = {
  zone: "",
  lighting: "",
  timeOfDay: "",
  weather: "",
  persistentProps: [],
};

/** Suggested values; free text stays valid — the lists only teach. */
const SUGGESTIONS = {
  zone: ["Entrance", "Chamber", "Tunnel", "Rooftop", "Courtyard", "Dockside"],
  lighting: [
    "Natural daylight",
    "Golden hour",
    "Overcast diffuse",
    "Sodium lamps",
    "Neon signage",
    "Firelight",
    "Moonlight",
  ],
  timeOfDay: ["Dawn", "Morning", "Midday", "Afternoon", "Sunset", "Dusk", "Night"],
  weather: ["Clear", "Overcast", "Rain", "Storm", "Fog", "Snow", "Heat haze"],
} as const;

const FIELDS = [
  { key: "zone" as const, label: "Zone", placeholder: "e.g. Entrance" },
  { key: "lighting" as const, label: "Lighting", placeholder: "e.g. Golden hour" },
  { key: "timeOfDay" as const, label: "Time of day", placeholder: "e.g. Dusk" },
  { key: "weather" as const, label: "Weather", placeholder: "e.g. Overcast" },
];

export function StructuredStateFields({
  value,
  onChange,
  idPrefix,
  testIdPrefix = "environments.state",
}: {
  value: StructuredStateValue;
  onChange: (next: StructuredStateValue) => void;
  /** Unique input id prefix when several editors render on one page. */
  idPrefix: string;
  testIdPrefix?: string;
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {FIELDS.map((field) => {
          const id = `${idPrefix}-${field.key}`;
          return (
            <FieldShell
              key={field.key}
              label={field.label}
              htmlFor={id}
              hint={`Up to ${ENVIRONMENT_FIELD_MAX} characters; left empty to inherit.`}
            >
              <input
                id={id}
                value={value[field.key]}
                maxLength={ENVIRONMENT_FIELD_MAX}
                placeholder={field.placeholder}
                list={`${id}-options`}
                onChange={(event) => onChange({ ...value, [field.key]: event.target.value })}
                data-testid={`${testIdPrefix}.field.${field.key}`}
                className="h-11 w-full rounded-[12px] border border-border-strong bg-raised px-3.5 text-sm text-ink placeholder:text-muted focus:border-primary focus:outline-none"
              />
              <datalist id={`${id}-options`}>
                {SUGGESTIONS[field.key].map((suggestion) => (
                  <option key={suggestion} value={suggestion} />
                ))}
              </datalist>
            </FieldShell>
          );
        })}
      </div>
      <PropsEditor
        props={value.persistentProps}
        onChange={(persistentProps) => onChange({ ...value, persistentProps })}
        idPrefix={idPrefix}
        testIdPrefix={testIdPrefix}
      />
    </div>
  );
}

/** Persistent props: discrete items with an explicit add affordance, capped
 * at the contract bound with a visible counter. */
export function PropsEditor({
  props,
  onChange,
  idPrefix,
  testIdPrefix = "environments.state",
}: {
  props: string[];
  onChange: (next: string[]) => void;
  idPrefix: string;
  testIdPrefix?: string;
}) {
  const inputId = `${idPrefix}-prop`;
  const [draft, setDraft] = useState("");

  function addProp() {
    const next = draft.trim().slice(0, ENVIRONMENT_FIELD_MAX);
    if (!next || props.includes(next) || props.length >= PERSISTENT_PROPS_MAX) return;
    onChange([...props, next]);
    setDraft("");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      addProp();
    }
  }

  const full = props.length >= PERSISTENT_PROPS_MAX;

  return (
    <FieldShell
      label="Persistent props"
      htmlFor={inputId}
      hint="Objects that always live in this environment — crates, lanterns, a parked truck."
      counter={`${props.length}/${PERSISTENT_PROPS_MAX}`}
    >
      <div className="space-y-2.5">
        <div className="flex gap-2">
          <input
            id={inputId}
            value={draft}
            disabled={full}
            maxLength={ENVIRONMENT_FIELD_MAX}
            placeholder={full ? `The ${PERSISTENT_PROPS_MAX}-prop bound is reached` : "e.g. Hanging lanterns"}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            data-testid={`${testIdPrefix}.prop.input`}
            className="h-11 min-w-0 flex-1 rounded-[12px] border border-border-strong bg-raised px-3.5 text-sm text-ink placeholder:text-muted focus:border-primary focus:outline-none disabled:opacity-55"
          />
          <Button
            variant="secondary"
            icon="plus"
            disabled={full || !draft.trim()}
            onClick={addProp}
            data-testid={`${testIdPrefix}.prop.add`}
          >
            Add
          </Button>
        </div>
        {props.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5" data-testid={`${testIdPrefix}.prop.list`}>
            {props.map((prop, index) => (
              <li key={`${prop}-${index}`}>
                <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-1 text-[12px] font-medium text-ink-soft">
                  {prop}
                  <button
                    type="button"
                    aria-label={`Remove ${prop}`}
                    data-testid={`${testIdPrefix}.prop.remove-${index}`}
                    onClick={() => onChange(props.filter((_, candidate) => candidate !== index))}
                    className="inline-flex size-4 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-ink"
                  >
                    <Icon name="close" size={10} />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12px] text-muted">No persistent props yet — add the objects every scene here should keep.</p>
        )}
      </div>
    </FieldShell>
  );
}
