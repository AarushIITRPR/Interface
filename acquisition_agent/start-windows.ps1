param(
  [Parameter(Mandatory=$true)][string]$Session,
  [Parameter(Mandatory=$true)][string]$Token,
  [string]$Csi="auto",
  [string]$Emg="auto",
  [string]$Gsr="auto",
  [string]$Ecg="none"
)

$agentRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
& "$agentRoot\.venv\Scripts\python.exe" -m meridian_agent --code $Session --token $Token --camera auto --audio auto --oximeter auto --csi $Csi --emg $Emg --gsr $Gsr --ecg $Ecg
