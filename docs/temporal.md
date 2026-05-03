# temporal

## proxyActivities

Temporal.io における proxyActivities（または proxy_activities）は、ワークフロー（Workflow）内からアクティビティ（Activity）を呼び出すための「窓口」を作成する機能です。
通常、アクティビティはワークフローとは別のワーカー（Worker）で実行されますが、ワークフローコードからそれらを型安全に、かつ直感的に呼び出せるようにするために使用されます。

### 主な役割と特徴

   1. 型安全な呼び出し (Type Safety):
   TypeScript SDKの場合、proxyActivities を通じてアクティビティを定義することで、エディタ上での自動補完が効くようになり、引数の型や戻り値の型をコンパイル時にチェックできます。
   2. 実行設定の紐付け:
   アクティビティを呼び出す際の「タイムアウト設定」や「リトライポリシー」などを、このプロキシを生成するタイミング（または呼び出し時）に指定します。

### コード例 (TypeScript SDK)

ワークフロー定義の中で、以下のように記述するのが一般的です。

```
import { proxyActivities } from '@temporalio/workflow';
import type * as activities from './activities'; // 型情報のみインポート

// 1. アクティビティのプロキシを作成
const { greet } = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute', // タイムアウト設定
  retry: {
    maximumAttempts: 3, // リトライ回数などのポリシー
  },
});

// 2. ワークフロー内で呼び出す
export async function myWorkflow(name: string): Promise<string> {
  return await greet(name); // 普通の関数のように呼べるが、実際にはTemporalが管理実行する
}
```

### 重要なポイント

* 「実行」ではなく「予約」: proxyActivities 自体が何かを実行するわけではありません。あくまで「この設定でこのアクティビティを呼ぶための関数」を生成するだけです。
* シリアライズ: プロキシ経由でアクティビティに渡される引数や戻り値は、Temporalによって内部でJSON等にシリアライズされ、ネットワーク越しにワーカーへ送られます。そのため、関数や複雑なクラスインスタンスをそのまま渡すことはできません。
* 副作用の分離: ワークフローコードは「決定的（Deterministic）」である必要があります（時刻取得やランダム数値生成がNG）。そのため、DB操作やAPI呼び出しなどの副作用を伴う処理は、必ずこのプロキシ経由でアクティビティとして実行させます。

この設定（タイムアウトやリトライ）の具体的なチューニング方法や、アクティビティ側の実装方法について詳しく知りたい部分はありますか？

## ProxyOptions

proxyActivities の引数である ActivityOptions は、アクティビティを実行する際の「制限時間（タイムアウト）」や「失敗時のリトライルール」などを細かく制御するための設定項目です。
主要なプロパティを役割別に解説します。

### 1. タイムアウト設定 (Timeouts)

Temporalでは、不測の事態（ワーカーのクラッシュなど）を検知するためにタイムアウトが必須です。startToCloseTimeout または scheduleToCloseTimeout のいずれか一方は必須となります。 [1, 2, 3, 4] 

* startToCloseTimeout (推奨): 1回の試行にかけられる最大時間です。ワーカーがアクティビティを開始してから、結果を返すまでの制限時間です。
* scheduleToCloseTimeout: リトライを含めた全体の制限時間です。
* heartbeatTimeout: 長時間実行されるアクティビティが、生存確認（Heartbeat）を送るべき間隔です。この時間を過ぎても更新がない場合、ワーカーが死んだとみなされリトライされます。 [1, 2, 3, 4, 5] 

### 2. リトライポリシー (RetryPolicy)

アクティビティがエラーで失敗した際、どのように再試行するかを定義します。 [6] 

* initialInterval: 最初の失敗から1回目のリトライまでの待ち時間。
* backoffCoefficient: 待ち時間をどれくらいの倍率で増やしていくか（デフォルトは 2.0）。
* maximumAttempts: 最大リトライ回数。無制限にする場合は 0 または未指定にします。
* nonRetryableErrorTypes: 特定のエラー（例：ビジネスロジック上の致命的なミス）が発生した場合に、リトライさせずに即座に失敗させたいエラー名を指定します。

### 3. その他の重要な設定

* taskQueue: 特定のアクティビティを、デフォルトとは別のタスクキュー（別のワーカーグループ）で実行したい場合に指定します。
* activityId: アクティビティに固有のIDを付与します。通常はシステムが自動生成するため、特別な理由がない限り指定しません。
* cancellationType: ワークフローがキャンセルされた際、実行中のアクティビティをどのように扱うか（即時中断か、最後まで待つか等）を指定します。 [5, 7, 8, 9, 10] 

### 設定の使い分け（例）

const { processPayment } = proxyActivities<typeof activities>({
  // 30秒以内に終わらなければ、ワーカーがハングしたとみなしてリトライ
  startToCloseTimeout: '30 seconds', 
  
  retry: {
    initialInterval: '1 second',
    maximumAttempts: 5, // 最大5回まで挑戦
    // 支払い拒否（残高不足など）はリトライしても無意味なので除外
    nonRetryableErrorTypes: ['InsufficientFundsError'],
  },
});

最適なタイムアウト設定は、そのアクティビティが「数秒で終わる短い処理」か、あるいは「数時間かかる長い処理」かによって戦略が大きく異なります。
[Temporal公式](https://temporal.io/blog/activity-timeouts)や[コミュニティの議論](https://community.temporal.io/t/activity-timeout-questions/924)を参考に、2つの代表的なシナリオに基づいた決め方を解説します。

### 1. 短時間で終わる処理（API連携、DB操作など）

数秒〜数分で完了する処理では、「ワーカーのクラッシュ」を素早く検知することを最優先します。

* startToCloseTimeout:
* 決め方: 「正常な実行時間の最大値」に少し余裕を持たせた値に設定します。
   * 理由: この時間を過ぎるとTemporalは「実行中のワーカーが死んだ」と判断してリトライを開始します。 
* retry (RetryPolicy):
* initialInterval: 1s など短めに設定し、一時的なネットワークエラーに備えます。
   * maximumAttempts: 原則として指定しない（無制限）ことが推奨されます。ビジネスエラーでない限り、成功するまでリトライし続けるのがTemporalの設計思想です。 

### 2. 長時間かかる処理（バッチ処理、機械学習の学習など）

数十分〜数時間かかる処理では、単純に長いタイムアウトを設定すると、ワーカーが開始直後にクラッシュした場合に「タイムアウトを待つまで数時間リトライされない」という問題が起きます。これを避けるために Heartbeat（生存確認） を活用します。 

* heartbeatTimeout:
* 決め方: 30s や 1m など、短めに設定します。
   * 必須作業: アクティビティの実装コード内で、定期的に heartbeat() を呼び出す必要があります。 
* startToCloseTimeout:
* 決め方: 処理が終わるまでにかかる「最長の時間（例：3時間）」を設定します。
   * 効果: もしワーカーがクラッシュしても、heartbeatTimeout で設定した時間（例：30秒）以内に異常を検知し、すぐに別のワーカーで再試行できます。 

### 設定値のクイックリファレンス

| 項目 | 目的 | 設定のコツ |
|---|---|---|
| startToCloseTimeout | 1回の試行の制限時間 | 想定される最大実行時間より長く設定する。 |
| scheduleToCloseTimeout | リトライ含めた全行程の制限時間 | 「1日経っても終わらなければ諦める」といった、ビジネス上のデッドラインを指定する。 |
| heartbeatTimeout | 生存確認の間隔 | 長時間処理で必須。短く設定し、失敗を即座に検知する。 |
| scheduleToStartTimeout | キューでの待ち時間 | 通常は指定不要（空にすると無制限）。タスクキューの滞留を検知したい特殊な場合のみ使用。 |

### 注意点：Workflow全体のタイムアウト

[コミュニティでの事例](https://community.temporal.io/t/activity-scheduletoclosetimeout-capped-by-workflowtasktimeout-how-to-choose-correct-timeout-for-polling-activities/18723)では、アクティビティに長いタイムアウトを設定しても、呼び出し元のWorkflow自体のタイムアウトが短いと、そこで処理が打ち切られてしまうことがあります。長時間アクティビティを扱う際は、Workflow側の設定も見直してください。 
現在開発されているアクティビティは、「外部APIの呼び出し」と「重いデータ処理」のどちらに近いでしょうか？それに応じてさらに具体的なリトライポリシーを提案できます。

