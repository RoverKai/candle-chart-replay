#requires -version 5
<#
  K线复盘 启动器
  用法:  powershell -ExecutionPolicy Bypass -File start.ps1 [-Port 8766] [-NoOpen]
#>
param(
  [int]$Port = 8766,
  [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

# 控制台按 UTF-8 输出，避免中文乱码
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $env:PYTHONIOENCODING = 'utf-8'
  $env:PYTHONUTF8 = '1'
} catch { }

function Test-Server([int]$p) {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$p/api/health" -UseBasicParsing -TimeoutSec 2
    return ($r.StatusCode -eq 200)
  } catch {
    return $false
  }
}

Write-Host ''
Write-Host '  ==================================================' -ForegroundColor DarkGray
Write-Host '   K线复盘 · MT4  ->  TradingView 风格图表' -ForegroundColor White
Write-Host '  ==================================================' -ForegroundColor DarkGray

# ---------------------------------------------------------------- 已经在跑
if (Test-Server $Port) {
  Write-Host ''
  Write-Host "  服务已经在运行: http://127.0.0.1:$Port/" -ForegroundColor Green
  Write-Host '  直接使用即可，不需要重复启动。' -ForegroundColor DarkGray
  if (-not $NoOpen) { Start-Process "http://127.0.0.1:$Port/" }
  Start-Sleep -Seconds 1
  exit 0
}

# ---------------------------------------------------------------- 找 Python
$candidates = @()

$py = Get-Command py -ErrorAction SilentlyContinue
if ($py) { $candidates += , @($py.Source, '-3') }

foreach ($name in @('python', 'python3')) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { $candidates += , @($cmd.Source) }
}

$common = @(
  "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe",
  "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
  "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe",
  "$env:LOCALAPPDATA\Programs\Python\Python310\python.exe",
  "$env:LOCALAPPDATA\Programs\Python\Python39\python.exe",
  'C:\Python313\python.exe',
  'C:\Python312\python.exe',
  'C:\Python311\python.exe',
  'D:\Conda\python.exe',
  'C:\Conda\python.exe',
  'C:\ProgramData\Anaconda3\python.exe',
  'C:\ProgramData\miniconda3\python.exe',
  "$env:USERPROFILE\anaconda3\python.exe",
  "$env:USERPROFILE\miniconda3\python.exe"
)
foreach ($p in $common) {
  if (Test-Path -LiteralPath $p) { $candidates += , @($p) }
}

$python = $null
$rejected = @()

foreach ($cand in $candidates) {
  $exe = $cand[0]
  $pre = @($cand | Select-Object -Skip 1)

  # 跳过 Microsoft Store 的 0 字节占位程序 (WindowsApps\python.exe)
  if ($exe -like '*\WindowsApps\*') {
    $rejected += "$exe  (应用商店占位程序)"
    continue
  }

  try {
    $probe = & $exe @pre '-c' 'import sys;print(sys.version.split()[0])' 2>$null
    if ($LASTEXITCODE -eq 0 -and $probe) {
      $python = @{ Exe = $exe; Pre = $pre; Version = ($probe | Select-Object -First 1) }
      break
    }
  } catch { }
  $rejected += "$exe  (无法运行)"
}

if (-not $python) {
  Write-Host ''
  Write-Host '  [x] 没有找到可用的 Python 3' -ForegroundColor Red
  if ($rejected.Count) {
    Write-Host '      已排除:' -ForegroundColor DarkGray
    $rejected | ForEach-Object { Write-Host "        - $_" -ForegroundColor DarkGray }
  }
  Write-Host ''
  Write-Host '  解决办法:' -ForegroundColor Yellow
  Write-Host '    1) 安装 Python 3.9+ (python.org)，安装时勾选 "Add python.exe to PATH"'
  Write-Host '    2) 或者告诉我 Python 的完整路径，我改一下 start.ps1'
  Write-Host ''
  Write-Host '  按回车关闭...' -ForegroundColor DarkGray
  [void](Read-Host)
  exit 1
}

Write-Host ''
Write-Host "  Python : $($python.Version)   $($python.Exe)" -ForegroundColor DarkGray
$hist = if ($env:MT4_HISTORY) { $env:MT4_HISTORY } else { 'C:\Program Files (x86)\MetaTrader 4\history' }
Write-Host "  数据   : $hist" -ForegroundColor DarkGray
Write-Host "  访问   : http://127.0.0.1:$Port/" -ForegroundColor Cyan
Write-Host '  停止   : Ctrl+C  (或直接关闭此窗口)' -ForegroundColor DarkGray
Write-Host ''

# ---------------------------------------------------------------- 启动
$pyArgs = @()
$pyArgs += $python.Pre
$pyArgs += (Join-Path $Root 'server\app.py')
$pyArgs += @('--port', "$Port")
if (-not $NoOpen) { $pyArgs += '--open' }

try {
  & $python.Exe @pyArgs
} catch {
  Write-Host ''
  Write-Host "  [x] 启动失败: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host ''
  Write-Host '  按回车关闭...' -ForegroundColor DarkGray
  [void](Read-Host)
  exit 1
}

exit 0
