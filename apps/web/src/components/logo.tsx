export function Logo() {
  return (
    <span className="flex items-center gap-2 font-display text-lg font-extrabold tracking-tight">
      <span className="relative grid size-7 place-items-center rounded-lg bg-volt">
        <span className="flex h-3.5 items-end gap-[2px]">
          <i className="block h-2 w-[3px] rounded-full bg-ink" />
          <i className="block h-3.5 w-[3px] rounded-full bg-ink" />
          <i className="block h-2.5 w-[3px] rounded-full bg-ink" />
        </span>
      </span>
      <span className="hidden sm:inline">
        Spoti<span className="text-volt">bay</span>
      </span>
    </span>
  );
}
