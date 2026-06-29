/**
 * Smoke test against a running Operations API.
 * Usage: bun run scripts/smoke.ts
 */
const base = process.env.API_BASE ?? "http://localhost:3002";

async function req(path: string, init?: RequestInit) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("FAIL", path, res.status, body);
    process.exit(1);
  }
  console.log("OK", path, res.status);
  return body;
}

await req("/health");

const catalog = await req("/api/v1/catalog/items");
if (!catalog.items?.length) {
  console.warn("WARN: no catalog items — run db:seed first");
}

const parties = await req("/api/v1/parties?externalSource=demo-app");
if (parties.items?.[0]) {
  const partyId = parties.items[0].id;
  const accounts = await req(`/api/v1/accounts?partyId=${partyId}`);
  console.log("accounts:", accounts.items?.length ?? 0);
}

console.log("Smoke passed.");
