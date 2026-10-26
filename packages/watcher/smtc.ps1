# smtc.ps1 - read the Windows System Media Transport Controls session.
#
# Output: one line of JSON, e.g.
#   {"found":true,"app":"cloudmusic.exe","title":"...","artist":"...","album":"","status":"Playing"}
#   {"found":false}
#
# IMPORTANT: keep this file pure ASCII (no CJK in comments). PowerShell 5.1
# reads BOM-less files as ANSI, and non-ASCII bytes break parsing.

$ErrorActionPreference = 'Stop'

# Node reads our stdout as UTF-8. Windows PowerShell defaults to the OEM code
# page (GBK on Chinese systems), which would turn song titles into mojibake.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime

    $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object {
            $_.Name -eq 'AsTask' -and
            $_.GetParameters().Count -eq 1 -and
            $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
        })

    function Await($WinRtTask, $ResultType) {
        $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
        $netTask = $asTask.Invoke($null, @($WinRtTask))
        $netTask.Wait(-1) | Out-Null
        $netTask.Result
    }

    # Tell PowerShell this is a WinRT type. The type literal must stay on ONE
    # line; a line break splits it into two arguments and parsing fails.
    $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]

    $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

    $session = $mgr.GetCurrentSession()
    if (-not $session) {
        '{"found":false}'
        exit 0
    }

    $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])

    $playback = $session.GetPlaybackInfo()

    # NetEase Cloud Music does not report a timeline, so this may be all zeros.
    # Read it defensively and omit it when unavailable.
    $timeline = $null
    try { $timeline = $session.GetTimelineProperties() } catch { }

    $result = [ordered]@{
        found  = $true
        app    = $session.SourceAppUserModelId
        title  = $props.Title
        artist = $props.Artist
        album  = $props.AlbumTitle
        status = $playback.PlaybackStatus.ToString()
    }

    if ($timeline) {
        $result.position = [math]::Round($timeline.Position.TotalSeconds, 1)
        $result.duration = [math]::Round($timeline.EndTime.TotalSeconds, 1)
    }

    $result | ConvertTo-Json -Compress
}
catch {
    # Degrade to "cannot read" instead of crashing the watcher.
    $msg = $_.Exception.Message -replace '\\', '/' -replace '"', "'"
    '{"found":false,"error":"' + $msg + '"}'
    exit 0
}
