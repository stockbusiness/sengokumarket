import { describe, expect, it } from 'vitest';
import { escapeHtml } from './htmlRenderer';

describe('escapeHtml', () => {
  it('&, <, >, ", \'をエスケープする', () => {
    expect(escapeHtml(`<script>alert("x" & 'y')</script>`)).toBe('&lt;script&gt;alert(&quot;x&quot; &amp; &#39;y&#39;)&lt;/script&gt;');
  });

  it('特殊文字を含まない文字列はそのまま返す', () => {
    expect(escapeHtml('テスト太郎')).toBe('テスト太郎');
  });
});
