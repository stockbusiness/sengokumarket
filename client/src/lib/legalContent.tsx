import { Fragment, type ReactNode } from 'react';

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
