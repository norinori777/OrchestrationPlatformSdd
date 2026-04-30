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

    最小コード（src/workflows.ts, src/worker.ts, src/client.ts）

    ```
    実行（別ターミナルで Worker 起動 → Client 起動）
    ```bash
    npx ts-node src/worker.ts
    # 別ターミナル
    npx ts-node src/client.ts
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
    2. workflows.tsにhellowWorkflow2のアクティビティを追加して、アクティビティのメッセージをOpen Policy Agentに渡しながら呼び出して、判定を受け取り、実行の代替として、判定結果を出力するようにしている。worker.tsを実行する。
        ```
        npx ts-node .\src\gRPC\subscribe2.ts
        ```
    3. publish2.tsにメッセージを追加して、発行している。publish2.tsを実行して、イベントを開始して、処理が流れることを確認する。
        ```
        npx ts-node .\src\nats\publish2.ts
        ```
