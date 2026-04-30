# オーケストレーションプラットフォーム検証

## 目的

複数のSaasの基盤になるためのオーケストレーションプラットフォームのMVP基盤を作成する。
イベントと状態管理で動作できることを確認する。

## 検証

### 導入、コンポーネント理解

進め方は、いきなり全部を作り込まずに「1コンポーネントずつ疎通を確認して、最後に流れをつなぐ」のが最短です。今の docker-compose.yaml なら、まずは Postgres と Temporal UI までを基準にして、その後に NATS と OPA を足していく順番がよいです。

1. 起動確認
   `docker-compose -f .\docker-compose.yaml up -d`
   成功条件: `postgres`、`temporal`、`temporal-ui`、`nats`、`opa` が `Up` になる。

2. Temporal UI 確認
   ブラウザで `http://localhost:8080` を開く。
   成功条件: Temporal の画面が表示される。

3. Temporal gRPC 確認
   `http://localhost:7233` はブラウザではなく SDK 用の接続先として扱う。
   成功条件: Worker から `localhost:7233` に接続できる。

   Node + TypeScript で Temporal Worker / Client を動かせます。手順（最小サンプル）と実行コマンドを示します。

    セットアップ（プロジェクト作成・依存追加）
    ```bash
    npm init -y
    npm install @temporalio/client @temporalio/worker
    npm install -D typescript ts-node @types/node
    npx tsc --init --target es2020 --module commonjs --esModuleInterop true
    ```

      最小コード（src/gPRC/workflows.ts, src/gPRC/workflow.ts, src/gPRC/client.ts）

   ```
   実行（別ターミナルで Worker 起動 → Client 起動）
   ```bash
   npx ts-node src/gPRC/workflow.ts
   # 別ターミナル
   npx ts-node src/gPRC/client.ts
   ```

    期待する動作: Worker が 7233 に接続してタスクキューを待ち、Client の start が成功して結果を返す（"hello world"）。

4. NATS 確認
   `nats://localhost:4222` で publish / subscribe を試す。
   成功条件: 送信したメッセージを別プロセスで受信できる。

    ```
    npm install nats
    ```

    ```
    npx ts-node src/nats/sub.ts
    # 別ターミナル
    npx ts-node src/nats/pub.ts
    ```

5. OPA 確認
   `http://localhost:8181` に対して最小の Rego を読み込ませて判定を返す。
   成功条件: Allow / Deny の結果が期待どおり返る。

   最小の実施手順は次の通りです。

   1. ポリシーを OPA に読み込む。
      ```bash
      npx ts-node src/Opa/loadPolicy.ts
      ```

   2. Allow を確認する。
      ```bash
      $body = @{ input = @{ user = 'alice'; action = 'read' } } | ConvertTo-Json -Depth 5
      Invoke-RestMethod -Method Post -Uri http://localhost:8181/v1/data/example/authz/allow -ContentType 'application/json' -Body $body
      ```
      期待値: `{"result":true}`

   3. Deny を確認する。
      ```bash
      $body = @{ input = @{ user = 'bob'; action = 'read' } } | ConvertTo-Json -Depth 5
      Invoke-RestMethod -Method Post -Uri http://localhost:8181/v1/data/example/authz/allow -ContentType 'application/json' -Body $body
      ```
      期待値: `{"result":false}`

   4. TypeScript の確認スクリプトを使う。
      ```bash
      npx ts-node src/Opa/testOpa.ts
      ```
      期待値: `alice/read -> true` と `bob/read -> false` が出る。


6. 連携確認
   NATS のイベントを受けて Temporal で Workflow を開始し、その中で OPA に問い合わせる。
   成功条件: 1つのリクエストが「受信 → 判定 → 実行 → 完了」まで流れる。

    1. subscribe2.tsをhelloWorkflow2をアクティビティを購読する処理を追加して、アクティビティのメッセージをwokerに渡すようにしている。subscribe2.tsを実行する。

        ```
        npx ts-node .\src\nats\subscribe2.ts
        ```
      2. workflows.tsにhelloWorkflow2のアクティビティを追加して、アクティビティのメッセージをOpen Policy Agentに渡しながら呼び出して、判定を受け取り、実行の代替として、判定結果を出力するようにしている。workflow.tsを実行する。
        ```
            npx ts-node .\src\gPRC\workflow.ts
        ```
    3. publish2.tsにメッセージを追加して、発行している。publish2.tsを実行して、イベントを開始して、処理が流れることを確認する。
        ```
        npx ts-node .\src\nats\publish2.ts
        ```

### 動作詳細確認

次は「つながったことを確認する」段階から、「どこで何が起きているかを自分で説明できる」段階に進めます。

1. 各層を単体で壊してみる  
   OPA の条件を変えて Allow と Deny を両方試し、Temporal の結果がどう変わるかを見ると、判定器の役割が明確になります。次に NATS の送信データを壊して、受信側でどこで落ちるかも確認すると、境界が見えます。

2. Temporal の実行経路を観察する  
   src/gPRC/workflow.ts と src/gPRC/workflows.ts を見ながら、Workflow と Activity の責務の違いを整理すると理解が深まります。Temporal UI で履歴を見て、Workflow 開始、Activity 実行、完了の順を追うのが有効です。

3. NATS のメッセージ形式を設計し直す  
   今は最小 JSON ですが、メッセージに requestId や source を足して、受信から完了まで同じ ID をログに出すようにすると、イベント駆動の流れを追いやすくなります。これは実運用でも重要です。

4. 失敗系を1つずつ試す  
   OPA を止める、Temporal を止める、NATS を止める、の3パターンを試して、それぞれどのプロセスがどう失敗するかを確認すると、障害時の責務分界が理解できます。成功パスより、失敗の見え方のほうが学びになります。

5. テスト用の最小ケースを増やす  
   testOpa.ts のように、NATS → Temporal → OPA のフローにも小さな確認スクリプトを足すと、手順を再現しやすくなります。次の段階では、「alice は通る」「bob は拒否される」を自動で確認できるようにすると学習効率が上がります。

## さらに理解を深めるための整理

このリポジトリは、単に各ミドルウェアを個別に動かすためのものではなく、「イベントを受けて、状態を持ちながら、判断して、結果を返す」流れを確認するための教材として読むと理解しやすいです。

### 全体の流れ

1. `publish2.ts` が NATS にイベントを送る。
2. `subscribe2.ts` がそのイベントを受け取り、Temporal の Workflow を開始する。
3. `workflows.ts` の `helloWorkflow2` が OPA 判定用の Activity を呼ぶ。
4. `opa.ts` が OPA の HTTP API に問い合わせる。
5. OPA の Rego ポリシーが `allow` / `deny` を返す。
6. Workflow は判定結果を文字列として返し、最終的な処理結果になる。

この流れを追うと、NATS は「通知」、Temporal は「実行管理」、OPA は「判定」、TypeScript のコードは「接着剤」の役割だと分かります。

### 各コンポーネントの役割

NATS はメッセージを配る役目です。送信側は受信側の状態を意識せずにイベントを投げられるので、疎結合にしやすいです。

Temporal はワークフローの進行管理を担います。処理が途中で止まっても履歴を追いやすく、どの順番で何が起きたかを後から確認できます。

OPA は「この入力に対して実行してよいか」を返す判定器です。業務ロジックの中に条件分岐を書き散らす代わりに、ポリシーとして外出しできます。

### 読み方のコツ

最初はコードを全部追うより、次の順番で見ると把握しやすいです。

1. `src/nats/publish2.ts` でどんな入力が流れてくるかを見る。
2. `src/nats/subscribe2.ts` でその入力が Temporal に渡る形を見る。
3. `src/gPRC/workflows.ts` で Activity 呼び出しの前後を確認する。
4. `src/Opa/opa.ts` と `src/Opa/policy.rego` で判定条件を見る。

### 何が分かるようになるか

この構成を理解できると、次の3点が説明できるようになります。

1. どこがイベント駆動で、どこが同期処理か。
2. どこに状態管理を寄せるべきか。
3. ビジネスルールをどこに切り出すと保守しやすいか。

つまり、このリポジトリは「メッセージング」「ワークフロー管理」「ポリシー判定」を分けて考える練習台です。ここを押さえると、後で SaaS 基盤を大きくしても責務分離を崩しにくくなります。


## product — プロダクションレベル オーケストレーションプラットフォーム

### ファイル構成

```
src/product/
├── config.ts                   環境変数から設定をロード (バリデーション付き)
├── logger.ts                   構造化 JSON ロガー (stdout/stderr)
├── types.ts                    共有型定義
├── worker.ts                   Temporal ワーカー (NativeConnection)
├── gateway.ts                  NATS JetStream → Temporal ゲートウェイ
├── healthServer.ts             HTTP ヘルスチェックサーバー (:3000)
├── index.ts                    メインエントリポイント
├── workflows/
│   └── platformWorkflow.ts    メインワークフロー (Signal/Query 対応)
├── activities/
│   ├── index.ts               アクティビティレジストリ + PlatformActivities 型
│   ├── opaActivity.ts         OPA ポリシー評価 (タイムアウト + リトライ)
│   ├── notificationActivity.ts 通知送信 (Webhook/Email 差し替え可)
│   └── persistenceActivity.ts DB 永続化 (PostgreSQL upsert 雛形付き)
└── policies/
    ├── platform.rego           テナント RBAC Rego ポリシー
    ├── platform-data.json      RBAC データ (ユーザー/ロール/テナント)
    └── loadPolicy.ts           OPA へポリシー+データをロードするスクリプト
```

### 主要な本番品質機能

| 機能 | 実装 |
|------|------|
| **耐久メッセージング** | NATS JetStream (durable consumer, ack_wait, max_deliver) |
| **冪等性** | `workflowId = "platform-{requestId}"` で重複起動を防止 |
| **ポリシー評価** | OPA RBAC (テナント × ユーザー × ロール × リソース) |
| **Graceful Shutdown** | SIGTERM/SIGINT → worker.shutdown() + nc.drain() |
| **ヘルスチェック** | `/health/live` (Liveness) / `/health/ready` (Readiness) |
| **構造化ログ** | JSON形式、子ロガーで相関ID伝播 |
| **DLQ** | 不正形式メッセージは `platform.dlq` へ転送して ack |
| **Signal/Query** | `cancel` シグナル・`getStatus` クエリ対応 |

### 起動手順

```bash
# 1. OPA にポリシーとデータをロード
npx ts-node src/product/policies/loadPolicy.ts

# 2. プラットフォーム全体を起動
npx ts-node src/product/index.ts
```

NATS へのテストメッセージ送信例:
```json
{
  "requestId": "req-001", "tenantId": "tenant-a",
  "userId": "alice", "action": "create", "resource": "orders",
  "payload": {}
}
```
を subject `platform.events.orders` へ publish すると、OPA → Temporal ワークフローが自動的に動作します。

変更を行いました。