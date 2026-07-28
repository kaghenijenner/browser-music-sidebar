param(
    [Parameter(Mandatory = $true)]
    [ValidateSet(
        'GetState',
        'Toggle',
        'Previous',
        'Next',
        'SeekRelative',
        'SeekTo',
        'SetShuffle',
        'SetRepeat'
    )]
    [string]$Action,

    [string]$Player = '',
    [string]$Value = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

function Await-WinRt {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Operation,

        [Parameter(Mandatory = $true)]
        [Type]$ResultType
    )

    $asTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object {
            $_.Name -eq 'AsTask' -and
            $_.IsGenericMethod -and
            $_.GetParameters().Count -eq 1 -and
            $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
        } |
        Select-Object -First 1

    $task = $asTaskMethod.MakeGenericMethod($ResultType).Invoke(
        $null,
        @($Operation)
    )
    $task.Wait()
    return $task.Result
}

function Invoke-MediaAction {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Operation
    )

    $accepted = Await-WinRt -Operation $Operation -ResultType ([bool])
    if (-not $accepted) {
        throw 'The media player rejected the requested command.'
    }
}

function Write-Json {
    param(
        [Parameter(Mandatory = $true)]
        [object]$InputObject
    )

    $InputObject | ConvertTo-Json -Depth 5 -Compress
}

try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime

    $managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
    $propertiesType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
    $repeatModeType = [Windows.Media.MediaPlaybackAutoRepeatMode, Windows.Media, ContentType = WindowsRuntime]
    $dataReaderType = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]

    $manager = Await-WinRt -Operation ($managerType::RequestAsync()) `
        -ResultType $managerType

    $session = $null
    if ([string]::IsNullOrWhiteSpace($Player)) {
        $session = $manager.GetCurrentSession()
    }
    else {
        $playerCandidates = @($Player)
        if ($Player -ieq 'chromium' -or $Player -ieq 'google-chrome') {
            $playerCandidates += 'chrome'
        }
        $session = @($manager.GetSessions()) |
            Where-Object {
                $sourceId = $_.SourceAppUserModelId
                $matched = $false
                foreach ($candidate in $playerCandidates) {
                    if ($sourceId.IndexOf(
                        $candidate,
                        [System.StringComparison]::OrdinalIgnoreCase
                    ) -ge 0) {
                        $matched = $true
                        break
                    }
                }
                $matched
            } |
            Select-Object -First 1
    }

    if ($null -eq $session) {
        if ($Action -eq 'GetState') {
            Write-Json -InputObject ([ordered]@{ active = $false })
            exit 0
        }
        throw 'No active media'
    }

    if ($Action -ne 'GetState') {
        switch ($Action) {
            'Toggle' {
                $playbackStatus = $session.GetPlaybackInfo().PlaybackStatus.ToString()
                if ($playbackStatus -eq 'Playing') {
                    Invoke-MediaAction -Operation ($session.TryPauseAsync())
                }
                else {
                    Invoke-MediaAction -Operation ($session.TryPlayAsync())
                }
            }
            'Previous' {
                Invoke-MediaAction -Operation ($session.TrySkipPreviousAsync())
            }
            'Next' {
                Invoke-MediaAction -Operation ($session.TrySkipNextAsync())
            }
            'SeekRelative' {
                $offsetSeconds = [double]::Parse(
                    $Value,
                    [System.Globalization.CultureInfo]::InvariantCulture
                )
                $timeline = $session.GetTimelineProperties()
                $targetSeconds = [Math]::Max(
                    0,
                    $timeline.Position.TotalSeconds + $offsetSeconds
                )
                $targetTicks = [long]($targetSeconds * 10000000)
                Invoke-MediaAction -Operation (
                    $session.TryChangePlaybackPositionAsync($targetTicks)
                )
            }
            'SeekTo' {
                $targetSeconds = [double]::Parse(
                    $Value,
                    [System.Globalization.CultureInfo]::InvariantCulture
                )
                $targetTicks = [long]([Math]::Max(0, $targetSeconds) * 10000000)
                Invoke-MediaAction -Operation (
                    $session.TryChangePlaybackPositionAsync($targetTicks)
                )
            }
            'SetShuffle' {
                $enabled = [bool]::Parse($Value)
                Invoke-MediaAction -Operation (
                    $session.TryChangeShuffleActiveAsync($enabled)
                )
            }
            'SetRepeat' {
                $repeatMode = switch ($Value) {
                    'Track' {
                        $repeatModeType::Track
                    }
                    'Playlist' {
                        $repeatModeType::List
                    }
                    default {
                        $repeatModeType::None
                    }
                }
                Invoke-MediaAction -Operation (
                    $session.TryChangeAutoRepeatModeAsync($repeatMode)
                )
            }
        }

        Write-Json -InputObject ([ordered]@{ ok = $true })
        exit 0
    }

    $media = Await-WinRt -Operation ($session.TryGetMediaPropertiesAsync()) `
        -ResultType $propertiesType
    $playback = $session.GetPlaybackInfo()
    $timeline = $session.GetTimelineProperties()
    $status = $playback.PlaybackStatus.ToString()

    if ([string]::IsNullOrWhiteSpace($media.Title) -and
        ($status -eq 'Closed' -or $status -eq 'Stopped')) {
        Write-Json -InputObject ([ordered]@{ active = $false })
        exit 0
    }

    $artworkUrl = $null
    if ($null -ne $media.Thumbnail) {
        try {
            $streamType = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
            $stream = Await-WinRt -Operation ($media.Thumbnail.OpenReadAsync()) `
                -ResultType $streamType
            $maximumArtworkBytes = 4MB
            if ($stream.Size -gt 0 -and $stream.Size -le $maximumArtworkBytes) {
                $reader = $dataReaderType::new(
                    $stream.GetInputStreamAt(0)
                )
                $bytesToRead = [uint32]$stream.Size
                [void](Await-WinRt -Operation ($reader.LoadAsync($bytesToRead)) `
                    -ResultType ([uint32]))
                $bytes = [byte[]]::new($bytesToRead)
                $reader.ReadBytes($bytes)
                $mimeType = if ([string]::IsNullOrWhiteSpace($stream.ContentType)) {
                    'image/jpeg'
                }
                else {
                    $stream.ContentType
                }
                $artworkUrl = 'data:{0};base64,{1}' -f $mimeType,
                    [Convert]::ToBase64String($bytes)
                $reader.Dispose()
            }
            $stream.Dispose()
        }
        catch {
            $artworkUrl = $null
        }
    }

    $shuffle = $null
    if ($null -ne $playback.IsShuffleActive) {
        $shuffle = [bool]$playback.IsShuffleActive.Value
    }

    $repeat = 'Unknown'
    if ($null -ne $playback.AutoRepeatMode) {
        $repeat = $playback.AutoRepeatMode.Value.ToString()
    }

    $controls = $playback.Controls
    Write-Json -InputObject ([ordered]@{
        active = $true
        playerName = $session.SourceAppUserModelId
        title = $media.Title
        artist = $media.Artist
        album = $media.AlbumTitle
        artworkUrl = $artworkUrl
        status = $status
        positionSeconds = $timeline.Position.TotalSeconds
        lengthSeconds = $timeline.EndTime.TotalSeconds
        shuffle = $shuffle
        repeat = $repeat
        capabilities = [ordered]@{
            previous = $controls.IsPreviousEnabled
            next = $controls.IsNextEnabled
            seek = $controls.IsPlaybackPositionEnabled
            shuffle = $controls.IsShuffleEnabled
            repeat = $controls.IsRepeatEnabled
        }
    })
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
