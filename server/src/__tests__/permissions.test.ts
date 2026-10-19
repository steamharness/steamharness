import assert from "node:assert/strict";
import test from "node:test";
import { i18n, initI18n, translateDynamicKey } from "@steamharness/i18n";
import {
  listBuiltinProjectRoles,
  listProjectPermissionGroups,
} from "../permissions";

test("storage.write is catalogued and granted to operational builtin roles", () => {
  const storagePermission = listProjectPermissionGroups()
    .flatMap((group) => group.permissions)
    .find((permission) => permission.key === "storage.write");
  assert.equal(storagePermission?.group, "configuration");

  const roles = new Map(listBuiltinProjectRoles().map((role) => [role.name, role.permissions]));
  for (const roleName of ["Admin", "Developer", "Operator"]) {
    assert.equal(roles.get(roleName)?.includes("storage.write"), true, roleName);
  }
  assert.equal(roles.get("Viewer")?.includes("storage.write"), false);
});

test("kv.manage is catalogued and stays out of the read-only KV roles", () => {
  const kvPermissions = listProjectPermissionGroups()
    .flatMap((group) => group.permissions)
    .filter((permission) => permission.key.startsWith("kv."));
  assert.deepEqual(kvPermissions.map((permission) => permission.key), ["kv.read", "kv.manage"]);
  assert.equal(kvPermissions.every((permission) => permission.group === "configuration"), true);

  const roles = new Map(listBuiltinProjectRoles().map((role) => [role.name, role.permissions]));
  // Deleting stored KV data is a management action: Admin and Developer get it,
  // while Operator and Viewer do not receive KV deletion management rights.
  for (const roleName of ["Admin", "Developer"]) {
    assert.equal(roles.get(roleName)?.includes("kv.manage"), true, roleName);
  }
  for (const roleName of ["Operator", "Viewer"]) {
    assert.equal(roles.get(roleName)?.includes("kv.manage"), false, roleName);
  }
  assert.equal(roles.get("Operator")?.includes("kv.read"), true);
});

test("both permission locales match the current Server registry and builtin roles", () => {
  const groups = listProjectPermissionGroups();
  const permissionKeys = groups.flatMap((group) => group.permissions.map((permission) => permission.key));
  const expectedTranslationKeys = permissionKeys.flatMap((key) => [
    `permission_${key.replaceAll(".", "_")}_label`,
    `permission_${key.replaceAll(".", "_")}_description`,
  ]).sort();

  for (const locale of ["en", "zh-CN"] as const) {
    initI18n({ preference: locale });
    const t = (key: string) => translateDynamicKey(key, "permissions");
    const translations = i18n.getResourceBundle(locale, "permissions") as Record<string, string>;
    assert.deepEqual(Object.keys(translations).filter((key) => key.startsWith("permission_")).sort(), expectedTranslationKeys);
    for (const [key, value] of Object.entries(translations)) {
      assert.ok(value.trim(), key);
      assert.doesNotMatch(value, /\bruns?\b|debug|queue|Webhook|Embed|运行|队列|调试/i, key);
    }
    for (const group of groups) {
      assert.notEqual(t(`group_${group.id}`), `group_${group.id}`);
      if (locale === "zh-CN") assert.equal(t(`group_${group.id}`), group.label);
      for (const permission of group.permissions) {
        const prefix = `permission_${permission.key.replaceAll(".", "_")}`;
        if (locale === "zh-CN") {
          assert.equal(t(`${prefix}_label`), permission.label);
          assert.equal(t(`${prefix}_description`), permission.description);
        }
      }
    }
    for (const role of listBuiltinProjectRoles()) {
      assert.notEqual(t(`role_${role.id}_description`), `role_${role.id}_description`);
      if (locale === "zh-CN") assert.equal(t(`role_${role.id}_description`), role.description);
    }
  }
});
