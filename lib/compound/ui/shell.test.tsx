/**
 * AccountMain and SkipToContent, rendered together the way
 * app/a/[id]/layout.tsx composes them — SkipToContent first, AccountMain
 * wrapping the content — so the one property that actually matters (the
 * link's href reaches the landmark's own id) is asserted as a relationship
 * between two independently rendered elements, not by repeating the same
 * literal in the test that the source already hard-codes.
 */
import { render, screen } from "@testing-library/react";
import { AccountMain, SkipToContent } from "./shell";

function renderShell(content = <p>Page content</p>) {
  return render(
    <>
      <SkipToContent />
      <header>Masthead stands in for the real one</header>
      <AccountMain>{content}</AccountMain>
    </>,
  );
}

describe("AccountMain", () => {
  it("is a <main> landmark", () => {
    renderShell();
    expect(screen.getByRole("main")).toBeInTheDocument();
  });

  it("renders its children inside the landmark", () => {
    renderShell(<p>Only the desk reads this</p>);
    expect(screen.getByRole("main")).toHaveTextContent("Only the desk reads this");
  });

  it("is programmatically focusable, so the skip link's jump actually moves focus", () => {
    // Without tabIndex={-1}, an in-page #hash link scrolls the viewport but
    // leaves focus on the link itself — a screen reader keeps announcing the
    // masthead as "next" instead of the content that just scrolled in.
    renderShell();
    expect(screen.getByRole("main")).toHaveAttribute("tabindex", "-1");
  });
});

describe("SkipToContent", () => {
  it("links to the id AccountMain actually renders, not a copy of it", () => {
    renderShell();
    const main = screen.getByRole("main");
    const link = screen.getByRole("link", { name: "Skip to content" });
    expect(main).toHaveAttribute("id");
    expect(link).toHaveAttribute("href", `#${main.getAttribute("id")}`);
  });
});
