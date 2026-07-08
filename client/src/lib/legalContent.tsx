import { Fragment, type ReactNode } from 'react';

// 仕様書外の拡張: 特定商取引法ページは項目が固定されているため、管理画面では
// 自由記述ではなく項目ごとの入力フォームで編集できるようにする。
// 保存時はこの並び・ラベルのkey|value行としてbodyへシリアライズし、
// 表示側(renderLegalBody)の記法とはそのまま互換性を保つ。
export const TOKUSHOHO_FIELDS = [
  { key: 'sellerName', label: '販売事業者名' },
  { key: 'operationManager', label: '運営統括責任者' },
  { key: 'address', label: '所在地' },
  { key: 'phone', label: '電話番号' },
  { key: 'email', label: 'メールアドレス' },
  { key: 'price', label: '販売価格' },
  { key: 'additionalFees', label: '商品代金以外の必要料金' },
  { key: 'paymentMethods', label: 'お支払い方法' },
  { key: 'paymentTiming', label: 'お支払い時期' },
  { key: 'deliveryTiming', label: '商品の引渡し時期' },
  { key: 'returnsPolicy', label: '返品・キャンセルについて' },
] as const;

export type TokushohoFieldKey = (typeof TOKUSHOHO_FIELDS)[number]['key'];
export type TokushohoFields = Record<TokushohoFieldKey, string> & { extraNotes: string };

export function parseTokushohoBody(body: string): TokushohoFields {
  const fields = Object.fromEntries(TOKUSHOHO_FIELDS.map((f) => [f.key, ''])) as TokushohoFields;
  fields.extraNotes = '';

  const labelToKey = new Map<string, TokushohoFieldKey>(TOKUSHOHO_FIELDS.map((f) => [f.label, f.key]));
  const extraLines: string[] = [];

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('!') || line.startsWith('## ')) continue;

    const separatorIndex = line.indexOf('|');
    if (separatorIndex > 0) {
      const label = line.slice(0, separatorIndex);
      const value = line.slice(separatorIndex + 1);
      const key = labelToKey.get(label);
      if (key) {
        fields[key] = value;
        continue;
      }
    }
    extraLines.push(line);
  }

  fields.extraNotes = extraLines.join('\n');
  return fields;
}

export function serializeTokushohoFields(fields: TokushohoFields): string {
  const lines = TOKUSHOHO_FIELDS.map((f) => `${f.label}|${fields[f.key]}`);
  if (fields.extraNotes.trim()) lines.push(fields.extraNotes.trim());
  return lines.join('\n');
}

// 法務ページ本文の簡易記法:
//   "## 見出し"   -> h2
//   "!注意書き"   -> 警告ボックス(仮文言の告知等)
//   "key|value"   -> 連続する行をテーブルとしてまとめる
//   それ以外       -> 段落
export function renderLegalBody(body: string): ReactNode {
  const lines = body.split('\n');
  const blocks: ReactNode[] = [];
  let tableRows: [string, string][] = [];

  const flushTable = () => {
    if (tableRows.length === 0) return;
    blocks.push(
      <table className="legal-table" key={`table-${blocks.length}`}>
        <tbody>
          {tableRows.map(([key, value], i) => (
            <tr key={i}>
              <th>{key}</th>
              <td>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>,
    );
    tableRows = [];
  };

  lines.forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (!line) return;

    if (line.startsWith('## ')) {
      flushTable();
      blocks.push(<h2 key={i}>{line.slice(3)}</h2>);
      return;
    }

    if (line.startsWith('!')) {
      flushTable();
      blocks.push(
        <p className="legal-placeholder-notice" key={i}>
          {line.slice(1)}
        </p>,
      );
      return;
    }

    const separatorIndex = line.indexOf('|');
    if (separatorIndex > 0) {
      tableRows.push([line.slice(0, separatorIndex), line.slice(separatorIndex + 1)]);
      return;
    }

    flushTable();
    blocks.push(<p key={i}>{line}</p>);
  });

  flushTable();
  return <Fragment>{blocks}</Fragment>;
}
