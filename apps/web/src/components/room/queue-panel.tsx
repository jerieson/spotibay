import { Shuffle, Users } from 'lucide-react';
import type { QueueMode } from '@spotibay/shared';
import { HistoryList } from '@/components/room/history-list';
import { QueueList } from '@/components/room/queue-list';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { socket } from '@/lib/socket';
import { useRoomStore } from '@/stores/room';

const modeLabels: Record<QueueMode, { name: string; hint: string }> = {
  fifo: { name: 'Votes', hint: 'Highest score first, then first come first served' },
  fair: { name: 'Fair', hint: 'Everyone takes turns, votes are just for show' },
};

export function QueuePanel({ code }: { code: string }) {
  const mode = useRoomStore((s) => s.room?.queueMode ?? 'fifo');
  const isHost = useRoomStore((s) => s.you?.role === 'host');
  const count = useRoomStore((s) => s.queue.length);
  const other: QueueMode = mode === 'fifo' ? 'fair' : 'fifo';

  return (
    <Tabs defaultValue="queue">
      <TabsList>
        <TabsTrigger value="queue">Up next{count > 0 && ` (${count})`}</TabsTrigger>
        <TabsTrigger value="history">History</TabsTrigger>
      </TabsList>
      <TabsContent value="queue" className="space-y-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {mode === 'fair' ? <Users className="size-3.5" /> : <Shuffle className="size-3.5" />}
          <span title={modeLabels[mode].hint}>Order: {modeLabels[mode].name}</span>
          {isHost && (
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto h-6 px-2 text-xs"
              title={modeLabels[other].hint}
              onClick={() => socket.emit('room:update', { queueMode: other })}
            >
              Switch to {modeLabels[other].name.toLowerCase()}
            </Button>
          )}
        </div>
        <QueueList />
      </TabsContent>
      <TabsContent value="history">
        <HistoryList code={code} />
      </TabsContent>
    </Tabs>
  );
}
