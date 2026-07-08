import { useEffect, useState } from 'react';
import { fetchAdminLegalDocuments, updateAdminLegalDocument, type AdminLegalDocument } from '../../lib/adminApi';
import {
  parseTokushohoBody,
  renderLegalBody,
  serializeTokushohoFields,
  TOKUSHOHO_FIELDS,
  type TokushohoFields,
} from '../../lib/legalContent';

const TOKUSHOHO_HELP: Partial<Record<string, string>> = {
  sellerName: '会社名(個人事業の場合は屋号でも可)を入力してください',
  operationManager: '代表者名、または通信販売の運営責任者名を入力してください',
  address: '所在地を入力してください(個人事業主等で開示が困難な場合は請求があれば開示する旨を記載してください)',
  phone: 'つながる電話番号を入力してください',
  email: '問い合わせ用のメールアドレスを入力してください',
  price: '商品ごとの価格の決まり方を入力してください',
  additionalFees: '送料・振込手数料など、商品代金以外に発生する費用を入力してください(ない場合は「なし」)',
  paymentMethods: '対応する決済方法を入力してください',
  paymentTiming: '支払いのタイミングを入力してください',
  deliveryTiming: '商品(デジタル会員証)をいつ受け取れるかを入力してください',
  returnsPolicy: '返品・キャンセルに関する取り扱いを入力してください',
};

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
  const [tokushohoFields, setTokushohoFields] = useState<TokushohoFields | null>(null);
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
    setTokushohoFields(doc.slug === 'tokushoho' ? parseTokushohoBody(doc.body) : null);
    setSavedAt(null);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!activeSlug) return;
    const bodyToSave = tokushohoFields ? serializeTokushohoFields(tokushohoFields) : body;
    setSaving(true);
    try {
      const res = await updateAdminLegalDocument(activeSlug, { title, body: bodyToSave });
      setDocuments((docs) => docs.map((d) => (d.slug === activeSlug ? res.document : d)));
      setBody(bodyToSave);
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

            {tokushohoFields ? (
              <>
                <p className="admin-legal-help">
                  項目ごとに入力してください。空欄のまま保存すると、その項目は「未記載」としてページに表示されます。
                </p>
                {TOKUSHOHO_FIELDS.map((f) => (
                  <label key={f.key}>
                    {f.label}
                    <textarea
                      value={tokushohoFields[f.key]}
                      onChange={(e) => setTokushohoFields((prev) => (prev ? { ...prev, [f.key]: e.target.value } : prev))}
                      rows={2}
                    />
                    {TOKUSHOHO_HELP[f.key] && <span className="admin-legal-field-help">{TOKUSHOHO_HELP[f.key]}</span>}
                  </label>
                ))}
                <label>
                  備考(任意。上記以外に記載したい内容があれば入力してください)
                  <textarea
                    value={tokushohoFields.extraNotes}
                    onChange={(e) => setTokushohoFields((prev) => (prev ? { ...prev, extraNotes: e.target.value } : prev))}
                    rows={3}
                  />
                </label>
              </>
            ) : (
              <label>
                本文(記法: 行頭「## 」で見出し / 行頭「!」で注意書き / 「項目名|値」でテーブル行)
                <textarea
                  className="admin-legal-raw-textarea"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={18}
                  required
                />
              </label>
            )}

            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? '保存中...' : '保存する'}
            </button>
            {savedAt && <span className="admin-legal-saved">{savedAt} に保存しました</span>}
          </form>

          <div className="admin-legal-preview">
            <h2 className="admin-legal-preview__label">プレビュー</h2>
            <div className="legal-page">
              <h1>{title}</h1>
              {renderLegalBody(tokushohoFields ? serializeTokushohoFields(tokushohoFields) : body)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
