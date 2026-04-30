# ─────────────────────────────────────────────────────────────────────────────
# プラットフォーム認可ポリシー (OPA Rego)
# パッケージ: platform.authz
#
# アクセス制御モデル:
#   - スーパー管理者 (super-admin ロール) はすべての操作を許可
#   - テナントごとの RBAC: ユーザー → ロール → パーミッション (action × resource)
#   - パーミッションが未設定のリクエストはデフォルト deny
#
# OPA データ構造 (data.platform):
#   users:   { [userId]: { roles: string[], tenants: string[] } }
#   tenants: { [tenantId]: { users: { [userId]: { roles: string[] } } } }
#   roles:   { [roleName]: { permissions: [{ action, resource }] } }
# ─────────────────────────────────────────────────────────────────────────────
package platform.authz

import rego.v1

# デフォルト拒否
default allow := false

# ── ルール 1: スーパー管理者は全操作を許可 ────────────────────────────────
allow if {
    "super-admin" in data.platform.users[input.userId].roles
}

# ── ルール 2: テナント RBAC ────────────────────────────────────────────────
allow if {
    # ユーザーがこのテナントに所属しているか確認
    input.tenantId in data.platform.users[input.userId].tenants

    # テナント内でのユーザーロールを取得
    some role in data.platform.tenants[input.tenantId].users[input.userId].roles

    # ロールのパーミッションを確認
    some permission in data.platform.roles[role].permissions
    permission.action   == input.action
    permission.resource == input.resource
}

# ── ルール 3: 読み取り専用ユーザー ────────────────────────────────────────
allow if {
    input.action == "read"
    input.tenantId in data.platform.users[input.userId].tenants
    tenant := data.platform.tenants[input.tenantId]
    input.userId in tenant.readonly_users
}
