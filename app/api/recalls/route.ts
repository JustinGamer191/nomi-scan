import { recallReport } from "@/lib/recalls";

export const maxDuration = 120;

type Body = { products?: { brand: string; keys?: string[] }[]; mock?: boolean };

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Body;
  const products = (body.products ?? []).filter((p) => typeof p?.brand === "string").slice(0, 5);
  if (!products.length) return Response.json({ error: "No products given." }, { status: 400 });
  const mock = !!body.mock || process.env.MOCK === "1";
  const reports = await Promise.all(products.map((p) => recallReport(p.brand, p.keys ?? [], mock)));
  return Response.json({ reports });
}
