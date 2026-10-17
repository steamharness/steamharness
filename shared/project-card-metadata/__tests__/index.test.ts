import { describe, expect, it } from "vitest";
import {
  generateProjectCardColorPair,
  getProjectCardColorContrastRatio,
  getProjectCardColorRelativeLuminance,
  normalizeProjectAppCardMetadata,
  readProjectAppCardMetadataFromPackageJson,
  readProjectCardMetadataFromPackageJson,
  validateProjectAppCardMetadata,
  writeProjectAppCardMetadataToPackageJson,
  writeProjectCardMetadataToPackageJson,
} from "@workflow-code/project-card-metadata";

describe("project-card-metadata package", () => {
  it("reads namespaced projectCard metadata from package.json", () => {
    const metadata = readProjectCardMetadataFromPackageJson(
      {
        workflowCode: {
          projectCard: {
            icon: "bot",
            iconUrl: "https://example.com/icon.png",
            iconColor: "#f8fafc",
            iconBackgroundColor: "#7c3aed",
          },
        },
      },
      "workflow",
    );

    expect(metadata).toEqual({
      icon: "bot",
      iconUrl: "https://example.com/icon.png",
      iconColor: "#f8fafc",
      iconBackgroundColor: "#7c3aed",
    });
  });

  it("keeps reading legacy appCard metadata from package.json", () => {
    const metadata = readProjectAppCardMetadataFromPackageJson(
      {
        workflowCode: {
          appCard: {
            icon: "bot",
            iconUrl: "https://example.com/icon.png",
            iconBackgroundColor: "#7c3aed",
          },
        },
      },
      "workflow",
    );

    expect(metadata).toEqual({
      icon: "bot",
      iconUrl: "https://example.com/icon.png",
      iconColor: "#ffffff",
      iconBackgroundColor: "#7c3aed",
    });
  });

  it("prefers projectCard over legacy appCard metadata", () => {
    const metadata = readProjectCardMetadataFromPackageJson(
      {
        workflowCode: {
          appCard: {
            icon: "workflow",
            iconBackgroundColor: "#2563eb",
          },
          projectCard: {
            icon: "message-circle",
            iconBackgroundColor: "#0f766e",
          },
        },
      },
      "workflow",
    );

    expect(metadata).not.toHaveProperty("kind");
    expect(metadata.icon).toBe("message-circle");
  });

  it("falls back safely when stored metadata is invalid", () => {
    expect(
      normalizeProjectAppCardMetadata(
        {
          icon: "unknown",
          iconUrl: "javascript:alert(1)",
          iconBackgroundColor: "blue",
        },
        "conversation",
      ),
    ).toEqual({
      icon: "message-circle",
      iconUrl: undefined,
      iconColor: "#ffffff",
      iconBackgroundColor: "#0f766e",
    });
  });

  it("normalizes legacy sparkles metadata to the shared workflow icon token", () => {
    expect(
      normalizeProjectAppCardMetadata(
        {
          icon: "sparkles",
          iconBackgroundColor: "#2563eb",
        },
        "workflow",
      ),
    ).toEqual({
      icon: "workflow",
      iconUrl: undefined,
      iconColor: "#ffffff",
      iconBackgroundColor: "#2563eb",
    });

    expect(
      validateProjectAppCardMetadata({
        icon: "sparkles",
        iconBackgroundColor: "#2563eb",
      }),
    ).toEqual({
      icon: "workflow",
      iconUrl: undefined,
      iconColor: "#ffffff",
      iconBackgroundColor: "#2563eb",
    });
  });

  it("validates URL and background color before writing", () => {
    expect(() =>
      validateProjectAppCardMetadata({
        icon: "workflow",
        iconColor: "white",
        iconBackgroundColor: "#2563eb",
      }),
    ).toThrow("Project icon color must be a #RRGGBB value.");
    expect(() =>
      validateProjectAppCardMetadata({
        icon: "workflow",
        iconUrl: "ftp://example.com/icon.png",
        iconBackgroundColor: "#2563eb",
      }),
    ).toThrow("Project icon URL must use http:// or https://.");
    expect(() =>
      validateProjectAppCardMetadata({
        icon: "workflow",
        iconBackgroundColor: "2563eb",
      }),
    ).toThrow("Project icon background color must be a #RRGGBB value.");
  });

  it("rejects the removed projectCard kind field", () => {
    expect(() => readProjectCardMetadataFromPackageJson({
      workflowCode: {
        projectCard: {
          kind: "conversation",
          icon: "message-circle",
          iconBackgroundColor: "#0f766e",
        },
      },
    }, "conversation")).toThrow(/projectCard\.kind was removed/);

    expect(() => validateProjectAppCardMetadata({
      kind: "workflow",
      icon: "workflow",
      iconBackgroundColor: "#2563eb",
    })).toThrow(/projectCard\.kind was removed/);
  });

  it("writes workflowCode.projectCard without removing existing workflowCode fields", () => {
    expect(
      writeProjectCardMetadataToPackageJson(
        {
          id: "demo",
          workflowCode: {
            existing: true,
          },
        },
        {
          icon: "database",
          iconColor: "#f8fafc",
          iconBackgroundColor: "#475569",
        },
      ),
    ).toEqual({
      id: "demo",
      workflowCode: {
        existing: true,
        projectCard: {
          icon: "database",
          iconColor: "#f8fafc",
          iconBackgroundColor: "#475569",
        },
      },
    });
  });

  it("legacy App writer aliases the projectCard package field", () => {
    const nextPackageJson = writeProjectAppCardMetadataToPackageJson(
      { id: "demo" },
      {
        icon: "database",
        iconColor: "#111827",
        iconBackgroundColor: "#475569",
      },
    );

    expect(nextPackageJson).toEqual({
      id: "demo",
      workflowCode: {
        projectCard: {
          icon: "database",
          iconColor: "#111827",
          iconBackgroundColor: "#475569",
        },
      },
    });
  });

  it("generates structured light-on-dark and dark-on-light color pairs with AA contrast", () => {
    const darkBackgroundPair = generateProjectCardColorPair(() => 0.25);
    const lightBackgroundPair = generateProjectCardColorPair(() => 0.75);

    expect(darkBackgroundPair.contrastRatio).toBeGreaterThanOrEqual(4.5);
    expect(lightBackgroundPair.contrastRatio).toBeGreaterThanOrEqual(4.5);
    expect(getProjectCardColorRelativeLuminance(darkBackgroundPair.iconColor)).toBeGreaterThan(
      getProjectCardColorRelativeLuminance(darkBackgroundPair.iconBackgroundColor),
    );
    expect(getProjectCardColorRelativeLuminance(lightBackgroundPair.iconColor)).toBeLessThan(
      getProjectCardColorRelativeLuminance(lightBackgroundPair.iconBackgroundColor),
    );
    expect(getProjectCardColorContrastRatio(
      darkBackgroundPair.iconColor,
      darkBackgroundPair.iconBackgroundColor,
    )).toBeCloseTo(darkBackgroundPair.contrastRatio);
    expect(getProjectCardColorContrastRatio(
      lightBackgroundPair.iconColor,
      lightBackgroundPair.iconBackgroundColor,
    )).toBeCloseTo(lightBackgroundPair.contrastRatio);
  });

  it("keeps every generated sample above the icon contrast threshold", () => {
    let seed = 123456789;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) % 0x100000000;
      return seed / 0x100000000;
    };

    for (let index = 0; index < 200; index += 1) {
      const pair = generateProjectCardColorPair(random);
      expect(pair.contrastRatio).toBeGreaterThanOrEqual(4.5);
    }
  });
});
