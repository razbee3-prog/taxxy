// Pulls a Plaid Sandbox item's transactions and writes a sanitized fixture (no tokens, no ids beyond Plaid's fake ones).
import { writeFileSync } from "node:fs";
import { Configuration, PlaidApi, PlaidEnvironments, Products } from "plaid";

const client = new PlaidApi(
  new Configuration({
    basePath: PlaidEnvironments.sandbox,
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
        "PLAID-SECRET": process.env.PLAID_SANDBOX_SECRET,
      },
    },
  }),
);
const pub = await client.sandboxPublicTokenCreate({
  institution_id: "ins_109508",
  initial_products: [Products.Transactions],
  options: { webhook: "https://example.com/plaid/webhook", transactions: { days_requested: 730 } },
});
const ex = await client.itemPublicTokenExchange({ public_token: pub.data.public_token });
const accessToken = ex.data.access_token;
const accounts = (await client.accountsGet({ access_token: accessToken })).data.accounts;
let cursor: string | undefined;
let added: unknown[] = [];
let modified: unknown[] = [];
let removed: unknown[] = [];
for (let i = 0; i < 20; i++) {
  const r = await client.transactionsSync({ access_token: accessToken, cursor, count: 500 });
  added = added.concat(r.data.added);
  modified = modified.concat(r.data.modified);
  removed = removed.concat(r.data.removed);
  cursor = r.data.next_cursor;
  if (!r.data.has_more) {
    if (added.length > 0) break;
    await new Promise((res) => setTimeout(res, 3000)); // sandbox may still be preparing
  }
}
const out = { item_id: ex.data.item_id, accounts, added, modified, removed, next_cursor: cursor };
writeFileSync(
  new URL("../test/fixtures/plaid-sandbox-sync.json", import.meta.url),
  `${JSON.stringify(out, null, 2)}\n`,
);
console.log(
  `accounts=${accounts.length} added=${added.length} modified=${modified.length} removed=${removed.length}`,
);
console.log(JSON.stringify(added[0], null, 1).slice(0, 1500));
