# Builds dist\TupraQ.exe - one self-contained file (bundles the Node runtime and the app).
# Usage:  powershell -ExecutionPolicy Bypass -File build\build.ps1 [-Level asInvoker] [-Out name.exe]
param([string]$Level = 'requireAdministrator', [string]$Out = 'TupraQ.exe')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$dist = Join-Path $root 'dist'; New-Item -ItemType Directory -Force $dist | Out-Null
$tmp = Join-Path $env:TEMP ('tupraq-build-' + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory $tmp | Out-Null
try {
  $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  $node = (Get-Command node.exe).Source
  $stamp = Join-Path $tmp 'stamp.txt'; [IO.File]::WriteAllText($stamp, (Get-Date).ToString('o'))
  $man = Join-Path $tmp 'app.manifest'
  [IO.File]::WriteAllText($man, ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'app.manifest')) -replace '__LEVEL__', $Level))
  $res = @("/resource:`"$stamp`",stamp.txt", "/resource:`"$node`",node.exe", "/resource:`"$(Join-Path $root 'server.js')`",server.js", "/resource:`"$(Join-Path $root 'updater.js')`",updater.js")
  Get-ChildItem (Join-Path $root 'ui') -File | ForEach-Object { $res += "/resource:`"$($_.FullName)`",ui/$($_.Name)" }
  # WebView2 SDK (Microsoft, from NuGet package Microsoft.Web.WebView2) - gives TupraQ its own window.
  $wv = Join-Path $PSScriptRoot 'webview2'
  Get-ChildItem $wv -Filter *.dll | ForEach-Object { $res += "/resource:`"$($_.FullName)`",$($_.Name)" }
  $outFile = Join-Path $dist $Out
  & $csc /nologo /target:winexe /optimize+ /platform:x64 "/out:$outFile" "/win32icon:$(Join-Path $root 'ui\tupraq.ico')" "/win32manifest:$man" /r:System.Windows.Forms.dll /r:System.Drawing.dll "/r:$(Join-Path $wv 'Microsoft.Web.WebView2.Core.dll')" "/r:$(Join-Path $wv 'Microsoft.Web.WebView2.WinForms.dll')" @res (Join-Path $PSScriptRoot 'launcher.cs')
  if ($LASTEXITCODE -ne 0) { throw "csc failed ($LASTEXITCODE)" }
  '{0}  {1:N1} MB' -f $outFile, ((Get-Item $outFile).Length / 1MB)
} finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
