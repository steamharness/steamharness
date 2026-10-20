export interface ProjectUploadOption {
  id: string;
  label: string;
  checked: boolean;
}

export interface ProjectUploadCompletion {
  message?: string;
  warning?: boolean;
}

export interface ProjectUploadExtension {
  options: ProjectUploadOption[];
  complete(values: Record<string, boolean>, signal: AbortSignal): Promise<ProjectUploadCompletion | void>;
}

export interface ProjectUploadProvider {
  prepare(context: { projectId: string; version: string; connection: { serverUrl: string; accessToken: string }; signal: AbortSignal }): Promise<ProjectUploadExtension>;
}
