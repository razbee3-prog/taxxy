import {
  type AccountBase,
  Configuration,
  CountryCode,
  PlaidApi,
  PlaidEnvironments,
  Products,
  type RemovedTransaction,
  type Transaction,
} from "plaid";
import { normalizeAccount, normalizeTransaction, removedIds } from "./normalize.js";
import { type PlaidClientLike, PlaidItemLoginRequired, type PlaidSyncPage } from "./types.js";

export interface PlaidEnv {
  PLAID_CLIENT_ID: string;
  PLAID_SECRET: string;
  PLAID_ENV: "sandbox" | "development" | "production";
}

const SYNC_PAGE = 500;

export function plaidClient(env: PlaidEnv): PlaidClientLike & { api: PlaidApi } {
  const api = new PlaidApi(
    new Configuration({
      basePath: PlaidEnvironments[env.PLAID_ENV],
      baseOptions: {
        headers: { "PLAID-CLIENT-ID": env.PLAID_CLIENT_ID, "PLAID-SECRET": env.PLAID_SECRET },
      },
    }),
  );
  return {
    api,
    async createLinkToken(userId, webhookUrl) {
      const r = await api.linkTokenCreate({
        user: { client_user_id: userId },
        client_name: "Taxxy",
        products: [Products.Transactions],
        transactions: { days_requested: 730 },
        country_codes: [CountryCode.Us],
        language: "en",
        ...(webhookUrl ? { webhook: webhookUrl } : {}),
      });
      return { linkToken: r.data.link_token, expiration: r.data.expiration };
    },
    async exchangePublicToken(publicToken) {
      const ex = await api.itemPublicTokenExchange({ public_token: publicToken });
      const accessToken = ex.data.access_token;
      const acc = await api.accountsGet({ access_token: accessToken });
      return {
        itemId: ex.data.item_id,
        accessToken,
        institution: acc.data.item.institution_name ?? acc.data.item.institution_id ?? null,
        accounts: acc.data.accounts.map(normalizeAccount),
      };
    },
    async syncTransactions(accessToken, cursor) {
      try {
        const r = await api.transactionsSync({
          access_token: accessToken,
          ...(cursor ? { cursor } : {}),
          count: SYNC_PAGE,
        });
        return pageFrom(r.data);
      } catch (err) {
        const code = (err as { response?: { data?: { error_code?: string; item_id?: string } } })
          .response?.data;
        if (code?.error_code === "ITEM_LOGIN_REQUIRED")
          throw new PlaidItemLoginRequired(code.item_id ?? "unknown");
        throw err;
      }
    },
    async sandboxPublicToken() {
      const r = await api.sandboxPublicTokenCreate({
        institution_id: "ins_109508",
        initial_products: [Products.Transactions],
        options: { transactions: { days_requested: 730 } },
      });
      return r.data.public_token;
    },
  };
}

export interface PlaidFixture {
  item_id: string;
  accounts: AccountBase[];
  added: Transaction[];
  modified: Transaction[];
  removed: RemovedTransaction[];
  next_cursor: string;
}

function pageFrom(d: {
  added: Transaction[];
  modified: Transaction[];
  removed: RemovedTransaction[];
  next_cursor: string;
  has_more: boolean;
}): PlaidSyncPage {
  return {
    added: d.added.map(normalizeTransaction),
    modified: d.modified.map(normalizeTransaction),
    removed: removedIds(d.removed),
    nextCursor: d.next_cursor,
    hasMore: d.has_more,
  };
}

/**
 * Offline Plaid: one fixture item. First sync returns the fixture, later syncs return whatever
 * was queued with `queueUpdate` (so tests can exercise modified/removed supersession).
 */
export function fixturePlaid(fixture: PlaidFixture, opts: { pageSize?: number } = {}) {
  const pageSize = opts.pageSize ?? 500;
  const queued: Array<{
    added: Transaction[];
    modified: Transaction[];
    removed: RemovedTransaction[];
  }> = [];
  const accessToken = `access-fixture-${fixture.item_id}`;
  const client: PlaidClientLike & {
    queueUpdate: (u: (typeof queued)[number]) => void;
    accessToken: string;
  } = {
    accessToken,
    queueUpdate: (u) => queued.push(u),
    async createLinkToken(userId) {
      return {
        linkToken: `link-fixture-${userId}`,
        expiration: new Date(Date.now() + 3.6e6).toISOString(),
      };
    },
    async exchangePublicToken(publicToken) {
      if (!publicToken.startsWith("public-")) throw new Error("fixturePlaid: invalid public token");
      return {
        itemId: fixture.item_id,
        accessToken,
        institution: "Fixture Bank",
        accounts: fixture.accounts.map(normalizeAccount),
      };
    },
    async syncTransactions(token, cursor) {
      if (token !== accessToken) throw new Error("fixturePlaid: unknown access token");
      const offset = cursor ? Number(cursor.split(":")[1] ?? 0) : 0;
      if (!cursor || offset < fixture.added.length) {
        const slice = fixture.added.slice(offset, offset + pageSize);
        const next = offset + slice.length;
        return pageFrom({
          added: slice,
          modified: [],
          removed: [],
          next_cursor: `fixture:${next}`,
          has_more: next < fixture.added.length,
        });
      }
      const u = queued.shift();
      return pageFrom({
        added: u?.added ?? [],
        modified: u?.modified ?? [],
        removed: u?.removed ?? [],
        next_cursor: `fixture:${offset}:${Date.now()}`,
        has_more: false,
      });
    },
    async sandboxPublicToken() {
      return "public-fixture";
    },
  };
  return client;
}
