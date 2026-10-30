import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { adminApi } from './admin-api';
import { Card, Empty, formatTime, PageHeader, QueryState } from './ui';
import { friendlyError } from '@/lib/errors';

export function ChatPage() {
  const qc = useQueryClient();
  const [roomCode, setRoomCode] = useState('');
  const [text, setText] = useState('');
  const [filter, setFilter] = useState({ roomCode: '', q: '' });
  const messages = useQuery({
    queryKey: ['admin', 'chat', filter],
    queryFn: () =>
      adminApi.chat({ roomCode: filter.roomCode || undefined, q: filter.q || undefined }),
  });
  const remove = useMutation({
    mutationFn: adminApi.deleteMessage,
    onSuccess: async () => {
      toast.success('Message deleted');
      await qc.invalidateQueries({ queryKey: ['admin', 'chat'] });
    },
    onError: (e) => toast.error(friendlyError(e)),
  });

  return (
    <>
      <PageHeader title="Chat" />
      <p className="mb-3 text-sm text-muted-foreground">
        Deleted messages disappear for everyone in the room. Edit the word filter under Settings →
        Moderation.
      </p>
      <form
        className="mb-4 flex flex-wrap gap-2"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setFilter({ roomCode: roomCode.trim(), q: text.trim() });
        }}
      >
        <Input
          className="w-32"
          placeholder="Room code"
          aria-label="Room code"
          maxLength={6}
          value={roomCode}
          onChange={(e) => setRoomCode(e.target.value)}
        />
        <Input
          className="min-w-40 flex-1"
          placeholder="Contains…"
          aria-label="Message contains"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Button type="submit">Filter</Button>
      </form>
      <QueryState isPending={messages.isPending} error={messages.error} />
      {messages.data?.length === 0 && <Empty>No messages.</Empty>}
      <Card className="divide-y p-0">
        {messages.data?.map((m) => (
          <div key={m.id} className="flex items-start gap-3 p-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{m.userName}</span> in {m.roomName} (
                {m.roomCode}) · {formatTime(m.createdAt)}
              </p>
              {m.body && (
                <p className={m.deleted ? 'text-muted-foreground line-through' : 'break-words'}>
                  {m.body}
                </p>
              )}
              {m.media && (
                <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
                  <img
                    src={m.media.previewUrl}
                    alt={m.media.title}
                    loading="lazy"
                    className={cn('h-16 w-auto rounded-md', m.deleted && 'opacity-40 grayscale')}
                  />
                  <span>
                    {m.media.kind === 'gif' ? 'GIF' : 'Sticker'}
                    {m.media.title && `: ${m.media.title}`}
                  </span>
                </div>
              )}
            </div>
            {!m.deleted && (
              <Button
                size="icon"
                variant="ghost"
                aria-label="Delete message"
                disabled={remove.isPending}
                onClick={() => remove.mutate(m.id)}
              >
                <Trash2 />
              </Button>
            )}
          </div>
        ))}
      </Card>
    </>
  );
}
