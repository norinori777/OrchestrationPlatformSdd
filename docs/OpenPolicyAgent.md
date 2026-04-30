
- 名前空間の対応：`package example.authz` は OPA のモジュール名前空間で、内部的には `data.example.authz` というデータツリーになります。ドット（.）はネストしたオブジェクト階層を表します。  
- ルール→エンドポイント：`allow` というルールを定義すると、その評価結果は `data.example.authz.allow` に現れます。これを HTTP API で参照するパスが `/v1/data/example/authz/allow` です。  
- リクエスト/レスポンス形式：入力は POST の JSON ボディで `{"input": ...}` を渡します。返り値は JSON で `{"result": <ruleの値>}` になります。例：  
  - ポリシーがブール値を返す場合、`{"result": true}` または `{"result": false}`。  
  - ルールがオブジェクトや集合を返す場合はそのまま JSON 型で返ります。  
- 例（今回のポリシー）：`package example.authz` と `allow if { input.user == "alice"; input.action == "read" }` の組合せだと、`/v1/data/example/authz/allow` に対して `{"input":{"user":"alice","action":"read"}}` を送ると `{"result":true}` が返ります。  
- 補足：  
  - `/v1/data/example/authz` を叩くと該当パッケージ配下の全データ（例：`{"result":{"allow":true,...}}`）が返ります。  
  - 入力が不要なら GET でも問い合わせ可能（ただしボディ無し）。  
  - 複数ルールや複雑な値を返す場合は、返る JSON の構造がそのままクライアントの取り扱い対象になります。

