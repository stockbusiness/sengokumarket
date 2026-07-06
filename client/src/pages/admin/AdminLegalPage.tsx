import { useEffect, useState } from 'react';
import { fetchAdminLegalDocuments, updateAdminLegalDocument, type AdminLegalDocument } from '../../lib/adminApi';
import { renderLegalBody } from '../../lib/legalContent';

const SLUG_LABELS: Record<string, string> = {
  tokushoho: '特定商取引法に基づく表記',
  terms: '利用規約',
  refund: '返金ポリシー',
  privacy: 'プライバシーポリシー',
};

export default function AdminLegalPage() {
  const [documents, setDocuments] = useState<AdminLegalDocument[]>([]);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    fetchAdminLegalDocuments().then((d) => {
      setDocuments(d.documents);
      if (d.documents.length > 0) {
        selectDocument(d.documents[0]);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function selectDocument(doc: AdminLegalDocument) {
    setActiveSlug(doc.slug);
    setTitle(doc.title);
    setBody(doc.body);
    setSavedAt(null);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!activeSlug) return;
    setSaving(true);
    try {
      const res = await updateAdminLegalDocument(activeSlug, { title, body });
      setDocuments((docs) => docs.map((d) => (d.slug === activeSlug ? res.document : d)));
      setSavedAt(new Date().toLocaleTimeString('ja-JP'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="admin-legal-page">
      <h1>法務ページ編集</h1>
      <p>特商法・利用規約・返金ポリシー・プライバシーポリシーの本文を編集できます。</p>

      <div className="admin-legal-tabs">
        {documents.map((doc) => (
          <button
            key={doc.slug}
            type="button"
            className={doc.slug === activeSlug ? 'admin-legal-tab admin-legal-tab--active' : 'admin-legal-tab'}
            onClick={() => selectDocument(doc)}
          >
            {SLUG_LABELS[doc.slug] ?? doc.slug}
          </button>
        ))}
      </div>

      {activeSlug && (
        <div className="admin-legal-editor">
          <form onSubmit={handleSave}>
            <label>
              ページタイトル
              <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} required />
            </label>
            <label>
              本文(記法: 行頭「## 」で見出し / 行頭「!」で注意書き / 「項目名|値」でテーブル行)
              <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={18} required />
            </label>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? '保存中...' : '保存する'}
            </button>
            {savedAt && <span className="admin-legal-saved">{savedAt} に保存しました</span>}
          </form>

          <div className="admin-legal-preview">
            <h2 className="admin-legal-preview__label">プレビュー</h2>
            <div className="legal-page">
              <h1>{title}</h1>
              {renderLegalBody(body)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
