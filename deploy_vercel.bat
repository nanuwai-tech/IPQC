@echo off
if "%VERCEL_TOKEN%"=="" (
    for /f "tokens=1,2 delims==" %%A in (.env) do (
        if "%%A"=="VERCEL_TOKEN" set VERCEL_TOKEN=%%B
    )
)
if "%VERCEL_TOKEN%"=="" (
    echo Error: VERCEL_TOKEN environment variable is not set.
    exit /b 1
)
call npx vercel --prod --yes --token=%VERCEL_TOKEN%
