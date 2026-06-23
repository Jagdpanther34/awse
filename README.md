# LocalLLM Studio

ブラウザ上で動作する、[Cherry Studio](https://github.com/CherryHQ/cherry-studio) のような
**ローカルLLMクライアント**です。インストール不要・ビルド不要で、ブラウザから
ローカルで動いているLLMサーバー（Ollama / LM Studio など）に接続してチャットできます。

## 特長

- 🧩 **複数プロバイダ対応** — Ollama ネイティブAPI / OpenAI互換API（LM Studio, llama.cpp, vLLM など）
- 🔄 **モデル一覧の自動取得** — 接続先からインストール済みモデルを取得して選択
- ⚡ **ストリーミング応答** — トークンを逐次表示
- 💬 **会話履歴** — 複数スレッドをブラウザ内（localStorage）に保存
- 📝 **Markdown + コード表示** — XSS対策に DOMPurify でサニタイズ
- ⚙️ **生成パラメータ** — システムプロンプト / temperature / max tokens
- 🔌 **依存ゼロのフロントエンド** — 静的ファイルのみ（CDNの marked / DOMPurify を利用）

## 使い方（もらったサーバーに接続する場合）

サーバーの持ち主から **URL** と **APIキー** をもらっているケースを想定した手順です。

### 1. サーバーURLを設定する

`config.js` を開き、`baseUrl` をもらったURLに書き換えます（OpenAI互換なら末尾は通常 `/v1`）。

```js
export const DEFAULT_SERVER = {
  name: "My LLM Server",
  type: "openai",
  baseUrl: "https://YOUR-SERVER-HERE/v1", // ← ここを書き換える
  requireApiKey: true,
};
```

> **APIキーはここに書きません。** コードに書くと公開時に誰でも見られてしまうため、
> キーは利用者が画面上で入力し、その人のブラウザ（localStorage）にのみ保存されます。

### 2. デプロイする

静的ファイルだけなので、そのまま静的ホスティングにアップロードできます。

- **Netlify Drop** … zip / フォルダをドロップするだけ
- **Cloudflare Pages / Vercel / GitHub Pages** … フォルダを公開

ローカル確認なら `python3 -m http.server 8000` で `http://localhost:8000` を開きます
（`file://` 直開きはESモジュールが動かない場合があるため非推奨）。

### 3. 利用する

1. サイトを開くと上部にAPIキー入力欄が出るので、もらったキーを貼り付けて「保存して接続」
2. `⟳` でモデル一覧を取得し、モデルを選択
3. メッセージを入力して送信（Enterで送信 / Shift+Enterで改行）

接続先やパラメータは左下の **⚙ 設定** からも変更でき、「接続テスト」で疎通確認できます。

### ローカルLLM（Ollama / LM Studio）に使う場合

`config.js` の `baseUrl` をローカルアドレス（例 `http://localhost:11434`）に、
`type` を `"ollama"`、`requireApiKey` を `false` にします。
ブラウザからローカルサーバーへアクセスするには **サーバー側のCORS許可** が必要です
（Ollama は `OLLAMA_ORIGINS="*"` を設定して起動）。

## ファイル構成

| ファイル | 役割 |
|----------|------|
| `config.js`  | 接続先サーバーURLの設定（ここを書き換える） |
| `index.html` | 画面構造 |
| `styles.css` | スタイル |
| `app.js`     | 状態管理・UI・チャット制御 |
| `providers.js` | Ollama / OpenAI互換 APIの抽象化（モデル一覧・ストリーミング） |

## データの保存場所

会話・設定はすべてブラウザの `localStorage` に保存されます（サーバー送信なし）。
ブラウザのデータを消去すると履歴も消えます。

## ライセンス

MIT
