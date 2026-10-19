export type GameInput = string;

export type GameWeapon = "m4a1" | "ak47" | "mp7";
export type GameAttachment = "holo-sight" | "suppressor" | "extended-mag";
export type GameMedicine = "field-bandage" | "adrenaline" | "trauma-kit";
export type GameArmor = "light-plate" | "heavy-plate" | "recon-vest";

export interface RunPayload {
  errCode: number;
  errMessage: string;
}

export type OutputContentType = "markdown" | "text" | "json";

export interface OutputItem {
  id: string;
  title: string;
  content: unknown;
  icon?: string;
  iconPreset?: "info" | "success" | "warning" | "error" | "note" | "code" | "list" | "quote" | "none";
  contentType?: OutputContentType;
  collapsed?: boolean;
  metadata?: Record<string, unknown>;
}

export interface RunOutputPayload extends RunPayload {
  items: OutputItem[];
}

export interface ExecutorResult<Output extends RunPayload> {
  ok: boolean;
  data?: Output;
  error?: unknown;
}

export interface MissionSeed extends RunPayload {
  task: string;
  intensity: number;
  stealth: number;
  range: number;
  attrition: number;
}

export interface LoadoutPlan extends MissionSeed {
  weapon: GameWeapon;
  attachment: GameAttachment;
  medicine: GameMedicine;
  armor: GameArmor;
  route: "assault" | "stealth" | "support";
}

export interface WeaponBrief extends LoadoutPlan {
  content: string;
  weaponDescription: string;
}

export interface AttachmentBrief extends WeaponBrief {
  attachmentDescription: string;
}

export interface MedicineBrief extends AttachmentBrief {
  medicineDescription: string;
}

export interface ArmorBrief extends MedicineBrief {
  armorDescription: string;
}

export interface GameStory extends ArmorBrief {
  story: string;
}

export interface GameResultDraft extends RunPayload {
  content: string;
  task: string;
  weapon: GameWeapon;
  attachment: GameAttachment;
  medicine: GameMedicine;
  armor: GameArmor;
  route: LoadoutPlan["route"];
  weaponDescription: string;
  attachmentDescription: string;
  medicineDescription: string;
  armorDescription: string;
  story: string;
  missionStatus: MissionStatus;
  success: boolean;
}

export type MissionStatus = "true" | "false" | "";

export interface GameResultOutput extends RunOutputPayload {
  task: string;
  weapon: GameWeapon;
  attachment: GameAttachment;
  medicine: GameMedicine;
  armor: GameArmor;
  route: LoadoutPlan["route"];
  weaponDescription: string;
  attachmentDescription: string;
  medicineDescription: string;
  armorDescription: string;
  story: string;
  missionStatus: MissionStatus;
  success: boolean;
}

export type GameOutput = ExecutorResult<GameResultOutput>;
