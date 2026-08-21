import { render, screen } from "@testing-library/react";
import { fold } from "@/lib/compound/engine/replay";
import { railSegments } from "@/lib/compound/present/rail";
import { HOLDER_NAMES, LEDGER, SEEDS } from "@/lib/compound/present/fixture";
import { OwnershipRail } from "./rail";

const SEGMENTS = railSegments(fold(LEDGER, SEEDS), HOLDER_NAMES);

describe("OwnershipRail", () => {
  it("fills the rail exactly — the widths sum to 100 percent", () => {
    const { container } = render(<OwnershipRail segments={SEGMENTS} />);
    const widths = [...container.querySelectorAll<HTMLElement>(".seg")]
      .map((s) => Number(s.style.width.replace("%", "")));
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 4);
  });

  it("gives the manager the darkest segment", () => {
    const { container } = render(<OwnershipRail segments={SEGMENTS} />);
    const first = container.querySelector<HTMLElement>(".seg")!;
    expect(first.style.background).toBe("rgb(20, 83, 45)");   // #14532d
  });

  it("labels every segment with a name and a percentage", () => {
    render(<OwnershipRail segments={SEGMENTS} />);
    const items = screen.getByRole("list", { name: "Ownership legend" });
    expect(items.textContent).toContain("J. Marsh (manager)");
    expect(items.textContent).toContain("62.15%");
    expect(items.textContent).toContain("Ada Lovelace");
    expect(items.textContent).toContain("22.66%");
    expect(items.textContent).toContain("Grace Hopper");
    expect(items.textContent).toContain("15.19%");
  });

  it("names the rail for a screen reader rather than leaving a bare div", () => {
    render(<OwnershipRail segments={SEGMENTS} />);
    expect(screen.getByRole("img", { name: "Ownership by holder" })).toBeInTheDocument();
  });

  it("renders nothing at all when no one holds units", () => {
    const { container } = render(<OwnershipRail segments={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
