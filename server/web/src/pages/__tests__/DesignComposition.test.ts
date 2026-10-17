import { describe, expect, it } from "vitest";
import usersPageSource from "../UsersPage.tsx?raw";
import versionsTabSource from "../detail/VersionsTab.tsx?raw";

describe("server web design composition", () => {
  it("uses table action composition for version downloads", () => {
    expect(versionsTabSource).toMatch(/<TableActionCell>[\s\S]*<IconActionButton[\s\S]*label=\{t\("storageDownload"\)\}/);
    expect(versionsTabSource).not.toContain("versionsOnlineAction");
    expect(versionsTabSource).not.toContain("versionsOfflineAction");
  });

  it("groups user role checkboxes with shadcn fieldset structure", () => {
    expect(usersPageSource).toContain("<FieldSet>");
    expect(usersPageSource).toContain("<FieldLegend variant=\"label\">{t(\"usersAssignableRoles\")}</FieldLegend>");
    expect(usersPageSource).toContain('FieldGroup data-slot="checkbox-group"');
  });
});
