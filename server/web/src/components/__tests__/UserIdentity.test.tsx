import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UserIdentity, createUserIdentitySearchText, getUserIdentityPrimary } from "../UserIdentity";

describe("UserIdentity", () => {
  it("renders display name email and user id with a stable avatar fallback", () => {
    render(
      <UserIdentity
        user={{
          userId: "user-123",
          displayName: "Alice Operator",
          email: "alice@example.com",
        }}
      />,
    );

    expect(screen.getByText("Alice Operator")).toBeTruthy();
    expect(screen.getByText("alice@example.com")).toBeTruthy();
    expect(screen.getByText("user-123")).toBeTruthy();
    expect(screen.getByText("AO")).toBeTruthy();
  });

  it("falls back to email then user id for incomplete identity data", () => {
    expect(getUserIdentityPrimary({ email: "fallback@example.com", userId: "user-fallback" })).toBe("fallback@example.com");
    expect(getUserIdentityPrimary({ userId: "user-fallback" })).toBe("user-fallback");
    expect(getUserIdentityPrimary(null, "系统 / 未知主体")).toBe("系统 / 未知主体");
  });

  it("creates searchable text across all identity fields", () => {
    expect(createUserIdentitySearchText({
      userId: "user-321",
      displayName: "Beta Publisher",
      email: "beta@example.com",
    })).toBe("beta publisher beta@example.com user-321");
  });
});
