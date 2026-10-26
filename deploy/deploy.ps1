# 部署 dsh-music-companion 到服务器
#
#   $env:DSH_SERVER_PASSWORD = '你的 root 密码'
#   .\deploy\deploy.ps1
#
# 做四件事：传代码 → 跑安装脚本 → 取 token → 从公网验证 8787。

param(
    [string]$Server   = '103.40.14.172',
    [int]   $Port     = 57168,
    [string]$User     = 'root',
    [string]$Password = $env:DSH_SERVER_PASSWORD
)

$ErrorActionPreference = 'Stop'

if (-not $Password) {
    throw '请先设置 $env:DSH_SERVER_PASSWORD'
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$target   = "$User@$Server"

# --- 免交互 SSH -----------------------------------------------------------
$askpass = Join-Path $env:TEMP '_dsh_askpass.bat'
"@echo off`r`necho $Password" | Set-Content -Path $askpass -Encoding ascii
$env:SSH_ASKPASS        = $askpass
$env:SSH_ASKPASS_REQUIRE = 'force'
$env:DISPLAY            = 'localhost'

$knownHosts = Join-Path $env:TEMP '_dsh_kh_rainyun'
$sshOpts = @('-o', "UserKnownHostsFile=$knownHosts", '-o', 'StrictHostKeyChecking=no', '-p', "$Port")
$scpOpts = @('-o', "UserKnownHostsFile=$knownHosts", '-o', 'StrictHostKeyChecking=no', '-P', "$Port")

function Invoke-Remote([string]$cmd) {
    & ssh @sshOpts $target $cmd
    if ($LASTEXITCODE -ne 0) { throw "远程命令失败（exit $LASTEXITCODE）：$cmd" }
}

# --- 1. 建目录 ------------------------------------------------------------
Write-Host '==> 1/4 建目录'
Invoke-Remote 'mkdir -p /opt/music-companion/packages/music-hub/src /opt/music-companion/packages/mcp-music/src /opt/music-companion/deploy'

# --- 2. 传文件 ------------------------------------------------------------
Write-Host '==> 2/4 传文件'
$files = @(
    @{ Local = 'packages/music-hub/src/hub.mjs';            Remote = 'packages/music-hub/src/hub.mjs' },
    @{ Local = 'packages/music-hub/package.json';           Remote = 'packages/music-hub/package.json' },
    @{ Local = 'packages/mcp-music/src/server.mjs';         Remote = 'packages/mcp-music/src/server.mjs' },
    @{ Local = 'packages/mcp-music/package.json';           Remote = 'packages/mcp-music/package.json' },
    @{ Local = 'deploy/install-server.sh';                  Remote = 'deploy/install-server.sh' }
)

foreach ($f in $files) {
    $localPath = Join-Path $repoRoot $f.Local
    & scp @scpOpts $localPath "${target}:/opt/music-companion/$($f.Remote)"
    if ($LASTEXITCODE -ne 0) { throw "scp 失败：$($f.Local)" }
    Write-Host "    $($f.Local)"
}

# --- 3. 安装 --------------------------------------------------------------
Write-Host '==> 3/4 安装与启动'
Invoke-Remote 'bash /opt/music-companion/deploy/install-server.sh'

# --- 4. 验证 --------------------------------------------------------------
Write-Host ''
Write-Host '==> 4/4 验证'
$token = (& ssh @sshOpts $target 'cat /opt/music-companion/hub-token').Trim()
Write-Host "    token: $token"

$healthUrl = "http://${Server}:8787/health"
try {
    $r = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 10
    Write-Host "    公网 health: $($r | ConvertTo-Json -Compress)"
} catch {
    Write-Host "    公网 health 失败：$($_.Exception.Message)"
    Write-Host '    如果你还没在雨云面板把 8787 映射出去，这一步失败是正常的。'
}

Write-Host ''
Write-Host '完成。把下面两个值填到桌面端 watcher：'
Write-Host "    MUSIC_HUB_URL   = http://${Server}:8787"
Write-Host "    MUSIC_HUB_TOKEN = $token"
