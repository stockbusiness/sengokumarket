import { statusVariant } from '../lib/statusStyle';

export default function StatusSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <select
      className={`status-select status-select--${statusVariant(value)}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  );
}
