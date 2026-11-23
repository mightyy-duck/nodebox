import { getItems } from "@/lib/items";

export async function GET() {
  return Response.json(await getItems());
}
