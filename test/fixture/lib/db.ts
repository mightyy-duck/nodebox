// Database access for the shop.
import { Pool } from "pg";

const pool = new Pool();

/** All items, newest first. */
export async function listItems() {
  return pool.query("select * from items order by id desc");
}
