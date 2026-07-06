import LegalPlaceholderNotice from './LegalPlaceholderNotice';

export default function TokushohoPage() {
  return (
    <div className="legal-page">
      <h1>特定商取引法に基づく表記</h1>
      <LegalPlaceholderNotice />
      <table className="legal-table">
        <tbody>
          <tr>
            <th>販売事業者名</th>
            <td>○○○○(準備中)</td>
          </tr>
          <tr>
            <th>運営統括責任者</th>
            <td>○○○○(準備中)</td>
          </tr>
          <tr>
            <th>所在地</th>
            <td>○○○○(準備中)</td>
          </tr>
          <tr>
            <th>電話番号</th>
            <td>○○○○(準備中)</td>
          </tr>
          <tr>
            <th>メールアドレス</th>
            <td>○○○○(準備中)</td>
          </tr>
          <tr>
            <th>販売価格</th>
            <td>各商品ページに表示する価格(税込)による</td>
          </tr>
          <tr>
            <th>商品代金以外の必要料金</th>
            <td>○○○○(準備中)</td>
          </tr>
          <tr>
            <th>お支払い方法</th>
            <td>クレジットカード決済(Stripe)</td>
          </tr>
          <tr>
            <th>お支払い時期</th>
            <td>ご注文時</td>
          </tr>
          <tr>
            <th>商品の引渡し時期</th>
            <td>決済完了後、順次デジタル会員証を発行します(詳細はマイページをご確認ください)</td>
          </tr>
          <tr>
            <th>返品・キャンセルについて</th>
            <td>
              <a href="/legal/refund">返金ポリシー</a>をご確認ください
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
