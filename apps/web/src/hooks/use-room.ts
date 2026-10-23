import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import type { ServerToClientEvents, SiteResponse } from '@spotibay/shared';
import { diffMembers } from '@/lib/members';
import { timeSync } from '@/lib/clock';
import { socket } from '@/lib/socket';
import { siteKey } from '@/hooks/use-site';
import { useRoomStore } from '@/stores/room';

/** Connects the socket and keeps the room store in sync while the room page is mounted. */
export function useRoomConnection(code: string, asAdmin = false) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const passwordRef = useRef<string | undefined>(undefined);

  const join = useCallback(() => {
    const store = useRoomStore.getState();
    store.setStatus('connecting');
    socket.emit(
      'room:join',
      { code, password: passwordRef.current, asAdmin: asAdmin || undefined },
      (res) => {
        if (res.ok) return; // the snapshot arrives as `room:state`
        const { code: errorCode } = res.error;
        const store = useRoomStore.getState();
        if (errorCode === 'wrong_password') {
          // The first prompt (no password sent yet) is not an error; a rejected attempt is.
          store.setStatus('needs-password', passwordRef.current === undefined ? null : res.error);
        } else {
          store.setStatus(errorCode === 'room_closed' ? 'closed' : 'failed', res.error);
        }
      },
    );
  }, [code, asAdmin]);

  useEffect(() => {
    const store = useRoomStore.getState();
    store.reset();
    passwordRef.current = undefined;

    const onConnect = () => {
      timeSync.start();
      join();
    };
    const onConnectError = (err: Error) => {
      useRoomStore.getState().setStatus('failed', {
        code:
          err.message === 'banned' || err.message === 'maintenance'
            ? err.message
            : 'unauthenticated',
        message:
          err.message === 'banned'
            ? 'You are banned from Spotibay.'
            : err.message === 'maintenance'
              ? 'Spotibay is down for maintenance.'
              : 'Could not connect.',
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
    const onPlayback: ServerToClientEvents['playback:state'] = (state) =>
      useRoomStore.getState().setPlayback(state);
    const onQueue: ServerToClientEvents['queue:updated'] = ({ queue }) =>
      useRoomStore.getState().setQueue(queue);
    const onSkipVotes: ServerToClientEvents['playback:skipVotes'] = (votes) =>
      useRoomStore.getState().setSkipVotes(votes);
    const onAddMany: ServerToClientEvents['queue:addManyResult'] = (r) => {
      const left = [
        r.duplicates > 0 && `${r.duplicates} already queued`,
        r.unplayable > 0 && `${r.unplayable} can't be played`,
        r.overLimit > 0 && `${r.overLimit} over the queue limit`,
      ].filter(Boolean);
      const base = `Queued ${r.added} ${r.added === 1 ? 'track' : 'tracks'}`;
      if (left.length === 0) toast(base);
      else if (r.added === 0) toast.error(`Nothing queued: ${left.join(', ')}`);
      else toast(`${base} (${left.join(', ')})`);
    };
    const onChat: ServerToClientEvents['chat:message'] = (message) =>
      useRoomStore.getState().addChat(message);
    const onClosed = () => useRoomStore.getState().setStatus('closed');
    const onChatDeleted: ServerToClientEvents['chat:deleted'] = ({ id }) =>
      useRoomStore.getState().removeChat(id);
    const onKicked: ServerToClientEvents['user:kicked'] = ({ reason }) => {
      toast.error(
        reason === 'banned' ? 'You have been banned.' : 'You were removed from the room.',
      );
      void navigate('/');
    };
    const onSettings: ServerToClientEvents['settings:updated'] = ({ key }) => {
      if (key === 'site.maintenanceMode') void queryClient.invalidateQueries({ queryKey: siteKey });
    };
    const onAnnouncement: ServerToClientEvents['site:announcement'] = ({ announcement }) =>
      queryClient.setQueryData<SiteResponse>(siteKey, (site) => ({
        maintenance: site?.maintenance ?? false,
        announcement,
      }));
    const onError: ServerToClientEvents['error'] = (err) => toast.error(err.message);

    socket.on('connect', onConnect);
    socket.on('connect_error', onConnectError);
    socket.on('room:state', onState);
    socket.on('room:members', onMembers);
    socket.on('room:updated', onUpdated);
    socket.on('playback:state', onPlayback);
    socket.on('queue:updated', onQueue);
    socket.on('playback:skipVotes', onSkipVotes);
    socket.on('queue:addManyResult', onAddMany);
    socket.on('chat:message', onChat);
    socket.on('room:closed', onClosed);
    socket.on('chat:deleted', onChatDeleted);
    socket.on('user:kicked', onKicked);
    socket.on('settings:updated', onSettings);
    socket.on('site:announcement', onAnnouncement);
    socket.on('error', onError);
    socket.connect();

    return () => {
      socket.off('connect', onConnect);
      socket.off('connect_error', onConnectError);
      socket.off('room:state', onState);
      socket.off('room:members', onMembers);
      socket.off('room:updated', onUpdated);
      socket.off('playback:state', onPlayback);
      socket.off('queue:updated', onQueue);
      socket.off('playback:skipVotes', onSkipVotes);
      socket.off('queue:addManyResult', onAddMany);
      socket.off('chat:message', onChat);
      socket.off('room:closed', onClosed);
      socket.off('chat:deleted', onChatDeleted);
      socket.off('user:kicked', onKicked);
      socket.off('settings:updated', onSettings);
      socket.off('site:announcement', onAnnouncement);
      socket.off('error', onError);
      timeSync.stop();
      socket.disconnect();
      useRoomStore.getState().reset();
    };
  }, [join, navigate, queryClient]);

  const submitPassword = useCallback(
    (password: string) => {
      passwordRef.current = password;
      join();
    },
    [join],
  );

  return { submitPassword };
}
