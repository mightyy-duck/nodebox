import { listItems } from "@/lib/db";

/** Items for the page, already mapped. */
export async function getItems() {
  const r = await listItems();
  return r.rows;
}
