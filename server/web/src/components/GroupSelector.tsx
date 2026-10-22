import { useEffect, useState } from "react";
import { useTranslation } from "@steamharness/i18n/react";
import { apiClient } from "../api";
import { isApiSuccess, type AccessPage, type ProjectGroup } from "../types";
import { Button, Field, FieldLabel, Input, SelectField } from "@/components/ui";
import { PaginationFooter } from "@/components/ui/pagination-footer";

export function GroupSelector({
  value,
  onChange,
  ownerOnly = false,
  label,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  ownerOnly?: boolean;
  label?: string;
}) {
  const { t } = useTranslation("serverWeb");
  const [revision, setRevision] = useState(0);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<AccessPage<ProjectGroup>>();
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setLoading(true);
    const timer = setTimeout(() => {
      void apiClient
        .listGroups({ q, page, minRole: ownerOnly ? "owner" : "developer" })
        .then((response) => {
          if (!live) return;
          setLoading(false);
          if (isApiSuccess(response)) {
            setResult(response.data);
            setError("");
          } else setError(response.errMessage);
        });
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q, page, ownerOnly, revision]);
  const groups = result?.items ?? [];
  return (
    <Field>
      <FieldLabel>{label ?? t("accessGroup")}</FieldLabel>
      <Input
        aria-label={t("accessSearchGroups")}
        placeholder={t("accessSearchGroups")}
        value={q}
        onChange={(event) => {
          setQ(event.target.value);
          setPage(1);
        }}
      />
      <SelectField
        disabled={loading}
        aria-label={label ?? t("accessGroup")}
        value={value ?? "__personal"}
        onValueChange={(id) => onChange(id === "__personal" ? null : id)}
        options={[
          { value: "__personal", label: t("accessPersonal") },
          ...(!groups.some((g) => g.id === value) && value
            ? [{ value, label: value }]
            : []),
          ...groups.map((g) => ({ value: g.id, label: g.name })),
        ]}
      />
      {loading && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("loginLoading")}
        </p>
      )}
      {error && (
        <div role="alert" className="text-sm text-destructive">
          {error}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => setRevision((v) => v + 1)}
          >
            {t("commonRetry")}
          </Button>
        </div>
      )}
      {!!result && result.total > 20 && (
        <PaginationFooter
          previousDisabled={loading || page === 1}
          nextDisabled={loading || page * 20 >= result.total}
          pageIndex={page - 1}
          total={result.total}
          rowsOnPage={groups.length}
          onPrevious={() => setPage((p) => p - 1)}
          onNext={() => setPage((p) => p + 1)}
        />
      )}
    </Field>
  );
}
