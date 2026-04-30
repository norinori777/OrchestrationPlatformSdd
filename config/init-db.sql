-- オーケストレーションプラットフォーム用 DB・ユーザー・スキーマの初期化
-- docker-compose の postgres サービスが /docker-entrypoint-initdb.d/ を自動実行します

-- アプリケーション用ユーザー作成
CREATE USER appuser WITH PASSWORD 'apppassword';

-- アプリケーション用データベース作成
CREATE DATABASE appdb OWNER appuser;

-- appdb に接続してスキーマを作成
\connect appdb

CREATE SCHEMA IF NOT EXISTS saas      AUTHORIZATION appuser;
CREATE SCHEMA IF NOT EXISTS platform  AUTHORIZATION appuser;
CREATE SCHEMA IF NOT EXISTS users     AUTHORIZATION appuser;
CREATE SCHEMA IF NOT EXISTS files     AUTHORIZATION appuser;

GRANT ALL PRIVILEGES ON SCHEMA saas     TO appuser;
GRANT ALL PRIVILEGES ON SCHEMA platform TO appuser;
GRANT ALL PRIVILEGES ON SCHEMA users    TO appuser;
GRANT ALL PRIVILEGES ON SCHEMA files    TO appuser;
