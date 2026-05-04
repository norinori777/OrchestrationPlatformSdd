連携の実際の流れを確認するため、ワークフロー側とアクティビティ定義の呼び出し元を見ます。

実際に「どこで複数サービスを束ねるか」を確認するため、リクエスト型とワークフローの入力を見ます。

認識は半分正しくて、半分違います。

現状の構成では、複数サービスの連携をまとめて担っているのは processRequestActivity ではなく、ワークフロー本体の platformWorkflow.ts です。ここでまず OPA 評価と Redis ベースのクォータチェックを行い、その後に processRequestActivity を1回呼んでいます。なので、1リクエストにつき必ず1個のビジネス処理だけ実行する設計になっています。

一方で processRequestActivity 自体は、単一の処理を実行するためのディスパッチャです。index.ts の handlers マップで action:resource をキーにして、該当するマイクロサービスへ HTTP を投げています。今ある具体例は create:files が FileStorageService、create:users が UserService です。つまり「複数マイクロサービスを横断して順番に実行する」役ではなく、「1つの要求を1つの下流サービスに委譲する」役です。

なので、今のままだと複数マイクロサービスを連続実行する動きにはなっていません。もし1件の業務要求の中で UserService と FileStorageService の両方を順番に呼ぶような連携をしたいなら、次のどちらかに寄せる必要があります。

- ワークフロー側で activity を複数回呼ぶ
- processRequestActivity の中で複数サービスをまとめて呼ぶ専用ハンドラを作る

補足すると、Redis はこの構成ではクォータ制御専用で、quotaActivity.ts から参照されています。業務マイクロサービスの連携制御そのものには使っていません。

必要なら次に、今の構成をベースに「1つの要求で複数サービスを順番実行する設計」にどう変えるべきかを、具体的なワークフロー案で整理できます。

はい。今の構成なら、複数マイクロサービスの連携は platformWorkflow.ts 側で順番に組み立てるのが正しいです。 index.ts の processRequestActivity は、あくまで action:resource に応じて 1 件の下流サービスへ委譲するディスパッチャです。なので、現状の認識どおり「1回の呼び出しで1サービスだけ実行している」動きです。

今の設計での実行順はこうなっています。

1. ワークフローが platformWorkflow.ts でリクエスト全体を受ける
2. OPA 評価をする
3. Redis を使ったクォータチェックをする
4. 必要なら複数の業務アクティビティを順番に呼ぶ
5. 失敗時は補償アクティビティを呼ぶ

つまり、複数サービスの連携をやる場所は processRequestActivity ではなく、ワークフロー本体です。 processRequestActivity は「実際の1サービス呼び出し」を担当するだけなので、役割としては合っています。

もし例えば「UserService にユーザー作成、その後 FileStorageService にファイル登録」を1つの業務としてやりたいなら、ワークフロー内でこのように並べます。

1. create:users 相当の activity を呼ぶ
2. 成功したら create:files 相当の activity を呼ぶ
3. 途中で失敗したら create:users の補償を実行する
4. 両方成功したら完了通知と DB 更新をする

この場合は、今の processRequestActivity をそのまま流用するより、ワークフロー側で複数回呼ぶか、複合処理専用の activity を別に作るほうが自然です。

補足すると、Redis はこの構成では quotaActivity.ts のクォータ制御にだけ使っています。複数マイクロサービスの連携制御や状態管理には使っていません。

結論としては、認識はほぼ正しくて、修正点は「複数サービスの連携は processRequestActivity がやる」のではなく「ワークフローが orchestrate する」という点です。必要なら次に、今のコードを前提にした「複数サービスを順番に呼ぶワークフロー案」を具体的に整理します。

基盤化するには、今の単発ディスパッチを「手順定義を受けて順次実行する」形に広げるのが最小の変更です。まず、既存の入力型とワークフローの接続点を確認して、どこまでを汎用化できるかを絞ります。

基盤案を崩さずに実装するため、既存の約束事をメモリに残しているか確認します。今回はワークフローに「定義ベースの複数ステップ実行」を足す方向で進めます。

この環境では編集ツールが使えないため、直接の反映まではできませんが、基盤として入れるべき変更は明確です。いまの単発ディスパッチを残しつつ、定義ベースで複数サービスを順番実行できる層を追加します。

まず、types.ts にオーケストレーション定義を足します。PlatformRequest.payload に orchestration を持たせ、steps の配列で実行順を表現します。各 step は service, method, path, headers, query, body を持ち、必要なら compensation も持てる形にします。これで「どのサービスの組み合わせでも、定義を追加するだけで呼べる」土台になります。

次に、index.ts に新しい実行アクティビティを追加します。processRequestActivity は今まで通り単発の下流呼び出し専用に残し、executeOrchestrationActivity のような新しい活動で steps を順番に処理します。実行時はサービス名からベースURLを解決し、前段の step 結果を後続 step の path や body に埋め込めるようにします。失敗時は reverse 順で補償定義を実行できるようにすると、オーケストレーション基盤としてかなり使いやすくなります。

最後に、platformWorkflow.ts で分岐します。payload に orchestration.steps があれば新しい定義駆動の実行アクティビティを呼び、なければ既存の processRequestActivity を使う。これで既存の1サービス処理は壊さず、複数サービスの連携も同じプラットフォーム上で扱えます。必要なら workflow.md にこの定義方式も追記して、利用者向けの説明まで揃えるのがよいです。

必要であれば次に、実際に差分としてそのまま適用できる形で、追加する型とワークフロー分岐の具体案をまとめます。

進め方としては、今の単発処理を壊さずに、その上に「定義駆動の実行層」を足すのが一番素直です。つまり、src/product/activities/index.ts の processRequestActivity は単発委譲のまま残し、複数サービス連携は src/product/workflows/platformWorkflow.ts で組み立てます。

実装イメージはこうです。

- リクエストに orchestration 定義を載せる
- workflow が steps を先頭から順番に読む
- 各 step を汎用 activity で実行する
- 失敗したら逆順に compensation を呼ぶ
- orchestration 定義がない場合は従来どおり processRequestActivity を1回だけ呼ぶ

定義の形は、例えばこんな粒度が扱いやすいです。

- service: どのサービスを呼ぶか
- method: GET, POST, PUT, DELETE
- path: 呼び出し先パス
- headers: 任意ヘッダー
- query: クエリ文字列
- body: リクエストボディ
- compensation: 失敗時の巻き戻し定義

この方式にすると、たとえば UserService に作成してから FileStorageService に登録する、あるいは OPA 判定後に複数の業務 API を連続実行する、といった組み合わせを定義追加だけで扱えます。オーケストレーションプラットフォームとして重要なのは、サービスごとに専用ロジックを増やすのではなく、workflow が「手順」を持つことです。

実際に直すなら、変更点は3つです。

- src/product/types.ts に orchestration 定義用の型を追加する
- src/product/activities/index.ts に汎用 step 実行アクティビティを追加する
- src/product/workflows/platformWorkflow.ts で orchestration 定義の有無を見て分岐する

必要なら次に、その3ファイルに入れる具体的な型定義と実行フローを、そのまま貼れるレベルで整理します。


具体案をそのまま置ける形で整理します。結論は、今の processRequestActivity は残しつつ、別で「手順定義を解釈して順次実行する activity」を追加するのが最も自然です。ワークフローは定義を読むだけにして、HTTP 実行は activity 側に閉じます。関連箇所は src/product/workflows/platformWorkflow.ts と src/product/activities/index.ts です。

まず型はこう分けるのがよいです。

PlatformRequest の payload に orchestration を追加します。中身は steps の配列です。各 step は service, method, path, headers, query, body を持ち、必要なら compensation を持たせます。これで UserService と FileStorageService のような固定ペアだけでなく、任意の組み合わせを定義できます。

step の最小構成は次です。

- service: 呼び出し先サービス名
- method: GET, POST, PUT, PATCH, DELETE
- path: パス
- headers: 任意ヘッダー
- query: クエリ
- body: リクエストボディ
- compensation: 失敗時の巻き戻し定義

worklflow 側の分岐は単純でよくて、payload に orchestration.steps があれば定義駆動で実行し、なければ従来どおり processRequestActivity を1回だけ呼びます。つまり、既存の単発処理は壊しません。

実行アクティビティは processRequestActivity とは分けて、たとえば executeOrchestrationActivity を追加します。これは steps を先頭から順に回し、各 step ごとに対象サービスへ HTTP を投げ、成功結果を履歴として保持します。途中で失敗したら、実行済み step を逆順にたどって compensation を実行します。ワークフロー自身はこの IO をしません。Temporal の deterministic 制約上、ここは activity に寄せるのが正しいです。

内部的には、サービスごとの base URL を activity 側で解決する registry を持ちます。今の processRequestActivity の handlers マップは action:resource ベースですが、新方式では service 名ベースにします。これで action に依存しない汎用オーケストレーションになります。

この構成にすると、たとえば次のような順序が定義だけで表せます。

1. UserService にユーザー作成
2. FileStorageService にファイル登録
3. 必要なら NotificationService に通知
4. 途中失敗時は作成済みリソースを逆順に削除

この方式の重要点は、オーケストレーションの本体をコードではなく定義に寄せられることです。サービスの組み合わせを増やすたびにワークフロー本体を書き換えるのではなく、step 定義を追加するだけで済みます。

次に必要なら、docs/workflow.md に追記する説明文として、以下の3点をそのまま反映できる形でまとめます。

- 型定義の草案
- platformWorkflow の分岐条件
- executeOrchestrationActivity の責務

必要なら続けて、その3点を実装メモとしてそのまま貼れる粒度で書きます。

workflow.md に追記するなら、次の形がそのまま使えます。

**追記案**
```markdown
## 定義ベースの複数サービス実行

今の processRequestActivity は単発の下流サービス呼び出しを担当する。  
複数サービスの連携はワークフロー側で orchestration 定義を読み、順番に実行する。

### リクエスト定義

PlatformRequest.payload に orchestration を追加する。

```json
{
  "orchestration": {
    "steps": [
      {
        "service": "user-service",
        "method": "POST",
        "path": "/api/users",
        "headers": {
          "Content-Type": "application/json"
        },
        "body": {
          "email": "user@example.com",
          "name": "Taro"
        },
        "compensation": {
          "service": "user-service",
          "method": "DELETE",
          "path": "/api/users/{result.id}"
        }
      },
      {
        "service": "file-storage-service",
        "method": "POST",
        "path": "/api/files",
        "body": {
          "userId": "{step0.result.id}",
          "storagePath": "/data/sample.txt"
        }
      }
    ]
  }
}
```

### step の役割

- service: 呼び出し先サービス名
- method: HTTP メソッド
- path: 呼び出し先パス
- headers: 任意ヘッダー
- query: クエリ文字列
- body: リクエスト本文
- compensation: 失敗時の巻き戻し定義

### 実行方針

- orchestration.steps がある場合は、定義に従って順番に実行する
- step の結果は次の step から参照できるようにする
- 途中で失敗したら、実行済み step を逆順に補償する
- orchestration 定義がない場合は、従来どおり processRequestActivity を1回だけ呼ぶ

### 責務分担

- ワークフロー: 実行順の制御、分岐、補償の判断
- activity: 実際の HTTP 呼び出し
- processRequestActivity: 単発処理の互換レイヤー
- executeOrchestrationActivity: 複数 step の定義駆動実行
```

この方針だと、今の単発処理を維持しながら、定義を追加するだけで任意のサービス組み合わせを実行できる基盤にできます。  
必要なら次に、この追記に合わせた types.ts と platformWorkflow.ts の具体的な型・分岐案も、そのまま貼れる形で書きます。



To Do 項目が 5 件作成されました

開始中: *types.ts にオーケストレーション型追加* (1/5)

**Step 1: types.ts に orchestration 型を追加します。** 

Replacing 9 lines with 74 lines in [](file:///c%3A/work/OrchestrationPlatformSdd/src/product/types.ts)


```

```


開始中: *orchestrationActivity.ts 新規作成* (2/5)

**Step 2: orchestrationActivity.ts を新規作成します。** 

Created [](file:///c%3A/work/OrchestrationPlatformSdd/src/product/activities/orchestrationActivity.ts)

開始中: *activities/index.ts に登録* (3/5)

**Step 3: activities/index.ts に import・登録・型定義を3箇所同時追加します。** 

Replacing 21 lines with 24 lines in [](file:///c%3A/work/OrchestrationPlatformSdd/src/product/activities/index.ts)


```

```


開始中: *platformWorkflow.ts に分岐追加* (4/5)

**Step 4: platformWorkflow.ts に `executeOrchestrationActivity` の destructure と Step 4 の分岐を追加します。**  

Replacing 20 lines with 30 lines in [](file:///c%3A/work/OrchestrationPlatformSdd/src/product/workflows/platformWorkflow.ts)


```

```
Step 5コメントは既に同じなので問題なし。変更は3件中2件反映済み。Step 5コメントと compensation 条件のみ確認します。 

Searched for text `if (request.action === 'create')` (`**/src/product/workflows/platformWorkflow.ts`), no results

Searched for text `request.action === 'create'` (`**/src/product/workflows/platformWorkflow.ts`), 1 result

compensation 条件は正しく反映済みです。では全体を確認します。 

Read [](file:///c%3A/work/OrchestrationPlatformSdd/src/product/workflows/platformWorkflow.ts#145-145), lines 145 to 230

ワークフローの変更は正しく反映されています。型チェックを実行します。  

開始中: *tsc 型チェック確認* (5/5)

Ran terminal command: cd C:\work\OrchestrationPlatformSdd ; npx tsc --noEmit 2>&1
Completed with input: cd C:\work\OrchestrationPlatformSdd ; npx tsc --noEmit 2>&1

Read [](file:///c%3A/Users/norin/AppData/Roaming/Code/User/workspaceStorage/b64ecae25ff9294bd0c32e1fef18ea13/GitHub.copilot-chat/chat-session-resources/c247974d-b474-4f66-b6b7-e0cb3b4a0fac/toolu_01Q21DS8yKUbLRkE17VCckmn__vscode-1777774473370/content.txt#1-1), lines 1 to 80

エラーは3種類あります。配列アクセスの `noUncheckedIndexedAccess` 由来の undefined、fetch の `body: undefined` 問題、`step` の undefined。まとめて修正します。  

Replacing 52 lines with 59 lines in [](file:///c%3A/work/OrchestrationPlatformSdd/src/product/activities/orchestrationActivity.ts)


```

```


Ran terminal command: npx tsc --noEmit 2>&1

型エラーゼロです。 

完了済み: *tsc 型チェック確認* (5/5)

型エラーゼロで全変更が完了しました。変更したファイルの概要は以下のとおりです。

---

### 変更ファイル一覧

| ファイル | 内容 |
|---------|------|
| types.ts | `StepCompensation`, `OrchestrationStep`, `OrchestrationDefinition`, `StepResult` の4型を追加 |
| orchestrationActivity.ts | **新規作成**。SERVICE_REGISTRY・テンプレート補間・Saga 補償・`executeOrchestrationActivity` を実装 |
| index.ts | import 追加・`createActivities` 戻り値に登録・`PlatformActivities` 型に追加 |
| platformWorkflow.ts | Step 4 に `hasOrchestration` 分岐追加・orchestration モード時の外側補償をスキップ |

---

### 使い方

新しいサービスを追加する場合は orchestrationActivity.ts の `SERVICE_REGISTRY` にエントリを1行追加するだけです。

```typescript
export const SERVICE_REGISTRY: Record<string, string> = {
  'user-service':         ...,
  'file-storage-service': ...,
  'routing-file-service': ...,
  'your-new-service':     process.env.YOUR_NEW_SERVICE_URL ?? 'http://localhost:5000', // ← 追加
};
```

呼び出し側は `PlatformRequest.payload.orchestration` に steps を定義するだけです。

```json
{
  "requestId": "...",
  "tenantId": "tenant1",
  "userId": "user1",
  "action": "create",
  "resource": "user-with-file",
  "payload": {
    "orchestration": {
      "steps": [
        {
          "service": "user-service",
          "method": "POST",
          "path": "/api/users",
          "body": { "email": "u@example.com", "name": "Taro" },
          "compensation": { "service": "user-service", "method": "DELETE", "path": "/api/users/{result.id}" }
        },
        {
          "service": "file-storage-service",
          "method": "POST",
          "path": "/api/files",
          "body": { "userId": "{step0.body.id}", "storagePath": "/data/sample.txt" }
        }
      ]
    }
  }
}
```

`orchestration` がない場合は従来どおり `processRequestActivity`（単発ディスパッチ）が呼ばれるので、既存の処理は壊れません。

変更を行いました。



現状の実装では、複数のオーケストレーション定義を置く専用ファイルはまだありません。定義の置き場所は基本的に次の2層です。

- 実行ロジック本体: orchestrationActivity.ts
- 定義の入力元: 各リクエストの types.ts に載る `PlatformRequest.payload.orchestration`

つまり、A→B、A→C、D→E、B→A→D のような複数パターンは、今の実装では「1つの共通 activity に対して、ワークフローごとに異なる `payload.orchestration.steps` を渡す」形です。  
定義を分けて管理する場所は、まだコード上ではなく「リクエストごとの入力データ」です。

実際の役割分担はこうです。

- platformWorkflow.ts: `payload.orchestration` があれば定義駆動で実行する分岐
- orchestrationActivity.ts: steps を順番に実行し、補償まで行う共通実行器
- types.ts: `OrchestrationDefinition` や `OrchestrationStep` の型定義

なので、今の段階では「オーケストレーション定義を複数置くファイル」は存在せず、**各ワークフローのリクエスト定義の中に複数パターンを持たせる**設計です。

もし運用上、A→B / A→C / D→E / B→A→D をコードとして一覧管理したいなら、次のどちらかを追加するのが自然です。

1. src/product/orchestrations/ のような定義カタログ
2. workflow.md にサンプル定義集を置く

必要なら次に、今の実装に合わせて「複数オーケストレーション定義をカタログ化する追加ファイル構成」を具体的に提案します。


複数オーケストレーションをコードとして管理するなら、今の実装では専用の定義カタログを追加するのが自然です。配置先は、たとえば次の構成です。

- `src/product/orchestrations/`
- `src/product/orchestrations/catalog.ts`
- `src/product/orchestrations/fileUploadAndMail.ts`
- `src/product/orchestrations/userCreateFlow.ts`
- `src/product/orchestrations/relationSyncFlow.ts`

役割はこう分けます。

- `catalog.ts`
  - どのオーケストレーションIDにどの steps 定義を割り当てるかを集約
- 個別ファイル
  - A→B、A→C、D→E、B→A→D のような具体的な手順定義を保持
- platformWorkflow.ts
  - リクエストの `orchestrationId` を見て、catalog から該当定義を取得して実行
- `orchestrationActivity.ts`
  - 定義された steps を順次実行し、補償も行う共通エンジン

たとえば、リクエスト側はこうなります。

```json
{
  "payload": {
    "orchestrationId": "file-upload-and-mail"
  }
}
```

そして `catalog.ts` では、こういう対応を持たせます。

- `file-upload-and-mail` → `fileUploadAndMail`
- `user-create-flow` → `userCreateFlow`
- `relation-sync-flow` → `relationSyncFlow`

この形にすると、  
「定義を増やす」作業と「実行エンジンを保つ」作業を分離できます。  
つまり、オーケストレーションの追加は新しいファイルを1つ増やすだけで済み、ワークフロー本体はほとんど変えずに運用できます。

必要なら次に、この構成をそのまま実装するための `catalog.ts` とサンプル定義ファイルを作る形で進めます。


定義カタログを実装する前に、今のリクエスト型とワークフローの分岐点を確認して、最小変更でつなげます。


複数定義をコードで持てるように、定義ファイル群とカタログ解決を追加します。まずは既存の汎用 activity を活かしたまま、Workflow が `orchestrationId` で定義を選べるようにします。


定義カタログと個別フローを追加し、ワークフローが ID で引けるようにします。次で実行時の分岐までつなぎます。


実行時に `orchestrationId` を解決するため、ワークフローとサービスレジストリをつなぎます。これで定義カタログと実行エンジンが一体になります。


パッチ形式の問題だけ直して再適用します。ワークフローは catalog 解決と embedded 定義の両方に対応させます。

カタログの接続点まで入れたので、型チェックで崩れていないか確認します。もし問題が出れば、その場で catalog の受け取り方を整えます。


実装は通っています。最後に定義群を束ねる index.ts を置いて、カタログを扱いやすくしておきます。


実装しました。複数オーケストレーションを定義ファイルで管理し、`orchestrationId` で切り替えられる形にしています。

追加した主なファイルは次のとおりです。

- catalog.ts
- fileUploadAndMail.ts
- userCreateFlow.ts
- relationSyncFlow.ts
- index.ts

あわせて、実行側もつないでいます。

- platformWorkflow.ts で `payload.orchestrationId` を見て catalog から定義を解決
- orchestrationActivity.ts に `mail-service` を追加
- 既存の `payload.orchestration` 直書きにも対応したままなので、後方互換は維持しています

`npx tsc --noEmit` は最後まで通っています。

使い方は、たとえばこうです。

```json
{
  "payload": {
    "orchestrationId": "file-upload-and-mail"
  }
}
```

これで `catalog.ts` に登録された定義を使って、複数マイクロサービスを順番に実行できます。

必要なら次に、workflow.md にこの `orchestrationId` ベースの運用例を追記します。

変更を行いました。


## Workflow追加方法

E→A→D を追加するなら、今の構成では最小で次のファイル対応になります。

- src/product/orchestrations/eadFlow.ts
  - E→A→D の `OrchestrationDefinition` を置く新規ファイルです
- catalog.ts
  - `OrchestrationId` に `ead-flow` のような ID を追加し、`ORCHESTRATION_CATALOG` に登録します
- index.ts
  - 外部から使えるように新しい定義を export します

追加で必要になるのは、サービスが未登録な場合だけです。

- orchestrationActivity.ts
  - E / A / D がまだ `SERVICE_REGISTRY` にないサービス名なら、ベース URL を追加します

つまり、**新しい Workflow ファイルを増やすのではなく、オーケストレーション定義ファイルを1つ追加して catalog に登録する**、という形です。  
ワークフロー本体は既存の platformWorkflow.ts のままで、`payload.orchestrationId` に `ead-flow` を渡せば動きます。

必要なら次に、E→A→D 用の `eadFlow.ts` のひな形をそのまま書けます。