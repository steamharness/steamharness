import { useEffect, useRef, useState } from "react";
import { i18n, useTranslation } from "@steamharness/i18n/react";
import {
  createMemoryClient,
  memoryText,
  memoryJobText,
  type MemoryTextKey,
  type MemoryRecord,
} from "@steamharness/account-memory";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { cn } from "cn";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ConfirmActionDialog,
  type ConfirmAction,
} from "@/components/ConfirmActionDialog";
import { ArrowLeft, Plus, RefreshCw, Trash2 } from "lucide-react";
const client = createMemoryClient();
export function MemoryPage() {
  useTranslation();
  const operation = useRef<{ key: string; id: string } | undefined>(undefined);
  const detailRequest = useRef(0);
  const t = (k: MemoryTextKey) => memoryText(i18n.language, k);
  const generation = useRef(0),
    alive = useRef(true);
  const [items, setItems] = useState<MemoryRecord[]>([]),
    [selected, setSelected] = useState<MemoryRecord | null>(null),
    [draft, setDraft] = useState<string | null>(null),
    [scope, setScope] = useState("all"),
    [origin, setOrigin] = useState("all"),
    [query, setQuery] = useState(""),
    [search, setSearch] = useState("");
  const [cursor, setCursor] = useState<string>(),
    [history, setHistory] = useState<(string | undefined)[]>([]),
    [next, setNext] = useState<string>(),
    [refresh, setRefresh] = useState(0),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [detailLoading, setDetailLoading] = useState(false),
    [error, setError] = useState(""),
    [service, setService] = useState(""),
    [automaticAvailable, setAutomaticAvailable] = useState(false),
    [preferences, setPreferences] = useState({
      enabled: true,
      automatic: true,
    }),
    [scopes, setScopes] = useState<any[]>([]),
    [locked, setLocked] = useState<Record<string, number>>({}),
    [jobs, setJobs] = useState<any[]>([]),
    [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query);
      resetPage();
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  const resetPage = () => {
    setCursor(undefined);
    setHistory([]);
    setSelected(null);
    setDraft(null);
    detailRequest.current++;
    setDetailLoading(false);
  };
  useEffect(() => {
    const epoch = ++generation.current;
    let cancelled = false;
    setLoading(true);
    setNext(undefined);
    setItems([]);
    setSelected(null);
    setDraft(null);
    setError("");
    setDetailLoading(false);
    setLocked({});
    void (async () => {
      try {
        const [caps, prefs, registered, pending] = await Promise.all([
          client.call("capabilities"),
          client.call("preferences"),
          client.call("scopes"),
          client.call("jobs"),
        ]);
        if (cancelled || epoch !== generation.current) return;
        setPreferences(prefs);
        setScopes(registered);
        setJobs(pending);
        setService(caps.status);
        setAutomaticAvailable(caps.automatic === true);
        if (caps.status !== "ready") return;
        if (
          registered.some((entry: any) => entry.scope === scope && entry.locked)
        ) {
          const page = await client.call("list", { pageSize: 1 });
          if (cancelled || epoch !== generation.current) return;
          setLocked({ [scope]: page.locked?.[scope] ?? 0 });
          return;
        }
        const page = await client.call("list", {
          scope: scope === "all" ? undefined : scope,
          origin: origin === "all" ? undefined : origin,
          query: search || undefined,
          cursor,
          pageSize: 20,
        });
        if (cancelled || epoch !== generation.current) return;
        setItems(page.items);
        setNext(page.nextCursor);
        setLocked(page.locked ?? {});
      } catch (e) {
        if (!cancelled && epoch === generation.current)
          setError((e as any).status === 403 ? t("locked") : t("error"));
      } finally {
        if (!cancelled && epoch === generation.current) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scope, origin, search, cursor, refresh, i18n.language]);
  async function mutate(action: string, input: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    const epoch = generation.current;
    try {
      const key = JSON.stringify({ action, input });
      if (operation.current?.key !== key)
        operation.current = { key, id: crypto.randomUUID() };
      await client.call(action, {
        ...input,
        operationId: operation.current.id,
      });
      if (!alive.current || epoch !== generation.current) return;
      operation.current = undefined;
      setConfirm(null);
      setDraft(null);
      setSelected(null);
      setRefresh((v) => v + 1);
    } catch (e) {
      if (alive.current && epoch === generation.current)
        setError(action === "retry" ? t("retryError") : (e as any).status === 409 ? t("conflict") : t("error"));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function loadDetail(id: string) {
    const request = ++detailRequest.current;
    const epoch = generation.current;
    setSelected(null);
    setDraft(null);
    setDetailLoading(true);
    try {
      const record = await client.call("get", { id });
      if (alive.current && epoch === generation.current && request === detailRequest.current)
        setSelected(record);
    } catch (e) {
      if (alive.current && epoch === generation.current && request === detailRequest.current)
        setError((e as any).status === 403 ? t("locked") : t("error"));
    } finally {
      if (alive.current && epoch === generation.current && request === detailRequest.current)
        setDetailLoading(false);
    }
  }
  const ask = (action: "forget" | "clear", target?: string) =>
    setConfirm({
      title: t(action === "forget" ? "confirmForget" : "confirmClear"),
      description: t("consequence"),
      confirmLabel: t("confirm"),
      onConfirm: () =>
        void mutate(
          action,
          action === "forget"
            ? { id: selected?.id }
            : { scope: target ?? scope },
        ),
    });
  const filter = (
    value: string,
    key: MemoryTextKey,
    choices: { value: string; label: string }[],
    onChange: (v: string) => void,
  ) => (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={t(key)} className="w-full sm:w-44">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>{t(key)}</SelectLabel>
          {choices.map((c) => (
            <SelectItem key={c.value} value={c.value}>
              {c.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
  const scopeName = (value: string) =>
    value === "global"
      ? t("global")
      : scopes.find((s) => s.scope === value && !s.locked)?.label ||
        `${t(value.startsWith("directory:") ? "directory" : "project")} · ${value.split(":").slice(1).join(":")}`;
  const showDetail = selected !== null || draft !== null || detailLoading;
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-6 p-4 lg:p-6" aria-label={t("title")}>
      <div>
        <h1 className="text-lg font-semibold">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("privacy")}</p>
      </div>
      <FieldGroup className="flex-row flex-wrap gap-6">
        {(["enabled", "automatic"] as const).map((key) => (
          <Field key={key} orientation="horizontal" className="w-auto">
            <Switch
              id={`memory-${key}`}
              checked={preferences[key]}
              disabled={busy || loading}
              onCheckedChange={(value) =>
                void mutate("setPreferences", { ...preferences, [key]: value })
              }
            />
            <FieldLabel htmlFor={`memory-${key}`}>
              {t(key === "enabled" ? "enabled" : "autoSave")}
            </FieldLabel>
          </Field>
        ))}
      </FieldGroup>
      <Separator />
      <div className="flex flex-wrap items-center gap-2">
        {filter(
          scope,
          "scope",
          [
            { value: "all", label: t("all") },
            { value: "global", label: t("global") },
            ...scopes
              .filter((s) => s.scope !== "global")
              .map((s) => ({
                value: s.scope,
                label: s.locked ? t("locked") : s.label || scopeName(s.scope),
              })),
          ],
          (v) => {
            setScope(v);
            resetPage();
          },
        )}
        {filter(
          origin,
          "source",
          [
            { value: "all", label: t("allOrigins") },
            { value: "manual", label: t("manual") },
            { value: "automatic", label: t("automatic") },
          ],
          (v) => {
            setOrigin(v);
            resetPage();
          },
        )}
        <Input
          type="search"
          aria-label={t("search")}
          placeholder={t("search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="min-w-36 flex-1"
        />
        <Button
          variant="outline"
          size="icon"
          aria-label={t("refresh")}
          onClick={() => setRefresh((v) => v + 1)}
        >
          <RefreshCw data-icon="inline-start" />
        </Button>
        <Button
          onClick={() => {
            detailRequest.current++;
            setDetailLoading(false);
            setSelected(null);
            setDraft("");
          }}
          disabled={
            service !== "ready" ||
            busy ||
            scopes.some((s) => s.scope === scope && s.locked)
          }
        >
          <Plus data-icon="inline-start" />
          {t("new")}
        </Button>
        <Button
          variant="outline"
          onClick={() => ask("clear")}
          disabled={scope === "all" || busy}
        >
          <Trash2 data-icon="inline-start" />
          {t("clear")}
        </Button>
      </div>
      {error && (
        <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>
      )}
      {service === "unconfigured" && (
        <Alert role="status"><AlertDescription>{t("unconfigured")}</AlertDescription></Alert>
      )}
      {service === "unavailable" && (
        <Alert role="status"><AlertDescription>{t("error")}</AlertDescription></Alert>
      )}
      {!preferences.enabled && (
        <Alert role="status"><AlertDescription>{t("disabled")}</AlertDescription></Alert>
      )}
      {service === "ready" && !automaticAvailable && (
        <p role="status" className="text-xs text-muted-foreground">
          {t("autoUnavailable")}
        </p>
      )}
      {jobs.length > 0 && <details>
        <summary className="cursor-pointer text-sm text-muted-foreground">{t("jobs")} · {jobs.length}</summary>
        <div className="mt-2 flex max-h-36 flex-col gap-2 overflow-auto">
      {jobs.map((job) => {
        const text = memoryJobText(job);
        return (
        <div
          key={job.id}
          className="flex items-center justify-between gap-3"
        >
          <div className="flex min-w-0 flex-col gap-1">
            <Badge variant="secondary">{t(text.label)}</Badge>
            {text.detail && <p className="text-sm text-muted-foreground">{t(text.detail)}</p>}
          </div>
          {job.status === "failed" && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || job.retryable === false || !preferences.enabled || !preferences.automatic || !automaticAvailable}
              onClick={() => void mutate("retry", { id: job.id })}
            >
              {t("retry")}
            </Button>
          )}
        </div>
        );
      })}
        </div>
      </details>}
      <div
        className="grid h-[min(600px,65dvh)] min-h-80 min-w-0 grid-cols-1 overflow-hidden rounded-md border border-border lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]"
        aria-busy={loading}
      >
        <div
          className={cn("min-w-0 overflow-auto", showDetail && "hidden lg:block")}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("content")}</TableHead>
                <TableHead>{t("scope")}</TableHead>
                <TableHead>{t("source")}</TableHead>
                <TableHead>{t("updated")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell
                    colSpan={4}
                    className="h-32 text-center text-muted-foreground"
                  >
                    <span className="sr-only">{t("loading")}</span>
                    <div className="flex flex-col gap-3" aria-hidden="true"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-1/2" /><Skeleton className="h-4 w-2/3" /></div>
                  </TableCell>
                </TableRow>
              ) : !items.length && service === "ready" ? (
                <TableRow>
                  <TableCell
                    colSpan={4}
                    className="h-32 text-center text-muted-foreground"
                  >
                    {!error && !Object.keys(locked).length && <Empty><EmptyHeader><EmptyDescription>{t("empty")}</EmptyDescription></EmptyHeader></Empty>}
                  </TableCell>
                </TableRow>
              ) : (
                items.map((item) => (
                  <TableRow
                    key={item.id}
                    data-state={
                      selected?.id === item.id ? "selected" : undefined
                    }
                  >
                    <TableCell className="max-w-64">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="max-w-full justify-start px-0"
                        title={item.content}
                        onClick={() => void loadDetail(item.id)}
                      >
                        <span className="truncate">{item.content}</span>
                      </Button>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {scopeName(item.scope)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {t(item.origin === "manual" ? "manual" : "automatic")}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {new Date(item.updatedAt).toLocaleString(i18n.language)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          {Object.entries(locked).map(([key, count]) => (
            <div
              key={key}
              className="flex items-center justify-between gap-2 border-t border-border p-3 text-sm"
            >
              <span>
                {t("locked")} · {count} {t("count")}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => ask("clear", key)}
              >
                {t("clear")}
              </Button>
            </div>
          ))}
        </div>
        <article
          className={cn("min-w-0 overflow-auto border-border p-4 lg:border-l", !showDetail && "hidden lg:block")}
        >
          {showDetail ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="mb-3 lg:hidden"
                onClick={() => {
                  detailRequest.current++;
                  setDetailLoading(false);
                  setSelected(null);
                  setDraft(null);
                }}
              >
                <ArrowLeft data-icon="inline-start" />
                {t("back")}
              </Button>
              <h2 className="mb-3 text-sm font-semibold">{t("detail")}</h2>
              {detailLoading ? <div role="status" aria-label={t("loading")} className="flex flex-col gap-3"><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-2/3" /></div> : draft !== null ? (
                <Field>
                  {!selected && (
                    <p className="text-xs text-muted-foreground">
                      {t("scope")}:{" "}
                      {scopeName(scope === "all" ? "global" : scope)}
                    </p>
                  )}
                  <FieldLabel htmlFor="memory-content">
                    {t("content")}
                  </FieldLabel>
                  <Textarea
                    id="memory-content"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    maxLength={16000}
                    className="min-h-52"
                  />
                  <div className="flex gap-2">
                    <Button
                      disabled={busy || !draft.trim()}
                      onClick={() =>
                        void mutate(
                          selected ? "update" : "remember",
                          selected
                            ? {
                                id: selected.id,
                                version: selected.version,
                                content: draft,
                              }
                            : {
                                scope: scope === "all" ? "global" : scope,
                                content: draft,
                              },
                        )
                      }
                    >
                      {t("save")}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setDraft(null);
                      }}
                    >
                      {t("cancel")}
                    </Button>
                  </div>
                </Field>
              ) : (
                selected && (
                  <>
                    <p className="whitespace-pre-wrap break-words text-sm leading-6">
                      {selected.content}
                    </p>
                    <p className="my-4 text-xs text-muted-foreground">
                      {t("version")} {selected.version} ·{" "}
                      {scopeName(selected.scope)}
                    </p>
                    <div className="mb-4 flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setDraft(selected.content)}
                      >
                        {t("edit")}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const epoch = generation.current;
                          void Promise.resolve().then(() => navigator.clipboard.writeText(selected.content)).catch(() => {
                            if (alive.current && epoch === generation.current) setError(t("error"));
                          });
                        }}
                      >
                        {t("copy")}
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => ask("forget")}
                      >
                        {t("forget")}
                      </Button>
                    </div>
                    <details>
                      <summary className="cursor-pointer text-xs text-muted-foreground">
                        {t("sources")}
                      </summary>
                      {selected.sources.map((source) => (
                        <blockquote
                          key={source.id}
                          className="mt-3 whitespace-pre-wrap break-words border-l-2 border-border pl-3 text-xs text-muted-foreground"
                        >
                          {source.content}
                        </blockquote>
                      ))}
                    </details>
                  </>
                )
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{t("select")}</p>
          )}
        </article>
      </div>
      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!history.length || loading}
          onClick={() => {
            const previous = [...history];
            setCursor(previous.pop());
            setHistory(previous);
          }}
        >
          {t("previous")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!next || loading}
          onClick={() => {
            setHistory([...history, cursor]);
            setCursor(next);
          }}
        >
          {t("next")}
        </Button>
      </div>
      <ConfirmActionDialog
        action={confirm && { ...confirm, busy }}
        onOpenChange={(open) => !open && !busy && setConfirm(null)}
      />
    </section>
  );
}
