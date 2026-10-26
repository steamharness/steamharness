export interface AccountSectionAction {
  id: string;
  label: string;
  icon?: string;
}

/** Display data only. Credentials and request logic stay in the extension host. */
export interface AccountSection {
  id: string;
  title: string;
  description?: string;
  message?: string;
  warning?: boolean;
  metrics?: { label: string; value: string; detail?: string }[];
  rows?: { label: string; value: string }[];
  meters?: { label: string; value: number; max: number | null; text: string; detail: string }[];
  table?: { columns: string[]; rows: string[][]; filterLabel: string; emptyMessage: string };
  actions?: AccountSectionAction[];
}

export interface AccountSectionConnection { serverUrl: string; accessToken: string }

export interface AccountSectionProvider {
  id: string;
  title: string;
  icon?: string;
  load(connection: AccountSectionConnection, signal: AbortSignal): Promise<AccountSection[]>;
  onAction?(action: string, connection: AccountSectionConnection): PromiseLike<unknown> | void;
}

export interface AccountSectionState {
  id: string;
  title: string;
  loading: boolean;
  failed: boolean;
  updatedAt?: string;
  sections: AccountSection[];
}
