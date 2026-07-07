# 代理店システム連携API 仕様書

戦国経済圏(以下「本システム」)は一般公開せず、LP経由の問い合わせ→代理店が説明→購入時に代理店専用の紹介URLを渡す、という運用を前提としています。
本ドキュメントは、代理店情報(組織ツリー・ログインアカウント)を外部の代理店システムから本システムへ同期するためのAPI仕様です。

対象読者: 代理店システム側の開発者。

## 1. 全体像

- 代理店システム側が「情報の発生源(source of truth)」です。代理店の新規登録・情報変更が代理店システム側で発生するたびに、本APIを呼び出して本システム側に反映してください。
- 本システムは受け取った内容をもとに、代理店ごとの紹介URL発行・報酬率解決・代理店ポータルログインを行います。
- 紹介URLの発行自体はこのAPIの対象外です。代理店は、本システムが提供する代理店ポータル(後述)にログインして自分で紹介URLを発行します。

## 2. 認証

サーバー間通信のため、Cookie/JWTではなく固定のAPIキーで認証します。次のどちらのヘッダーでも認証できます。

```http
x-api-key: <APIキー>
```

```http
Authorization: Bearer <APIキー>
```

- APIキーは本システムの管理画面(`/admin/settings`)の「代理店連携APIキー」欄で発行・確認できます。運営担当者から共有を受けてください。
- キー未設定時は `503 API_KEY_NOT_CONFIGURED`、未指定は `401 API_KEY_REQUIRED`、不一致は `401 INVALID_API_KEY` を返します。

## 3. ベースURL

```
https://<本システムの本番ドメイン>/api/integrations/agencies
```

## 4. 共通仕様

- リクエスト/レスポンスはすべてJSON(`Content-Type: application/json`)。
- エラーレスポンスは共通形式です。

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "external_idを指定してください" } }
```

- 代理店の一意キーは本システム内部のUUIDではなく、代理店システム側で発行する `external_id`(任意の文字列)です。**同じ`external_id`で複数回POSTしても二重登録されず、更新として扱われます(冪等)。**

## 5. エンドポイント一覧

| メソッド | パス | 用途 |
|---|---|---|
| POST | `/` | 代理店の新規登録・更新(upsert) |
| GET | `/` | 代理店の一覧取得 |
| GET | `/:external_id` | 代理店の詳細取得(子代理店一覧を含む) |

### 5.1 POST `/` — 代理店の登録・更新

代理店システム側の代理店IDを起点に、新規作成 or 既存更新を自動判定します。

**リクエストボディ**

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `external_id` | string | ○ | 代理店システム側の代理店ID。本システム側の一意キーとして使用 |
| `name` | string | ○ | 代理店名 |
| `parent_external_id` | string \| null | - | 親代理店の`external_id`。多階層ツリーを組む場合に指定。**親は先に登録しておく必要があります**。未指定なら現状の親構成を維持(新規作成時は本部直下)。`null`または空文字`""`を指定すると本部直下に解除 |
| `default_commission_rate` | number(0〜100) | - | 既定報酬率(%)。紹介URL個別・インフルエンサー個別に報酬率が設定されていない場合のフォールバック値 |
| `contact_name` | string | - | 担当者名。未指定の場合、新規作成時は`name`と同じ値が使われる |
| `contact_email` | string | - | 連絡先メールアドレス |
| `status` | `"active"` \| `"inactive"` | - | 代理店ステータス。省略時、新規作成なら`active` |
| `login_email` | string | - | 指定すると代理店ポータルのログインアカウントを発行(下記6章参照) |

**リクエスト例(親代理店の登録)**

```http
POST /api/integrations/agencies
x-api-key: <APIキー>
Content-Type: application/json

{
  "external_id": "agency-001",
  "name": "株式会社サンプル代理店",
  "default_commission_rate": 20,
  "contact_name": "山田太郎",
  "contact_email": "yamada@example.com",
  "login_email": "yamada@example.com"
}
```

**リクエスト例(子代理店の登録)**

```http
POST /api/integrations/agencies
x-api-key: <APIキー>
Content-Type: application/json

{
  "external_id": "agency-001-sub-01",
  "name": "サンプル代理店 東京支店",
  "parent_external_id": "agency-001",
  "default_commission_rate": 15
}
```

**レスポンス**

- 新規作成: `201 Created`
- 既存更新: `200 OK`

```json
{
  "success": true,
  "data": {
    "id": "9805a3a7-ee08-4c08-a042-fdbf5bc403cd",
    "external_id": "agency-001",
    "name": "株式会社サンプル代理店",
    "code": "AG003",
    "status": "active",
    "default_commission_rate": 20,
    "contact_name": "山田太郎",
    "contact_email": "yamada@example.com",
    "parent_external_id": null,
    "login_provisioned": true,
    "synced": true
  }
}
```

- `code`: 本システム側で自動採番される内部コード(AG連番)。代理店システム側から指定・変更はできません。
- `login_provisioned`: このリクエストで新規にログインアカウントを発行した場合のみ`true`。既にアカウントがある代理店に`login_email`を送っても`false`が返り、二重発行はされません。
- `synced`: 常に`true`(受信・反映が成功したことを示す)。

**主なエラー**

| ステータス | code | 原因 |
|---|---|---|
| 400 | `VALIDATION_ERROR` | `external_id`/`name`未指定、`default_commission_rate`が0〜100の範囲外、`status`不正、`login_email`の形式不正、自分自身または自分の配下代理店を親に指定(循環)など |
| 404 | `PARENT_AGENCY_NOT_FOUND` | `parent_external_id`に該当する代理店が存在しない(親を先に登録してください) |
| 409 | `LOGIN_EMAIL_ALREADY_EXISTS` | `login_email`が既に他のアカウントで使用されている |
| 500 | `SERVER_ERROR` | 本システム側の予期しないエラー |

### 5.2 GET `/` — 代理店一覧取得

```http
GET /api/integrations/agencies
x-api-key: <APIキー>
```

```json
{
  "agencies": [
    {
      "id": "9805a3a7-ee08-4c08-a042-fdbf5bc403cd",
      "external_id": "agency-001",
      "name": "株式会社サンプル代理店",
      "code": "AG003",
      "status": "active",
      "default_commission_rate": 20,
      "contact_name": "山田太郎",
      "contact_email": "yamada@example.com",
      "parent_external_id": null
    }
  ]
}
```

登録済みの全代理店をフラットな配列で返します。`parent_external_id`を見て、代理店システム側でツリー構造を再構築してください。

### 5.3 GET `/:external_id` — 代理店詳細取得

```http
GET /api/integrations/agencies/agency-001
x-api-key: <APIキー>
```

```json
{
  "agency": {
    "id": "9805a3a7-ee08-4c08-a042-fdbf5bc403cd",
    "external_id": "agency-001",
    "name": "株式会社サンプル代理店",
    "code": "AG003",
    "status": "active",
    "default_commission_rate": 20,
    "contact_name": "山田太郎",
    "contact_email": "yamada@example.com",
    "parent_external_id": null,
    "child_external_ids": ["agency-001-sub-01"]
  }
}
```

一覧との違いは `child_external_ids`(直下の子代理店の`external_id`一覧)が含まれる点です。存在しない場合は`404 AGENCY_NOT_FOUND`。

サーバー設定等でパス形式(`/:external_id`)が使えない場合は、`GET /?external_id=<external_id>` のクエリ形式でも同じ詳細レスポンスを取得できます。

## 6. ログインアカウント発行(`login_email`)について

- `login_email`を指定してPOSTすると、その代理店に紐づく代理店ポータル用ログインアカウントを作成します。
- **`login_email`が本システムの既存の一般会員(評議員デジタル会員証の購入者等)のメールアドレスと一致する場合、新規アカウントは作成せず、その既存アカウントに代理店ポータルの権限を付与します。** この場合、既にパスワードを持っているため仮パスワードの発行・設定メールは送られず、代わりに「代理店ポータルが使えるようになった」ことを案内するメールのみ送信されます。ログインは今まで通り同じメールアドレス・パスワードで行えます。
  - 例: 評議員デジタル会員証を購入して会員登録したユーザーが、インフルエンサーとして代理店システムに申請・承認された場合、そのユーザーの購入時のメールアドレスを`login_email`に指定してPOSTすることで、追加のパスワード再設定なしに代理店ポータルへログインできるようになります。
  - 一致したメールアドレスが既に別の代理店ポータル・管理者アカウントとして使われている場合は`409 LOGIN_EMAIL_ALREADY_EXISTS`になります(上書き・付け替えは行いません)。
- 該当する既存会員が見つからない場合は、従来通り新規アカウントを作成し、仮パスワードは**発行せず**本人にパスワード設定メールを送信します(セキュリティ上、仮パスワードの平文送信は行いません)。
- 1代理店につきログインアカウントは1つまでです。既にある状態で`login_email`を送っても新規作成はされません(`login_provisioned: false`)。
- ログイン後、代理店担当者は本システムの通常ログイン画面(`/login`)から同じメールアドレス・パスワードでログインし、代理店ポータル(`/agency`)で自代理店の紹介URLを発行・一覧できます。他代理店の情報は参照できません。

### 6.1 上位代理店の自動継承

- 新規代理店を作成する際、`parent_external_id`を指定せず、かつ`login_email`が「既にこのサイトで購入し代理店へ永久帰属済みの会員」のメールアドレスと一致する場合、その会員が最初に紐づいた代理店(紹介元)を自動的に上位代理店(`parent_external_id`)として設定します。
- `parent_external_id`を明示的に指定した場合は、常にその指定が優先されます(自動継承はされません)。
- 既存代理店の更新(`external_id`が既存)には自動継承は適用されません(新規作成時のみ)。

## 7. 階層(ツリー)に関する制約

- **親を先に登録してください。** 子代理店の`parent_external_id`が未登録の`external_id`を指すと`404 PARENT_AGENCY_NOT_FOUND`になります。
- 自分自身を親に指定することはできません(`400 VALIDATION_ERROR`)。
- 自分の配下(子・孫…)の代理店を親に指定することもできません。循環構造になるため`400 VALIDATION_ERROR`を返します。
- 推奨する同期順序: 親代理店→子代理店→孫代理店…の順に登録してください。

## 8. 運用上の注意

- 代理店の削除APIはありません。使わなくする場合は`status: "inactive"`を送ってください。
- `code`(AG連番)・紹介URLのコード(SGI連番)は本システム側の自動採番のみで、外部から指定・変更することはできません。
- 冪等性のキーは`external_id`です。代理店システム側でこの値を変えると別の代理店として新規作成されるため、変更しないでください。
- `contact_email`と`login_email`はそれぞれ独立した項目として保存されます。`login_email`を送っても`contact_email`が上書きされることはありません。
