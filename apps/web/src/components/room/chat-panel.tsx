import { ArrowDown, Send } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { ChatMessage } from '@spotibay/shared';
import { UserAvatar } from '@/components/user-avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { socket } from '@/lib/socket';
import { cn } from '@/lib/utils';
import { useRoomStore } from '@/stores/room';

const NEAR_BOTTOM_PX = 48;

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const formatTime = (iso: string) => timeFormat.format(new Date(iso));

export function ChatPanel() {
  const messages = useRoomStore((s) => s.chat);
  const selfId = useRoomStore((s) => s.you?.userId);
  const listRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [unread, setUnread] = useState(0);
  const [draft, setDraft] = useState('');
  const seenRef = useRef(messages.length);

  function scrollToBottom() {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    stickRef.current = true;
    setUnread(0);
  }

  function onScroll() {
    const el = listRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    if (stickRef.current) setUnread(0);
  }

  // Follow new messages while the reader is at the bottom; otherwise count them for the pill.
  useLayoutEffect(() => {
    const added = messages.length - seenRef.current;
    seenRef.current = messages.length;
    if (stickRef.current) {
      scrollToBottom();
    } else if (added > 0) {
      setUnread((n) => n + added);
    }
  }, [messages]);

  useEffect(scrollToBottom, []);

  function submit(e: FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    socket.emit('chat:send', { body });
    setDraft('');
    scrollToBottom();
  }

  return (
    <div className="flex h-96 flex-col gap-2">
      <div className="relative min-h-0 flex-1">
        <div
          ref={listRef}
          onScroll={onScroll}
          className="h-full space-y-2 overflow-y-auto pr-1"
          role="log"
          aria-live="polite"
          aria-label="Chat"
        >
          {messages.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No messages yet. Say hi!
            </p>
          )}
          {messages.map((m) => (
            <Message key={m.id} message={m} own={m.kind === 'user' && m.author.userId === selfId} />
          ))}
        </div>
        {unread > 0 && (
          <Button
            size="sm"
            className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full shadow-lg"
            onClick={scrollToBottom}
          >
            <ArrowDown /> {unread} new {unread === 1 ? 'message' : 'messages'}
          </Button>
        )}
      </div>
      <form onSubmit={submit} className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Send a message"
          aria-label="Message"
          autoComplete="off"
        />
        <Button type="submit" size="icon" aria-label="Send" disabled={draft.trim() === ''}>
          <Send />
        </Button>
      </form>
    </div>
  );
}

function Message({ message, own }: { message: ChatMessage; own: boolean }) {
  if (message.kind === 'system') {
    return <p className="px-1 text-center text-xs text-muted-foreground">{message.body}</p>;
  }
  const { author } = message;
  return (
    <div className="flex gap-2">
      <UserAvatar avatar={author.avatar} name={author.displayName} className="mt-0.5 size-7" />
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-2 text-xs text-muted-foreground">
          <span className={cn('truncate font-semibold', own ? 'text-volt' : 'text-foreground')}>
            {author.displayName}
          </span>
          <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
        </p>
        <p className="break-words text-sm">{message.body}</p>
      </div>
    </div>
  );
}
