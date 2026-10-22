import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@spotibay/shared';

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** One connection for the app. It is connected only while a room page is open. */
export const socket: AppSocket = io({ autoConnect: false });
