export type PublicUser = {
  id: string;
  displayName: string;
  username: string;
  color: string;
  email?: string;
};

export type Member = PublicUser & {
  online?: boolean;
};

export type Household = {
  id: string;
  name: string;
  inviteCode: string;
  members: Member[];
};

export type List = {
  id: string;
  name: string;
  emoji: string;
  sortOrder: number;
  createdAt: number;
};

export type Section = {
  id: string;
  listId: string;
  name: string;
  sortOrder: number;
  createdAt: number;
};

export type Item = {
  id: string;
  listId: string;
  name: string;
  quantity: string;
  category: string;
  notes: string;
  checked: boolean;
  sectionId: string | null;
  addedBy: PublicUser;
  checkedBy: PublicUser | null;
  createdAt: number;
  updatedAt: number;
};

export type Suggestion = {
  name: string;
  category: string;
  quantity: string;
  count: number;
};

export type ReminderKind = "trip" | "nudge" | "item";

export type Reminder = {
  id: string;
  listId: string | null;
  itemId: string | null;
  kind: ReminderKind;
  title: string;
  dueAt: number;
  durationMin: number;
  createdBy: PublicUser;
  createdAt: number;
};

export type Note = {
  id: string;
  title: string;
  body: string;
  fileName: string | null;
  fileMime: string | null;
  fileSize: number | null;
  createdBy: PublicUser;
  createdAt: number;
  updatedAt: number;
};

export type VaultItemSummary = {
  id: string;
  title: string;
  itemType: string;
  state: string;
};

export type VaultItemDetail = VaultItemSummary & {
  note: string;
  fields: Record<string, unknown>;
};

export type VaultStatus = {
  configured: boolean;
  vault: string;
  source: "cache" | "live" | "unavailable";
  syncedAt: number | null;
  count: number;
};

export type VaultList = {
  vault: string;
  items: VaultItemSummary[];
};
export type Bootstrap = {
  user: PublicUser;
  household: Household;
  lists: List[];
  sections: Section[];
  items: Item[];
  reminders: Reminder[];
  notes: Note[];
};

export type RealtimeEvent =
  | { type: "item.created"; item: Item }
  | { type: "item.updated"; item: Item }
  | { type: "item.deleted"; id: string; listId: string }
  | { type: "list.created"; list: List }
  | { type: "list.updated"; list: List }
  | { type: "list.deleted"; id: string }
  | { type: "household.updated"; household: Household }
  | { type: "presence"; userIds: string[] };
