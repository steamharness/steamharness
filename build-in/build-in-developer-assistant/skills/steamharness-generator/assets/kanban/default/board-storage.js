import { STATUSES } from "./board-state.js";

export const BOARD_STORAGE_VERSION = 1;
export const BOARD_STORAGE_KEY_PREFIX = "kanban.board-state.v1:";

export function createBoardStorageKey(configurationId) {
  const normalized = String(configurationId ?? "").trim();
  return `${BOARD_STORAGE_KEY_PREFIX}${normalized || "default"}`;
}

export function serializeBoardState(state) {
  return {
    version: BOARD_STORAGE_VERSION,
    tasks: state.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
    })),
  };
}

export function restoreBoardState(value, fallbackState) {
  if (!isStoredBoardState(value)) return fallbackState;
  return {
    ...fallbackState,
    tasks: value.tasks.map((task) => ({ ...task })),
  };
}

export function createBoardStorageController({
  kv,
  delay = 300,
  onStatus = () => undefined,
  schedule = (callback, wait) => setTimeout(callback, wait),
  cancel = (handle) => clearTimeout(handle),
} = {}) {
  let generation = 0;
  let currentKey = createBoardStorageKey();
  let pendingSave;
  let pendingHandle;
  const failedSaves = new Map();
  const temporaryStates = new Map();
  const latestSaveVersions = new Map();
  let saveQueue = Promise.resolve();
  let saveVersion = 0;
  let readBlocked = true;
  let temporary = false;

  function temporaryStatus() {
    onStatus({ state: "unavailable", message: "临时模式：绑定数据库后可保存任务，刷新页面会丢失当前修改" });
  }

  async function load(configurationId, fallbackState) {
    await flush().catch(() => undefined);
    const loadGeneration = generation + 1;
    generation = loadGeneration;
    currentKey = createBoardStorageKey(configurationId);
    readBlocked = true;
    temporary = false;
    if (!kv) {
      readBlocked = false;
      temporary = true;
      temporaryStatus();
      return { applied: true, state: temporaryStates.get(currentKey) ?? fallbackState, stored: false };
    }
    const failedSave = failedSaves.get(currentKey);
    if (failedSave) {
      readBlocked = false;
      onStatus({ state: "error", message: "保存失败，可重试" });
      return {
        applied: true,
        state: restoreBoardState(failedSave.value, fallbackState),
        stored: false,
        saveFailed: true,
      };
    }
    onStatus({ state: "loading", message: "正在加载" });
    try {
      const stored = await kv.getValue(currentKey);
      if (loadGeneration !== generation) return { applied: false };
      if (stored != null && !isStoredBoardState(stored)) throw new Error("保存的任务格式无效");
      const state = restoreBoardState(stored, fallbackState);
      readBlocked = false;
      onStatus({ state: "saved", message: stored == null ? "尚未保存" : "已恢复" });
      return { applied: true, state, stored: stored != null };
    } catch (error) {
      if (loadGeneration !== generation) return { applied: false };
      if (error?.code === "DATABASE_UNBOUND") {
        readBlocked = false;
        temporary = true;
        temporaryStatus();
        return { applied: true, state: temporaryStates.get(currentKey) ?? fallbackState, stored: false };
      }
      onStatus({ state: "error", message: "加载失败，可重试" });
      return { applied: true, state: fallbackState, stored: false, loadFailed: true };
    }
  }

  function scheduleSave(state) {
    if (readBlocked) return;
    if (temporary) {
      temporaryStates.set(currentKey, structuredClone(state));
      temporaryStatus();
      return;
    }
    if (pendingHandle !== undefined) cancel(pendingHandle);
    pendingSave = createSaveRecord(state);
    onStatus({ state: "saving", message: "保存中" });
    pendingHandle = schedule(() => {
      pendingHandle = undefined;
      const record = pendingSave;
      pendingSave = undefined;
      if (record) void enqueueSave(record).catch(() => undefined);
    }, delay);
  }

  function save(state) {
    if (readBlocked) return Promise.reject(new Error("看板尚未成功加载，未覆盖已有数据"));
    if (temporary) {
      scheduleSave(state);
      return Promise.resolve();
    }
    return enqueueSave(createSaveRecord(state));
  }

  function flush() {
    if (pendingHandle !== undefined) {
      cancel(pendingHandle);
      pendingHandle = undefined;
    }
    const record = pendingSave;
    pendingSave = undefined;
    return record ? enqueueSave(record) : saveQueue;
  }

  function retrySave() {
    const failedSave = failedSaves.get(currentKey);
    if (!failedSave) return Promise.resolve();
    const record = {
      ...failedSave,
      generation,
      version: ++saveVersion,
    };
    failedSaves.set(currentKey, record);
    latestSaveVersions.set(currentKey, record.version);
    return enqueueSave(record);
  }

  function createSaveRecord(state) {
    const record = {
      key: currentKey,
      value: serializeBoardState(state),
      generation,
      version: ++saveVersion,
    };
    failedSaves.delete(record.key);
    latestSaveVersions.set(record.key, record.version);
    return record;
  }

  function enqueueSave(record) {
    const operation = saveQueue.then(async () => {
      onStatus({ state: "saving", message: "保存中" });
      try {
        await kv.setValue(record.key, record.value);
        if (latestSaveVersions.get(record.key) === record.version) {
          failedSaves.delete(record.key);
        }
        if (
          record.generation === generation &&
          record.key === currentKey &&
          record.version === saveVersion
        ) {
          onStatus({ state: "saved", message: "已保存" });
        }
      } catch {
        if (latestSaveVersions.get(record.key) === record.version) {
          failedSaves.set(record.key, record);
        }
        if (
          latestSaveVersions.get(record.key) === record.version &&
          record.generation === generation &&
          record.key === currentKey &&
          record.version === saveVersion
        ) {
          onStatus({ state: "error", message: "保存失败，可重试" });
        }
        throw new Error("看板保存失败");
      }
    });
    saveQueue = operation.catch(() => undefined);
    return operation;
  }

  return { load, scheduleSave, save, flush, retrySave };
}

function isStoredBoardState(value) {
  return value !== null &&
    typeof value === "object" &&
    value.version === BOARD_STORAGE_VERSION &&
    Array.isArray(value.tasks) &&
    value.tasks.every((task) => (
      task !== null &&
      typeof task === "object" &&
      typeof task.id === "string" &&
      task.id.trim() !== "" &&
      typeof task.title === "string" &&
      task.title.trim() !== "" &&
      typeof task.description === "string" &&
      typeof task.status === "string" &&
      STATUSES.includes(task.status)
    ));
}
