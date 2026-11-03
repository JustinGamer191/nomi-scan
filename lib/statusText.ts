import type { Flag } from "./types";

// Headline for the status bar when the problem isn't an overlap between products,
// e.g. one product with a boxed warning. Returns null to use the default copy.
export function singleProductHeadline(flags: Flag[]): { title: string; sub: string } | null {
  if (flags.some((f) => f.kind === "duplicate" || f.kind === "class" || f.kind === "interaction")) return null;
  const boxed = flags.filter((f) => f.kind === "boxed");
  if (!boxed.length) return null;
  const n = new Set(boxed.flatMap((f) => f.products)).size;
  return {
    title: `Serious warning on ${n} product${n > 1 ? "s" : ""}`,
    sub: "The FDA label has a boxed warning or an age caution. Read it below and ask a pharmacist.",
  };
}
