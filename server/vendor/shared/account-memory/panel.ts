import {
  memoryText,
  memoryJobText,
  type MemoryTextKey,
  type MemoryClient,
  type MemoryRecord,
} from "./index";
import { formatDateTime } from "../i18n/utils/format";

let panelSequence = 0;

/** Host owns authentication and theme; no credentials enter this panel. */
export function createMemoryPanel(options: {
  client: MemoryClient;
  locale: string;
  account?: boolean;
  onAuthorize?: () => void;
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
  const panelId = `am-panel-${++panelSequence}`;
  root.ariaLabel = t("title");
  let epoch = 0,
    detailEpoch = 0,
    disposed = false,
    pending = false,
    available = false;
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
  const surface = el("div", undefined, "am-surface");
  const toolbar = el("div", undefined, "am-toolbar"),
    status = el("div", undefined, "am-status");
  const layout = el("div", undefined, "am-layout"),
    list = el("ul", undefined, "am-list");
  const detail = el("article", t("select"), "am-detail"),
    footer = el("div", undefined, "am-footer");
  layout.hidden = footer.hidden = true;
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
  for (const [input, key, note] of [
    [enabled, "enabled", "enabledNote"],
    [automatic, "autoSave", "autoSaveNote"],
  ] as const) {
    const label = el("label", undefined, "am-preference");
    const description = el("span", undefined, "am-preference-copy");
    const explanation = el("span", t(note), "am-muted");
    explanation.id = `${panelId}-${key}`;
    description.append(el("span", t(key), "am-preference-title"), explanation);
    input.className = "am-switch";
    input.setAttribute("role", "switch");
    input.ariaLabel = t(key);
    input.setAttribute("aria-describedby", explanation.id);
    label.append(description, input);
    controls.append(label);
    input.onchange = () => void changePreferences();
  }
  const create = button("new", () => edit());
  const clear = button("clear", () => confirm("clear", scope));
  create.disabled = clear.disabled = true;
  const toolbarActions = el("div", undefined, "am-toolbar-actions");
  toolbarActions.append(
    button("refresh", () => void load()),
    create,
    clear,
  );
  toolbar.append(scopes, origins, search, toolbarActions);
  layout.append(list, detail);
  surface.append(
    ...(options.account ? [controls] : []),
    toolbar,
    status,
    layout,
    footer,
  );
  root.append(intro, surface);
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
      available &&
      caps?.status === "ready" &&
      !caps?.readOnly &&
      (caps?.enabled || options.account);
    create.disabled =
      pending ||
      !writable ||
      registered.some((entry) => entry.scope === scope && entry.locked);
    clear.disabled = pending || !writable || !scope;
    enabled.disabled = pending || !available || caps?.readOnly;
    automatic.disabled = enabled.disabled || !prefs.enabled;
    scopes.disabled = origins.disabled = search.disabled = pending || (!available && !!layout.hidden);
    for (const retry of status.querySelectorAll<HTMLButtonElement>(".am-job button"))
      retry.disabled = pending || retry.dataset.retryable === "false" ||
        !prefs.enabled || !prefs.automatic || !caps?.automatic;
  };
  function showUnavailable(key: MemoryTextKey) {
    available = false;
    list.replaceChildren();
    layout.hidden = footer.hidden = true;
    status.classList.add("am-unavailable");
    status.replaceChildren(el("p", t(key)));
    if (key === "unauthorized" && options.onAuthorize)
      status.append(button("authorize", options.onAuthorize));
  }
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
    status.classList.remove("am-unavailable");
    available = false;
    caps = undefined;
    updateControls();
    selected = undefined;
    detail.textContent = t("select");
    root.classList.remove("am-show-detail");
    root.setAttribute("aria-busy", "true");
    create.disabled = clear.disabled = true;
    try {
      const capability = await options.client.call("capabilities");
      if (!valid(version)) return;
      caps = capability;
      status.replaceChildren();
      if (!caps.connected || caps.status === "unconfigured") {
        showUnavailable("unconfigured");
        return;
      }
      if (caps.status !== "ready") {
        showUnavailable("error");
        return;
      }
      if (!caps.enabled && !options.account) {
        showUnavailable("disabled");
        return;
      }
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
          const note = el("div", undefined, "am-job");
          const copy = el("div", undefined, "am-job-copy");
          const text = memoryJobText(job);
          copy.append(el("span", t(text.label)));
          if (text.detail) copy.append(el("p", t(text.detail), "am-muted"));
          note.append(copy);
          if (job.status === "failed") {
            const error = el("p", undefined, "am-error");
            copy.append(error);
            const retry = button("retry", () => {
              const version = epoch;
              error.textContent = "";
              retry.textContent = t("retrying");
              void mutate("retry", { id: job.id }, error).finally(() => {
                if (valid(version)) retry.textContent = t("retry");
              });
            });
            retry.dataset.retryable = String(job.retryable !== false);
            note.append(retry);
          }
          status.append(note);
        }
      }
      if (options.account && prefs.enabled && prefs.automatic && !caps.automatic)
        status.append(el("p", t("autoUnavailable"), "am-muted"));
      if (caps.readOnly) status.append(el("p", t("readonly"), "am-muted"));
      if (registered.some((entry) => entry.scope === scope && entry.locked)) {
        const page = await options.client.call("list", { pageSize: 1 });
        if (!valid(version)) return;
        list.replaceChildren();
        lockedRow(scope, page.locked?.[scope] ?? 0);
        available = true;
        layout.hidden = false;
        return;
      }
      const page = await options.client.call("list", {
        scope: scope || undefined,
        origin: origin || undefined,
        query: query || undefined,
        cursor,
      });
      if (!valid(version)) return;
      list.replaceChildren();
      const emptyPage = !page.items.length && !Object.keys(page.locked ?? {}).length;
      root.classList.toggle("am-empty-page", emptyPage);
      if (emptyPage) {
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
          `${scopeName(item.scope)} · ${t(item.origin === "manual" ? "manual" : "automatic")} · ${formatDateTime(item.updatedAt)}`,
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
      available = true;
      layout.hidden = false;
      footer.hidden = !nextCursor && !history.length;
      previous.disabled = !history.length;
      next.disabled = !nextCursor;
    } catch (error) {
      if (valid(version))
        showUnavailable(
          (error as any)?.status === 403
            ? "locked"
            : (error as any)?.status === 401
              ? "unauthorized"
              : (error as any)?.status === 404 ? "unsupported" : "error",
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
    if (!available || pending) return;
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
        `${t("version")} ${item.version} · ${formatDateTime(item.updatedAt)}`,
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
      button("cancel", () => (item ? view() : back())),
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
      button("cancel", () => (item ? view() : back())),
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
          action === "retry" ? "retryError" : (cause as any)?.status === 409 ? "conflict" : "error",
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
