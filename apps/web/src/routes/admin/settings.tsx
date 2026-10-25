import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import {
  settingDescriptions,
  settingGroup,
  settingKeys,
  settingsSchemas,
  type SettingKey,
} from '@spotibay/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { adminApi } from './admin-api';
import { Card, PageHeader, QueryState, Select, Textarea } from './ui';

type JsonSchema = {
  type?: string;
  enum?: unknown[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  anyOf?: JsonSchema[];
  minimum?: number;
  exclusiveMinimum?: number;
  maximum?: number;
  maxLength?: number;
};

/** The form is derived from the Zod schemas, so a new setting shows up without touching this file. */
const jsonSchemas = Object.fromEntries(
  settingKeys.map((key) => [key, z.toJSONSchema(settingsSchemas[key]) as JsonSchema]),
) as Record<SettingKey, JsonSchema>;

const groupTitles: Record<string, string> = {
  features: 'Features',
  limits: 'Limits',
  queue: 'Queue',
  sync: 'Sync',
  search: 'Search',
  moderation: 'Moderation',
  site: 'Site',
};

export function SettingsPage() {
  const settings = useQuery({ queryKey: ['admin', 'settings'], queryFn: adminApi.settings });
  const groups = useMemo(() => {
    const map = new Map<string, SettingKey[]>();
    for (const key of settingKeys) {
      const group = settingGroup(key);
      map.set(group, [...(map.get(group) ?? []), key]);
    }
    return [...map];
  }, []);

  return (
    <>
      <PageHeader title="Settings" />
      <QueryState isPending={settings.isPending} error={settings.error} />
      {settings.data && (
        <div className="space-y-6">
          {groups.map(([group, keys]) => (
            <section key={group} className="space-y-2">
              <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
                {groupTitles[group] ?? group}
              </h2>
              <Card className="divide-y p-0">
                {keys.map((key) => (
                  <SettingRow key={key} settingKey={key} current={settings.data.settings[key]} />
                ))}
              </Card>
            </section>
          ))}
        </div>
      )}
    </>
  );
}

function SettingRow({ settingKey, current }: { settingKey: SettingKey; current: unknown }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<unknown>(current);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(current);
  const save = useMutation({
    mutationFn: () => adminApi.updateSetting(settingKey, draft),
    onSuccess: async () => {
      setError(null);
      await qc.invalidateQueries({ queryKey: ['admin', 'settings'] });
      toast.success(`Saved ${settingKey}`);
    },
    onError: (err) => setError(err.message),
  });
  const id = `setting-${settingKey}`;

  return (
    <div className="grid grid-cols-1 gap-3 p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] md:items-start">
      <div>
        <Label htmlFor={id} className="font-mono text-sm">
          {settingKey}
        </Label>
        <p className="mt-1 text-sm text-muted-foreground">{settingDescriptions[settingKey]}</p>
      </div>
      <div className="space-y-2">
        <Field id={id} schema={jsonSchemas[settingKey]} value={draft} onChange={setDraft} />
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {dirty && (
          <div className="flex gap-2">
            <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(current);
                setError(null);
              }}
            >
              Reset
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

interface FieldProps {
  id: string;
  schema: JsonSchema;
  value: unknown;
  onChange: (value: unknown) => void;
}

function Field({ id, schema, value, onChange }: FieldProps) {
  const nonNull = schema.anyOf?.filter((s) => s.type !== 'null');
  if (nonNull?.length === 1 && schema.anyOf!.length === 2) {
    return <OptionalField {...{ id, value, onChange }} schema={nonNull[0]!} />;
  }
  if (schema.type === 'boolean') {
    return (
      <label className="flex items-center gap-2 text-sm">
        <input
          id={id}
          type="checkbox"
          className="size-4 accent-[var(--primary)]"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
        {value === true ? 'On' : 'Off'}
      </label>
    );
  }
  if (schema.type === 'integer' || schema.type === 'number') {
    const min = schema.minimum ?? schema.exclusiveMinimum;
    return (
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min={min}
        max={schema.maximum}
        step={schema.type === 'integer' ? 1 : 0.05}
        value={typeof value === 'number' ? value : ''}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      />
    );
  }
  if (schema.type === 'string' && schema.enum) {
    return (
      <Select id={id} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
        {schema.enum.map((option) => (
          <option key={String(option)} value={String(option)}>
            {String(option)}
          </option>
        ))}
      </Select>
    );
  }
  if (schema.type === 'string') {
    return (
      <Input
        id={id}
        maxLength={schema.maxLength}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  if (schema.type === 'array' && schema.items?.type === 'string') {
    const lines = Array.isArray(value) ? (value as string[]) : [];
    return (
      <Textarea
        id={id}
        rows={5}
        value={lines.join('\n')}
        onChange={(e) =>
          onChange(
            e.target.value
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean),
          )
        }
      />
    );
  }
  if (schema.type === 'object' && schema.properties) {
    const obj = (value ?? {}) as Record<string, unknown>;
    return (
      <div className="space-y-2">
        {Object.entries(schema.properties).map(([name, prop]) => (
          <div key={name} className="space-y-1">
            <span className="text-sm text-muted-foreground">{name}</span>
            <Field
              id={`${id}-${name}`}
              schema={prop}
              value={obj[name]}
              onChange={(v) => onChange({ ...obj, [name]: v })}
            />
          </div>
        ))}
      </div>
    );
  }
  // Anything else still gets edited, as JSON.
  return <JsonField {...{ id, value, onChange }} />;
}

/** A setting that may be `null`: a switch plus the editor for the non-null shape. */
function OptionalField({ id, schema, value, onChange }: FieldProps) {
  const on = value !== null && value !== undefined;
  const fresh = (): unknown => {
    const props = schema.properties;
    if (!props) return '';
    return Object.fromEntries(Object.entries(props).map(([k, p]) => [k, p.enum ? p.enum[0] : '']));
  };
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4 accent-[var(--primary)]"
          checked={on}
          onChange={(e) => onChange(e.target.checked ? fresh() : null)}
          aria-label="Enabled"
        />
        {on ? 'Enabled' : 'Not set'}
      </label>
      {on && <Field {...{ id, schema, value, onChange }} />}
    </div>
  );
}

function JsonField({ id, value, onChange }: Omit<FieldProps, 'schema'>) {
  const [text, setText] = useState(JSON.stringify(value, null, 2));
  return (
    <Textarea
      id={id}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        try {
          onChange(JSON.parse(e.target.value));
        } catch {
          // keep typing; the last valid value stays in the draft
        }
      }}
    />
  );
}
