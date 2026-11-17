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
function deferredResponse() {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>(done => { resolve = done; });
  return { promise, resolve };
}
async function open(title: string) {
  fireEvent.click(await screen.findByRole("button", { name: title }));
  return within(screen.getByRole("dialog", { name: title }));
}
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
  ["en", "Account security", "Loading account info"],
  ["zh", "账号安全", "加载账号信息"],
])("keeps the page frame while loading without showing errors or retry actions (%s)", async (language, title, loadingLabel) => {
  await i18n.changeLanguage(language);
  const account = deferredResponse(), config = deferredResponse();
  vi.spyOn(apiClient, "authAction").mockImplementation(path => path === "/me/security" ? account.promise : config.promise);
  render(<AccountSecurityPage onChanged={vi.fn()} />);
  const heading = screen.getByRole("heading", { name: title });
  expect(heading).toBeVisible();
  expect(screen.getByRole("status", { name: loadingLabel })).toHaveAttribute("aria-busy", "true");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
  await act(async () => config.resolve(ok({ mailAvailable: true })));
  expect(screen.getByRole("status", { name: loadingLabel })).toBeInTheDocument();
  expect(screen.queryByRole("button")).toBeNull();
  await act(async () => account.resolve(ok(bound)));
  expect(screen.getByRole("heading", { name: title })).toBe(heading);
  expect(screen.queryByRole("status", { name: loadingLabel })).toBeNull();
  expect(screen.getByText(bound.email!)).toBeVisible();
  expect(screen.getByRole("button", { name: language === "zh" ? "更换邮箱" : "Change email" })).toBeEnabled();
});

it("offers retry after a load failure and returns to the loading state during recovery", async () => {
  const recovery = deferredResponse();
  let attempts = 0;
  vi.spyOn(apiClient, "authAction").mockImplementation(async path => path === "/config" ? ok({ mailAvailable: true })
    : ++attempts === 1 ? { errCode: 503, errMessage: "Account unavailable" } : recovery.promise);
  render(<AccountSecurityPage onChanged={vi.fn()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Account unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(screen.getByRole("status", { name: "Loading account info" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  await act(async () => recovery.resolve(ok(bound)));
  expect(screen.getByRole("button", { name: "Change email" })).toBeEnabled();
  expect(screen.queryByText("Account unavailable")).toBeNull();
  expect(attempts).toBe(2);
});

it("shows a sign-in action instead of retrying an expired session", async () => {
  const signIn = vi.fn();
  vi.spyOn(apiClient, "authAction").mockImplementation(async path => path === "/config" ? ok({ mailAvailable: true })
    : { errCode: 401, errMessage: "Session expired" });
  render(<AccountSecurityPage onChanged={vi.fn()} onSignIn={signIn} />);
  expect(await screen.findByText("Session expired")).toHaveAttribute("role", "status");
  expect(screen.getByText("Sign in on this website with your password or email code to manage account security.")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Back to sign in" }));
  expect(signIn).toHaveBeenCalledTimes(1);
});

it("keeps loaded account details available when only mail configuration fails", async () => {
  vi.spyOn(apiClient, "authAction").mockImplementation(async path => path === "/me/security" ? ok(bound)
    : { errCode: 503, errMessage: "Configuration unavailable" });
  render(<AccountSecurityPage onChanged={vi.fn()} />);
  expect(await screen.findByText(bound.email!)).toBeVisible();
  expect(screen.queryByRole("status", { name: "Loading account info" })).toBeNull();
  expect(screen.getByRole("button", { name: "Change password" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Change email" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
});

it.each([
  [unbound, ["Bind email", "Change password"]],
  [{ ...bound, emailVerifiedAt: null }, ["Verify email", "Change email", "Unbind email", "Change password"]],
  [bound, ["Change email", "Unbind email", "Change password"]],
  [{ ...bound, username: null, hasPassword: false }, ["Change email", "Unbind email", "Set password", "Set username"]],
] as const)("shows independent entries for account state %# without opening sensitive forms", async (security, actions) => {
  mockAccount(security);
  render(<AccountSecurityPage onChanged={vi.fn()} />);
  await screen.findByRole("heading", { name: "Account security" });
  for (const name of actions) expect(await screen.findByRole("button", { name })).toBeVisible();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByLabelText("Current password")).toBeNull();
  expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  if (!security.username || !security.hasPassword) expect(screen.getByRole("button", { name: "Unbind email" })).toBeDisabled();
});

it("clears email codes and new passwords on cancel without offering identity verification", async () => {
  const action = mockAccount();
  render(<AccountSecurityPage onChanged={vi.fn()} />);
  await open("Change email");
  expect(screen.getByLabelText("New email")).toHaveAttribute("name", "new-email");
  expect(screen.getByLabelText("New email")).toHaveAttribute("autocomplete", "section-security-target email");
  await newEmail();
  expect(screen.queryByLabelText("Current password")).toBeNull();
  expect(screen.queryByRole("button", { name: "Continue to identity verification" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await open("Change password"); passwordDetails();
  expect(screen.queryByLabelText("New email")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await open("Change password");
  expect(screen.getByLabelText("New password")).toHaveValue("");
  expect(screen.getByLabelText("Confirm password")).toHaveValue("");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await open("Change email");
  expect(screen.getByLabelText("New email")).toHaveValue("");
  expect(screen.getByLabelText("Code from new email")).toHaveValue("");
  expect(screen.getByLabelText("Code from new email")).toBeDisabled();
  expect(action).not.toHaveBeenCalledWith("/me/email", expect.anything());
  expect(action).not.toHaveBeenCalledWith("/me/password", expect.anything());
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
  expect(screen.queryByLabelText("Current password")).toBeNull();
  expect(screen.queryByRole("button", { name: "Continue to identity verification" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Verify email" }));
  await waitFor(() => expect(changed).toHaveBeenCalledWith(true));
  expect(action).toHaveBeenCalledWith("/me/email", { action: "bind", challengeId: "bind-email", code: "111111" });
});

it.each([
  [{ ...unbound, hasPassword: false }, "Bind email"],
  [{ ...bound, emailVerifiedAt: null, hasPassword: false }, "Verify email"],
] as const)("allows target-code-only binding without an existing identity proof method (%s)", async (security, title) => {
  const action = mockAccount(security);
  const changed = vi.fn();
  render(<AccountSecurityPage onChanged={changed} />);
  const dialog = await open(title);
  expect(dialog.queryByLabelText("Current password")).toBeNull();
  expect(dialog.queryByLabelText("Code from current email")).toBeNull();
  expect(dialog.queryByRole("button", { name: "Continue to identity verification" })).toBeNull();
  const emailLabel = title === "Bind email" ? "New email" : "Email";
  const codeLabel = title === "Bind email" ? "Code from new email" : "Email verification code";
  if (title === "Bind email") fireEvent.change(dialog.getByLabelText(emailLabel), { target: { value: "new@example.test" } });
  fireEvent.submit(dialog.getByRole("form"));
  expect(action).not.toHaveBeenCalledWith("/me/email", expect.anything());
  fireEvent.click(dialog.getByRole("button", { name: title === "Bind email" ? "Send code to new email" : "Send code" }));
  await screen.findByText(`A verification code was sent to ${title === "Bind email" ? "new@example.test" : bound.email}.`);
  fireEvent.change(screen.getByLabelText(codeLabel), { target: { value: "111111" } });
  fireEvent.click(screen.getByRole("button", { name: title }));
  await waitFor(() => expect(changed).toHaveBeenCalledWith(true));
  expect(action).toHaveBeenCalledWith("/me/email", { action: "bind", challengeId: "bind-email", code: "111111" });
});

it("blocks duplicate direct-bind submissions while the target code is being saved", async () => {
  const action = mockAccount(unbound);
  render(<AccountSecurityPage onChanged={vi.fn()} />);
  await open("Bind email"); await newEmail();
  let finish!: (value: any) => void;
  action.mockImplementation(() => new Promise(done => { finish = done; }));
  const form = screen.getByLabelText("New email").closest("form")!;
  fireEvent.submit(form); fireEvent.submit(form);
  expect(action.mock.calls.filter(([path]) => path === "/me/email")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Bind email" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await act(async () => finish(ok({})));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it.each([true, false])("changes email using only the new email code (password: %s)", async hasPassword => {
  const action = mockAccount({ ...bound, hasPassword });
  const changed = vi.fn();
  render(<AccountSecurityPage onChanged={changed} />);
  const dialog = await open("Change email");
  await newEmail();
  expect(dialog.queryByLabelText("Current password")).toBeNull();
  expect(dialog.queryByLabelText("Code from current email")).toBeNull();
  expect(dialog.queryByRole("button", { name: "Continue to identity verification" })).toBeNull();
  fireEvent.click(dialog.getByRole("button", { name: "Change email" }));
  await waitFor(() => expect(changed).toHaveBeenCalledWith(true));
  expect(action).toHaveBeenCalledWith("/email-code/send", { email: "new@example.test", purpose: "bind-email" });
  expect(action.mock.calls.filter(([path]) => path === "/email-code/send")).toHaveLength(1);
  expect(action).toHaveBeenCalledWith("/me/email", { action: "bind", challengeId: "bind-email", code: "111111" });
});

it("unbinds email without requesting a password or email code", async () => {
  const action = mockAccount();
  render(<AccountSecurityPage onChanged={vi.fn()} />);
  const dialog = await open("Unbind email");
  expect(dialog.queryByRole("textbox")).toBeNull();
  expect(dialog.queryByLabelText("Current password")).toBeNull();
  expect(dialog.queryByLabelText("Code from current email")).toBeNull();
  expect(dialog.getByText(bound.email!)).toBeVisible();
  fireEvent.click(dialog.getByRole("button", { name: "Unbind email" }));
  await waitFor(() => expect(action).toHaveBeenCalledWith("/me/email", { action: "unbind" }));
  expect(action.mock.calls.filter(([path]) => path === "/email-code/send")).toHaveLength(0);
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
  expect(screen.getByRole("button", { name: "Bind email" })).toBeDisabled();
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
  expect(screen.getByRole("button", { name: "Change email" })).toBeDisabled();
});

it("validates new passwords and blocks duplicate commits and dismissal while saving directly", async () => {
  const action = mockAccount();
  render(<AccountSecurityPage onChanged={vi.fn()} />);
  const dialog = await open("Change password"); passwordDetails();
  fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "different-password" } });
  fireEvent.click(dialog.getByRole("button", { name: "Change password" }));
  expect(screen.getByRole("alert")).toHaveTextContent("The passwords do not match.");
  expect(action).not.toHaveBeenCalledWith("/me/password", expect.anything());
  expect(screen.queryByLabelText("Current password")).toBeNull();
  passwordDetails();
  let finish!: (value: any) => void;
  action.mockImplementation(() => new Promise(done => { finish = done; }));
  const form = screen.getByLabelText("New password").closest("form")!;
  fireEvent.submit(form); fireEvent.submit(form);
  expect(dialog.getByRole("button", { name: "Change password" })).toBeDisabled();
  expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.getByRole("dialog")).toBeVisible();
  expect(action.mock.calls.filter(([path]) => path === "/me/password")).toHaveLength(1);
  expect(action).toHaveBeenCalledWith("/me/password", { password: "new-password" });
  await act(async () => finish({ errCode: 503, errMessage: "Save unavailable" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Save unavailable");
  expect(screen.getByLabelText("New password")).toHaveValue("new-password");
  expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await open("Change email");
  expect(screen.queryByText("Save unavailable")).toBeNull();
});

it("keeps password and username operations available without a password, verified email, or mail service", async () => {
  const action = mockAccount({ ...bound, username: null, emailVerifiedAt: null, hasPassword: false }, false);
  const changed = vi.fn();
  render(<AccountSecurityPage onChanged={changed} />);
  const dialog = await open("Set username");
  fireEvent.change(dialog.getByLabelText("Username"), { target: { value: "new-user" } });
  expect(dialog.queryByLabelText("Current password")).toBeNull();
  expect(dialog.queryByLabelText("Code from current email")).toBeNull();
  fireEvent.click(dialog.getByRole("button", { name: "Set username" }));
  await waitFor(() => expect(changed).toHaveBeenCalledWith(false));
  expect(action).toHaveBeenCalledWith("/me/username", { username: "new-user" });
  expect(screen.getByRole("button", { name: "Set password" })).toBeEnabled();
  expect(action.mock.calls.filter(([path]) => path === "/email-code/send")).toHaveLength(0);
});

it.each([true, false])("allows password changes while mail is unavailable (password: %s)", async hasPassword => {
  const action = mockAccount({ ...bound, username: null, hasPassword }, false);
  const changed = vi.fn();
  render(<AccountSecurityPage onChanged={changed} />);
  expect(await screen.findByRole("button", { name: "Change email" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Unbind email" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Set username" })).toBeEnabled();
  const title = hasPassword ? "Change password" : "Set password";
  const dialog = await open(title); passwordDetails();
  expect(dialog.queryByLabelText("Current password")).toBeNull();
  expect(dialog.queryByLabelText("Code from current email")).toBeNull();
  fireEvent.click(dialog.getByRole("button", { name: title }));
  await waitFor(() => expect(changed).toHaveBeenCalledWith(true));
  expect(action).toHaveBeenCalledWith("/me/password", { password: "new-password" });
  expect(action.mock.calls.filter(([path]) => path === "/email-code/send")).toHaveLength(0);
});

it("allows unbinding while mail is unavailable", async () => {
  const action = mockAccount(bound, false);
  render(<AccountSecurityPage onChanged={vi.fn()} />);
  const dialog = await open("Unbind email");
  expect(dialog.queryByLabelText("Current password")).toBeNull();
  expect(dialog.queryByLabelText("New email")).toBeNull();
  fireEvent.click(dialog.getByRole("button", { name: "Unbind email" }));
  await waitFor(() => expect(action).toHaveBeenCalledWith("/me/email", { action: "unbind" }));
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
