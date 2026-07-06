import { useEffect, useState } from 'react';
import { fetchLegalDocument, type LegalDocument } from '../../lib/api';
import { renderLegalBody } from '../../lib/legalContent';

export default function LegalDocumentPage({ slug }: { slug: string }) {
  const [document, setDocument] = useState<LegalDocument | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDocument(null);
    setError(null);
    fetchLegalDocument(slug)
      .then((res) => setDocument(res.document))
      .catch((e) => setError(e instanceof Error ? e.message : 'ページの読み込みに失敗しました'));
  }, [slug]);

  if (error) {
    return (
      <div className="legal-page">
        <p className="checkout-error">{error}</p>
      </div>
    );
  }

  if (!document) {
    return <div className="legal-page" />;
  }

  return (
    <div className="legal-page">
      <h1>{document.title}</h1>
      {renderLegalBody(document.body)}
    </div>
  );
}
