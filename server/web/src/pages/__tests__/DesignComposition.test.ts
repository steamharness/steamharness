import { describe, expect, it } from "vitest";
import usersPageSource from "../UsersPage.tsx?raw";
import versionsTabSource from "../detail/VersionsTab.tsx?raw";

describe("server web design composition", () => {
  it("uses table action composition for version downloads", () => {
    expect(versionsTabSource).toMatch(/<TableActionCell>[\s\S]*<IconActionButton[\s\S]*label=\{t\("storageDownload"\)\}/);
    expect(versionsTabSource).not.toContain("versionsOnlineAction");
    expect(versionsTabSource).not.toContain("versionsOfflineAction");
  });

  it("only exposes the fixed administrator account setting", () => {
    expect(usersPageSource).toContain('isSystemAdmin');
    expect(usersPageSource).not.toContain('usersAssignableRoles');
  });
});
