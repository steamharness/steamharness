import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { i18n } from "@steamharness/i18n";
import { ProjectAvatar } from "../ProjectAvatar";
import { UserIdentity } from "../UserIdentity";
import { AccountPage } from "../../pages/AccountPage";

describe("avatar interactions", () => {
  it("opens the upload picker when clicking the personal profile avatar", () => {
    render(<AccountPage tab="profile" me={null} apiKeys={[]} theme="light" localePreference="en"
      onRefresh={vi.fn()} onSaveProfile={vi.fn()} onThemeChange={vi.fn()} onLocalePreferenceChange={vi.fn()}
      onCreateApiKey={vi.fn()} onRevokeApiKey={vi.fn()} />);
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!, pick = vi.spyOn(input, "click");
    fireEvent.click(screen.getAllByRole("button", { name: i18n.t("accountAvatarUpload", { ns: "serverWeb" }) })[0]);
    expect(pick).toHaveBeenCalledOnce();
  });

  it("previews project avatars with the declared colors and returns focus to the trigger", async () => {
    render(<ProjectAvatar card={{ icon: "database", iconColor: "#123456", iconBackgroundColor: "#eeeeee" }} />);
    const trigger = screen.getByRole("button", { name: i18n.t("projectAvatarPreview", { ns: "serverWeb" }) });
    trigger.focus(); fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog");
    expect(decodeURIComponent(within(dialog).getByRole("img").getAttribute("src")!)).toContain('stroke="#123456"');
    fireEvent.keyDown(dialog, { key: "Escape" });
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("navigates through an avatar once without also activating the surrounding row", () => {
    const open = vi.fn(), row = vi.fn();
    render(<div onClick={row}><ProjectAvatar label="Example" onClick={open} /></div>);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("projectAvatarOpen", { ns: "serverWeb", name: "Example" }) }));
    expect(open).toHaveBeenCalledOnce(); expect(row).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows only the identity fields allowed by the caller and does not navigate the row", () => {
    const row = vi.fn();
    render(<div onClick={row}><UserIdentity user={{ displayName: "Alice", email: "alice@example.test", userId: "private-id" }} showUserId={false} /></div>);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("userIdentityDetails", { ns: "serverWeb", name: "Alice" }) }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("alice@example.test")).toBeTruthy();
    expect(within(dialog).queryByText("private-id")).toBeNull();
    expect(row).not.toHaveBeenCalled();
  });

  it("lets an account menu own the avatar click without nesting buttons", () => {
    const menu = vi.fn();
    render(<button onClick={menu}><UserIdentity user={{ displayName: "Alice" }} interactive={false} /></button>);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByText("AL")); expect(menu).toHaveBeenCalledOnce();
  });
});
