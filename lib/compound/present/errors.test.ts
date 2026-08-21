import { explainCommitError, isNextControlFlow } from "./errors";

describe("explainCommitError", () => {
  it("explains the interlock refusal in terms of what to do", () => {
    const msg = explainCommitError({ code: "CX002", message: "compound: reading crosses candidate" });
    expect(msg).toContain("unclassified capital event");
    expect(msg).toContain("Classify it in Review first");
    expect(msg).not.toContain("CX002");
  });

  it("explains a stale cursor without saying 'cursor'", () => {
    expect(explainCommitError({ code: "CX003" })).toContain("Readings only move forward");
  });

  it("explains the append-only guard in terms of what to do instead", () => {
    const msg = explainCommitError({ code: "CX010", message: "compound_ledger_entry is append-only: UPDATE refused." });
    expect(msg).toContain("reversing entry");
    expect(msg).not.toContain("CX010");
  });

  it.each([
    "CX001", "CX002", "CX003", "CX004", "CX005", "CX010",
    "CX101", "CX102",
    "CX201", "CX202", "CX203", "CX204", "CX205", "CX206", "CX207", "CX208", "CX209", "CX210", "CX211",
    "CX301", "CX302", "CX303", "CX304",
  ])(
    "has a sentence for %s",
    (code) => {
      const msg = explainCommitError({ code });
      expect(msg.length).toBeGreaterThan(20);
      expect(msg).not.toContain(code);
    },
  );

  it("passes a RangeError through, because the reconciler's own text is already the explanation", () => {
    const e = new RangeError("duplicate snapshot for tradeDate 2026-08-12 in the reading window");
    expect(explainCommitError(e)).toBe(e.message);
  });

  it("does not swallow an unrecognised code into a generic sentence with no signal", () => {
    // A code nobody handled must still surface the driver's own message, or a
    // new writer's refusal becomes invisible the day it is added.
    expect(explainCommitError(Object.assign(new Error("relation does not exist"), { code: "42P01" })))
      .toBe("relation does not exist");
  });

  it("has something to say about a value that is not an error at all", () => {
    expect(explainCommitError("boom")).toBe("Something went wrong and nothing was committed.");
  });

  it("has something to say about null", () => {
    expect(explainCommitError(null)).toBe("Something went wrong and nothing was committed.");
  });
});

describe("isNextControlFlow", () => {
  it("recognises a redirect throw, which must never be reported as a failure", () => {
    expect(isNextControlFlow({ digest: "NEXT_REDIRECT;replace;/a/7;307;" })).toBe(true);
    expect(isNextControlFlow({ digest: "NEXT_NOT_FOUND" })).toBe(true);
  });

  it("does not mistake a real error for one", () => {
    expect(isNextControlFlow(new Error("nope"))).toBe(false);
    expect(isNextControlFlow({ digest: 42 })).toBe(false);
    expect(isNextControlFlow({ code: "CX002" })).toBe(false);
  });
});
