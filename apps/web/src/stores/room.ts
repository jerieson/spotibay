import { create } from 'zustand';
import {
  idlePlayback,
  type ChatMessage,
  type Member,
  type PlaybackState,
  type QueueItem,
  type Room,
  type RoomRole,
  type RoomState,
  type SkipVotes,
  type SocketError,
  type SyncConfig,
} from '@spotibay/shared';

/** Older messages are dropped client-side so a long session stays light. */
const CHAT_CAP = 200;

export type RoomStatus = 'connecting' | 'needs-password' | 'joined' | 'closed' | 'failed';

interface RoomStoreState {
  status: RoomStatus;
  error: SocketError | null;
  room: Room | null;
  members: Member[];
  you: { userId: string; role: RoomRole } | null;
  playback: PlaybackState;
  queue: QueueItem[];
  skipVotes: SkipVotes;
  chat: ChatMessage[];
  sync: SyncConfig;
  reset: () => void;
  setStatus: (status: RoomStatus, error?: SocketError | null) => void;
  setState: (state: RoomState) => void;
  setMembers: (members: Member[]) => void;
  setRoom: (room: Room) => void;
  setPlayback: (playback: PlaybackState) => void;
  setQueue: (queue: QueueItem[]) => void;
  setSkipVotes: (skipVotes: SkipVotes) => void;
  addChat: (message: ChatMessage) => void;
  removeChat: (id: string) => void;
}

const initial = {
  status: 'connecting' as RoomStatus,
  error: null,
  room: null,
  members: [] as Member[],
  you: null,
  playback: idlePlayback,
  queue: [] as QueueItem[],
  skipVotes: { queueItemId: null, voters: [], needed: 1 } as SkipVotes,
  chat: [] as ChatMessage[],
  sync: { driftThresholdMs: 600, checkIntervalMs: 2000 } as SyncConfig,
};

export const useRoomStore = create<RoomStoreState>((set) => ({
  ...initial,
  reset: () => set(initial),
  setStatus: (status, error = null) => set({ status, error }),
  setState: (state) =>
    set({
      status: 'joined',
      error: null,
      room: state.room,
      members: state.members,
      you: state.you,
      playback: state.playback,
      queue: state.queue,
      skipVotes: state.skipVotes,
      chat: state.chat,
      sync: state.sync,
    }),
  // The server is the source of truth for roles, so our own role follows the member list.
  setMembers: (members) =>
    set((s) => {
      const me = s.you && members.find((m) => m.userId === s.you!.userId);
      return { members, you: me && s.you ? { ...s.you, role: me.role } : s.you };
    }),
  setRoom: (room) => set({ room }),
  // Updates can arrive out of order around a reconnect; only move forward.
  setPlayback: (playback) =>
    set((s) => (playback.version > s.playback.version ? { playback } : {})),
  setQueue: (queue) => set({ queue }),
  setSkipVotes: (skipVotes) => set({ skipVotes }),
  addChat: (message) =>
    set((s) =>
      s.chat.some((m) => m.id === message.id)
        ? {}
        : { chat: [...s.chat, message].slice(-CHAT_CAP) },
    ),
  removeChat: (id) => set((s) => ({ chat: s.chat.filter((m) => m.id !== id) })),
}));
