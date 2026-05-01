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
echo start "Orchestration Platform" cmd /k "cd /d ""%ROOT%"" ^&^& npx ts-node src/product/index.ts"
echo start "SaaS Backend" cmd /k "cd /d ""%ROOT%\src\Saas\backend"" ^&^& npm run dev"
echo start "SaaS Frontend" cmd /k "cd /d ""%ROOT%\src\Saas\frontend"" ^&^& npm run dev"
echo start "User Service" cmd /k "cd /d ""%ROOT%\src\MicroService\UserService"" ^&^& npm run dev"
echo start "File Storage Service" cmd /k "cd /d ""%ROOT%\src\MicroService\FileStorageService"" ^&^& npm run dev"
popd
exit /b 0

:error
echo Failed to start the infrastructure containers.
popd
exit /b 1