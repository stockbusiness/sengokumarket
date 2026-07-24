import { statusVariant } from '../lib/statusStyle';

// 残課題指示書Stage8: サーバーの状態遷移Policy(@sengoku/contracts)と同じ表を使い、
// 現在の状態から遷移できる選択肢だけを表示する(不正遷移をUI上で選べないようにする)。
// 許可遷移が無い(終端状態)の場合はselect自体を無効化する。
export default function StatusSelect<T extends string>({
  value,
  transitions,
  onChange,
  disabled,
}: {
  value: T;
  transitions: Record<T, readonly T[]>;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const allowed = transitions[value] ?? [];
  const options = [value, ...allowed];
  const isTerminal = allowed.length === 0;

  return (
    <select
      className={`status-select status-select--${statusVariant(value)}`}
      value={value}
      disabled={disabled || isTerminal}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  );
}
