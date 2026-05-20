import { getRedis } from "@/lib/db/redis";

export async function GET() {
  try {
    const r = getRedis();
    if (!r) return Response.json({ states: {}, source: "no-redis" });

    const data = await r.get("supreme:pair_states");
    if (!data) return Response.json({ states: {}, source: "empty" });

    return Response.json({ states: JSON.parse(data), source: "redis" });
  } catch (err) {
    return Response.json({ states: {}, source: "error" });
  }
}