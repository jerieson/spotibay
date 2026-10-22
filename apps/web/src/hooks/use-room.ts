import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import type { ServerToClientEvents } from '@spotibay/shared';
import { diffMembers } from '@/lib/members';
import { socket } from '@/lib/socket';
import { useRoomStore } from '@/stores/room';

/** Connects the socket and keeps the room store in sync while the room page is mounted. */
export function useRoomConnection(code: string) {
  const passwordRef = useRef<string | undefined>(undefined);

  const join = useCallback(() => {
    const store = useRoomStore.getState();
    store.setStatus('connecting');
    socket.emit('room:join', { code, password: passwordRef.current }, (res) => {
      if (res.ok) return; // the snapshot arrives as `room:state`
      const { code: errorCode } = res.error;
      const store = useRoomStore.getState();
      if (errorCode === 'wrong_password') {
        // The first prompt (no password sent yet) is not an error; a rejected attempt is.
        store.setStatus('needs-password', passwordRef.current === undefined ? null : res.error);
      } else {
        store.setStatus(errorCode === 'room_closed' ? 'closed' : 'failed', res.error);
      }
    });
  }, [code]);

  useEffect(() => {
    const store = useRoomStore.getState();
    store.reset();
    passwordRef.current = undefined;

    const onConnect = () => join();
    const onConnectError = (err: Error) => {
      useRoomStore.getState().setStatus('failed', {
        code: err.message === 'banned' ? 'banned' : 'unauthenticated',
        message: err.message === 'banned' ? 'You are banned from Spotibay.' : 'Could not connect.',
      });
    };
    const onState: ServerToClientEvents['room:state'] = (state) =>
      useRoomStore.getState().setState(state);
    const onMembers: ServerToClientEvents['room:members'] = ({ members }) => {
      const { members: prev, you, status } = useRoomStore.getState();
      if (status === 'joined' && you) {
        const { joined, left } = diffMembers(prev, members, you.userId);
        for (const m of joined) toast(`${m.displayName} joined`);
        for (const m of left) toast(`${m.displayName} left`);
      }
      useRoomStore.getState().setMembers(members);
    };
    const onUpdated: ServerToClientEvents['room:updated'] = ({ room }) =>
      useRoomStore.getState().setRoom(room);
    const onClosed = () => useRoomStore.getState().setStatus('closed');
    const onError: ServerToClientEvents['error'] = (err) => toast.error(err.message);

    socket.on('connect', onConnect);
    socket.on('connect_error', onConnectError);
    socket.on('room:state', onState);
    socket.on('room:members', onMembers);
    socket.on('room:updated', onUpdated);
    socket.on('room:closed', onClosed);
    socket.on('error', onError);
    socket.connect();

    return () => {
      socket.off('connect', onConnect);
      socket.off('connect_error', onConnectError);
      socket.off('room:state', onState);
      socket.off('room:members', onMembers);
      socket.off('room:updated', onUpdated);
      socket.off('room:closed', onClosed);
      socket.off('error', onError);
      socket.disconnect();
      useRoomStore.getState().reset();
    };
  }, [join]);

  const submitPassword = useCallback(
    (password: string) => {
      passwordRef.current = password;
      join();
    },
    [join],
  );

  return { submitPassword };
}
