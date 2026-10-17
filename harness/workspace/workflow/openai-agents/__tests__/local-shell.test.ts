import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createControlledLocalShell,
  resolveLocalShellInvocation,
  resolveLocalShellWorkdir,
  validateShellCommand,
} from "../local-shell";

describe("controlled local shell", () => {
  it("runs a safe command in the configured workdir", async () => {
    const shell = createControlledLocalShell({ workdir: "." });

    const result = await shell.run({
      commands: [process.platform === "win32" ? "cd" : "pwd"],
      timeoutMs: 2_000,
      maxOutputLength: 2_000,
    });

    expect(result.output).toHaveLength(1);
    expect(result.output[0]?.stdout.trim()).toBe(process.cwd());
    expect(result.output[0]?.outcome).toEqual({ type: "exit", exitCode: 0 });
  });

  it("rejects dangerous commands before spawning", async () => {
    const shell = createControlledLocalShell({ workdir: process.cwd() });

    const result = await shell.run({
      commands: ["rm -rf ./tmp"],
    });

    expect(result.output[0]?.stderr).toContain("not allowed");
    expect(result.output[0]?.outcome).toEqual({ type: "exit", exitCode: 126 });
  });

  it("reports timeouts", async () => {
    const shell = createControlledLocalShell({ workdir: process.cwd() });

    const result = await shell.run({
      commands: [process.platform === "win32" ? "ping -n 3 127.0.0.1" : "sleep 1"],
      timeoutMs: 1,
    });

    expect(result.output[0]?.outcome).toEqual({ type: "timeout" });
  });

  it("keeps relative workdirs inside the execution directory", () => {
    expect(resolveLocalShellWorkdir(".")).toBe(process.cwd());
    expect(resolveLocalShellWorkdir("workspace")).toBe(path.join(process.cwd(), "workspace"));
    expect(() => resolveLocalShellWorkdir("..")).toThrow(/inside/);
  });

  it("rejects write redirection", () => {
    expect(validateShellCommand("echo hi > out.txt")).toContain("redirection");
    expect(validateShellCommand("echo hi >> out.txt")).toContain("redirection");
  });

  it("selects the shell for the target platform", () => {
    expect(resolveLocalShellInvocation("cd", "win32", "C:\\Windows\\System32\\cmd.exe")).toEqual({
      executable: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "cd"],
    });
    expect(resolveLocalShellInvocation("pwd", "darwin")).toEqual({
      executable: "/bin/sh",
      args: ["-lc", "pwd"],
    });
  });

  it("rejects Windows mutation commands", () => {
    expect(validateShellCommand("del out.txt")).toContain("not allowed");
  });
});
