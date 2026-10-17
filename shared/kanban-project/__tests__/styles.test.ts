import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const kanbanStyles = readFileSync(
  resolve(import.meta.dirname, "../styles.css"),
  "utf8",
).replaceAll("\r\n", "\n");

const inputStyles = readFileSync(
  resolve(import.meta.dirname, "../run-workspace/styles.module.css"),
  "utf8",
).replaceAll("\r\n", "\n");

describe("Kanban settings style contract", () => {
  it("switches the shared workspace from a pane to a drawer by container width", () => {
    expect(kanbanStyles).toContain("container-name: kanban-workspace");
    expect(kanbanStyles).toContain("container-type: inline-size");
    expect(kanbanStyles).toContain("@container kanban-workspace (max-width: 760px)");
    expect(kanbanStyles).not.toContain("@media (max-width: 760px)");
    expect(kanbanStyles).toContain('.kanban-workspace[data-has-params="false"] .kanban-workspace-layout');
  });

  it("keeps settings controls continuous, stacked, and textarea-resizable", () => {
    expect(inputStyles).toContain(".rwi-params-form.settings");
    expect(inputStyles).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(inputStyles).toContain(".rwi-option-list.segmented");
    expect(inputStyles).toContain("grid-template-columns: repeat(auto-fit, minmax(min(72px, 100%), 1fr))");
    expect(inputStyles).not.toContain("min-width: min(92px, 100%)");
    expect(inputStyles).toContain(".rwi-option-color-swatch");
    expect(inputStyles).toContain("resize: vertical");
  });

  it("uses the shared theme status token for saved feedback", () => {
    expect(kanbanStyles).toContain("color: var(--state-success-fg, #166534)");
    expect(kanbanStyles).not.toContain("--color-success-fg");
  });

  it("keeps coarse-pointer toolbar actions at least 44 pixels wide", () => {
    expect(kanbanStyles).toMatch(/@media \(pointer: coarse\)[\s\S]*\.kanban-configuration-toolbar \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) 44px 44px/);
    expect(kanbanStyles).toMatch(/@media \(pointer: coarse\)[\s\S]*\.kanban-toolbar-icon-button \{[\s\S]*width: 44px/);
  });
});
