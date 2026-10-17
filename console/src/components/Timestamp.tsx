import { formatUtc } from "../lib/format";

export function Timestamp({ value }: { value: string | null | undefined }) {
  if (!value) return <span>—</span>;
  return <time dateTime={value}>{formatUtc(value)}</time>;
}
