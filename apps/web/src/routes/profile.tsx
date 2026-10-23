import { Dices, KeyRound, TriangleAlert } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import {
  avatarBackgrounds,
  avatarStyles,
  displayNameSchema,
  type Avatar,
  type User,
} from '@spotibay/shared';
import { CopyButton } from '@/components/copy-button';
import { UserAvatar } from '@/components/user-avatar';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  useRecoverAccount,
  useRegenerateRecoveryCode,
  useSession,
  useUpdateProfile,
} from '@/hooks/use-session';
import { avatarStyleLabels, randomSeed } from '@/lib/avatar';
import { cn } from '@/lib/utils';
import { useRecoveryStore } from '@/stores/recovery';

export function ProfilePage() {
  const session = useSession();

  if (session.isPending) return <p className="text-muted-foreground">Loading…</p>;
  if (session.isError) return <p className="text-destructive">Couldn&apos;t load your profile.</p>;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="font-display text-3xl font-extrabold tracking-tight">Your profile</h1>
      <ProfileForm key={session.data.id} user={session.data} />
      <RecoverySection />
      <RestoreSection />
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4 rounded-2xl border bg-card p-4 text-card-foreground sm:p-6">
      <div>
        <h2 className="font-semibold">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function ProfileForm({ user }: { user: User }) {
  const update = useUpdateProfile();
  const [name, setName] = useState(user.displayName);
  const [avatar, setAvatar] = useState<Avatar>(user.avatar);

  const nameCheck = displayNameSchema.safeParse(name);
  const dirty =
    name.trim() !== user.displayName || JSON.stringify(avatar) !== JSON.stringify(user.avatar);
  const serverError = update.error?.message;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!nameCheck.success) return;
    update.mutate({ displayName: nameCheck.data, avatar });
  }

  return (
    <form onSubmit={submit}>
      <Section title="Name and avatar" description="This is how others see you in rooms.">
        <div className="flex items-center gap-4">
          <UserAvatar avatar={avatar} name={name} className="size-24" />
          <div className="flex-1 space-y-2">
            <Label htmlFor="display-name">Display name</Label>
            <Input
              id="display-name"
              value={name}
              maxLength={24}
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
              aria-invalid={!nameCheck.success}
            />
            {!nameCheck.success && <p className="text-sm text-destructive">Use 2–24 characters.</p>}
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Style</Label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setAvatar({ ...avatar, seed: randomSeed() })}
            >
              <Dices className="size-4" /> Re-roll
            </Button>
          </div>
          <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label="Avatar style">
            {avatarStyles.map((style) => (
              <button
                key={style}
                type="button"
                role="radio"
                aria-checked={avatar.style === style}
                onClick={() => setAvatar({ ...avatar, style })}
                className={cn(
                  'flex flex-col items-center gap-1 rounded-xl border p-2 text-sm transition-colors hover:border-ring/60',
                  avatar.style === style && 'border-volt ring-2 ring-volt/60',
                )}
              >
                <UserAvatar avatar={{ ...avatar, style }} name="" className="size-12" />
                {avatarStyleLabels[style]}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <Label>Background</Label>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Avatar background">
            {avatarBackgrounds.map((hex) => (
              <button
                key={hex}
                type="button"
                role="radio"
                aria-checked={avatar.options.backgroundColor === hex}
                aria-label={`Background #${hex}`}
                onClick={() => setAvatar({ ...avatar, options: { backgroundColor: hex } })}
                style={{ backgroundColor: `#${hex}` }}
                className={cn(
                  'size-8 rounded-full border',
                  avatar.options.backgroundColor === hex &&
                    'ring-2 ring-volt ring-offset-2 ring-offset-card',
                )}
              />
            ))}
          </div>
        </div>

        {serverError && <p className="text-sm text-destructive">{serverError}</p>}
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={!dirty || !nameCheck.success || update.isPending}>
            {update.isPending ? 'Saving…' : 'Save changes'}
          </Button>
          {update.isSuccess && !dirty && (
            <span className="text-sm text-muted-foreground">Saved</span>
          )}
        </div>
      </Section>
    </form>
  );
}

function RecoverySection() {
  const code = useRecoveryStore((s) => s.code);
  const regenerate = useRegenerateRecoveryCode();

  return (
    <Section
      title="Recovery code"
      description="Use it to sign back in to this account from another browser or device."
    >
      <Alert>
        <TriangleAlert className="size-4" />
        <AlertTitle>Lose it and you lose the account</AlertTitle>
        <AlertDescription>
          Without your recovery code, this account can&apos;t be restored on other devices or after
          clearing your browser data.
        </AlertDescription>
      </Alert>
      {code ? (
        <div className="flex items-center gap-2 rounded-xl border bg-muted p-3">
          <code className="flex-1 text-center font-mono text-lg tracking-widest">{code}</code>
          <CopyButton text={code} label="Copy recovery code" />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          For security the code is only shown once. If you didn&apos;t save it, generate a new one —
          the old code stops working.
        </p>
      )}
      {regenerate.isError && <p className="text-sm text-destructive">{regenerate.error.message}</p>}
      <Button
        type="button"
        variant="outline"
        disabled={regenerate.isPending}
        onClick={() => {
          if (
            !code ||
            window.confirm('Generate a new code? Your current code will stop working.')
          ) {
            regenerate.mutate();
          }
        }}
      >
        <KeyRound className="size-4" /> Generate new code
      </Button>
    </Section>
  );
}

function RestoreSection() {
  const recover = useRecoverAccount();
  const [code, setCode] = useState('');

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    if (
      !window.confirm(
        'Switch to the restored account? This browser will stop using the current guest.',
      )
    )
      return;
    recover.mutate(code, { onSuccess: () => setCode('') });
  }

  return (
    <form onSubmit={submit}>
      <Section
        title="Restore an account"
        description="Already have a recovery code? Enter it to switch to that account on this device."
      >
        <div className="space-y-2">
          <Label htmlFor="restore-code">Recovery code</Label>
          <Input
            id="restore-code"
            value={code}
            placeholder="XXXX-XXXX-XXXX-XXXX"
            autoComplete="off"
            spellCheck={false}
            className="font-mono uppercase"
            onChange={(e) => setCode(e.target.value)}
          />
        </div>
        {recover.isError && (
          <p className="text-sm text-destructive">
            {recover.error.message === 'invalid_recovery_code' ||
            recover.error.message.includes('404')
              ? "That code didn't match an account."
              : recover.error.message}
          </p>
        )}
        {recover.isSuccess && <p className="text-sm text-muted-foreground">Account restored.</p>}
        <Button type="submit" variant="outline" disabled={!code.trim() || recover.isPending}>
          {recover.isPending ? 'Restoring…' : 'Restore account'}
        </Button>
      </Section>
    </form>
  );
}
