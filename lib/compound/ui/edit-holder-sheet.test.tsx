import { render, screen } from "@testing-library/react";
import { EditHolderSheet, type EditHolderIdentity } from "./edit-holder-sheet";

const noop = async () => {};

const ADA: EditHolderIdentity = {
  id: 2, name: "Ada Lovelace", email: "ada@example.com", isManager: false, splitBps: 4000,
};
const MANAGER: EditHolderIdentity = {
  id: 1, name: "J. Marsh", email: null, isManager: true, splitBps: 0,
};

const base = { accountId: 7, backHref: "/a/7/holders/2", commitAction: noop };

describe("EditHolderSheet — step one, a non-manager holder", () => {
  it("pre-fills every field from the holder's current row, not an empty form", () => {
    render(<EditHolderSheet {...base} holder={ADA} form={{}} />);
    expect(screen.getByLabelText("Name")).toHaveValue("Ada Lovelace");
    expect(screen.getByLabelText("Email")).toHaveValue("ada@example.com");
    expect(screen.getByLabelText(/Your share of their profit/)).toHaveValue("40");
  });

  it("shows an empty email as an empty field, not the literal string null", () => {
    render(<EditHolderSheet {...base} holder={{ ...ADA, email: null }} form={{}} />);
    expect(screen.getByLabelText("Email")).toHaveValue("");
  });

  it("says a split change only reaches future payouts", () => {
    render(<EditHolderSheet {...base} holder={ADA} form={{}} />);
    expect(screen.getByText(/every payout already posted keeps the split it was paid at/i))
      .toBeInTheDocument();
  });

  it("shows a refusal from a previous attempt", () => {
    render(
      <EditHolderSheet
        {...base} holder={ADA} form={{}} error="That holder is not on this account."
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("That holder is not on this account");
    expect(screen.getByRole("alert").textContent).toContain("Nothing was committed");
  });

  it("a holder whose split really is zero shows 0, not a blank field — 0 is falsy, not absent", () => {
    render(<EditHolderSheet {...base} holder={{ ...ADA, splitBps: 0 }} form={{}} />);
    expect(screen.getByLabelText(/Your share of their profit/)).toHaveValue("0");
  });
});

describe("EditHolderSheet — step one, the manager's own row", () => {
  it("offers no split field at all", () => {
    render(<EditHolderSheet {...base} holder={MANAGER} form={{}} />);
    expect(screen.queryByLabelText(/share of their profit/i)).toBeNull();
  });

  it("still offers name and email", () => {
    render(<EditHolderSheet {...base} holder={MANAGER} form={{}} />);
    expect(screen.getByLabelText("Name")).toHaveValue("J. Marsh");
    expect(screen.getByLabelText("Email")).toHaveValue("");
  });
});

describe("EditHolderSheet — confirm step, a name and email change", () => {
  beforeEach(() =>
    render(
      <EditHolderSheet
        {...base} holder={ADA}
        form={{ step: "confirm", name: "Ada Byron", email: "ada.byron@example.com", split: "40" }}
      />,
    ));

  it("shows the old value and the new value for every changed field", () => {
    expect(screen.getByLabelText("Name").textContent).toBe("Ada Lovelace → Ada Byron");
    expect(screen.getByLabelText("Email").textContent)
      .toBe("ada@example.com → ada.byron@example.com");
  });

  it("shows an unchanged field plainly, with no arrow", () => {
    expect(screen.getByLabelText("Split").textContent).toBe("60 / 40");
  });

  it("names the holder on the button", () => {
    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
  });

  it("carries every field forward as a hidden input, including the holder id", () => {
    const form = screen.getByRole("button", { name: "Save changes" }).closest("form")!;
    const hidden = (name: string) => form.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    expect(hidden("accountId")).toHaveValue("7");
    expect(hidden("holderId")).toHaveValue("2");
    expect(hidden("name")).toHaveValue("Ada Byron");
    expect(hidden("email")).toHaveValue("ada.byron@example.com");
    expect(hidden("split")).toHaveValue("40");
  });
});

describe("EditHolderSheet — confirm step, a split change", () => {
  it("shows the split ratio moving, and explains the new terms in a sentence", () => {
    render(
      <EditHolderSheet
        {...base} holder={ADA}
        form={{ step: "confirm", name: "Ada Lovelace", email: "ada@example.com", split: "25" }}
      />,
    );
    expect(screen.getByLabelText("Split").textContent).toBe("60 / 40 → 75 / 25");
    expect(screen.getByText(/Ada Lovelace keeps 75% of profit and you keep 25%/))
      .toBeInTheDocument();
  });

  it("says nothing about new terms when the split did not change", () => {
    render(
      <EditHolderSheet
        {...base} holder={ADA}
        form={{ step: "confirm", name: "Ada Lovelace", email: "ada@example.com", split: "40" }}
      />,
    );
    expect(screen.queryByText(/keeps .*% of profit and you keep/)).toBeNull();
  });
});

describe("EditHolderSheet — confirm step, the manager's own row", () => {
  beforeEach(() =>
    render(
      <EditHolderSheet
        {...base} holder={MANAGER}
        form={{ step: "confirm", name: "Jamie Marsh", email: "" }}
      />,
    ));

  it("shows no split line at all", () => {
    expect(screen.queryByLabelText("Split")).toBeNull();
  });

  it("forces the hidden split field to 0 regardless of what the query string might carry", () => {
    const form = screen.getByRole("button", { name: "Save changes" }).closest("form")!;
    expect(form.querySelector<HTMLInputElement>('input[name="split"]')).toHaveValue("0");
  });

  it("still shows the name change", () => {
    expect(screen.getByLabelText("Name").textContent).toBe("J. Marsh → Jamie Marsh");
  });
});
