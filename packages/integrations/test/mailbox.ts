import { readFileSync } from "node:fs";
import type { FixtureMailbox } from "../src/gmail/client.js";

export function loadMailbox(): FixtureMailbox {
  return JSON.parse(
    readFileSync(new URL("./fixtures/gmail-mailbox.json", import.meta.url), "utf8"),
  ) as FixtureMailbox;
}
