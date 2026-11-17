import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "@steamharness/i18n/react";
import { App } from "../App";
import { apiClient } from "../api";
const ok = (data: unknown) => ({errCode:0,errMessage:"",data}) as any;
const principal = {kind:"user_session",userId:"account-user",displayName:"Account User",isSystemAdmin:false};
const security = {username:"account-user",email:null,emailVerifiedAt:null,hasPassword:true};
beforeEach(async () => {
  window.localStorage.clear();
  window.localStorage.setItem("steamharness-server-admin:locale","en");
  window.history.replaceState(null,"","/settings/security");
  await i18n.changeLanguage("en");
  vi.spyOn(apiClient,"health").mockResolvedValue({errCode:503,errMessage:"Health unavailable"});
  vi.spyOn(apiClient,"getSession").mockResolvedValue(ok({authenticated:true,principal}));
  vi.spyOn(apiClient,"getMe").mockResolvedValue(ok({principal,profile:{...principal,email:null,status:"active",createdAt:"2026-01-01",updatedAt:"2026-01-01"}}));
  vi.spyOn(apiClient,"listApiKeys").mockResolvedValue(ok({items:[]}));
  vi.spyOn(apiClient,"listProjects").mockResolvedValue(ok({items:[],total:0,page:1,pageSize:20}));
  vi.spyOn(apiClient,"authAction").mockImplementation(async path => path === "/me/security" ? ok(security) : path === "/config" ? ok({registrationEnabled:true,mailAvailable:true}) : ok({}));
});
afterEach(() => vi.restoreAllMocks());

it("renders the real account security page from the sidebar route", async () => {
  render(<App />);
  expect(await screen.findByRole("heading",{name:"Account security"})).toBeVisible();
  expect(screen.queryByLabelText("Current password")).toBeNull();
  expect(screen.getByRole("button",{name:"Change password"})).toBeVisible();
  expect(window.location.pathname).toBe("/settings/security");
});

it.each(["/login","/register","/forgot-password"])("preserves an authenticated device destination from %s", async path => {
  window.history.replaceState(null,"",path+"?returnTo="+encodeURIComponent("/login/device?user_code=ABCD-1234"));
  render(<App />);
  expect(await screen.findByLabelText("Code shown in Studio or CLI")).toHaveValue("ABCD-1234");
  expect(window.location.pathname+window.location.search).toBe("/login/device?user_code=ABCD-1234");
});

it("allows signed-in users to enter a device code manually", async () => {
  window.history.replaceState(null,"","/login/device");
  render(<App />);
  const code = await screen.findByLabelText("Code shown in Studio or CLI");
  expect(code).toHaveValue("");
  fireEvent.change(code,{target:{value:"abcd-1234"}});
  await waitFor(() => expect(apiClient.authAction).toHaveBeenCalledWith("/device/ABCD-1234"));
  expect(window.location.pathname).toBe("/login/device");
});

it("retains a manually entered device code when signing in as another account", async () => {
  window.history.replaceState(null,"","/login/device");
  const logout = vi.spyOn(apiClient,"logout").mockResolvedValue(ok({loggedOut:true}));
  render(<App />);
  fireEvent.change(await screen.findByLabelText("Code shown in Studio or CLI"),{target:{value:"abcd-1234"}});
  fireEvent.click(screen.getByRole("button",{name:"Use another account"}));
  expect(await screen.findByLabelText("Username or email")).toBeVisible();
  expect(logout).toHaveBeenCalledOnce();
  expect(window.location.pathname+window.location.search).toBe("/login/device?user_code=ABCD-1234");
  const href = screen.getByRole("link",{name:"Create account"}).getAttribute("href")!;
  expect(new URL(href,window.location.origin).searchParams.get("returnTo")).toBe("/login/device?user_code=ABCD-1234");
});

it("shows a clear sign-in message after changing the password", async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole("button",{name:"Change password"}));
  fireEvent.change(screen.getByLabelText("New password"),{target:{value:"new-password"}});
  fireEvent.change(screen.getByLabelText("Confirm password"),{target:{value:"new-password"}});
  fireEvent.click(screen.getByRole("button",{name:"Continue to identity verification"}));
  fireEvent.change(screen.getByLabelText("Current password"),{target:{value:"old-password"}});
  fireEvent.submit(screen.getByLabelText("Current password").closest("form")!);
  expect(await screen.findByText("Account security updated. Sign in again on the website and in your apps.")).toBeVisible();
  expect(window.location.pathname).toBe("/login");
  expect(screen.getByLabelText("Username or email")).toBeVisible();
});

it("shows profile data even when API key listing fails", async () => {
  window.history.replaceState(null,"","/settings/profile");
  vi.mocked(apiClient.listApiKeys).mockResolvedValue({errCode:503,errMessage:"Key service unavailable"});
  render(<App />);
  expect(await screen.findByDisplayValue("Account User")).toBeVisible();
  expect(screen.queryByText("Email not loaded")).toBeNull();
});

it("discards a profile response arriving after the account session is cleared", async () => {
  let finish!: (value: any) => void;
  vi.mocked(apiClient.getMe).mockReturnValueOnce(new Promise(done => { finish = done; }));
  vi.spyOn(apiClient,"logout").mockResolvedValue(ok({loggedOut:true}));
  render(<App />);
  fireEvent.click(await screen.findByRole("button",{name:"Change password"}));
  fireEvent.change(screen.getByLabelText("New password"),{target:{value:"new-password"}});
  fireEvent.change(screen.getByLabelText("Confirm password"),{target:{value:"new-password"}});
  fireEvent.click(screen.getByRole("button",{name:"Continue to identity verification"}));
  fireEvent.change(screen.getByLabelText("Current password"),{target:{value:"old-password"}});
  fireEvent.submit(screen.getByLabelText("Current password").closest("form")!);
  await screen.findByLabelText("Username or email");
  await act(async () => finish(ok({principal,profile:{...principal,displayName:"Stale private profile"}})));
  expect(screen.queryByDisplayValue("Stale private profile")).toBeNull();
});


it("distinguishes a failed key list from an empty list and provides retry", async () => {
  window.history.replaceState(null,"","/settings/api-keys");
  vi.mocked(apiClient.listApiKeys).mockResolvedValueOnce({errCode:503,errMessage:"Key service unavailable"});
  render(<App />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Key service unavailable");
  expect(screen.queryByText(i18n.t("accountApiKeyEmptyTitle",{ns:"serverWeb"}))).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Retry"}));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(apiClient.listApiKeys).toHaveBeenCalledTimes(2);
});

it("offers profile retry without showing an empty editable form", async () => {
  window.history.replaceState(null,"","/settings/profile");
  vi.mocked(apiClient.getMe).mockResolvedValueOnce({errCode:503,errMessage:"Profile unavailable"});
  render(<App />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Profile unavailable");
  expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Retry"}));
  expect(await screen.findByDisplayValue("Account User")).toBeVisible();
});


it("keeps profile editing disabled until the account is loaded", async () => {
  window.history.replaceState(null,"","/settings/profile");
  let finish!: (value: any) => void;
  vi.mocked(apiClient.getMe).mockReturnValueOnce(new Promise(done => {finish=done;}));
  render(<App />);
  const input = await screen.findByRole("textbox");
  expect(input).toBeDisabled();
  await act(async () => finish(ok({principal,profile:{...principal,email:null,status:"active"}})));
  expect(await screen.findByDisplayValue("Account User")).toBeEnabled();
});
