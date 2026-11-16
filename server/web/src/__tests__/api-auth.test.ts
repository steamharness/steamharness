import { afterEach, expect, it, vi } from "vitest";
import { ServerApiClient } from "../api";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("bounds every authentication request, including bootstrap, logout and invitations", async () => {
  const timeout = vi.spyOn(AbortSignal,"timeout");
  const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify({errCode:0,errMessage:"",data:{}})));
  vi.stubGlobal("fetch",fetcher);
  const client = new ServerApiClient();
  await client.getSession(); await client.logout(); await client.lookupAccountInvitation("invite");
  await client.acceptAccountInvitation("invite",{password:"test-password"}); await client.authAction("/email-code/send",{email:"user@example.test",purpose:"login"});
  expect(timeout.mock.calls).toEqual(Array.from({length:5},() => [30_000]));
  expect(fetcher.mock.calls.every(([,init]) => init.signal instanceof AbortSignal)).toBe(true);
});
it("returns a recoverable response when an authentication request times out", async () => {
  const controller = new AbortController();
  vi.spyOn(AbortSignal,"timeout").mockReturnValue(controller.signal);
  vi.stubGlobal("fetch",vi.fn((_path,init) => new Promise((_resolve,reject) => init.signal.addEventListener("abort",() => reject(init.signal.reason)))));
  const result = new ServerApiClient().logout();
  controller.abort(new DOMException("Timed out","TimeoutError"));
  expect(await result).toMatchObject({errCode:-1,errMessage:expect.any(String)});
});
