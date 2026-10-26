import { ArrowDown, Send, X } from 'lucide-react';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import type { ChatMedia, Member } from '@spotibay/shared';
import { ChatMessageRow, quoteText, type UserMessage } from '@/components/room/chat-message';
import { GifPicker } from '@/components/room/gif-picker';
import { UserAvatar } from '@/components/user-avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useSite } from '@/hooks/use-site';
import { activeMentionIds, findMentionQuery, insertMention } from '@/lib/mentions';
import { socket } from '@/lib/socket';
import { cn } from '@/lib/utils';
import { useRoomStore } from '@/stores/room';

const NEAR_BOTTOM_PX = 48;
const MAX_SUGGESTIONS = 6;
const HIGHLIGHT_MS = 1500;

export function ChatPanel() {
  const messages = useRoomStore((s) => s.chat);
  const members = useRoomStore((s) => s.members);
  const selfId = useRoomStore((s) => s.you?.userId);
  const gifsEnabled = useSite().data?.gifs ?? false;
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const stickRef = useRef(true);
  const [unread, setUnread] = useState(0);
  const [draft, setDraft] = useState('');
  /** People picked from the mention list: id -> name. */
  const [picked, setPicked] = useState<ReadonlyMap<string, string>>(new Map());
  const [replyTo, setReplyTo] = useState<UserMessage | null>(null);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const seenRef = useRef(messages.length);

  const suggestions = mention
    ? members
        .filter(
          (m) =>
            m.userId !== selfId &&
            m.displayName.toLowerCase().startsWith(mention.query.toLowerCase()),
        )
        .slice(0, MAX_SUGGESTIONS)
    : [];

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

  // A reply to a message that was just removed can't be sent.
  useEffect(() => {
    if (replyTo && !messages.some((m) => m.id === replyTo.id)) setReplyTo(null);
  }, [messages, replyTo]);

  function focusAt(caret: number) {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(caret, caret);
    });
  }

  function edit(value: string, caret: number | null) {
    setDraft(value);
    const next = caret === null ? null : findMentionQuery(value, caret);
    setMention(next);
    if (next?.query !== mention?.query) setActive(0);
  }

  function chooseMention(member: Member) {
    if (!mention) return;
    const caret = inputRef.current?.selectionStart ?? draft.length;
    const result = insertMention(draft, mention.start, caret, member.displayName);
    setDraft(result.text);
    setPicked((prev) => new Map(prev).set(member.userId, member.displayName));
    setMention(null);
    focusAt(result.caret);
  }

  /** Clicking a name in the chat adds `@name` to the end of the draft. */
  function mentionByName(name: string) {
    const member = members.find((m) => m.displayName === name && m.userId !== selfId);
    if (!member) return;
    const text = `${draft}${draft && !draft.endsWith(' ') ? ' ' : ''}@${name} `;
    setDraft(text);
    setPicked((prev) => new Map(prev).set(member.userId, name));
    focusAt(text.length);
  }

  function startReply(message: UserMessage) {
    setReplyTo(message);
    focusAt(draft.length);
  }

  function jumpTo(id: string) {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setHighlighted(id);
    setTimeout(() => setHighlighted((h) => (h === id ? null : h)), HIGHLIGHT_MS);
  }

  function send(media?: ChatMedia) {
    const body = draft.trim();
    if (!body && !media) return;
    const mentionIds = activeMentionIds(body, picked);
    socket.emit('chat:send', {
      body,
      replyToId: replyTo?.id,
      mentionIds: mentionIds.length > 0 ? mentionIds : undefined,
      media: media ? { kind: media.kind, id: media.id } : undefined,
    });
    setDraft('');
    setPicked(new Map());
    setReplyTo(null);
    setMention(null);
    scrollToBottom();
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    send();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (suggestions.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setActive((i) => (i + step + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        chooseMention(suggestions[Math.min(active, suggestions.length - 1)]!);
        return;
      }
    }
    if (e.key === 'Escape') {
      if (mention) setMention(null);
      else if (replyTo) setReplyTo(null);
    }
  }

  return (
    <div className="flex h-[min(34rem,62dvh)] flex-col gap-2 lg:h-[min(44rem,calc(100dvh-12rem))]">
      <div className="relative min-h-0 flex-1">
        <div
          ref={listRef}
          onScroll={onScroll}
          className="h-full space-y-1.5 overflow-y-auto pr-1"
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
            <ChatMessageRow
              key={m.id}
              message={m}
              selfId={selfId}
              highlighted={highlighted === m.id}
              onReply={startReply}
              onMention={mentionByName}
              onJump={jumpTo}
            />
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
      {replyTo && (
        <div className="flex items-center gap-2 rounded-lg border-l-2 border-volt bg-muted/60 py-1 pr-1 pl-2 text-xs">
          <p className="min-w-0 flex-1 truncate text-muted-foreground">
            Replying to{' '}
            <span className="font-semibold text-foreground">{replyTo.author.displayName}</span>
            {': '}
            {quoteText({
              excerpt: replyTo.body,
              media: replyTo.media?.kind ?? null,
            })}
          </p>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label="Cancel reply"
            onClick={() => setReplyTo(null)}
          >
            <X />
          </Button>
        </div>
      )}
      <form onSubmit={submit} className="relative flex gap-1.5">
        {suggestions.length > 0 && (
          <ul
            id="mention-list"
            role="listbox"
            aria-label="Mention someone"
            className="absolute right-0 bottom-full left-0 z-20 mb-1 overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
          >
            {suggestions.map((m, i) => (
              <li
                key={m.userId}
                id={`mention-${m.userId}`}
                role="option"
                aria-selected={i === active}
                // Keep focus in the input while picking.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => chooseMention(m)}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm',
                  i === active && 'bg-accent text-accent-foreground',
                )}
              >
                <UserAvatar avatar={m.avatar} name={m.displayName} className="size-6" />
                <span className="truncate">{m.displayName}</span>
              </li>
            ))}
          </ul>
        )}
        <Input
          ref={inputRef}
          value={draft}
          onChange={(e) => edit(e.target.value, e.target.selectionStart)}
          onKeyDown={onKeyDown}
          onSelect={(e) => {
            const el = e.currentTarget;
            setMention(findMentionQuery(el.value, el.selectionStart ?? el.value.length));
          }}
          onBlur={() => setMention(null)}
          placeholder={replyTo ? 'Write a reply' : 'Send a message, @ to mention'}
          aria-label="Message"
          autoComplete="off"
          role="combobox"
          aria-expanded={suggestions.length > 0}
          aria-controls="mention-list"
          aria-activedescendant={
            suggestions[active] ? `mention-${suggestions[active].userId}` : undefined
          }
        />
        {gifsEnabled && <GifPicker onPick={(media) => send(media)} />}
        <Button type="submit" size="icon" aria-label="Send" disabled={draft.trim() === ''}>
          <Send />
        </Button>
      </form>
    </div>
  );
}
