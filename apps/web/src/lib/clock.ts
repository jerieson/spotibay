import { socket } from '@/lib/socket';
import { createTimeSync } from '@/lib/time-sync';

/** The app-wide estimate of the server clock; started while a room page is connected. */
export const timeSync = createTimeSync(socket);
