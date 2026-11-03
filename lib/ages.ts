// Age profiles. Plain data, safe to import from client components.

export type AgeGroupId = "infant" | "toddler" | "preschool" | "child" | "teen" | "adult" | "senior";

export type AgeGroup = {
  id: AgeGroupId;
  label: string;
  short: string;
  min: number; // years, inclusive
  max: number; // years, exclusive
};

export const AGE_GROUPS: AgeGroup[] = [
  { id: "infant", label: "Baby (under 2)", short: "Under 2", min: 0, max: 2 },
  { id: "toddler", label: "Toddler (2–3)", short: "2–3", min: 2, max: 4 },
  { id: "preschool", label: "Young kid (4–5)", short: "4–5", min: 4, max: 6 },
  { id: "child", label: "Kid (6–11)", short: "6–11", min: 6, max: 12 },
  { id: "teen", label: "Teen (12–17)", short: "12–17", min: 12, max: 18 },
  { id: "adult", label: "Adult (18–64)", short: "Adult", min: 18, max: 65 },
  { id: "senior", label: "Older adult (65+)", short: "65+", min: 65, max: 200 },
];

export const DEFAULT_AGE: AgeGroupId = "adult";

export function ageGroup(id: unknown): AgeGroup {
  return AGE_GROUPS.find((g) => g.id === id) ?? AGE_GROUPS.find((g) => g.id === DEFAULT_AGE)!;
}

// The dose timer schedules from the adult ("adults and children 12 years and over") directions.
export const isUnder12 = (g: AgeGroup) => g.max <= 12;
