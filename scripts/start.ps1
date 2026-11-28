#requires -version 5
<#
  K线复盘 启动器
  用法:  powershell -ExecutionPolicy Bypass -File scripts\start.ps1 [-Port 8766] [-NoOpen]
#>
param(
  [int]$Port = 8766,
  [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

# 控制台按 UTF-8 输出，避免中文乱码
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

function Test-Server([int]$p) {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$p/api/health" -UseBasicParsing -TimeoutSec 2
    return ($r.StatusCode -eq 200)
  } catch {
    return $false
  }
}

function Test-PortBusy([int]$p) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $client.Connect('127.0.0.1', $p)
    return $true
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

if ($Port -lt 1 -or $Port -gt 65535) {
  Write-Host "  [x] 端口无效: $Port" -ForegroundColor Red
  exit 2
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

if (Test-PortBusy $Port) {
  Write-Host ''
  Write-Host "  [x] 端口 $Port 已被其他程序占用" -ForegroundColor Red
  Write-Host "      换一个端口重试: powershell -ExecutionPolicy Bypass -File scripts\start.ps1 -Port 9000" -ForegroundColor DarkGray
  exit 1
}

# ---------------------------------------------------------------- 找二进制 / 编译
$NeedBuild = $false
if ($env:KLINE_BIN) {
  $Bin = $env:KLINE_BIN
  if (-not (Test-Path -LiteralPath $Bin)) {
    Write-Host ''
    Write-Host "  [x] KLINE_BIN 指向的文件不存在: $Bin" -ForegroundColor Red
    exit 1
  }
} else {
  $Bin = Join-Path $Root 'server\target\release\kline-replay.exe'
  if (-not (Test-Path -LiteralPath $Bin)) {
    $NeedBuild = $true
  } else {
    $cargo = Get-Command cargo -ErrorAction SilentlyContinue
    if ($cargo) {
      $binTime = (Get-Item -LiteralPath $Bin).LastWriteTimeUtc
      $sources = @()
      $srcDir = Join-Path $Root 'server\src'
      if (Test-Path -LiteralPath $srcDir) {
        $sources += Get-ChildItem -LiteralPath $srcDir -Recurse -File -Filter *.rs
      }
      foreach ($rel in @('server\Cargo.toml', 'server\Cargo.lock')) {
        $candidate = Join-Path $Root $rel
        if (Test-Path -LiteralPath $candidate) { $sources += Get-Item -LiteralPath $candidate }
      }
      if ($sources | Where-Object { $_.LastWriteTimeUtc -gt $binTime } | Select-Object -First 1) {
        $NeedBuild = $true
      }
    }
  }
}

if ($NeedBuild) {
  $cargoCmd = Get-Command cargo -ErrorAction SilentlyContinue
  if (-not $cargoCmd) {
    Write-Host ''
    Write-Host '  [x] 找不到服务端二进制，也没有找到 cargo' -ForegroundColor Red
    Write-Host '      需要先安装 Rust: https://rustup.rs' -ForegroundColor Yellow
    Write-Host '      安装后重新运行本脚本，会自动编译。' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '  按回车关闭...' -ForegroundColor DarkGray
    [void](Read-Host)
    exit 1
  }
  Write-Host ''
  Write-Host '  正在编译 Rust 服务端（首次约 1-3 分钟，之后秒开）...' -ForegroundColor DarkGray
  $manifest = Join-Path $Root 'server\Cargo.toml'
  & $cargoCmd.Source build --release --locked --manifest-path $manifest
  if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Write-Host '  [x] Rust 服务端编译失败' -ForegroundColor Red
    Write-Host '      请检查 cargo 是否可用、网络能否访问 crates.io，或先手动执行:' -ForegroundColor Yellow
    Write-Host '      cargo build --release --locked --manifest-path server\Cargo.toml' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '  按回车关闭...' -ForegroundColor DarkGray
    [void](Read-Host)
    exit 1
  }
}

if (-not (Test-Path -LiteralPath $Bin)) {
  Write-Host ''
  Write-Host "  [x] 没有找到可执行的服务端: $Bin" -ForegroundColor Red
  exit 1
}

$defaultHist = 'C:\Program Files (x86)\MetaTrader 4\history'
$repoHist = Join-Path $Root 'data\history'
$hist = if ($env:MT4_HISTORY) {
  $env:MT4_HISTORY
} elseif (Test-Path -LiteralPath $defaultHist) {
  $defaultHist
} elseif (Test-Path -LiteralPath $repoHist) {
  "$repoHist  (仓库自带样例)"
} else {
  $defaultHist
}

Write-Host ''
Write-Host "  服务端 : $Bin" -ForegroundColor DarkGray
Write-Host "  数据   : $hist" -ForegroundColor DarkGray
Write-Host "  访问   : http://127.0.0.1:$Port/" -ForegroundColor Cyan
Write-Host '  停止   : Ctrl+C  (或直接关闭此窗口)' -ForegroundColor DarkGray
Write-Host ''

# ---------------------------------------------------------------- 启动
$serverArgs = @('--port', "$Port")
if (-not $NoOpen) { $serverArgs += '--open' }

try {
  & $Bin @serverArgs
} catch {
  Write-Host ''
  Write-Host "  [x] 启动失败: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host ''
  Write-Host '  按回车关闭...' -ForegroundColor DarkGray
  [void](Read-Host)
  exit 1
}

exit 0
