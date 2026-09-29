# obsidian-vault-mcp

ディスク上の Obsidian Vault を直接読み書きする MCP サーバー。Obsidian アプリを起動しておく必要はない。
読み書き・検索に加えて、`[[wikilink]]` のグラフ探索（バックリンク、N-hop 近傍、未解決リンク、孤立ノート）を提供する。

- TypeScript / 公式 MCP SDK v2（仕様 2026-07-28 と 2025 系の両方に対応）
- Streamable HTTP（Bearer トークン）と stdio
- Node.js 24+ で `node src/main.ts` として直接実行できる。Claude Desktop 用には依存を同梱した `.mcpb`（デスクトップ拡張）も作れる

## 使い方

### Claude Desktop（デスクトップ拡張 / ネットワークに何も公開しない）

```bash
pnpm install && pnpm pack:mcpb     # obsidian-vault-mcp.mcpb ができる
```

生成された `.mcpb` を Claude Desktop の **Settings > Extensions** にドラッグして、インストールする。設定画面で Vault のフォルダを選ぶ。
初期値は**読み取り専用**なので、書き込ませたいときは「Read-only」をオフにする（「Writable folders」で書き込めるフォルダも限定できる）。

### Claude Code（ローカル、stdio）

```bash
claude mcp add --scope user obsidian --env OBSIDIAN_VAULT_PATH=$HOME/vault --env OBSIDIAN_MCP_READONLY=1 -- node /path/to/obsidian-vault-mcp/src/main.ts --stdio
```

### Claude Code（リモートのサーバーへ HTTP で接続）

下の「サーバーへのデプロイ」を参照。

## 構成（サーバーに常駐させる場合）

```
[各端末の Obsidian] ⇄ CouchDB
                          ⇅  livesync-cli daemon（E2EE v2・パス難読化に対応）
                     /srv/vault（平文のミラー）
                          ↑ 読み書き
                     obsidian-vault-mcp  127.0.0.1:8787
                          ↑ HTTPS のリバースプロキシ（tailscale serve、Caddy など）
                   Claude Code / その他 MCP クライアント
```

MCP での書き込みは livesync-cli がファイル監視で拾い、CouchDB 経由で各端末に配信する。

## ツール

| 種別 | ツール | 内容 |
|---|---|---|
| 読み取り | `list_notes` | フォルダ内のノートを更新日時の新しい順に一覧 |
| | `read_note` | 本文を読む。見出しセクションだけ読む、ページングも可。編集用の `hash` を返す |
| | `get_note_info` | frontmatter・タグ・エイリアス・見出し構成・リンク数 |
| | `search_notes` | 全文検索（AND、大文字小文字区別なし、日本語可）または正規表現。フォルダ・タグで絞り込み |
| | `list_tags` | タグと件数 |
| グラフ | `resolve_link` | `[[リンク]]` がどのファイルに解決されるか |
| | `get_backlinks` | このノートへのリンク元と該当行。リンクされていない言及も任意で取得 |
| | `get_outgoing_links` | 発リンクとその解決先（wiki / markdown / 埋め込み / frontmatter） |
| | `graph_neighbors` | BFS で N-hop 近傍（in / out / both） |
| | `find_unresolved_links` | 存在しないノートへのリンクを、リンク先ごとにまとめる |
| | `find_orphans` | どこからもリンクされていないノート |
| 書き込み | `write_note` | 新規作成（上書きには `overwrite=true` が必要） |
| | `append_to_note` | ノート末尾、または見出しセクションの末尾に追記 |
| | `edit_section` | 見出しセクションの置換・先頭挿入・末尾挿入（`"親 > 子"` 指定可） |
| | `replace_in_note` | 完全一致の置換（出現回数が一致しなければ失敗する） |
| | `update_frontmatter` | プロパティの追加・削除（コメントや他のキーは保持） |

ノートの指定は、パス（`folder/note.md`）・ノート名（`Note Name`）・エイリアスのどれでもよい。

### 安全策

- `.obsidian/` など `.` で始まるパスは読み書きとも不可（LiveSync の認証情報を守るため）。Vault 外への脱出（`..` やシンボリックリンク）も拒否する
- 書き込めるのは `.md` だけ。`OBSIDIAN_MCP_WRITE_PATHS` でフォルダを限定できる。`CLAUDE.md` / `AGENTS.md` は常に書き込み不可
- 編集系ツールは楽観ロックを行う。読み込み後にノートが変わっていたら失敗する（`expected_hash` を渡すと `read_note` の時点を基準にできる）
- 書き込みは隠し一時ファイルに書いてから rename する（アトミック）
- 削除と移動のツールは**意図的に実装していない**。livesync-cli の `mirror` はディスク上の削除を反映せず、ファイルを復元してしまうため（削除は `livesync-cli rm` で行う）

### リンク解決のルール（Obsidian 準拠）

- `folder/Note` はパスの完全一致、なければ末尾一致
- 素の `Note` は同じフォルダ → ルートに近いもの → 浅いパスの順で優先。候補が複数あるときは `ambiguous` として列挙する
- `./` `../` は相対パスとして解決する。`#見出し` と `#^block` は subpath として保持する
- `[[エイリアス]]` はグラフ上は未解決として扱う（Obsidian と同じ）。ツール引数でノートを指定するときだけエイリアスでも引ける
- コードブロック、インラインコード、`%%コメント%%`、`<!-- -->`、`$$数式$$` の中のリンクとタグは無視する

## 開発

```bash
pnpm install
pnpm test          # ユニットテスト + HTTP 経由の e2e
pnpm typecheck
OBSIDIAN_VAULT_PATH=~/vault OBSIDIAN_MCP_READONLY=1 pnpm start
```

## サーバーへのデプロイ

以下は Debian / Ubuntu 系の Linux を想定。LiveSync の CouchDB に到達できる場所に置く。

### 1. Node.js 24 以上とユーザーの用意

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash - && sudo apt-get install -y nodejs git curl
sudo useradd --system --create-home --home-dir /var/lib/obsidian --shell /bin/bash obsidian
sudo mkdir -p /srv/vault && sudo chown obsidian: /srv/vault
```

### 2. livesync-cli（CouchDB から /srv/vault へのミラー）

Self-hosted LiveSync プラグインの作者（vrtmrz）が同じリポジトリ（`vrtmrz/obsidian-livesync` の `src/apps/cli`）で公開している CLI を使う（Obsidian 公式のツールではない）。`livesync-bridge` は E2EE 環境で復号に失敗する不具合が未解決なので使わない。

```bash
sudo -iu obsidian
git clone https://github.com/vrtmrz/obsidian-livesync.git ~/obsidian-livesync
cd ~/obsidian-livesync && bash src/apps/cli/deploy/install.sh --vault /srv/vault
```

他の端末の Obsidian で「Self-hosted LiveSync → Setup → Copy the current settings to a setup URI」を実行し、Setup URI を作る。それを CLI に取り込む（パスフレーズは標準入力で渡す）。

```bash
livesync-cli /srv/vault setup "obsidian://setuplivesync?settings=..."
```

- **E2EE のパスフレーズは他の端末と完全に一致させる**こと。違っていても警告なしに同期が壊れる。パス難読化も同じパスフレーズから導出される
- 最初は CouchDB への書き込みを避け、`livesync-cli /srv/vault mirror` を一回だけ実行して `/srv/vault` の中身を確認するのが安全
- 一時ファイルを確実に除外するため、`/srv/vault/.livesync/ignore` に次を書いておく

  ```
  .*.tmp
  ```

### 3. obsidian-vault-mcp

```bash
sudo git clone https://github.com/asann3/obsidian-vault-mcp.git /opt/obsidian-mcp
cd /opt/obsidian-mcp && sudo corepack enable && sudo pnpm install --prod
sudo cp deploy/obsidian-mcp.env.example /etc/obsidian-mcp.env && sudo chmod 600 /etc/obsidian-mcp.env
sudo sed -i "s/^OBSIDIAN_MCP_TOKEN=.*/OBSIDIAN_MCP_TOKEN=$(openssl rand -hex 32)/" /etc/obsidian-mcp.env
sudoedit /etc/obsidian-mcp.env                 # ALLOWED_HOSTS を公開するホスト名に
sudo cp deploy/obsidian-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now obsidian-mcp
curl -s localhost:8787/healthz
```

### 4. HTTPS で公開する

サーバーは `127.0.0.1` だけで待ち受ける。TLS はリバースプロキシで終端する。Tailscale なら次のとおり。

```bash
sudo tailscale serve --bg 8787
tailscale serve status        # https://<ホスト名>/ → 127.0.0.1:8787
```

### 5. クライアント登録（Claude Code）

```bash
claude mcp add --transport http --scope user obsidian https://<ホスト名>/mcp --header "Authorization: Bearer <TOKEN>"
```

## claude.ai / スマホから使う場合

claude.ai のコネクタは、Anthropic のクラウドからサーバーに接続する。そのため、インターネットから届く URL（Tailscale Funnel など）が必要になる。認証は次のどちらか。

- **リクエストヘッダー方式（ベータ）**：コネクタの追加画面で、認証を「サインインなし」にして、`authorization: Bearer <トークン>` を登録する。このサーバーの Bearer 認証がそのまま使える。この項目が表示されないアカウントもある
- **OAuth 2.1**：未実装。`OAuthTokenVerifier` を差し替えて、PRM / AS メタデータ、PKCE、CIMD または DCR を実装する必要がある

公開するときは、読み取り専用にするか `OBSIDIAN_MCP_WRITE_PATHS` で書き込み先を絞ること。
