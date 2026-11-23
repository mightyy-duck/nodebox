"use client";

export async function loadItems() {
  const res = await fetch("/api/items");
  return res.json();
}

export default function List() {
  loadItems();
  return null;
}
