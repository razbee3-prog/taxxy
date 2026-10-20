import { readFileSync } from "node:fs";
import type { PlaidFixture } from "../src/plaid/client.js";

export function loadSandboxFixture(): PlaidFixture {
  return JSON.parse(
    readFileSync(new URL("./fixtures/plaid-sandbox-sync.json", import.meta.url), "utf8"),
  ) as PlaidFixture;
}
