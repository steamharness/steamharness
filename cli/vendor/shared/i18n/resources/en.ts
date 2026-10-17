// English is the canonical key source. Each namespace lives in its own file so
// parallel migration agents can edit disjoint resource files safely.
import { common } from "./en/common";
import { desktop } from "./en/desktop";
import { serverWeb } from "./en/server-web";
import { server } from "./en/server";
import { cli } from "./en/cli";
import { permissions } from "./en/permissions";

export const enResources = { common, desktop, serverWeb, server, cli, permissions };
