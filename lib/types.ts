import type { AgeGroupId } from "./ages";

export type Ingredient = { name: string; strength: string };

export type Product = {
  brand: string;
  active_ingredients: Ingredient[];
  confidence: number;
};

export type LabelInfo = {
  ingredient: string; // normalized ingredient key
  found: boolean;
  label_name?: string; // brand/title of the openFDA label used
  set_id?: string;
  warnings?: string;
  do_not_use?: string;
  ask_doctor?: string;
  stop_use?: string;
};

export type Severity = "red" | "yellow";

export type Flag = {
  id: string;
  kind: "duplicate" | "class" | "age";
  severity: Severity;
  title: string;
  ingredients: string[]; // normalized keys involved
  products: string[]; // brands involved
  source: string; // where the rule comes from
  explanation?: string;
  citations?: string[];
};

export type ScanResult = {
  mock: boolean;
  age: AgeGroupId;
  model: string;
  status: "red" | "yellow" | "green";
  products: (Product & { keys: string[]; images?: number[] })[];
  image_count: number;
  hints: string[]; // per-image problems, e.g. "Image 2: labels too small to read, try a closer photo"
  labels: Record<string, LabelInfo>;
  flags: Flag[];
  notes: string[];
};
