import { Reply, SmilePlus } from 'lucide-react';
import { useState } from 'react';
import {
  REACTION_EMOJIS,
  type ChatMedia,
  type ChatMessage,
  type ChatReply,
  type MessageReaction,
  type ReactionEmoji as EmojiName,
} from '@spotibay/shared';
import { EmojiButton, ReactionEmoji } from '@/components/reaction-emoji';
import { UserAvatar } from '@/components/user-avatar';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { splitMentions } from '@/lib/mentions';
import { socket } from '@/lib/socket';
import { cn } from '@/lib/utils';
import { useRoomStore } from '@/stores/room';

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const formatTime = (iso: string) => timeFormat.format(new Date(iso));

export type UserMessage = Extract<ChatMessage, { kind: 'user' }>;

const mediaLabel = (kind: ChatMedia['kind']) => (kind === 'gif' ? 'GIF' : 'Sticker');

/** What a reply shows of a message: its text, or what kind of media it was. */
export function quoteText(reply: Pick<ChatReply, 'excerpt' | 'media'>): string {
  return reply.excerpt || (reply.media ? mediaLabel(reply.media) : '');
}

export function ChatMessageRow({
  message,
  selfId,
  highlighted,
  onReply,
  onMention,
  onJump,
}: {
  message: ChatMessage;
  selfId: string | undefined;
  highlighted: boolean;
  onReply: (message: UserMessage) => void;
  onMention: (name: string) => void;
  onJump: (id: string) => void;
}) {
  if (message.kind === 'system') {
    return <p className="px-1 text-center text-sm text-muted-foreground">{message.body}</p>;
  }
  const { author } = message;
  const own = author.userId === selfId;
  const mentionsMe = !own && message.mentions.some((m) => m.userId === selfId);
  return (
    <div
      id={`msg-${message.id}`}
      className={cn(
        'group relative flex gap-2 rounded-lg px-1 py-0.5 transition-colors duration-700',
        mentionsMe && 'bg-volt/10 ring-1 ring-volt/30',
        highlighted && 'bg-accent',
      )}
    >
      <UserAvatar avatar={author.avatar} name={author.displayName} className="mt-0.5 size-7" />
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-2 pr-16 text-sm text-muted-foreground">
          <button
            type="button"
            onClick={() => onMention(author.displayName)}
            className={cn(
              'truncate font-semibold hover:underline',
              own ? 'text-volt-text' : 'text-foreground',
            )}
            title={own ? author.displayName : `Mention ${author.displayName}`}
            disabled={own}
          >
            {author.displayName}
          </button>
          <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
        </p>
        {message.replyTo && <ReplyQuote reply={message.replyTo} onJump={onJump} />}
        {message.body && (
          <p className="break-words text-sm whitespace-pre-wrap">
            {splitMentions(message.body, message.mentions).map((segment, i) =>
              segment.type === 'mention' ? (
                <span
                  key={i}
                  className={cn(
                    'rounded px-0.5 font-semibold text-volt-text',
                    segment.userId === selfId && 'bg-volt/20',
                  )}
                >
                  {segment.text}
                </span>
              ) : (
                <span key={i}>{segment.text}</span>
              ),
            )}
          </p>
        )}
        {message.media && <Media media={message.media} />}
        {message.reactions.length > 0 && (
          <ReactionChips messageId={message.id} reactions={message.reactions} selfId={selfId} />
        )}
      </div>
      <div className="absolute top-0 right-0 flex opacity-0 group-hover:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100 [@media(hover:none)]:opacity-60">
        <ReactPicker messageId={message.id} />
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={`Reply to ${author.displayName}`}
          onClick={() => onReply(message)}
        >
          <Reply />
        </Button>
      </div>
    </div>
  );
}

const reactTo = (messageId: string, emoji: EmojiName) =>
  socket.emit('chat:reactMessage', { messageId, emoji });

function ReactPicker({ messageId }: { messageId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="size-7" aria-label="Add reaction">
          <SmilePlus />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        collisionPadding={16}
        className="flex w-auto gap-0.5 rounded-full p-1"
      >
        {REACTION_EMOJIS.map((emoji) => (
          <EmojiButton
            key={emoji}
            emoji={emoji}
            className="size-8"
            onClick={() => {
              reactTo(messageId, emoji);
              setOpen(false);
            }}
          />
        ))}
      </PopoverContent>
    </Popover>
  );
}

function ReactionChips({
  messageId,
  reactions,
  selfId,
}: {
  messageId: string;
  reactions: MessageReaction[];
  selfId: string | undefined;
}) {
  const members = useRoomStore((s) => s.members);
  const nameOf = (id: string) =>
    id === selfId ? 'You' : (members.find((m) => m.userId === id)?.displayName ?? 'Someone');
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {reactions.map(({ emoji, userIds }) => {
        const mine = selfId !== undefined && userIds.includes(selfId);
        return (
          <button
            key={emoji}
            type="button"
            onClick={() => reactTo(messageId, emoji)}
            title={userIds.map(nameOf).join(', ')}
            aria-label={`${emoji} ${userIds.length}${mine ? ', including you' : ''}`}
            aria-pressed={mine}
            className={cn(
              'flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs tabular-nums transition-colors hover:bg-muted',
              mine && 'border-volt/60 bg-volt/15 font-semibold',
            )}
          >
            <ReactionEmoji emoji={emoji} className="size-4" />
            {userIds.length}
          </button>
        );
      })}
    </div>
  );
}

function ReplyQuote({ reply, onJump }: { reply: ChatReply; onJump: (id: string) => void }) {
  if (reply.deleted) {
    return (
      <p className="my-0.5 border-l-2 border-muted-foreground/30 pl-2 text-xs text-muted-foreground italic">
        Message removed
      </p>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onJump(reply.id)}
      className="my-0.5 block w-full min-w-0 border-l-2 border-volt pl-2 text-left text-xs text-muted-foreground hover:text-foreground"
    >
      <span className="font-semibold">{reply.authorName}</span>{' '}
      <span className="line-clamp-2 break-words">{quoteText(reply)}</span>
    </button>
  );
}

function Media({ media }: { media: ChatMedia }) {
  return (
    <img
      src={media.url}
      alt={media.title || mediaLabel(media.kind)}
      title={media.title || undefined}
      width={media.width}
      height={media.height}
      loading="lazy"
      className={cn(
        'mt-1 h-auto w-auto max-w-full',
        media.kind === 'gif' ? 'max-h-48 rounded-lg bg-muted' : 'max-h-32',
      )}
    />
  );
}
