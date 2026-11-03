"use client";

import { AGE_GROUPS, type AgeGroupId } from "@/lib/ages";

export default function AgePicker({ value, onChange }: { value: AgeGroupId; onChange: (id: AgeGroupId) => void }) {
  return (
    <fieldset className="mt-5">
      <legend className="text-sm font-medium text-stone-700">Who is taking these?</legend>
      <div role="radiogroup" className="mt-2 flex flex-wrap gap-2">
        {AGE_GROUPS.map((g) => (
          <button
            key={g.id}
            role="radio"
            aria-checked={value === g.id}
            onClick={() => onChange(g.id)}
            className={`rounded-full border px-3 py-1.5 text-sm ${
              value === g.id
                ? "border-stone-900 bg-stone-900 text-white"
                : "border-stone-300 bg-white text-stone-700 hover:border-stone-900"
            }`}
          >
            {g.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
