import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveResourceAccess } from "@steamharness/project-access";
import { i18n } from "@steamharness/i18n/react";
import { apiClient } from "../../api";
import { GroupsPage } from "../GroupsPage";
import { ResourceMembersPanel } from "../../components/ResourceMembersPanel";
const owner = resolveResourceAccess([
  { type: "group", id: "parent", role: "owner", name: "Parent" },
]);
const developer = resolveResourceAccess([
  { type: "group", id: "parent", role: "developer", name: "Parent" },
]);
const maintainer = resolveResourceAccess([
  { type: "group", id: "parent", role: "maintainer", name: "Parent" },
]);
const ok = <T,>(data: T) => ({ errCode: 0 as const, errMessage: "", data });
beforeEach(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => vi.restoreAllMocks());
describe("project and group access", () => {
  it("uses authorized server pagination to navigate groups", async () => {
    vi.spyOn(apiClient, "listGroups").mockResolvedValue(
      ok({
        items: [
          {
            id: "engineering",
            name: "Engineering",
            description: "Team",
            parentId: null,
            createdAt: "2026-10-22",
            access: owner,
          },
        ],
        total: 21,
        page: 1,
        pageSize: 20,
      }),
    );
    const navigate = vi.fn();
    render(<GroupsPage onOpenGroup={navigate} onOpenProject={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Engineering" }));
    expect(navigate).toHaveBeenCalledWith("engineering");
    expect(apiClient.listGroups).toHaveBeenCalledWith({
      parentId: null,
      page: 1,
      q: "",
    });
  });
  it("shows inherited sources without offering to remove inherited membership", async () => {
    vi.spyOn(apiClient, "resourceMembers").mockResolvedValue(
      ok({
        items: [
          {
            userId: "dev",
            resourceId: "project",
            projectId: "project",
            role: "developer",
            createdAt: "2026-10-22",
            access: developer,
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      }),
    );
    vi.spyOn(apiClient, "resourceInvitations").mockResolvedValue(ok([]));
    render(<ResourceMembersPanel type="project" id="project" access={owner} />);
    const row = (await screen.findByText("dev")).closest("tr")!;
    expect(within(row).getByRole("link")).toHaveAttribute(
      "href",
      "/groups/parent",
    );
    expect(within(row).queryByRole("button")).toBeNull();
  });
  it("prevents maintainers from editing peers and confirms a direct member removal", async () => {
    vi.spyOn(apiClient, "resourceMembers").mockResolvedValue(
      ok({
        items: [
          {
            userId: "peer",
            resourceId: "project",
            projectId: "project",
            role: "maintainer",
            directRole: "maintainer",
            createdAt: "2026-10-22",
            access: maintainer,
          },
          {
            userId: "dev",
            resourceId: "project",
            projectId: "project",
            role: "developer",
            directRole: "developer",
            createdAt: "2026-10-22",
            access: developer,
          },
        ],
        total: 2,
        page: 1,
        pageSize: 20,
      }),
    );
    vi.spyOn(apiClient, "resourceInvitations").mockResolvedValue(ok([]));
    vi.spyOn(apiClient, "setResourceMember").mockResolvedValue(
      ok({ removed: true }),
    );
    render(
      <ResourceMembersPanel type="project" id="project" access={maintainer} />,
    );
    const peer = (await screen.findByText("peer")).closest("tr")!;
    expect(within(peer).queryByRole("combobox")).toBeNull();
    expect(within(peer).queryByRole("button")).toBeNull();
    fireEvent.click(
      within(screen.getByText("dev").closest("tr")!).getByRole("button"),
    );
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(apiClient.setResourceMember).toHaveBeenCalledWith(
        "project",
        "project",
        "dev",
      ),
    );
  });
});
