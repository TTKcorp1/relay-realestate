# Save as install-pkg.ps1 and run from project folder
$ErrorActionPreference = "Stop"
cd C:\Users\tulip\Downloads\relay-html-css-js
New-Item -ItemType Directory -Force -Path public, relay | Out-Null
$b64 = @'
ewogICJuYW1lIjogInJlbGF5LWh0bWwtY3NzIiwKICAidmVyc2lvbiI6ICIxLjAuMCIsCiAgIm1haW4iOiAic2VydmVyLmpzIiwKICAic2NyaXB0cyI6IHsKICAgICJ0ZXN0IjogIm5vZGUgdGVzdC5qcyIsCiAgICAic3RhcnQiOiAibm9kZSBzZXJ2ZXIuanMiLAogICAgImRldiI6ICJub2RlbW9uIC0taWdub3JlIFwiKi5qc29uXCIgLS1pZ25vcmUgXCJwdWJsaWMvKlwiIHNlcnZlci5qcyIKICB9LAogICJkZXBlbmRlbmNpZXMiOiB7CiAgICAiZG90ZW52IjogIl4xOC4wLjEiLAogICAgImV4cHJlc3MiOiAiXjUuMi4xIiwKICAgICJwZyI6ICJeOC4yMy4wIgogIH0sCiAgImRldkRlcGVuZGVuY2llcyI6IHsKICAgICJub2RlbW9uIjogIl4zLjEuMTQiCiAgfQp9Cg==
'@
$bytes = [Convert]::FromBase64String($b64.Trim())
$path = Join-Path (Get-Location) 'package.json'
[IO.File]::WriteAllBytes($path, $bytes)
Write-Host "OK package.json ($($bytes.Length) bytes)"
