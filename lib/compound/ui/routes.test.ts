import {
  SUBNAV, activeNavKey, deskHref, holderHref, payoutHref, routeTitle, withdrawHref,
} from "./routes";

describe("SUBNAV", () => {
  it("carries the six agreed entries in the agreed order", () => {
    expect(SUBNAV.map((n) => n.key))
      .toEqual(["desk", "journal", "calendar", "performance", "ledger", "review"]);
  });

  it("has no Holders entry — the desk table is the index", () => {
    expect(SUBNAV.some((n) => n.key === "holders")).toBe(false);
  });

  it("badges Review and nothing else", () => {
    expect(SUBNAV.filter((n) => n.badge).map((n) => n.key)).toEqual(["review"]);
  });

  it("builds every href from the account id", () => {
    expect(SUBNAV.map((n) => n.href(7))).toEqual([
      "/a/7", "/a/7/journal", "/a/7/calendar", "/a/7/performance", "/a/7/ledger", "/a/7/review",
    ]);
  });
});

describe("activeNavKey", () => {
  it.each([
    ["/a/7", "desk"],
    ["/a/7/", "desk"],
    ["/a/7/ledger", "ledger"],
    ["/a/7/review", "review"],
    ["/a/7/review/12", "review"],
    ["/a/7/journal", "journal"],
    ["/a/7/holders/2", "desk"],
    ["/a/7/holders/2/edit", "desk"],
    ["/a/7/actions/payout/2", "desk"],
  ])("maps %s to %s", (path, key) => {
    expect(activeNavKey(path, 7)).toBe(key);
  });

  it("does not match another account's path", () => {
    expect(activeNavKey("/a/8/ledger", 7)).toBe("");
  });

  it("does not match a prefix collision", () => {
    // /a/71 starts with /a/7. A naive startsWith on the id alone gets this
    // wrong and highlights the wrong tab on every page of account 71.
    expect(activeNavKey("/a/71/ledger", 7)).toBe("");
  });

  it("returns empty for an unknown segment rather than guessing", () => {
    expect(activeNavKey("/a/7/settings", 7)).toBe("");
  });
});

describe("href builders", () => {
  it("builds the routes the sheets and tables link to", () => {
    expect(deskHref(7)).toBe("/a/7");
    expect(holderHref(7, 2)).toBe("/a/7/holders/2");
    expect(payoutHref(7, 2)).toBe("/a/7/actions/payout/2");
    expect(withdrawHref(7, 2)).toBe("/a/7/actions/withdraw/2");
  });
});

describe("routeTitle", () => {
  it("names the surface and the account, with the brand last", () => {
    expect(routeTitle("Ledger", "Pooled — live")).toBe("Ledger · Pooled — live — Compound");
  });

  it("gives two different surfaces on the same account two different titles", () => {
    // The defect this exists to fix: every route under /a/[id] sharing one
    // <title>. Two calls for the same account must not collide.
    expect(routeTitle("Desk", "Pooled — live")).not.toBe(routeTitle("Ledger", "Pooled — live"));
  });

  it("gives the same surface on two different accounts two different titles", () => {
    // The other half of the same defect: a manager with two accounts open
    // in two tabs, both on the same route, needs the tab titles to tell
    // the accounts apart.
    expect(routeTitle("Desk", "Pooled — live")).not.toBe(routeTitle("Desk", "Pooled — second"));
  });

  it("takes no parameter a cents value could be handed to", () => {
    // A signature-level guard, not a runtime one: routeTitle(surface: string,
    // accountLabel: string) has nowhere to pass a Cents/bigint through even
    // by mistake. See route-titles.test.ts for the check that the seven real
    // pages actually call this rather than building their own title string.
    expect(routeTitle.length).toBe(2);
  });
});
