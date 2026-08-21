/**
 * LiveChip gets incidental coverage from statement.test.tsx (it appears
 * inside StatementHead's live block). InterlockBanner and Notice do not
 * appear anywhere else in Task 4 — nothing in this plan renders them again
 * until Task 14's review queue and Task 8's desk. Since spec section 5.3
 * treats the interlock as a refusal to guess, not a staleness hint, its
 * exact wording and its role="status" are load-bearing, not decoration, so
 * this file tests both states directly rather than waiting for a later task
 * to exercise them by accident.
 */
import { render, screen } from "@testing-library/react";
import { InterlockBanner, LiveChip, Notice } from "./banner";

describe("LiveChip", () => {
  it("says the figure beside it is live and not yet posted, with its timestamp", () => {
    render(<LiveChip pushedAt="2026-08-18T09:14:22.000Z" />);
    expect(screen.getByText(/Live · not yet posted/)).toBeInTheDocument();
    expect(screen.getByText(/18 Aug 2026, 09:14 UTC/)).toBeInTheDocument();
  });
});

describe("InterlockBanner", () => {
  it("names the frozen date, the candidate date, and links to Review", () => {
    render(
      <InterlockBanner
        frozenAt="2026-06-30"
        candidateDate="2026-08-14"
        reviewHref="/a/7/review"
      />,
    );
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText(/Figures frozen at 30 Jun 2026\./)).toBeInTheDocument();
    expect(screen.getByText(/unexplained balance move on 14 Aug 2026/)).toBeInTheDocument();
    expect(screen.getByText(/NAV will not advance past 30 Jun 2026/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review it" })).toHaveAttribute("href", "/a/7/review");
  });

  it("says 'inception' rather than printing a date when nothing has posted yet", () => {
    render(
      <InterlockBanner frozenAt={null} candidateDate="2026-03-05" reviewHref="/a/9/review" />,
    );
    expect(screen.getByText(/Figures frozen at inception\./)).toBeInTheDocument();
    expect(screen.getByText(/NAV will not advance past inception/)).toBeInTheDocument();
    // The candidate date is a real date even when the frozen point is not.
    expect(screen.getByText(/unexplained balance move on 5 Mar 2026/)).toBeInTheDocument();
  });
});

describe("Notice", () => {
  it("renders its children as a status region", () => {
    render(<Notice>The reading was posted.</Notice>);
    expect(screen.getByRole("status").textContent).toBe("The reading was posted.");
  });
});
