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

## 使い方

### 1. LLMサーバーを起動する

**Ollama の場合:**
```bash
ollama serve          # 起動
ollama pull llama3.2  # 任意のモデルを取得
```

**LM Studio の場合:** アプリ内の「Local Server」を起動（既定では `http://localhost:1234/v1`）。

### 2. CORS を許可する（重要）

ブラウザから別ポートのローカルサーバーへアクセスするため、サーバー側でCORSの許可が必要です。

**Ollama:**
```bash
# 環境変数を設定してから ollama serve を起動
export OLLAMA_ORIGINS="*"
ollama serve
```
（macOSアプリ版は `launchctl setenv OLLAMA_ORIGINS "*"` 後に再起動）

**LM Studio:** サーバー設定で CORS を有効化してください。

### 3. このアプリを開く

`file://` で直接開くと一部ブラウザでESモジュールが動かないため、簡易サーバー経由を推奨します。

```bash
# Python があれば
python3 -m http.server 8000

# もしくは Node
npx serve .
```

ブラウザで `http://localhost:8000` を開きます。

### 4. 接続・チャット

1. 右上でプロバイダ（Ollama / LM Studio）を選択
2. `⟳` でモデル一覧を更新し、モデルを選択
3. メッセージを入力して送信（Enterで送信 / Shift+Enterで改行）

接続先やパラメータは左下の **⚙ 設定** から変更できます。各プロバイダは「接続テスト」で
疎通確認が可能です。

## ファイル構成

| ファイル | 役割 |
|----------|------|
| `index.html` | 画面構造 |
| `styles.css` | スタイル |
| `app.js`     | 状態管理・UI・チャット制御 |
| `providers.js` | Ollama / OpenAI互換 APIの抽象化（モデル一覧・ストリーミング） |

## データの保存場所

会話・設定はすべてブラウザの `localStorage` に保存されます（サーバー送信なし）。
ブラウザのデータを消去すると履歴も消えます。

## ライセンス

MIT
