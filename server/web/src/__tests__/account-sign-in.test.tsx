import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "@steamharness/i18n/react";
import { apiClient } from "../api";
import { LoginPage } from "../components/LoginPage";
import { DeviceApprovalPage } from "../pages/DeviceApprovalPage";
import { AccountSecurityPage } from "../pages/AccountSecurityPage";
const ok = (data: unknown) => ({errCode:0,errMessage:"",data}) as any;
const fail = {errCode:400,errMessage:"Verification code is invalid or expired."};
beforeEach(async () => { window.history.replaceState(null,"","/login"); await i18n.changeLanguage("en"); });
afterEach(() => vi.restoreAllMocks());

it("hides registration and disables its direct page while registration is closed", async () => {
  vi.spyOn(apiClient,"authAction").mockResolvedValue(ok({registrationEnabled:false,mailAvailable:false}));
  const view = render(<LoginPage onAuthenticated={vi.fn()} />);
  await screen.findByText("Username or email");
  expect(screen.queryByRole("link",{name:"Create account"})).toBeNull();
  view.rerender(<LoginPage mode="register" onAuthenticated={vi.fn()} />);
  expect(await screen.findByText("Registration is currently closed.")).toBeVisible();
  expect(screen.queryByRole("textbox")).toBeNull();
});

it("registers a username without an email and keeps an actionable server error", async () => {
  const action = vi.spyOn(apiClient,"authAction").mockImplementation(async path => path === "/config" ? ok({registrationEnabled:true,mailAvailable:true}) : fail);
  render(<LoginPage mode="register" onAuthenticated={vi.fn()} />);
  const username = await screen.findByLabelText("Username");
  fireEvent.change(username,{target:{value:"test_user"}});
  fireEvent.change(screen.getByLabelText("Password"),{target:{value:"test-password"}});
  fireEvent.change(screen.getByLabelText("Confirm password"),{target:{value:"test-password"}});
  fireEvent.submit(username.closest("form")!);
  await waitFor(() => expect(action).toHaveBeenCalledWith("/register",expect.objectContaining({method:"username",username:"test_user",password:"test-password"})));
  expect(await screen.findByRole("alert")).toHaveTextContent(fail.errMessage);
  expect(screen.queryByLabelText("Email")).toBeNull();
});

it("requires a verification code for email registration while keeping the password optional", async () => {
  const action = vi.spyOn(apiClient,"authAction").mockImplementation(async path => path === "/config" ? ok({registrationEnabled:true,mailAvailable:true}) : path === "/email-code/send" ? ok({challengeId:"challenge",retryAfterSeconds:60}) : fail);
  render(<LoginPage mode="register" onAuthenticated={vi.fn()} />);
  await screen.findByLabelText("Username");
  fireEvent.click(screen.getByRole("radio",{name:"Email"}));
  const email = screen.getByLabelText("Email");
  fireEvent.change(email,{target:{value:"test@example.test"}});
  expect(screen.getByLabelText("Password (optional, at least 8 characters)")).not.toBeRequired();
  expect(screen.getByRole("button",{name:"Create account"})).toBeDisabled();
  fireEvent.click(screen.getByRole("button",{name:"Send code"}));
  await waitFor(() => expect(action).toHaveBeenCalledWith("/email-code/send",{email:"test@example.test",purpose:"register"}));
  await screen.findByText("If the address is eligible, a code has been sent. Check your inbox.");
  fireEvent.change(screen.getByLabelText("Verification code"),{target:{value:"123456"}});
  fireEvent.submit(email.closest("form")!);
  await waitFor(() => expect(action).toHaveBeenCalledWith("/register",expect.objectContaining({method:"email",password:"",challengeId:"challenge",code:"123456"})));
});

it("uses the email recovery challenge and keeps device returnTo on navigation links", async () => {
  window.history.replaceState(null,"","/forgot-password?returnTo=%2Flogin%2Fdevice%3Fuser_code%3DABCD-1234");
  const action=vi.spyOn(apiClient,"authAction").mockImplementation(async path => path === "/config" ? ok({registrationEnabled:true,mailAvailable:true}) : path === "/email-code/send" ? ok({challengeId:"recovery",retryAfterSeconds:60}) : fail);
  render(<LoginPage mode="forgot-password" onAuthenticated={vi.fn()} />);
  const email=await screen.findByLabelText("Email");
  fireEvent.change(email,{target:{value:"test@example.test"}});
  fireEvent.click(screen.getByRole("button",{name:"Send code"}));
  await waitFor(() => expect(action).toHaveBeenCalledWith("/email-code/send",{email:"test@example.test",purpose:"password-reset"}));
  await screen.findByText("If the address is eligible, a code has been sent. Check your inbox.");
  fireEvent.change(screen.getByLabelText("Verification code"),{target:{value:"123456"}});
  fireEvent.change(screen.getByLabelText("Password"),{target:{value:"new-password"}});
  fireEvent.change(screen.getByLabelText("Confirm password"),{target:{value:"new-password"}});
  fireEvent.submit(email.closest("form")!);
  await waitFor(() => expect(action).toHaveBeenCalledWith("/password/reset",{challengeId:"recovery",code:"123456",password:"new-password"}));
  const link=screen.getByRole("link",{name:"Back to sign in"});
  expect(new URL(link.getAttribute("href")!,window.location.origin).searchParams.get("returnTo")).toBe("/login/device?user_code=ABCD-1234");
});

it.each(["dev","alpha","main"])("shows the approving identity and the %s application return link", async channel => {
  const url=`steamharness-studio${channel==="main"?"":`-${channel}`}://studio.studio-workstation/auth/callback?state=${"s".repeat(43)}`;
  const action=vi.spyOn(apiClient,"authAction").mockImplementation(async path => path.startsWith("/device/") && path!=="/device/approve" ? ok({clientName:"SteamHarness Studio",context:{channel},state:"pending",expiresAt:new Date(Date.now()+60000).toISOString()}) : ok({returnUrl:url}));
  render(<DeviceApprovalPage userCode="ABCD-1234" identity="test_user" onSwitchAccount={vi.fn()} />);
  expect(await screen.findByText(`SteamHarness Studio · ${channel}`)).toBeVisible();
  expect(screen.getByText("Signing in as test_user")).toBeVisible();
  fireEvent.click(screen.getByRole("button",{name:"Approve login"}));
  expect(await screen.findByRole("link",{name:"Open app and return"})).toHaveAttribute("href",url);
  expect(action).toHaveBeenCalledWith("/device/approve",{userCode:"ABCD-1234"});
});

it("prevents approval of expired requests", async () => {
  vi.spyOn(apiClient,"authAction").mockResolvedValue(ok({clientName:"CLI",state:"pending",expiresAt:new Date(Date.now()-1).toISOString()}));
  render(<DeviceApprovalPage userCode="ABCD-1234" identity="User" onSwitchAccount={vi.fn()} />);
  await screen.findByText("This request has expired. Start sign-in again from the app.");
  expect(screen.getByRole("button",{name:"Approve login"})).toBeDisabled();
});

it("binds an email using only the target code and the signed-in account", async () => {
  const changed=vi.fn();
  const action=vi.spyOn(apiClient,"authAction").mockImplementation(async path => path === "/config" ? ok({mailAvailable:true}) : path === "/me/security" ? ok({username:"test_user",email:null,emailVerifiedAt:null,hasPassword:true}) : path === "/email-code/send" ? ok({challengeId:"target",retryAfterSeconds:60}) : ok({}));
  render(<AccountSecurityPage onChanged={changed} />);
  expect(await screen.findByText(/Not bound/)).toBeVisible();
  fireEvent.click(screen.getByRole("button",{name:"Bind email"}));
  const email=screen.getByLabelText("New email");
  fireEvent.change(email,{target:{value:"bound@example.test"}});
  fireEvent.click(screen.getByRole("button",{name:"Send code to new email"}));
  await waitFor(() => expect(action).toHaveBeenCalledWith("/email-code/send",{email:"bound@example.test",purpose:"bind-email"}));
  await screen.findByText("A verification code was sent to bound@example.test.");
  fireEvent.change(screen.getByLabelText("Code from new email"),{target:{value:"123456"}});
  expect(screen.queryByLabelText("Current password")).toBeNull();
  expect(screen.queryByRole("button",{name:"Continue to identity verification"})).toBeNull();
  fireEvent.submit(email.closest("form")!);
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  expect(action).toHaveBeenCalledWith("/me/email",{action:"bind",challengeId:"target",code:"123456"});
});


it("retries configuration loading without losing a session message", async () => {
  const action = vi.spyOn(apiClient, "authAction").mockResolvedValueOnce({errCode:503,errMessage:"Configuration unavailable"}).mockResolvedValue(ok({registrationEnabled:true,mailAvailable:true}));
  render(<LoginPage onAuthenticated={vi.fn()} message="Please sign in again" />);
  expect(await screen.findByText("Configuration unavailable")).toBeVisible();
  fireEvent.click(screen.getByRole("button",{name:"Retry"}));
  await waitFor(() => expect(screen.getByRole("button",{name:"Enter console"})).toBeEnabled());
  expect(action).toHaveBeenCalledTimes(2);
});

it("keeps registration inputs after mismatched passwords and rejects invalid usernames", async () => {
  const action = vi.spyOn(apiClient,"authAction").mockResolvedValue(ok({registrationEnabled:true,mailAvailable:false}));
  render(<LoginPage mode="register" onAuthenticated={vi.fn()} />);
  const username = await screen.findByLabelText("Username");
  fireEvent.change(username,{target:{value:"bad/name"}});
  expect(username).toBeInvalid();
  fireEvent.change(username,{target:{value:"valid-name_1"}});
  expect(username).toBeValid();
  fireEvent.change(screen.getByLabelText("Password"),{target:{value:"test-password"}});
  fireEvent.change(screen.getByLabelText("Confirm password"),{target:{value:"different-password"}});
  fireEvent.submit(username.closest("form")!);
  expect(await screen.findByText("The passwords do not match.")).toBeVisible();
  expect(username).toHaveValue("valid-name_1");
  expect(action).toHaveBeenCalledTimes(1);
});

it("lets another email request a code during the first email's cooldown", async () => {
  const action = vi.spyOn(apiClient,"authAction").mockImplementation(async path => path === "/config" ? ok({registrationEnabled:true,mailAvailable:true}) : ok({challengeId:"code",retryAfterSeconds:60}));
  render(<LoginPage onAuthenticated={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("radio",{name:"Email code"})).toBeEnabled());
  fireEvent.click(screen.getByRole("radio",{name:"Email code"}));
  const email = screen.getByLabelText("Email");
  fireEvent.change(email,{target:{value:"first@example.test"}});
  fireEvent.click(screen.getByRole("button",{name:"Send code"}));
  expect(await screen.findByRole("button",{name:/60/})).toBeDisabled();
  fireEvent.change(email,{target:{value:"second@example.test"}});
  expect(screen.getByRole("button",{name:"Send code"})).toBeEnabled();
  expect(screen.getByRole("button",{name:"Enter console"})).toBeDisabled();
  fireEvent.click(screen.getByRole("button",{name:"Send code"}));
  await waitFor(() => expect(action).toHaveBeenCalledWith("/email-code/send",{email:"second@example.test",purpose:"login"}));
});

it("finishes password recovery with an explicit sign-in step", async () => {
  const authenticated = vi.fn();
  vi.spyOn(apiClient,"authAction").mockImplementation(async path => path === "/config" ? ok({registrationEnabled:true,mailAvailable:true}) : path === "/email-code/send" ? ok({challengeId:"reset",retryAfterSeconds:60}) : ok({}));
  render(<LoginPage mode="forgot-password" onAuthenticated={authenticated} />);
  const email = await screen.findByLabelText("Email");
  await waitFor(() => expect(email).toBeEnabled());
  fireEvent.change(email,{target:{value:"user@example.test"}});
  fireEvent.click(screen.getByRole("button",{name:"Send code"}));
  await screen.findByText(/If the address is eligible/);
  fireEvent.change(screen.getByLabelText("Verification code"),{target:{value:"123456"}});
  fireEvent.change(screen.getByLabelText("Password"),{target:{value:"new-password"}});
  fireEvent.change(screen.getByLabelText("Confirm password"),{target:{value:"new-password"}});
  fireEvent.submit(email.closest("form")!);
  expect(await screen.findByText("Password reset. Sign in with your new password to continue.")).toBeVisible();
  expect(screen.getByRole("link",{name:"Back to sign in"})).toHaveAttribute("href","/login");
  expect(screen.queryByLabelText("Password")).toBeNull();
  expect(authenticated).not.toHaveBeenCalled();
});

const device = (extra: object = {}) => ({clientName:"CLI",state:"pending",expiresAt:new Date(Date.now()+60000).toISOString(),...extra});
it("retries device loading and keeps the entered code when switching accounts", async () => {
  vi.spyOn(apiClient,"authAction").mockResolvedValueOnce({errCode:503,errMessage:"Device unavailable"}).mockResolvedValue(ok(device()));
  const logout = vi.spyOn(apiClient,"logout").mockResolvedValueOnce({errCode:503,errMessage:"Logout failed"}).mockResolvedValue(ok({loggedOut:true}));
  const switchAccount = vi.fn();
  render(<DeviceApprovalPage userCode="" identity="User" onSwitchAccount={switchAccount} />);
  fireEvent.change(screen.getByLabelText("Code shown in Studio or CLI"),{target:{value:"abcd-1234"}});
  expect(await screen.findByText("Device unavailable")).toBeVisible();
  fireEvent.click(screen.getByRole("button",{name:"Retry"}));
  await waitFor(() => expect(screen.getByRole("button",{name:"Approve login"})).toBeEnabled());
  fireEvent.click(screen.getByRole("button",{name:"Use another account"}));
  expect(await screen.findByText("Logout failed")).toBeVisible();
  expect(switchAccount).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"Use another account"}));
  await waitFor(() => expect(switchAccount).toHaveBeenCalledWith("ABCD-1234"));
  expect(logout).toHaveBeenCalledTimes(2);
});

it("ignores an old approval response and releases busy state after the device code changes", async () => {
  let resolve!: (result: any) => void;
  vi.spyOn(apiClient,"authAction").mockImplementation(async path => path === "/device/approve" ? await new Promise(done => { resolve = done; }) : ok(device()));
  const view = render(<DeviceApprovalPage userCode="ABCD-1234" identity="User" onSwitchAccount={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("button",{name:"Approve login"})).toBeEnabled());
  fireEvent.click(screen.getByRole("button",{name:"Approve login"}));
  view.rerender(<DeviceApprovalPage userCode="EFGH-5678" identity="User" onSwitchAccount={vi.fn()} />);
  await act(async () => resolve(ok({returnUrl:"http://localhost/?auth_state="+"s".repeat(43)})));
  await waitFor(() => expect(screen.getByRole("button",{name:"Approve login"})).toBeEnabled());
  expect(screen.getByLabelText("Code shown in Studio or CLI")).toHaveValue("EFGH-5678");
  expect(screen.queryByRole("link",{name:"Open app and return"})).toBeNull();
});

it.each([
  "https://evil.example.test/?auth_state="+"s".repeat(43),
  "http://user:password@127.0.0.1/?auth_state="+"s".repeat(43),
  "steamharness-studio://evil/auth/callback?state="+"s".repeat(43),
  "steamharness-studio://studio.studio-workstation/auth/callback?state=short",
  "http://127.0.0.1/?auth_state="+"s".repeat(43)+"&other=x",
])("rejects unsafe application return links (%#)", async returnUrl => {
  vi.spyOn(apiClient,"authAction").mockResolvedValue(ok(device({state:"approved",returnUrl})));
  render(<DeviceApprovalPage userCode="ABCD-1234" identity="User" onSwitchAccount={vi.fn()} />);
  await screen.findByText(/Sign-in approved/);
  expect(screen.queryByRole("link")).toBeNull();
});

it("keeps the return link after an approved request has already been consumed", async () => {
  const returnUrl = "http://127.0.0.1:1234/?auth_state="+"s".repeat(43);
  vi.spyOn(apiClient,"authAction").mockResolvedValue(ok(device({state:"consumed",expiresAt:new Date(0).toISOString(),returnUrl})));
  render(<DeviceApprovalPage userCode="ABCD-1234" identity="User" onSwitchAccount={vi.fn()} />);
  expect(await screen.findByRole("link",{name:"Open app and return"})).toHaveAttribute("href",returnUrl);
});

it("sets a password directly and requests sign-in again", async () => {
  const changed = vi.fn();
  const action = vi.spyOn(apiClient,"authAction").mockImplementation(async path => path === "/config" ? ok({mailAvailable:true}) : path === "/me/security" ? ok({username:null,email:"user@example.test",emailVerifiedAt:"2026-01-01",hasPassword:false}) : path === "/email-code/send" ? ok({challengeId:"proof",retryAfterSeconds:60}) : ok({}));
  render(<AccountSecurityPage onChanged={changed} />);
  fireEvent.click(await screen.findByRole("button",{name:"Set password"}));
  fireEvent.change(screen.getByLabelText("New password"),{target:{value:"new-password"}});
  fireEvent.change(screen.getByLabelText("Confirm password"),{target:{value:"new-password"}});
  expect(screen.queryByLabelText("Current password")).toBeNull();
  expect(screen.queryByLabelText("Code from current email")).toBeNull();
  fireEvent.submit(screen.getByLabelText("New password").closest("form")!);
  await waitFor(() => expect(changed).toHaveBeenCalledWith(true));
  expect(action).toHaveBeenCalledWith("/me/password",{password:"new-password"});
});

it("closes the username operation after setting it once", async () => {
  let username: string | null = null;
  const action = vi.spyOn(apiClient,"authAction").mockImplementation(async (path,body: any) => {
    if(path === "/config") return ok({mailAvailable:true});
    if(path === "/me/security") return ok({username,email:"user@example.test",emailVerifiedAt:"2026-01-01",hasPassword:true});
    username = body.username; return ok({});
  });
  const changed = vi.fn();
  render(<AccountSecurityPage onChanged={changed} />);
  fireEvent.click(await screen.findByRole("button",{name:"Set username"}));
  fireEvent.change(screen.getByLabelText("Username"),{target:{value:"new-user"}});
  fireEvent.submit(screen.getByLabelText("Username").closest("form")!);
  await waitFor(() => expect(changed).toHaveBeenCalledWith(false));
  expect(screen.queryByRole("button",{name:"Set username"})).toBeNull();
  expect(screen.queryByLabelText("Username")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("button",{name:"Change email"})).toBeVisible();
  expect(action).toHaveBeenCalledWith("/me/username",{username:"new-user"});
});

it("unbinds without requiring a password or email code", async () => {
  const changed = vi.fn();
  const action = vi.spyOn(apiClient,"authAction").mockImplementation(async path => path === "/config" ? ok({mailAvailable:true}) : path === "/me/security" ? ok({username:"user",email:"user@example.test",emailVerifiedAt:"2026-01-01",hasPassword:true}) : ok({}));
  render(<AccountSecurityPage onChanged={changed} />);
  fireEvent.click(await screen.findByRole("button",{name:"Unbind email"}));
  fireEvent.click(screen.getAllByRole("button",{name:"Unbind email"}).at(-1)!);
  await waitFor(() => expect(changed).toHaveBeenCalledWith(true));
  expect(action).toHaveBeenCalledWith("/me/email",{action:"unbind"});
});

it("requires a new challenge after a bind failure instead of reusing a consumed code", async () => {
  vi.spyOn(apiClient,"authAction").mockImplementation(async path => path === "/config" ? ok({mailAvailable:true}) : path === "/me/security" ? ok({username:"user",email:null,emailVerifiedAt:null,hasPassword:true}) : path === "/email-code/send" ? ok({challengeId:"target",retryAfterSeconds:60}) : fail);
  render(<AccountSecurityPage onChanged={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button",{name:"Bind email"}));
  const email = screen.getByLabelText("New email");
  fireEvent.change(email,{target:{value:"new@example.test"}});
  fireEvent.click(screen.getByRole("button",{name:"Send code to new email"}));
  await screen.findByText("A verification code was sent to new@example.test.");
  fireEvent.change(screen.getByLabelText("Code from new email"),{target:{value:"123456"}});
  fireEvent.submit(email.closest("form")!);
  await screen.findByText(fail.errMessage);
  expect(screen.getByRole("button",{name:"Bind email"})).toBeDisabled();
  expect(screen.getByLabelText("Code from new email")).toHaveValue("");
});

it("offers browser sign-in when security requires a user session", async () => {
  vi.spyOn(apiClient,"authAction").mockResolvedValue({errCode:401,errMessage:"A user session is required"});
  const signIn = vi.fn();
  render(<AccountSecurityPage onChanged={vi.fn()} onSignIn={signIn} />);
  fireEvent.click(await screen.findByRole("button",{name:"Back to sign in"}));
  expect(signIn).toHaveBeenCalledOnce();
});
