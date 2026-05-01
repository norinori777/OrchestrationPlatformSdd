@echo off
setlocal EnableExtensions

set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"
pushd "%ROOT%"

set "COMPOSE_CMD=docker compose"
where docker-compose >nul 2>nul
if %errorlevel%==0 set "COMPOSE_CMD=docker-compose"

if /i "%~1"=="--dry-run" goto :dry_run

echo Starting infrastructure containers...
%COMPOSE_CMD% -f "%ROOT%\docker-compose.yaml" up -d
if errorlevel 1 goto :error

call :wait_for_opa || goto :error

echo Starting orchestration platform...
start "Orchestration Platform" cmd /k "cd /d ""%ROOT%"" && npx ts-node src/product/index.ts"

echo Starting SaaS backend...
start "SaaS Backend" cmd /k "cd /d ""%ROOT%\src\Saas\backend"" && npm run dev"

echo Starting SaaS frontend...
start "SaaS Frontend" cmd /k "cd /d ""%ROOT%\src\Saas\frontend"" && npm run dev"

echo Starting user microservice...
start "User Service" cmd /k "cd /d ""%ROOT%\src\MicroService\UserService"" && npm run dev"

echo Starting file storage microservice...
start "File Storage Service" cmd /k "cd /d ""%ROOT%\src\MicroService\FileStorageService"" && npm run dev"

echo.
echo All components were launched in separate windows.
echo Close each window when you want to stop the corresponding process.
popd
exit /b 0

:dry_run
echo Dry run: the following commands would be executed.
echo %COMPOSE_CMD% -f "%ROOT%\docker-compose.yaml" up -d
echo call :wait_for_opa
echo npx ts-node src/product/policies/loadPolicy.ts
echo start "Orchestration Platform" cmd /k "cd /d ""%ROOT%"" ^&^& npx ts-node src/product/index.ts"
echo start "SaaS Backend" cmd /k "cd /d ""%ROOT%\src\Saas\backend"" ^&^& npm run dev"
echo start "SaaS Frontend" cmd /k "cd /d ""%ROOT%\src\Saas\frontend"" ^&^& npm run dev"
echo start "User Service" cmd /k "cd /d ""%ROOT%\src\MicroService\UserService"" ^&^& npm run dev"
echo start "File Storage Service" cmd /k "cd /d ""%ROOT%\src\MicroService\FileStorageService"" ^&^& npm run dev"
popd
exit /b 0

:wait_for_opa
echo Waiting for OPA to become ready...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; for ($i = 0; $i -lt 60; $i++) { try { $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:8181/health' -TimeoutSec 2; if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { exit 0 } } catch { Start-Sleep -Seconds 2 } }; exit 1"
if errorlevel 1 exit /b 1
exit /b 0

echo Loading platform policy into OPA...
npx ts-node src/product/policies/loadPolicy.ts
if errorlevel 1 goto :error

:error
echo Failed to start the infrastructure containers.
popd
exit /b 1

