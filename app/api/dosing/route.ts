import { dosingFor } from "@/lib/dosing";
import type { Product } from "@/lib/types";

export const maxDuration = 60;

type Body = { products?: (Product & { keys: string[] })[]; mock?: boolean };

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Body;
  const products = (body.products ?? [])
    .filter((p) => typeof p?.brand === "string" && Array.isArray(p.keys) && Array.isArray(p.active_ingredients))
    .slice(0, 5);
  if (!products.length) return Response.json({ error: "No products given." }, { status: 400 });
  const mock = !!body.mock || process.env.MOCK === "1";
  return Response.json(await dosingFor(products, mock));
}
