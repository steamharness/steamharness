import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "@steamharness/i18n/react";
import { apiClient } from "../../api";
import { ProjectSourceSharePage } from "../ProjectSourceSharePage";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => vi.restoreAllMocks());

it("offers the signed access request link when a private project's source is denied", async () => {
  vi.spyOn(apiClient, "getSourceShare").mockResolvedValue({
    errCode: 403,
    errMessage: "Permission denied.",
    data: {
      requestUrl: `${window.location.origin}/access-requests/signed-token`,
    },
  });
  render(
    <ProjectSourceSharePage
      id="private-project"
      version="1.0.0"
      onNavigateProjects={vi.fn()}
    />,
  );
  expect(
    await screen.findByRole("link", { name: "Request project access" }),
  ).toHaveAttribute("href", "/access-requests/signed-token");
});

it.each([
  "https://other.example/access-requests/token",
  "/projects/private",
  "javascript:alert(1)",
])("rejects untrusted application URLs: %s", async (requestUrl) => {
  vi.spyOn(apiClient, "getSourceShare").mockResolvedValue({
    errCode: 403,
    errMessage: "Permission denied.",
    data: { requestUrl },
  });
  render(
    <ProjectSourceSharePage
      id="private-project"
      version="1.0.0"
      onNavigateProjects={vi.fn()}
    />,
  );
  await screen.findByText("Permission denied.");
  expect(
    screen.queryByRole("link", { name: "Request project access" }),
  ).toBeNull();
});
