"use client";

/**
 * CastPicker / EnvironmentPicker — the two canon membership pickers a
 * workspace needs (feature spec 05). Thin, labeled configurations of the
 * shared CanonMembershipPicker; both read the canon library through the
 * production read APIs (read-only) and report toggle changes upward.
 */

import { CanonMembershipPicker, type CanonMembershipPickerProps } from "./CanonMembershipPicker";

type PickerProps = Omit<CanonMembershipPickerProps,
  "entityNoun" | "entityNounPlural" | "createHref" | "createLabel" | "emptyBody" | "testPrefix">;

export function CastPicker(props: PickerProps) {
  return (
    <CanonMembershipPicker
      {...props}
      entityNoun="character"
      entityNounPlural="characters"
      createHref="/character"
      createLabel="Create a character"
      emptyBody="Characters you create stay on-model in every scene of this workspace. Create your first character, then add it here."
      testPrefix="workspaces.cast"
    />
  );
}

export function EnvironmentPicker(props: PickerProps) {
  return (
    <CanonMembershipPicker
      {...props}
      entityNoun="environment"
      entityNounPlural="environments"
      createHref="/environments"
      createLabel="Create an environment"
      emptyBody="Environments keep your recurring places consistent from episode to episode. Create one, then add it here."
      testPrefix="workspaces.environments"
    />
  );
}
