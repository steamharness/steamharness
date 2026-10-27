import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n, type ServerWebResourceKey } from "@steamharness/i18n";
import { AvatarCropDialog } from "../AvatarCropDialog";
import { AccountPage } from "../../pages/AccountPage";
import { cropAndCompressAvatar } from "@/lib/avatar-image";

vi.mock("@/lib/avatar-image", () => ({ cropAndCompressAvatar: vi.fn() }));

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

function loadImage() {
  const image = screen.getByAltText(label("accountAvatarCropImageAlt")) as HTMLImageElement;
  Object.defineProperties(image, { naturalWidth: { value: 1600 }, naturalHeight: { value: 800 } });
  vi.spyOn(image.parentElement!, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400, toJSON() {} });
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
    const image = loadImage();
    // Changing just the right edge must not force a matching height change.
    fireEvent.keyDown(within(dialog).getByRole("button", { name: label("accountAvatarCropHandleE") }), { key: "ArrowLeft", shiftKey: true });
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const crop = vi.mocked(cropAndCompressAvatar).mock.calls[0][1];
    expect(crop.width).toBeLessThan(100);
    expect(crop.height).toBe(100);
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

  it("restores the full original proportions with Use full image", async () => {
    const confirm = vi.fn();
    render(<AvatarCropDialog file={new File(["image"], "avatar.png")} onConfirm={confirm} onClose={vi.fn()} />);
    loadImage();
    fireEvent.keyDown(screen.getByRole("button", { name: label("accountAvatarCropHandleE") }), { key: "ArrowLeft" });
    fireEvent.click(screen.getByRole("button", { name: label("accountAvatarCropReset") }));
    fireEvent.click(screen.getByRole("button", { name: label("accountAvatarCropConfirm") }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(compressed));
    expect(vi.mocked(cropAndCompressAvatar).mock.calls[0][1]).toEqual({ unit: "%", x: 0, y: 0, width: 100, height: 100 });
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
