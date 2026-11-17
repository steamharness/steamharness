import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "@steamharness/i18n/react";
import { apiClient } from "../api";
import { AccountSecurityPage } from "../pages/AccountSecurityPage";
import type { AccountSecurity } from "../components/AccountSecurityAction";

const ok = (data: unknown) => ({ errCode: 0, errMessage: "", data }) as any;
const bound: AccountSecurity = { username: "user", email: "current@example.test", emailVerifiedAt: "2026-01-01", hasPassword: true };
const unbound: AccountSecurity = { ...bound, email: null, emailVerifiedAt: null };
function mockAccount(security = bound, mailAvailable = true) {
  return vi.spyOn(apiClient, "authAction").mockImplementation(async (path, body: any) => {
    if (path === "/me/security") return ok(security);
    if (path === "/config") return ok({ mailAvailable });
    if (path === "/email-code/send") return ok({ challengeId: body.purpose, retryAfterSeconds: 60 });
    return ok({});
  });
}
async function open(title: string) {
  fireEvent.click(await screen.findByRole("button", { name: title }));
  return within(screen.getByRole("dialog", { name: title }));
}
function next() { fireEvent.click(screen.getByRole("button", { name: "Continue to identity verification" })); }
function passwordDetails() {
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: "new-password" } });
  fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "new-password" } });
}
async function newEmail(address = "new@example.test") {
  fireEvent.change(screen.getByLabelText("New email"), { target: { value: address } });
  fireEvent.click(screen.getByRole("button", { name: "Send code to new email" }));
  await screen.findByText(`A verification code was sent to ${address}.`);
  fireEvent.change(screen.getByLabelText("Code from new email"), { target: { value: "111111" } });
}
beforeEach(async () => { await i18n.changeLanguage("en"); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it.each([
  [unbound, ["Bind email", "Change password"]],
  [{ ...bound, emailVerifiedAt: null }, ["Verify email", "Change email", "Unbind email", "Change password"]],
  [bound, ["Change email", "Unbind email", "Change password"]],
  [{ ...bound, username: null, hasPassword: false }, ["Change email", "Unbind email", "Set password", "Set username"]],
] as const)("shows independent entries for account state %# without opening sensitive forms", async (security, actions) => {
  mockAccount(security);
  render(<AccountSecurityPage onChanged={vi.fn()} />);
  await screen.findByRole("heading", { name: "Account security" });
  for (const name of actions) expect(screen.getByRole("button", { name })).toBeVisible();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByLabelText("Current password")).toBeNull();
  expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  if (!security.username || !security.hasPassword) expect(screen.getByRole("button", { name: "Unbind email" })).toBeDisabled();
});

it("keeps new-email inputs apart from current-password autofill and clears both on cancel", async () => {
  const action = mockAccount(unbound);
  render(<AccountSecurityPage onChanged={vi.fn()} />);
  await open("Bind email");
  expect(screen.getByLabelText("New email")).toHaveAttribute("name", "new-email");
  expect(screen.getByLabelText("New email")).toHaveAttribute("autocomplete", "section-security-target email");
  expect(screen.queryByLabelText("Current password")).toBeNull();
  await newEmail(); next();
  expect(screen.queryByLabelText("New email")).toBeNull();
  expect(screen.queryByLabelText("Code from new email")).toBeNull();
  fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "secret-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await open("Change password");
  expect(screen.getByLabelText("New password")).toHaveValue("");
  expect(screen.queryByLabelText("New email")).toBeNull();
  passwordDetails(); next();
  expect(screen.getByLabelText("Current password")).toHaveValue("");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await open("Bind email");
  expect(screen.getByLabelText("New email")).toHaveValue("");
  expect(screen.getByLabelText("Code from new email")).toHaveValue("");
  expect(screen.getByLabelText("Code from new email")).toBeDisabled();
  expect(action).not.toHaveBeenCalledWith("/me/email", expect.anything());
});

it("verifies an existing unverified address without turning it into a change-email form", async () => {
  const action = mockAccount({ ...bound, emailVerifiedAt: null });
  const changed = vi.fn();
  render(<AccountSecurityPage onChanged={changed} />);
  const dialog = await open("Verify email");
  expect(dialog.getByLabelText("Email")).toHaveValue(bound.email);
  expect(dialog.getByLabelText("Email")).toHaveAttribute("readonly");
  expect(dialog.queryByLabelText("New email")).toBeNull();
  fireEvent.click(dialog.getByRole("button", { name: "Send code" }));
  await screen.findByText("A verification code was sent to current@example.test.");
  fireEvent.change(screen.getByLabelText("Email verification code"), { target: { value: "111111" } });
  next();
  fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "old-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Verify email" }));
  await waitFor(() => expect(changed).toHaveBeenCalledWith(true));
  expect(action).toHaveBeenCalledWith("/me/email", { action: "bind", challengeId: "bind-email", code: "111111", currentPassword: "old-password" });
});

it("keeps new-email proof and current-email identity proof separate during a change", async () => {
  const action = mockAccount();
  const changed = vi.fn();
  render(<AccountSecurityPage onChanged={changed} />);
  await open("Change email");
  await newEmail(); next();
  fireEvent.click(screen.getByRole("radio", { name: "Code from current email" }));
  fireEvent.click(screen.getByRole("button", { name: "Send code to current email" }));
  await screen.findByText("A code to confirm your identity was sent to current@example.test.");
  expect(screen.queryByLabelText("Code from new email")).toBeNull();
  fireEvent.change(screen.getByLabelText("Code from current email"), { target: { value: "222222" } });
  fireEvent.click(screen.getByRole("button", { name: "Change email" }));
  await waitFor(() => expect(changed).toHaveBeenCalledWith(true));
  expect(action).toHaveBeenCalledWith("/email-code/send", { email: "new@example.test", purpose: "bind-email" });
  expect(action).toHaveBeenCalledWith("/email-code/send", { email: bound.email, purpose: "reauth" });
  expect(action).toHaveBeenCalledWith("/me/email", { action: "bind", challengeId: "bind-email", code: "111111", reauthChallengeId: "reauth", reauthCode: "222222" });
});

it("unbinds directly with current-email proof and never requests a target email", async () => {
  const action = mockAccount();
  render(<AccountSecurityPage onChanged={vi.fn()} />);
  const dialog = await open("Unbind email");
  expect(dialog.queryByLabelText("New email")).toBeNull();
  expect(dialog.queryByRole("button", { name: "Continue to identity verification" })).toBeNull();
  fireEvent.click(dialog.getByRole("radio", { name: "Code from current email" }));
  fireEvent.click(dialog.getByRole("button", { name: "Send code to current email" }));
  await screen.findByText("A code to confirm your identity was sent to current@example.test.");
  fireEvent.change(screen.getByLabelText("Code from current email"), { target: { value: "222222" } });
  fireEvent.click(screen.getByRole("button", { name: "Unbind email" }));
  await waitFor(() => expect(action).toHaveBeenCalledWith("/me/email", { action: "unbind", reauthChallengeId: "reauth", reauthCode: "222222" }));
  expect(action.mock.calls.filter(([path]) => path === "/email-code/send")).toHaveLength(1);
});

it("discards a cancelled request's challenge, preserves its delivery limit, and allows other operations", async () => {
  const action = mockAccount(unbound);
  let finish!: (value: any) => void;
  action.mockImplementation(async path => path === "/me/security" ? ok(unbound) : path === "/config" ? ok({ mailAvailable: true })
    : new Promise(done => { finish = done; }));
  render(<AccountSecurityPage onChanged={vi.fn()} />);
  await open("Bind email");
  fireEvent.change(screen.getByLabelText("New email"), { target: { value: "new@example.test" } });
  fireEvent.click(screen.getByRole("button", { name: "Send code to new email" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await open("Bind email");
  fireEvent.change(screen.getByLabelText("New email"), { target: { value: "new@example.test" } });
  expect(screen.getByRole("button", { name: "Send code to new email" })).toBeDisabled();
  await act(async () => finish(ok({ challengeId: "stale", retryAfterSeconds: 60 })));
  expect(screen.getByLabelText("Code from new email")).toBeDisabled();
  expect(screen.queryByText("A verification code was sent to new@example.test.")).toBeNull();
  expect(screen.getByRole("button", { name: /Resend in/ })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Continue to identity verification" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await open("Change password");
  expect(screen.getByLabelText("New password")).toBeEnabled();
  expect(action.mock.calls.filter(([path]) => path === "/email-code/send")).toHaveLength(1);
});

it("validates the target email, invalidates its code on edit, and rejects rebinding the same address", async () => {
  const action = mockAccount();
  render(<AccountSecurityPage onChanged={vi.fn()} />);
  await open("Change email");
  fireEvent.change(screen.getByLabelText("New email"), { target: { value: "user" } });
  fireEvent.click(screen.getByRole("button", { name: "Send code to new email" }));
  expect(action.mock.calls.filter(([path]) => path === "/email-code/send")).toHaveLength(0);
  await newEmail();
  fireEvent.change(screen.getByLabelText("New email"), { target: { value: "CURRENT@example.test" } });
  expect(screen.getByLabelText("Code from new email")).toHaveValue("");
  expect(screen.getByRole("button", { name: "Send code to new email" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Continue to identity verification" })).toBeDisabled();
});

it("enforces password confirmation, clears proof on back, and blocks duplicate commits and dismissal", async () => {
  const action = mockAccount();
  render(<AccountSecurityPage onChanged={vi.fn()} />);
  await open("Change password"); passwordDetails();
  fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "different-password" } });
  next();
  expect(screen.getByRole("alert")).toHaveTextContent("The passwords do not match.");
  expect(screen.queryByLabelText("Current password")).toBeNull();
  passwordDetails(); next();
  fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "old-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Back to details" }));
  next();
  expect(screen.getByLabelText("Current password")).toHaveValue("");
  fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "old-password" } });
  let finish!: (value: any) => void;
  action.mockImplementation(() => new Promise(done => { finish = done; }));
  const form = screen.getByLabelText("Current password").closest("form")!;
  fireEvent.submit(form); fireEvent.submit(form);
  expect(screen.getByRole("button", { name: "Change password" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.getByRole("dialog")).toBeVisible();
  expect(action.mock.calls.filter(([path]) => path === "/me/password")).toHaveLength(1);
  await act(async () => finish({ errCode: 401, errMessage: "Wrong current password" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Wrong current password");
  expect(screen.getByLabelText("Current password")).toHaveValue("");
  expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await open("Change email");
  expect(screen.queryByText("Wrong current password")).toBeNull();
});

it("shares only the current-email delivery countdown when switching operations, never the proof", async () => {
  const action = mockAccount();
  render(<AccountSecurityPage onChanged={vi.fn()} />);
  await open("Change password"); passwordDetails(); next();
  fireEvent.click(screen.getByRole("radio", { name: "Code from current email" }));
  fireEvent.click(screen.getByRole("button", { name: "Send code to current email" }));
  await screen.findByText("A code to confirm your identity was sent to current@example.test.");
  fireEvent.change(screen.getByLabelText("Code from current email"), { target: { value: "222222" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await open("Unbind email");
  fireEvent.click(screen.getByRole("radio", { name: "Code from current email" }));
  expect(screen.getByLabelText("Code from current email")).toHaveValue("");
  expect(screen.getByLabelText("Code from current email")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Send code to current email" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Unbind email" })).toBeDisabled();
  expect(action.mock.calls.filter(([path]) => path === "/email-code/send")).toHaveLength(1);
});

it.each([true, false])("offers only usable operations when mail is unavailable (password: %s)", async hasPassword => {
  mockAccount({ ...bound, username: null, hasPassword }, false);
  render(<AccountSecurityPage onChanged={vi.fn()} />);
  await screen.findByRole("heading", { name: "Account security" });
  expect(screen.getByRole("button", { name: "Change email" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Unbind email" })).toBeDisabled();
  const password = screen.getByRole("button", { name: hasPassword ? "Change password" : "Set password" });
  if (hasPassword) {
    expect(password).toBeEnabled();
    expect(screen.getByRole("button", { name: "Set username" })).toBeEnabled();
  } else {
    expect(password).toBeDisabled();
    expect(screen.getByRole("button", { name: "Set username" })).toBeDisabled();
  }
  if (hasPassword) {
    await open("Change password"); passwordDetails(); next();
    expect(screen.getByLabelText("Current password")).toBeEnabled();
    expect(screen.queryByRole("radio", { name: "Code from current email" })).toBeNull();
  } else expect(screen.getByText("No identity verification method is available. Contact your administrator for help.")).toBeVisible();
});

it("allows password-based unbinding while mail is unavailable", async () => {
  mockAccount(bound, false);
  render(<AccountSecurityPage onChanged={vi.fn()} />);
  const dialog = await open("Unbind email");
  expect(dialog.getByLabelText("Current password")).toBeEnabled();
  expect(dialog.queryByLabelText("New email")).toBeNull();
});

it("recovers a failed send within its own dialog without carrying the error to another operation", async () => {
  const action = mockAccount(unbound);
  action.mockImplementation(async path => path === "/me/security" ? ok(unbound) : path === "/config" ? ok({ mailAvailable: true }) : { errCode: 503, errMessage: "Mail unavailable" });
  render(<AccountSecurityPage onChanged={vi.fn()} />);
  await open("Bind email");
  fireEvent.change(screen.getByLabelText("New email"), { target: { value: "new@example.test" } });
  fireEvent.click(screen.getByRole("button", { name: "Send code to new email" }));
  await screen.findByText("Mail unavailable");
  expect(screen.getByRole("button", { name: "Send code to new email" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await open("Change password");
  expect(screen.queryByText("Mail unavailable")).toBeNull();
});
