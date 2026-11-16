import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

it("shows an unbound account and sends its current password proof when binding an email", async () => {
  const changed=vi.fn();
  const action=vi.spyOn(apiClient,"authAction").mockImplementation(async path => path === "/config" ? ok({mailAvailable:true}) : path === "/me/security" ? ok({username:"test_user",email:null,emailVerifiedAt:null,hasPassword:true}) : path === "/email-code/send" ? ok({challengeId:"target",retryAfterSeconds:60}) : ok({}));
  render(<AccountSecurityPage onChanged={changed} />);
  expect(await screen.findByText(/Not bound/)).toBeVisible();
  const email=screen.getByLabelText("Email");
  fireEvent.change(email,{target:{value:"bound@example.test"}});
  fireEvent.click(screen.getByRole("button",{name:"Send code"}));
  await waitFor(() => expect(action).toHaveBeenCalledWith("/email-code/send",{email:"bound@example.test",purpose:"bind-email"}));
  await screen.findByText("If the address is eligible, a code has been sent. Check your inbox.");
  fireEvent.change(screen.getByLabelText("Verification code"),{target:{value:"123456"}});
  fireEvent.change(screen.getByLabelText("Current password"),{target:{value:"test-password"}});
  fireEvent.submit(email.closest("form")!);
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  expect(action).toHaveBeenCalledWith("/me/email",expect.objectContaining({action:"bind",challengeId:"target",code:"123456",currentPassword:"test-password"}));
});
