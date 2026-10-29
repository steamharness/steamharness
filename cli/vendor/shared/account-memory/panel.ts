import {
  memoryText,
  type MemoryTextKey,
  type MemoryClient,
  type MemoryRecord,
} from "./index";

/** Host owns authentication and theme; no credentials enter this panel. */
export function createMemoryPanel(options: {
  client: MemoryClient;
  locale: string;
  account?: boolean;
}) {
  const t = (key: MemoryTextKey) => memoryText(options.locale, key);
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    text?: string,
    cls?: string,
  ) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  };
  const button = (key: MemoryTextKey, fn: () => void) => {
    const node = el("button", t(key));
    node.type = "button";
    node.onclick = fn;
    return node;
  };
  const option = (select: HTMLSelectElement, value: string, label: string) => {
    const node = el("option", label);
    node.value = value;
    select.append(node);
  };
  const root = el("section", undefined, "account-memory");
  root.ariaLabel = t("title");
  let epoch = 0,
    detailEpoch = 0,
    disposed = false,
    pending = false;
  let cursor: string | undefined, nextCursor: string | undefined;
  let history: (string | undefined)[] = [],
    selected: MemoryRecord | undefined;
  let caps: any,
    prefs = { enabled: true, automatic: true };
  let registered: { scope: string; label: string; locked: boolean }[] = [];
  let scope = options.account ? "" : "global",
    origin = "",
    query = "";
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const valid = (version: number) => !disposed && version === epoch;
  const scopeName = (value: string) =>
    value === "global"
      ? t("global")
      : value === "current"
        ? t("current")
        : registered.find((entry) => entry.scope === value && !entry.locked)
            ?.label ||
          `${t(value.startsWith("directory:") ? "directory" : "project")} · ${value.split(":").slice(1).join(":")}`;
  const intro = el("p", t("privacy"), "am-muted");
  const toolbar = el("div", undefined, "am-toolbar"),
    status = el("div", undefined, "am-status");
  const layout = el("div", undefined, "am-layout"),
    list = el("ul", undefined, "am-list");
  const detail = el("article", t("select"), "am-detail"),
    footer = el("div", undefined, "am-footer");
  status.setAttribute("role", "status");
  status.ariaLive = "polite";
  list.ariaLabel = t("title");
  const scopes = el("select");
  scopes.ariaLabel = t("scope");
  const origins = el("select");
  origins.ariaLabel = t("source");
  const search = el("input");
  search.type = "search";
  search.placeholder = t("search");
  search.ariaLabel = t("search");
  if (options.account) option(scopes, "", t("all"));
  option(scopes, "global", t("global"));
  if (!options.account) option(scopes, "current", t("current"));
  for (const [value, key] of [
    ["", "allOrigins"],
    ["automatic", "automatic"],
    ["manual", "manual"],
  ] as const)
    option(origins, value, t(key));
  const previous = button("previous", () => {
    cursor = history.pop();
    void load();
  });
  const next = button("next", () => {
    history.push(cursor);
    cursor = nextCursor;
    void load();
  });
  previous.disabled = next.disabled = true;
  footer.append(previous, next);
  const controls = el("div", undefined, "am-preferences");
  const enabled = el("input");
  enabled.type = "checkbox";
  enabled.disabled = true;
  const automatic = el("input");
  automatic.type = "checkbox";
  automatic.disabled = true;
  for (const [input, key] of [
    [enabled, "enabled"],
    [automatic, "autoSave"],
  ] as const) {
    const label = el("label", t(key));
    label.prepend(input);
    controls.append(label);
    input.onchange = () => void changePreferences();
  }
  const create = button("new", () => edit());
  const clear = button("clear", () => confirm("clear", scope));
  create.disabled = clear.disabled = true;
  toolbar.append(
    scopes,
    origins,
    search,
    button("refresh", () => void load()),
    create,
    clear,
  );
  layout.append(list, detail);
  root.append(
    intro,
    ...(options.account ? [controls] : []),
    toolbar,
    status,
    layout,
    footer,
  );
  const reset = () => {
    cursor = undefined;
    nextCursor = undefined;
    history = [];
    selected = undefined;
    detailEpoch++;
    detail.textContent = t("select");
    root.classList.remove("am-show-detail");
  };
  const updateControls = () => {
    const writable =
      caps?.status === "ready" &&
      !caps?.readOnly &&
      (caps?.enabled || options.account);
    create.disabled =
      pending ||
      !writable ||
      registered.some((entry) => entry.scope === scope && entry.locked);
    clear.disabled = pending || !writable || !scope;
    enabled.disabled = automatic.disabled = pending || !caps || caps.readOnly;
  };
  scopes.onchange = () => {
    scope = scopes.value;
    reset();
    void load();
  };
  origins.onchange = () => {
    origin = origins.value;
    reset();
    void load();
  };
  search.oninput = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      query = search.value;
      reset();
      void load();
    }, 250);
  };
  async function changePreferences() {
    if (pending) return;
    const version = epoch;
    pending = true;
    updateControls();
    try {
      const value = await options.client.call("setPreferences", {
        enabled: enabled.checked,
        automatic: automatic.checked,
      });
      if (!valid(version)) return;
      prefs = value;
      await load();
    } catch {
      if (valid(version)) {
        enabled.checked = prefs.enabled;
        automatic.checked = prefs.automatic;
        status.textContent = t("error");
      }
    } finally {
      if (!disposed) {
        pending = false;
        updateControls();
      }
    }
  }
  async function load() {
    const version = ++epoch;
    detailEpoch++;
    nextCursor = undefined;
    previous.disabled = next.disabled = true;
    status.textContent = t("loading");
    selected = undefined;
    list.replaceChildren();
    detail.textContent = t("select");
    root.classList.remove("am-show-detail");
    root.setAttribute("aria-busy", "true");
    create.disabled = clear.disabled = true;
    try {
      const capability = await options.client.call("capabilities");
      if (!valid(version)) return;
      caps = capability;
      status.replaceChildren();
      if (options.account) {
        const [p, entries, jobs] = await Promise.all([
          options.client.call("preferences"),
          options.client.call("scopes"),
          options.client.call("jobs"),
        ]);
        if (!valid(version)) return;
        prefs = p;
        registered = entries;
        enabled.checked = p.enabled;
        automatic.checked = p.automatic;
        while (scopes.options.length > 2) scopes.remove(2);
        for (const entry of registered)
          if (entry.scope !== "global")
            option(
              scopes,
              entry.scope,
              entry.locked ? t("locked") : scopeName(entry.scope),
            );
        scopes.value = scope;
        for (const job of jobs) {
          const note = el(
            "div",
            t(job.status === "failed" ? "failed" : "pending"),
            "am-job",
          );
          if (job.status === "failed")
            note.append(
              button("retry", () => void mutate("retry", { id: job.id })),
            );
          status.append(note);
        }
      }
      if (!caps.connected || caps.status === "unconfigured") {
        status.textContent = t("unconfigured");
        return;
      }
      if (caps.status !== "ready") {
        status.textContent = t("error");
        return;
      }
      if (!caps.enabled && !options.account) {
        status.textContent = t("disabled");
        return;
      }
      if (options.account && !caps.automatic)
        status.append(el("p", t("autoUnavailable"), "am-muted"));
      if (caps.readOnly) status.append(el("p", t("readonly"), "am-muted"));
      if (registered.some((entry) => entry.scope === scope && entry.locked)) {
        const page = await options.client.call("list", { pageSize: 1 });
        if (!valid(version)) return;
        lockedRow(scope, page.locked?.[scope] ?? 0);
        return;
      }
      const page = await options.client.call("list", {
        scope: scope || undefined,
        origin: origin || undefined,
        query: query || undefined,
        cursor,
      });
      if (!valid(version)) return;
      if (!page.items.length) {
        const empty = el("li", undefined, "am-empty-state");
        empty.append(
          el("strong", t("empty")),
          el("p", t("emptyNote"), "am-muted"),
        );
        list.append(empty);
      }
      for (const item of page.items as MemoryRecord[]) {
        const entry = el("li"),
          row = el("button", undefined, "am-row");
        row.type = "button";
        row.ariaPressed = "false";
        const summary = el("span", item.content, "am-summary");
        summary.title = item.content;
        const meta = el(
          "span",
          `${scopeName(item.scope)} · ${t(item.origin === "manual" ? "manual" : "automatic")} · ${new Date(item.updatedAt).toLocaleString(options.locale)}`,
          "am-meta",
        );
        row.append(summary, meta);
        row.onclick = () => {
          for (const other of list.querySelectorAll("button.am-row"))
            other.setAttribute("aria-pressed", String(other === row));
          void openDetail(item.id);
        };
        entry.append(row);
        list.append(entry);
      }
      for (const [lockedScope, count] of Object.entries(page.locked ?? {}))
        lockedRow(lockedScope, count);
      nextCursor = page.nextCursor;
      previous.disabled = !history.length;
      next.disabled = !nextCursor;
    } catch (error) {
      if (valid(version))
        status.textContent = t(
          (error as any)?.status === 403
            ? "locked"
            : (error as any)?.status === 401
              ? "unconfigured"
              : "error",
        );
    } finally {
      if (valid(version)) {
        root.setAttribute("aria-busy", "false");
        updateControls();
      }
    }
  }
  function lockedRow(target: string, count: unknown) {
    const note = el(
      "li",
      `${t("locked")} · ${count} ${t("count")}`,
      "am-locked",
    );
    note.append(el("p", t("lockedNote")));
    if (options.account && !caps?.readOnly)
      note.append(button("clear", () => confirm("clear", target)));
    list.append(note);
  }
  function back() {
    root.classList.remove("am-show-detail");
  }
  async function openDetail(id: string) {
    const version = epoch,
      request = ++detailEpoch;
    root.classList.add("am-show-detail");
    detail.textContent = t("loading");
    try {
      const item = await options.client.call("get", { id });
      if (valid(version) && request === detailEpoch) {
        selected = item;
        view();
      }
    } catch {
      if (valid(version) && request === detailEpoch)
        detail.replaceChildren(button("back", back), el("p", t("error")));
    }
  }
  function view() {
    if (!selected) return;
    const item = selected;
    detail.replaceChildren(
      button("back", back),
      el("h3", t("detail")),
      el("p", scopeName(item.scope), "am-muted"),
      el("p", item.content, "am-content"),
      el(
        "p",
        `${t("version")} ${item.version} · ${new Date(item.updatedAt).toLocaleString(options.locale)}`,
        "am-muted",
      ),
    );
    const actions = el("div", undefined, "am-actions");
    actions.append(
      button("copy", () => {
        void navigator.clipboard?.writeText(item.content).catch(() => {
          status.textContent = t("error");
        });
      }),
    );
    if (!caps?.readOnly)
      actions.append(
        button("edit", () => edit(item)),
        button("forget", () => confirm("forget")),
      );
    detail.append(actions);
    if (item.sources.length) {
      const sources = el("details");
      sources.append(el("summary", t("sources")));
      for (const source of item.sources)
        sources.append(el("blockquote", source.content, "am-source"));
      detail.append(sources);
    }
  }
  function edit(item?: MemoryRecord) {
    if (caps?.readOnly || pending) return;
    selected = item;
    detailEpoch++;
    root.classList.add("am-show-detail");
    detail.replaceChildren(
      button("back", back),
      el("h3", t(item ? "edit" : "new")),
    );
    const destination = el("select");
    destination.ariaLabel = t("scope");
    for (const value of options.account
      ? [
          "global",
          ...registered
            .filter((entry) => !entry.locked && entry.scope !== "global")
            .map((entry) => entry.scope),
        ]
      : ["global", "current"])
      option(destination, value, scopeName(value));
    destination.value = scope || "global";
    if (!item) detail.append(destination);
    const text = el("textarea");
    text.ariaLabel = t("content");
    text.value = item?.content ?? "";
    text.maxLength = 16000;
    const error = el("p", undefined, "am-error");
    error.setAttribute("role", "alert");
    const operationId = crypto.randomUUID();
    const save = button("save", () => {
      if (!text.value.trim() || pending) return;
      save.disabled = true;
      void mutate(
        item ? "update" : "remember",
        {
          ...(item
            ? { id: item.id, version: item.version }
            : { scope: destination.value }),
          content: text.value,
          operationId,
        },
        error,
      ).finally(() => {
        save.disabled = !text.value.trim();
      });
    });
    save.disabled = !text.value.trim();
    text.oninput = () => {
      save.disabled = !text.value.trim() || pending;
    };
    detail.append(
      text,
      error,
      save,
      button("cancel", () => (item ? view() : detail.replaceChildren())),
    );
    text.focus();
  }
  function confirm(action: "forget" | "clear", target?: string) {
    if (pending || caps?.readOnly || (action === "clear" && !target)) return;
    const item = selected,
      operationId = crypto.randomUUID();
    detailEpoch++;
    const confirmButton = button("confirm", () => {
      confirmButton.disabled = true;
      void mutate(action, {
        ...(action === "forget" ? { id: item?.id } : { scope: target }),
        operationId,
      }).finally(() => {
        confirmButton.disabled = false;
      });
    });
    detail.replaceChildren(
      el("h3", t(action === "forget" ? "confirmForget" : "confirmClear")),
      el("p", t("consequence")),
      confirmButton,
      button("cancel", () => (item ? view() : detail.replaceChildren())),
    );
    root.classList.add("am-show-detail");
    confirmButton.focus();
  }
  async function mutate(
    action: string,
    input: Record<string, unknown>,
    error?: HTMLElement,
  ) {
    if (pending) return;
    const version = epoch;
    pending = true;
    updateControls();
    try {
      await options.client.call(action, input);
      if (!valid(version)) return;
      reset();
      await load();
    } catch (cause) {
      if (valid(version))
        (error ?? status).textContent = t(
          (cause as any)?.status === 409 ? "conflict" : "error",
        );
    } finally {
      if (!disposed) {
        pending = false;
        updateControls();
      }
    }
  }
  void load();
  return {
    element: root,
    refresh() {
      reset();
      void load();
    },
    dispose() {
      disposed = true;
      epoch++;
      detailEpoch++;
      clearTimeout(debounce);
      root.replaceChildren();
    },
  };
}
