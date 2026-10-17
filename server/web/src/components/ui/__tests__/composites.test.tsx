import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  FilePickerField,
  IconActionButton,
  SemanticBadge,
  SettingsField,
  TableEmptyRow,
} from "../composites";

describe("server web UI composition components", () => {
  it("keeps icon-only actions accessible", () => {
    render(
      <>
        <IconActionButton label="查看版本">V</IconActionButton>
        <IconActionButton label="删除项目" size="icon" danger>D</IconActionButton>
      </>,
    );

    const compactAction = screen.getByRole("button", { name: "查看版本" });
    expect(compactAction.getAttribute("title")).toBe("查看版本");
    expect(compactAction.getAttribute("data-ui")).toBe("icon-action-button");
    expect(screen.getByRole("button", { name: "删除项目" })).toHaveAttribute("data-variant", "destructive");
  });

  it("renders table empty state with shadcn Empty inside a table row", () => {
    render(
      <table>
        <tbody>
          <TableEmptyRow colSpan={4} title="没有匹配的数据" description="调整筛选后重试。" />
        </tbody>
      </table>,
    );

    const row = screen.getByRole("row");
    expect(row.getAttribute("data-ui")).toBe("table-empty-row");
    expect(within(row).getByText("没有匹配的数据")).toBeTruthy();
    expect(within(row).getByText("调整筛选后重试。").closest("[data-slot=empty-description]")).toBeTruthy();
    expect(row.querySelector("td")?.getAttribute("colspan")).toBe("4");
  });

  it("wraps settings controls with Field, FieldLabel, and FieldDescription", () => {
    render(
      <SettingsField label="公开项目" description="允许成员查看项目。" htmlFor="project-public">
        <input id="project-public" type="checkbox" />
      </SettingsField>,
    );

    const field = screen.getByText("公开项目").closest("[data-slot=field]");
    expect(field).not.toBeNull();
    expect(field?.getAttribute("data-ui")).toBe("settings-field");
    expect(screen.getByText("允许成员查看项目。").getAttribute("data-slot")).toBe("field-description");
    expect(screen.getByLabelText("公开项目")).toBeTruthy();
  });

  it("exposes file inputs through the field label while using Button for the picker action", () => {
    const onFileChange = vi.fn();
    render(
      <FilePickerField
        id="avatar-file"
        label="头像"
        chooseLabel="选择图片"
        preview={{ src: "", fallback: "WF" }}
        onFileChange={onFileChange}
      />,
    );

    const file = new File(["avatar"], "avatar.png", { type: "image/png" });
    const input = screen.getByLabelText("头像") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [file] });
    fireEvent.change(input);

    expect(screen.getByRole("button", { name: "选择图片" }).getAttribute("data-slot")).toBe("button");
    expect(onFileChange).toHaveBeenCalledWith(file, expect.any(Object));
  });

  it("maps semantic tones to Badge variants", () => {
    render(
      <>
        <SemanticBadge tone="success">成功</SemanticBadge>
        <SemanticBadge tone="danger">失败</SemanticBadge>
      </>,
    );

    expect(screen.getByText("成功").getAttribute("data-variant")).toBe("secondary");
    expect(screen.getByText("失败").getAttribute("data-variant")).toBe("destructive");
  });
});
