#!/bin/bash
set -euo pipefail

KC_SERVER="http://keycloak:8080"
KC_REALM="orchestration"
KC_USER="admin"
KC_PASSWORD="admin"
CLIENT_FILE="/opt/keycloak/data/import/temporal-ui-client.json"

echo "Waiting for Keycloak admin API..."
until /opt/keycloak/bin/kcadm.sh config credentials --server "$KC_SERVER" --realm master --user "$KC_USER" --password "$KC_PASSWORD" >/dev/null 2>&1; do
  sleep 2
done

if ! /opt/keycloak/bin/kcadm.sh get realms/"$KC_REALM" >/dev/null 2>&1; then
  /opt/keycloak/bin/kcadm.sh create realms -s realm="$KC_REALM" -s enabled=true
fi

if ! /opt/keycloak/bin/kcadm.sh get clients -r "$KC_REALM" -q clientId=temporal-ui | grep -q '"clientId"[[:space:]]*:[[:space:]]*"temporal-ui"'; then
  /opt/keycloak/bin/kcadm.sh create clients -r "$KC_REALM" -f "$CLIENT_FILE"
fi

if ! /opt/keycloak/bin/kcadm.sh get users -r "$KC_REALM" -q username=temporal-user | grep -q '"username"[[:space:]]*:[[:space:]]*"temporal-user"'; then
  /opt/keycloak/bin/kcadm.sh create users -r "$KC_REALM" -s username=temporal-user -s enabled=true
fi

/opt/keycloak/bin/kcadm.sh set-password -r "$KC_REALM" --username temporal-user --new-password temporal-user --temporary=false

echo "Keycloak realm bootstrap completed."