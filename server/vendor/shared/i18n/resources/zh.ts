// Simplified Chinese resources. Each namespace mirrors en/<ns>.ts and is typed
// against it so the compiler rejects keys added to only one language.
import type { enResources } from "./en";
import { common as zhcommon } from "./zh/common";
import { desktop as zhDesktop } from "./zh/desktop";
import { serverWeb as zhserverWeb } from "./zh/server-web";
import { server as zhserver } from "./zh/server";
import { cli as zhcli } from "./zh/cli";
import { permissions as zhpermissions } from "./zh/permissions";

export const zhResources: typeof enResources = { common: zhcommon, desktop: zhDesktop, serverWeb: zhserverWeb, server: zhserver, cli: zhcli, permissions: zhpermissions };
