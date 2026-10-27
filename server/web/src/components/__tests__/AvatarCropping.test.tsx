import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n, type ServerWebResourceKey } from "@steamharness/i18n";
import { AvatarCropDialog } from "../AvatarCropDialog";
import { AccountPage } from "../../pages/AccountPage";
import { UsersPage } from "../../pages/UsersPage";
import type { AdminUserSummary } from "../../types";
import { cropAndCompressAvatar } from "@/lib/avatar-image";

vi.mock("@/lib/avatar-image", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/avatar-image")>(),
  cropAndCompressAvatar: vi.fn(),
}));

const label = (key: ServerWebResourceKey) => i18n.t(key, { ns: "serverWeb" });
const compressed = "data:image/webp;base64,YXZhdGFy";
const createObjectURL = vi.fn(() => "blob:avatar-source");
const revokeObjectURL = vi.fn();

beforeEach(() => {
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = createObjectURL;
    static revokeObjectURL = revokeObjectURL;
  });
  vi.mocked(cropAndCompressAvatar).mockResolvedValue(compressed);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function loadImage(naturalWidth = 1600, naturalHeight = 800, width = 800, height = 400) {
  const image = screen.getByAltText(label("accountAvatarCropImageAlt")) as HTMLImageElement;
  Object.defineProperties(image, { naturalWidth: { value: naturalWidth }, naturalHeight: { value: naturalHeight } });
  vi.spyOn(image.parentElement!, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON() {} });
  fireEvent.load(image);
  return image;
}

function renderProfile(onSaveProfile = vi.fn()) {
  return render(<AccountPage tab="profile" me={null} apiKeys={[]} theme="light" localePreference="en"
    onRefresh={vi.fn()} onSaveProfile={onSaveProfile} onThemeChange={vi.fn()} onLocalePreferenceChange={vi.fn()}
    onCreateApiKey={vi.fn()} onRevokeApiKey={vi.fn()} />);
}

function chooseFile(file = new File([new Uint8Array(2 * 1024 * 1024)], "large-avatar.png", { type: "image/png" })) {
  fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [file] } });
  return file;
}

describe("avatar crop workflow", () => {
  it("uses the same square crop and compression before uploading a managed user's avatar", async () => {
    const user: AdminUserSummary = {
      userId: "user-1", displayName: "Alice", email: "alice@example.test", status: "active", isSystemAdmin: false,
    };
    const updateAvatar = vi.fn(), updateUser = vi.fn();
    render(<UsersPage users={[user]} total={1} page={1} pageSize={20} totalPages={1}
      onRefresh={vi.fn()} onInvite={vi.fn()} onUpdateUser={updateUser} onUpdateAdministrator={vi.fn()}
      onUpdateAvatar={updateAvatar} onSearch={vi.fn()} onPageChange={vi.fn()} onFetchInviteLink={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("usersManageAria", { ns: "serverWeb", displayName: user.displayName }) }));
    const manage = screen.getByRole("dialog", { name: i18n.t("usersManageTitle", { ns: "serverWeb", displayName: user.displayName }) });
    const file = new File(["original"], "original.png", { type: "image/png" });
    fireEvent.change(within(manage).getByLabelText(label("usersEditAvatarLabel")), { target: { files: [file] } });
    expect(updateAvatar).not.toHaveBeenCalled();
    loadImage();
    fireEvent.click(screen.getByRole("button", { name: label("accountAvatarCropConfirm") }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: label("accountAvatarCropTitle") })).toBeNull());
    expect(updateAvatar).not.toHaveBeenCalled();
    expect(cropAndCompressAvatar).toHaveBeenCalledWith(expect.any(HTMLImageElement), { unit: "%", x: 25, y: 0, width: 50, height: 100 });
    fireEvent.click(within(manage).getByRole("button", { name: label("accountProfileSave") }));
    expect(updateAvatar).toHaveBeenCalledOnce();
    const uploaded = updateAvatar.mock.calls[0][1] as File;
    expect(uploaded).not.toBe(file);
    expect(uploaded.name).toBe("avatar.webp");
    expect(uploaded.type).toBe("image/webp");
    expect(uploaded.size).toBe(6);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("accepts sources larger than 512 KB and only saves the compressed selection after confirmation", async () => {
    const save = vi.fn();
    renderProfile(save);
    const file = chooseFile();
    const dialog = screen.getByRole("dialog", { name: label("accountAvatarCropTitle") });
    expect(createObjectURL).toHaveBeenCalledWith(file);
    const confirm = within(dialog).getByRole("button", { name: label("accountAvatarCropConfirm") });
    expect(confirm).toBeDisabled();
    expect(save).not.toHaveBeenCalled();
    expect(cropAndCompressAvatar).not.toHaveBeenCalled();
    expect(screen.getByRole("status", { name: i18n.t("imagePreviewLoading", { ns: "common" }) })).toBeVisible();
    const image = loadImage();
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.keyDown(within(dialog).getByRole("button", { name: label("accountAvatarCropHandleSE") }), { key: "ArrowLeft", shiftKey: true });
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const crop = vi.mocked(cropAndCompressAvatar).mock.calls[0][1];
    expect(crop.width).toBeLessThan(50);
    expect(1600 * crop.width).toBeCloseTo(800 * crop.height);
    expect(cropAndCompressAvatar).toHaveBeenCalledWith(image, crop);
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: label("accountProfileSave") }));
    expect(save).toHaveBeenCalledWith({ displayName: "", avatarUrl: compressed });
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:avatar-source");
  });

  it("cancels without changing the profile and releases images when leaving the page", () => {
    const page = renderProfile();
    chooseFile();
    fireEvent.click(screen.getByRole("button", { name: label("commonCancel") }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: label("accountProfileSave") })).toBeDisabled();
    expect(cropAndCompressAvatar).not.toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    chooseFile();
    page.unmount();
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it("retains a confirmed avatar when a replacement cannot be read and is canceled", async () => {
    const save = vi.fn();
    renderProfile(save);
    chooseFile();
    loadImage();
    fireEvent.click(screen.getByRole("button", { name: label("accountAvatarCropConfirm") }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    chooseFile();
    fireEvent.error(screen.getByAltText(label("accountAvatarCropImageAlt")));
    fireEvent.click(screen.getByRole("button", { name: label("commonCancel") }));
    fireEvent.click(screen.getByRole("button", { name: label("accountProfileSave") }));
    expect(save).toHaveBeenCalledWith({ displayName: "", avatarUrl: compressed });
  });

  it("restores the largest centered square after the selection is collapsed", async () => {
    const confirm = vi.fn();
    render(<AvatarCropDialog file={new File(["image"], "avatar.png")} onConfirm={confirm} onClose={vi.fn()} />);
    loadImage(1600, 800, 100, 50);
    fireEvent.keyDown(screen.getByRole("button", { name: label("accountAvatarCropHandleSE") }), { key: "ArrowLeft", ctrlKey: true, metaKey: true });
    expect(screen.getByRole("button", { name: label("accountAvatarCropConfirm") })).toBeDisabled();
    expect(cropAndCompressAvatar).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: label("accountAvatarCropReset") }));
    fireEvent.click(screen.getByRole("button", { name: label("accountAvatarCropConfirm") }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(compressed));
    expect(vi.mocked(cropAndCompressAvatar).mock.calls[0][1]).toEqual({ unit: "%", x: 25, y: 0, width: 50, height: 100 });
  });

  it.each([
    { kind: "tiny", naturalWidth: 10, naturalHeight: 15, width: 264, height: 396 },
    { kind: "portrait", naturalWidth: 900, naturalHeight: 1600, width: 222.75, height: 396 },
    { kind: "landscape", naturalWidth: 1600, naturalHeight: 900, width: 704, height: 396 },
  ])("keeps $kind images square when resizing the crop after preview scaling", async ({ naturalWidth, naturalHeight, width, height }) => {
    const confirm = vi.fn();
    render(<AvatarCropDialog file={new File(["image"], "avatar.png")} onConfirm={confirm} onClose={vi.fn()} />);
    const image = loadImage(naturalWidth, naturalHeight, width, height);
    fireEvent.keyDown(screen.getByRole("button", { name: label("accountAvatarCropHandleSE") }), { key: "ArrowLeft", shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: label("accountAvatarCropConfirm") }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(compressed));
    const crop = vi.mocked(cropAndCompressAvatar).mock.calls[0][1];
    expect(crop.width).toBeGreaterThan(0);
    expect(crop.width).toBeLessThan(100);
    expect(naturalWidth * crop.width).toBeCloseTo(naturalHeight * crop.height);
    expect(cropAndCompressAvatar).toHaveBeenCalledWith(image, crop);
  });

  it("reports decoded images without usable dimensions rather than enabling processing", () => {
    renderProfile();
    chooseFile();
    loadImage(0, 0);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(label("accountAvatarErrorReadFailed"));
    expect(screen.getByRole("button", { name: label("accountAvatarCropConfirm") })).toBeDisabled();
    expect(cropAndCompressAvatar).not.toHaveBeenCalled();
  });

  it("shows processing failures and allows retrying without losing the selection", async () => {
    vi.mocked(cropAndCompressAvatar).mockRejectedValueOnce(new Error("encoding unavailable"));
    const confirm = vi.fn();
    render(<AvatarCropDialog file={new File(["image"], "avatar.png")} onConfirm={confirm} onClose={vi.fn()} />);
    loadImage();
    fireEvent.click(screen.getByRole("button", { name: label("accountAvatarCropConfirm") }));
    expect(await screen.findByRole("alert")).toHaveTextContent(label("accountAvatarErrorProcessFailed"));
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: label("accountAvatarCropConfirm") }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(compressed));
  });

  it("reports unreadable images without changing the draft", () => {
    renderProfile();
    chooseFile();
    fireEvent.error(screen.getByAltText(label("accountAvatarCropImageAlt")));
    expect(screen.getByRole("alert")).toHaveTextContent(label("accountAvatarErrorReadFailed"));
    expect(screen.getByRole("button", { name: label("accountAvatarCropConfirm") })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: label("commonCancel") }));
    expect(screen.getByRole("button", { name: label("accountProfileSave") })).toBeDisabled();
  });

  it("prevents duplicate processing and discards results after unmount", async () => {
    let resolve!: (value: string) => void;
    vi.mocked(cropAndCompressAvatar).mockReturnValue(new Promise(done => { resolve = done; }));
    const confirm = vi.fn(), close = vi.fn();
    const page = render(<AvatarCropDialog file={new File(["image"], "avatar.png")} onConfirm={confirm} onClose={close} />);
    loadImage();
    fireEvent.click(screen.getByRole("button", { name: label("accountAvatarCropConfirm") }));
    const processing = screen.getByRole("button", { name: label("accountAvatarProcessing") });
    fireEvent.click(processing);
    expect(processing).toBeDisabled();
    expect(screen.getByRole("button", { name: label("commonCancel") })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
    expect(cropAndCompressAvatar).toHaveBeenCalledTimes(1);
    page.unmount();
    await act(async () => resolve(compressed));
    expect(confirm).not.toHaveBeenCalled();
  });
});
