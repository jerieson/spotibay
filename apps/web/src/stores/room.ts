import { create } from 'zustand';
import type { Member, Room, RoomRole, RoomState, SocketError } from '@spotibay/shared';

export type RoomStatus = 'connecting' | 'needs-password' | 'joined' | 'closed' | 'failed';

interface RoomStoreState {
  status: RoomStatus;
  error: SocketError | null;
  room: Room | null;
  members: Member[];
  you: { userId: string; role: RoomRole } | null;
  reset: () => void;
  setStatus: (status: RoomStatus, error?: SocketError | null) => void;
  setState: (state: RoomState) => void;
  setMembers: (members: Member[]) => void;
  setRoom: (room: Room) => void;
}

const initial = {
  status: 'connecting' as RoomStatus,
  error: null,
  room: null,
  members: [] as Member[],
  you: null,
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
    }),
  // The server is the source of truth for roles, so our own role follows the member list.
  setMembers: (members) =>
    set((s) => {
      const me = s.you && members.find((m) => m.userId === s.you!.userId);
      return { members, you: me && s.you ? { ...s.you, role: me.role } : s.you };
    }),
  setRoom: (room) => set({ room }),
}));
