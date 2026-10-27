import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@steamharness/i18n";
import { ProjectAvatar } from "../ProjectAvatar";
import { UserIdentity } from "../UserIdentity";
import { AccountPage } from "../../pages/AccountPage";
import { FilePickerField } from "../ui/composites";

afterEach(() => vi.restoreAllMocks());

function loadAvatarImages() {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(1024);
}

const previewLabel = (name: string) => i18n.t("attachmentPreview", { ns: "common", name });

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

  it("previews the current avatar draft without uploading, submitting, or activating the surrounding row", async () => {
    loadAvatarImages();
    const change = vi.fn(), submit = vi.fn(event => event.preventDefault()), row = vi.fn();
    const field = (src: string) => <div onClick={row}><form onSubmit={submit}>
      <FilePickerField id="avatar-file" label="Avatar" chooseLabel="Choose image"
        preview={{ src, alt: "Alice", fallback: "AL" }} onFileChange={change} />
    </form></div>;
    const view = render(field("/avatar-draft.webp"));
    const input = screen.getByLabelText("Avatar"), pick = vi.spyOn(input, "click");
    const trigger = screen.getByRole("button", { name: previewLabel("Alice") });
    trigger.focus(); fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: previewLabel("Alice") });
    expect(await within(dialog).findByRole("img", { name: "Alice" })).toHaveAttribute("src", "/avatar-draft.webp");
    view.rerender(field("/avatar-replaced.webp"));
    await vi.waitFor(() => expect(within(dialog).getByRole("img")).toHaveAttribute("src", "/avatar-replaced.webp"));
    fireEvent.click(within(dialog).getByRole("img"));
    expect(change).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
    expect(row).not.toHaveBeenCalled(); expect(pick).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: i18n.t("commonClose", { ns: "serverWeb" }) }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
    fireEvent.click(screen.getByRole("button", { name: "Choose image" }));
    expect(pick).toHaveBeenCalledOnce();
  });

  it.each(["", "/unavailable-avatar.webp"])("previews fallback initials when the avatar source is %s", (src) => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
    render(<FilePickerField id="avatar-file" label="Avatar" preview={{ src, fallback: "AL", alt: "Alice" }} onFileChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: previewLabel("Alice") }));
    expect(within(screen.getByRole("dialog")).getByText("AL")).toBeVisible();
  });

  it("opens a larger avatar from profile details and closes one dialog at a time", async () => {
    loadAvatarImages();
    const row = vi.fn();
    render(<div onClick={row}><UserIdentity user={{ displayName: "Alice", email: "alice@example.test", userId: "private-id", avatarUrl: "/alice.webp" }} showUserId={false} /></div>);
    const profile = screen.getByRole("button", { name: i18n.t("userIdentityDetails", { ns: "serverWeb", name: "Alice" }) });
    profile.focus(); fireEvent.click(profile);
    const trigger = within(screen.getByRole("dialog", { name: "Alice" })).getByRole("button", { name: previewLabel("Alice") });
    trigger.focus(); fireEvent.click(trigger);
    const preview = screen.getByRole("dialog", { name: previewLabel("Alice") });
    expect(await within(preview).findByRole("img", { name: "Alice" })).toHaveAttribute("src", "/alice.webp");
    expect(within(preview).queryByText("private-id")).toBeNull();
    fireEvent.keyDown(preview, { key: "Escape" });
    await vi.waitFor(() => expect(screen.queryByRole("dialog", { name: previewLabel("Alice") })).toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
    const details = screen.getByRole("dialog", { name: "Alice" });
    expect(within(details).getByText("alice@example.test")).toBeVisible();
    fireEvent.keyDown(details, { key: "Escape" });
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(profile));
    expect(row).not.toHaveBeenCalled();
  });
});
