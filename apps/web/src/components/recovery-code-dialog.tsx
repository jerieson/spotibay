import { TriangleAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import { CopyButton } from '@/components/copy-button';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useRecoveryStore } from '@/stores/recovery';

/** Shown once when an account is created or its recovery code is regenerated. */
export function RecoveryCodeDialog() {
  const { code, unacknowledged, acknowledge } = useRecoveryStore();

  return (
    <Dialog open={unacknowledged && code !== null} onOpenChange={(open) => !open && acknowledge()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save your recovery code</DialogTitle>
          <DialogDescription>
            This code is the only way to get this account back on another device or after clearing
            your browser. We can&apos;t show it again.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 rounded-xl border bg-muted p-3">
          <code
            className="flex-1 text-center font-mono text-lg tracking-widest"
            data-testid="recovery-code"
          >
            {code}
          </code>
          <CopyButton text={code ?? ''} label="Copy recovery code" />
        </div>
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          Anyone with this code can take over your account. Keep it somewhere private.
        </p>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" asChild onClick={acknowledge}>
            <Link to="/profile">Open profile</Link>
          </Button>
          <Button onClick={acknowledge}>I&apos;ve saved it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
